//! Compose a LinkedIn connection-request note into the `outreach` table (channel='linkedin').

use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};

/// LinkedIn's connection-request note character limit.
pub const NOTE_MAX: usize = 300;

/// Store a LinkedIn note for a company as a reviewable outreach row (channel='linkedin').
/// Requires the company to have a contact with a linkedin_url. One row per domain (upsert),
/// matching `draft::add` semantics. Never sends.
///
/// When a Canonical CTA link is configured (`product::cta_link()`, read from product.md), it
/// is appended as the note's final line — mirroring the email path's `{link}` (see
/// `src/message.rs`) — unless the note already references it. The combined note is trimmed
/// to fit LinkedIn's `NOTE_MAX` cap; the note BODY is trimmed, never the link.
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

    let note = with_cta_link(note, &domain);

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

/// True if `note` already references `link` (or `trycanonical` generally) — guards against
/// appending a second link on a re-`add`, and lets `relink` skip already-linked drafts.
fn already_linked(note: &str, link: &str) -> bool {
    let lower = note.to_lowercase();
    lower.contains(&link.to_lowercase()) || lower.contains("trycanonical")
}

/// Append the per-company CTA link (product.md's `## Call to Action` link, with `{slug}`
/// filled in via `crate::enrich::slug`) as the note's final line, if one is configured and
/// not already present. If nothing is configured, `note` is returned unchanged.
fn with_cta_link(note: &str, domain: &str) -> String {
    let Some(raw) = crate::product::cta_link() else {
        return note.to_string();
    };
    let link = raw.replace("{slug}", &crate::enrich::slug(domain));
    if already_linked(note, &link) {
        return note.to_string();
    }
    format!("{}\n{link}", trimmed_body(note, link.chars().count()))
}

