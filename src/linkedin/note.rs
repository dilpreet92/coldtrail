//! Compose a LinkedIn connection-request note into the `outreach` table (channel='linkedin').

use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};

/// LinkedIn's connection-request note character limit.
pub const NOTE_MAX: usize = 300;

/// Store a LinkedIn note for a company as a reviewable outreach row (channel='linkedin').
/// Requires the company to have a contact with a linkedin_url. One row per domain (upsert),
/// matching `draft::add` semantics. Never sends.
pub fn add(domain: &str, note: &str) -> Result<()> {
    let domain = domain.trim().to_lowercase();
    let note = note.trim();
    if note.chars().count() > NOTE_MAX {
        return Err(anyhow!(
            "LinkedIn note is {} chars — the limit is {NOTE_MAX}",
            note.chars().count()
        ));
    }
    crate::db::init()?;
    let conn = crate::db::open()?;
    let contact_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM contacts WHERE domain=?1 AND linkedin_url IS NOT NULL \
             ORDER BY found_at DESC LIMIT 1",
            [&domain],
            |r| r.get(0),
        )
        .optional()?;
    let contact_id = contact_id
        .ok_or_else(|| anyhow!("no LinkedIn contact on file for {domain} — add one first"))?;
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
            "UPDATE outreach SET channel='linkedin', subject='', body=?2, contact_id=?3, \
             status='draft_pending' WHERE domain=?1",
            params![domain, note, contact_id],
        )?;
    } else {
        conn.execute(
            "INSERT INTO outreach (domain, contact_id, channel, subject, body, status) \
             VALUES (?1, ?2, 'linkedin', '', ?3, 'draft_pending')",
            params![domain, contact_id, note],
        )?;
    }
    println!("linkedin note stored for {domain}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_over_length_note() {
        crate::testutil::with_home("ct-note-long", |_| {
            crate::db::init().unwrap();
            let long = "x".repeat(NOTE_MAX + 1);
            let err = add("acme.com", &long).unwrap_err().to_string();
            assert!(err.contains("300"), "got: {err}");
        });
    }

    #[test]
    fn rejects_when_no_linkedin_contact() {
        crate::testutil::with_home("ct-note-nolinked", |_| {
            crate::db::init().unwrap();
            let err = add("acme.com", "hi").unwrap_err().to_string();
            assert!(err.contains("no LinkedIn"), "got: {err}");
        });
    }

    #[test]
    fn stores_linkedin_channel_row() {
        crate::testutil::with_home("ct-note-ok", |_| {
            crate::db::init().unwrap();
            let c = crate::db::open().unwrap();
            c.execute(
                "INSERT INTO companies (domain, source_query) VALUES ('acme.com','q')",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO contacts (domain, founder_name, linkedin_url) \
                 VALUES ('acme.com','Jane','https://www.linkedin.com/in/janedoe')",
                [],
            )
            .unwrap();
            add("acme.com", "Hi Jane, loved what Acme is building.").unwrap();
            let (chan, body): (String, String) = c
                .query_row(
                    "SELECT channel, body FROM outreach WHERE domain='acme.com'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(chan, "linkedin");
            assert!(body.contains("Jane"));
        });
    }
}
