//! Build personalized drafts for MX-verified founder contacts that aren't drafted
//! yet. Writes one `outreach` row (draft_pending) per contact and dumps
//! `pending_drafts.json`. Never sends anything.

use anyhow::Result;
use rusqlite::params;
use serde_json::json;

use crate::message::Message;

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