/// The note body, trimmed if needed to leave room for `link_len` chars plus the joining
/// newline within `NOTE_MAX`. Prefers cutting at a whitespace boundary near the cut point
/// (so a word isn't split) but falls back to a hard cut rather than sacrifice much body.
fn trimmed_body(note: &str, link_len: usize) -> String {
    let budget = NOTE_MAX.saturating_sub(link_len + 1); // +1 for the joining newline
    let chars: Vec<char> = note.chars().collect();
    if chars.len() <= budget {
        return note.to_string();
    }
    if budget == 0 {
        return String::new();
    }
    let window = &chars[..budget];
    let cut = match window.iter().rposition(|c| c.is_whitespace()) {
        Some(ws) if budget - ws <= 40 => ws,
        _ => budget,
    };
    chars[..cut]
        .iter()
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// Backfill existing pending/drafted LinkedIn notes with the CTA link (for drafts written
/// before this feature, or written while no CTA link was configured). Skips rows that
/// already reference the link, and rows where no CTA link is configured (a no-op — `add`'s
/// today-unchanged behavior). Returns `(updated, total pending)`.
pub fn relink() -> Result<(usize, usize)> {
    crate::db::init()?;
    let conn = crate::db::open()?;
    let mut stmt = conn.prepare(
        "SELECT id, domain, body FROM outreach \
         WHERE channel='linkedin' AND status IN ('draft_pending','drafted')",
    )?;
    let rows: Vec<(i64, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);

    let total = rows.len();
    let mut updated = 0;
    for (id, domain, body) in rows {
        let relinked = with_cta_link(&body, &domain);
        if relinked != body {
            conn.execute(
                "UPDATE outreach SET body=?2 WHERE id=?1",
                params![id, relinked],
            )?;
            updated += 1;
        }
    }
    println!("linkedin-relink: updated {updated} of {total} pending LinkedIn draft(s)");
    Ok((updated, total))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_cta_link(link: &str) {
        let md = format!("## Call to Action\n\n- Link: {link}\n");
        std::fs::write(crate::home::path("product.md").unwrap(), md).unwrap();
    }

    fn seed_contact(domain: &str, name: &str) {
        crate::db::init().unwrap();
        let c = crate::db::open().unwrap();
        c.execute(
            "INSERT INTO companies (domain, source_query) VALUES (?1,'q')",
            [domain],
        )
        .unwrap();
        c.execute(
            "INSERT INTO contacts (domain, founder_name, linkedin_url) \
             VALUES (?1,?2,'https://www.linkedin.com/in/janedoe')",
            params![domain, name],
        )
        .unwrap();
    }

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

    #[test]
    fn no_cta_configured_leaves_note_unchanged() {
        crate::testutil::with_home("ct-note-no-cta", |_| {
            seed_contact("acme.com", "Jane");
            add("acme.com", "Hi Jane, loved what Acme is building.").unwrap();
            let conn = crate::db::open().unwrap();
            let body: String = conn
                .query_row(
                    "SELECT body FROM outreach WHERE domain='acme.com'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(body, "Hi Jane, loved what Acme is building.");
        });
    }

    #[test]
    fn appends_cta_link_with_per_company_slug() {
        crate::testutil::with_home("ct-note-cta", |_| {
            seed_contact("acme.com", "Jane");
            set_cta_link("https://trycanonical.ai/?utm_content={slug}");
            add("acme.com", "Hi Jane, loved what Acme is building.").unwrap();
            let conn = crate::db::open().unwrap();
            let body: String = conn
                .query_row(
                    "SELECT body FROM outreach WHERE domain='acme.com'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                body,
                "Hi Jane, loved what Acme is building.\nhttps://trycanonical.ai/?utm_content=acme"
            );
            assert!(body.chars().count() <= NOTE_MAX);
        });
    }

    #[test]
    fn trims_long_body_but_never_the_link() {
        crate::testutil::with_home("ct-note-cta-trim", |_| {
            seed_contact("acme.com", "Jane");
            set_cta_link("https://trycanonical.ai/?utm_content={slug}");
            // 290 chars of body (under NOTE_MAX alone) but pushes the total over 300 once the
            // link is appended, forcing a body trim.
            let body = format!("Hi Jane, {}", "x".repeat(280));
            assert!(body.chars().count() <= NOTE_MAX);
            add("acme.com", &body).unwrap();
            let conn = crate::db::open().unwrap();
            let stored: String = conn
                .query_row(
                    "SELECT body FROM outreach WHERE domain='acme.com'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(
                stored.chars().count() <= NOTE_MAX,
                "len={}",
                stored.chars().count()
            );
            assert!(
                stored.ends_with("https://trycanonical.ai/?utm_content=acme"),
                "link must survive intact: {stored}"
            );
        });
    }

    #[test]
    fn does_not_double_append_when_note_already_has_the_link() {
        crate::testutil::with_home("ct-note-cta-dup", |_| {
            seed_contact("acme.com", "Jane");
            set_cta_link("https://trycanonical.ai/?utm_content={slug}");
            let note =
                "Hi Jane — see https://trycanonical.ai/?utm_content=acme for more.".to_string();
            add("acme.com", &note).unwrap();
            let conn = crate::db::open().unwrap();
            let stored: String = conn
                .query_row(
                    "SELECT body FROM outreach WHERE domain='acme.com'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(stored, note);
            assert_eq!(stored.matches("trycanonical").count(), 1);
        });
    }

    #[test]
    fn relink_backfills_missing_link_and_skips_linked_row() {
        crate::testutil::with_home("ct-note-relink", |_| {
            seed_contact("acme.com", "Jane");
            seed_contact("beta.com", "Bob");
            set_cta_link("https://trycanonical.ai/?utm_content={slug}");
            let conn = crate::db::open().unwrap();
            // acme.com: an old draft with no link — should get backfilled.
            conn.execute(
                "INSERT INTO outreach (domain, channel, subject, body, status) \
                 VALUES ('acme.com','linkedin','','Hi Jane, loved Acme.','draft_pending')",
                [],
            )
            .unwrap();
            // beta.com: already has the link — must be left untouched.
            let already = "Hi Bob — https://trycanonical.ai/?utm_content=beta";
            conn.execute(
                "INSERT INTO outreach (domain, channel, subject, body, status) \
                 VALUES ('beta.com','linkedin','',?1,'drafted')",
                [already],
            )
            .unwrap();

            let (updated, total) = relink().unwrap();
            assert_eq!(total, 2);
            assert_eq!(updated, 1);

            let acme_body: String = conn
                .query_row(
                    "SELECT body FROM outreach WHERE domain='acme.com'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(acme_body.ends_with("https://trycanonical.ai/?utm_content=acme"));

            let beta_body: String = conn
                .query_row(
                    "SELECT body FROM outreach WHERE domain='beta.com'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(beta_body, already);
        });
    }

    #[test]
    fn relink_is_noop_when_no_cta_configured() {
        crate::testutil::with_home("ct-note-relink-nocta", |_| {
            seed_contact("acme.com", "Jane");
            let conn = crate::db::open().unwrap();
            conn.execute(
                "INSERT INTO outreach (domain, channel, subject, body, status) \
                 VALUES ('acme.com','linkedin','','Hi Jane, loved Acme.','draft_pending')",
                [],
            )
            .unwrap();
            let (updated, total) = relink().unwrap();
            assert_eq!(total, 1);
            assert_eq!(updated, 0);
        });
    }
}
