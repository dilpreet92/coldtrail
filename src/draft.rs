//! Build personalized drafts for MX-verified founder contacts that aren't drafted
//! yet. Writes one `outreach` row (draft_pending) per contact and dumps
//! `pending_drafts.json`. Never sends anything.

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde_json::json;

use crate::message::Message;

/// Store an agent-composed, personalized draft for a company (subject + body written
/// by the agent using `message.toml` as a brief). One row per domain; re-drafting a
/// domain replaces its pending draft. Never sends.
pub fn add(domain: &str, subject: &str, body: &str) -> Result<()> {
    let domain = domain.trim().to_lowercase();
    crate::db::init()?;
    let conn = crate::db::open()?;
    let contact_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM contacts WHERE domain=?1 AND email IS NOT NULL ORDER BY found_at DESC LIMIT 1",
            [&domain],
            |r| r.get(0),
        )
        .optional()?;
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM outreach WHERE domain=?1 LIMIT 1",
            [&domain],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if exists {
        conn.execute(
            "UPDATE outreach SET subject=?2, body=?3, contact_id=?4, status='draft_pending' WHERE domain=?1",
            params![domain, subject, body, contact_id],
        )?;
    } else {
        conn.execute(
            "INSERT INTO outreach (domain, contact_id, subject, body, status) \
             VALUES (?1, ?2, ?3, ?4, 'draft_pending')",
            params![domain, contact_id, subject, body],
        )?;
    }
    println!("drafted {domain}: {subject}");
    Ok(())
}

/// Store a follow-up as a NEW touch (outreach row) for a domain that was already
/// contacted. Always inserts — a domain can have several touches over time. Refused once the
/// company replied or bounced: that ends its sequence (`mark` drops what was waiting then), and
/// a follow-up written meanwhile (a Draft follow-up turn still going when a reply check marks
/// it) must not land in Drafts afterwards.
pub fn followup_add(domain: &str, subject: &str, body: &str) -> Result<()> {
    let domain = domain.trim().to_lowercase();
    crate::db::init()?;
    let conn = crate::db::open()?;
    let ended: Option<String> = conn
        .query_row(
            "SELECT CASE WHEN EXISTS (SELECT 1 FROM outreach WHERE domain=?1 AND status='replied') \
                           OR EXISTS (SELECT 1 FROM companies WHERE domain=?1 AND status='replied') \
                         THEN 'replied' \
                         WHEN EXISTS (SELECT 1 FROM outreach WHERE domain=?1 AND status='bounced') \
                           OR EXISTS (SELECT 1 FROM companies WHERE domain=?1 AND status='bounced') \
                         THEN 'bounced' END",
            [&domain],
            |r| r.get(0),
        )?;
    if let Some(how) = ended {
        anyhow::bail!("{domain} already {how}, so its sequence is over: no follow-up was stored");
    }
    let contact_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM contacts WHERE domain=?1 AND email IS NOT NULL ORDER BY found_at DESC LIMIT 1",
            [&domain],
            |r| r.get(0),
        )
        .optional()?;
    conn.execute(
        "INSERT INTO outreach (domain, contact_id, subject, body, status) \
         VALUES (?1, ?2, ?3, ?4, 'draft_pending')",
        params![domain, contact_id, subject, body],
    )?;
    println!("follow-up drafted for {domain}: {subject}");
    Ok(())
}

/// A row eligible for drafting: (contact_id, domain, founder_name, email, company_name).
type DraftRow = (i64, String, Option<String>, String, Option<String>);

pub fn run(max: usize) -> Result<()> {
    crate::db::init()?;
    let conn = crate::db::open()?;
    let message = Message::load()?;

    let mut stmt = conn.prepare(
        "SELECT k.id, k.domain, k.founder_name, k.email, c.name \
         FROM contacts k JOIN companies c ON c.domain = k.domain \
         WHERE k.mx_ok = 1 AND k.email IS NOT NULL AND c.status = 'emailed' \
           AND NOT EXISTS (SELECT 1 FROM outreach o WHERE o.domain = k.domain) \
         ORDER BY k.found_at LIMIT ?1",
    )?;
    let rows: Vec<DraftRow> = stmt
        .query_map([max as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;

    let mut drafts = Vec::new();
    for (contact_id, domain, founder, email, name) in &rows {
        let r = message.render(name.as_deref(), founder.as_deref(), domain);
        conn.execute(
            "INSERT INTO outreach (domain, contact_id, subject, body, utm_url, status) \
             VALUES (?1, ?2, ?3, ?4, ?5, 'draft_pending')",
            params![domain, contact_id, r.subject, r.body, r.link],
        )?;
        drafts.push(json!({
            "domain": domain, "to": email, "subject": r.subject,
            "body": r.body, "html": r.html,
        }));
    }

    let out = crate::home::path("pending_drafts.json")?;
    std::fs::write(&out, serde_json::to_string_pretty(&drafts)?)?;
    println!("prepared {} drafts -> {}", drafts.len(), out.display());
    for (_, domain, _, email, _) in &rows {
        println!("  {domain:<28} -> {email}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outreach(domain: &str) -> Vec<String> {
        crate::db::open()
            .unwrap()
            .prepare("SELECT status FROM outreach WHERE domain=?1 ORDER BY id")
            .unwrap()
            .query_map([domain], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    /// A follow-up stored after its company replied or bounced (a reply check that finished
    /// while the follow-up was being written) is refused, so nothing waits in Drafts for a
    /// founder who already answered. One still awaiting a reply is stored as before.
    #[test]
    fn followup_refused_once_the_company_replied_or_bounced() {
        crate::testutil::with_home("ct-draft-followup-ended", |_| {
            crate::db::init().unwrap();
            crate::db::open()
                .unwrap()
                .execute_batch(
                    "INSERT INTO companies (domain, status) VALUES \
                     ('r.com','sent'), ('b.com','bounced'), ('o.com','sent'); \
                     INSERT INTO contacts (domain, email) VALUES \
                     ('r.com','ann@r.com'), ('b.com','ben@b.com'), ('o.com','olu@o.com'); \
                     INSERT INTO outreach (domain, channel, status, sent_at) VALUES \
                     ('r.com','email','sent',datetime('now','-6 days')), \
                     ('b.com','email','sent',datetime('now','-6 days')), \
                     ('o.com','email','sent',datetime('now','-6 days'));",
                )
                .unwrap();
            crate::mark::run("r.com", "replied").unwrap();

            let err = followup_add("r.com", "Re: idea", "Following up.")
                .unwrap_err()
                .to_string();
            assert!(err.contains("already replied"), "{err}");
            assert_eq!(outreach("r.com"), ["replied"]);
            let err = followup_add("B.com", "Re: idea", "Following up.")
                .unwrap_err()
                .to_string();
            assert!(err.contains("already bounced"), "{err}");
            assert_eq!(outreach("b.com"), ["sent"]);

            followup_add("o.com", "Re: idea", "Following up.").unwrap();
            assert_eq!(outreach("o.com"), ["sent", "draft_pending"]);
        });
    }
}
