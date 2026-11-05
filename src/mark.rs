//! Record a Gmail draft id against a company's email draft (after the agent creates the draft
//! via the Gmail MCP), or mark it sent / replied / bounced. Each value changes only the rows it
//! is about: a send or a Gmail draft is one draft, the newest waiting on its channel (the one
//! Drafts shows and `deliver::reviewable` sends; never sent history, or an older draft that
//! comes up after it); a reply or a bounce is recorded on what went out.

use anyhow::{bail, Result};
use rusqlite::{params, Connection};

/// The id of the domain's (?1) newest draft waiting on a channel (?2; a legacy NULL channel is
/// email), in the order `deliver::reviewable` picks it.
const NEWEST_WAITING: &str = "(SELECT id FROM outreach WHERE domain=?1 \
     AND status IN ('draft_pending','drafted') AND COALESCE(channel,'email')=?2 \
     ORDER BY created_at DESC, id DESC LIMIT 1)";

/// Record `domain`'s newest draft waiting on `channel` as sent; false when none waits.
pub fn mark_newest_sent(c: &Connection, domain: &str, channel: &str) -> Result<bool> {
    let n = c.execute(
        &format!(
            "UPDATE outreach SET status='sent', sent_at=datetime('now') WHERE id={NEWEST_WAITING}"
        ),
        params![domain, channel],
    )?;
    Ok(n > 0)
}

/// Record a send of `domain`'s draft waiting on `channel`, and move the company to Sent. With
/// no channel (the agent's `mark <domain> sent`): the waiting email, else a LinkedIn note sent
/// by hand. Fails, changing nothing, when no such draft waits.
pub fn sent(domain: &str, channel: Option<&str>) -> Result<()> {
    let mut conn = crate::db::open()?;
    let tx = conn.transaction()?;
    let marked = match channel {
        Some(ch) => mark_newest_sent(&tx, domain, ch)?,
        None => {
            mark_newest_sent(&tx, domain, "email")? || mark_newest_sent(&tx, domain, "linkedin")?
        }
    };
    if !marked {
        match channel {
            Some("linkedin") => bail!("{domain} has no LinkedIn note waiting to mark sent"),
            Some(_) => bail!("{domain} has no email draft waiting to mark sent"),
            None => bail!("{domain} has no draft waiting to mark sent"),
        }
    }
    crate::db::set_status(&tx, domain, "sent")?;
    tx.commit()?;
    Ok(())
}

pub fn run(domain: &str, value: &str) -> Result<()> {
    if value == "sent" {
        sent(domain, None)?;
        println!("{domain}: {value}");
        return Ok(());
    }
    let mut conn = crate::db::open()?;
    let tx = conn.transaction()?;
    match value {
        "bounced" | "replied" => {
            let sent = tx.execute(
                "UPDATE outreach SET status=?2 \
                 WHERE domain=?1 AND status IN ('sent','replied','bounced')",
                params![domain, value],
            )?;
            // A reply or a bounce ends the sequence: a follow-up or note still waiting must
            // neither go out later nor count as a touch. Without sends there is no sequence,
            // so a first draft stays. DB-only, like Discard: a Gmail draft stays in Gmail.
            if sent > 0 {
                tx.execute(
                    "DELETE FROM outreach WHERE domain=?1 AND status IN ('draft_pending','drafted')",
                    [domain],
                )?;
            }
            crate::db::set_status(&tx, domain, value)?;
        }
        draft_id => {
            let n = tx.execute(
                &format!(
                    "UPDATE outreach SET gmail_draft_id=?3, status='drafted' WHERE id={NEWEST_WAITING}"
                ),
                params![domain, "email", draft_id],
            )?;
            if n == 0 {
                bail!("{domain} has no email draft waiting to record a Gmail draft on");
            }
            // A follow-up's Gmail draft doesn't move a company already written to back a stage.
            if !contacted(&tx, domain)? {
                crate::db::set_status(&tx, domain, "drafted")?;
            }
        }
    }
    tx.commit()?;
    println!("{domain}: {value}");
    Ok(())
}

/// Whether anything went out to `domain` (sent, replied or bounced) on either channel.
pub fn contacted(c: &Connection, domain: &str) -> Result<bool> {
    Ok(c.query_row(
        "SELECT EXISTS (SELECT 1 FROM outreach \
         WHERE domain=?1 AND status IN ('sent','replied','bounced'))",
        [domain],
        |r| r.get(0),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(sql: &str) {
        crate::db::init().unwrap();
        crate::db::open().unwrap().execute_batch(sql).unwrap();
    }

    /// (channel, status, gmail_draft_id, sent_at) of every outreach row for `domain`, oldest first.
    fn rows_of(domain: &str) -> Vec<(String, String, Option<String>, Option<String>)> {
        crate::db::open()
            .unwrap()
            .prepare(
                "SELECT COALESCE(channel,'email'), status, gmail_draft_id, sent_at FROM outreach \
                 WHERE domain = ?1 ORDER BY id",
            )
            .unwrap()
            .query_map([domain], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn status_of(domain: &str) -> String {
        crate::db::open()
            .unwrap()
            .query_row(
                "SELECT status FROM companies WHERE domain = ?1",
                [domain],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn row(
        ch: &str,
        status: &str,
        draft: Option<&str>,
        sent: Option<&str>,
    ) -> (String, String, Option<String>, Option<String>) {
        (
            ch.into(),
            status.into(),
            draft.map(Into::into),
            sent.map(Into::into),
        )
    }

    /// A sent email, its follow-up and a LinkedIn note: Mark sent (and Send now) records the
    /// follow-up only. The first email keeps its send date and the note stays in the queue.
    #[test]
    fn mark_sent_touches_only_the_reviewable_email() {
        crate::testutil::with_home("ct-mark-sent-scope", |_| {
            seed(
                "INSERT INTO companies (domain, status) VALUES ('acme.com','sent'); \
                 INSERT INTO outreach (domain, channel, status, gmail_draft_id, sent_at) VALUES \
                 ('acme.com','email','sent',NULL,'2026-10-24 09:00:00'), \
                 ('acme.com',NULL,'drafted','r-1',NULL), \
                 ('acme.com','linkedin','draft_pending',NULL,NULL);",
            );
            run("acme.com", "sent").unwrap();
            let rows = rows_of("acme.com");
            assert_eq!(
                rows[0],
                row("email", "sent", None, Some("2026-10-24 09:00:00"))
            );
            assert_eq!((rows[1].1.as_str(), rows[1].3.is_some()), ("sent", true));
            assert_eq!(rows[2], row("linkedin", "draft_pending", None, None));
            assert_eq!(status_of("acme.com"), "sent");
        });
    }

    /// Create Gmail draft records the id on the reviewable email only: sent history (either
    /// channel) stays sent, and an already-contacted company keeps its stage. A first draft
    /// still moves its company to `drafted`.
    #[test]
    fn mark_gmail_draft_touches_only_the_reviewable_email() {
        crate::testutil::with_home("ct-mark-gmail-scope", |_| {
            seed(
                "INSERT INTO companies (domain, status) VALUES ('acme.com','sent'), ('new.com','emailed'); \
                 INSERT INTO outreach (domain, channel, status, sent_at) VALUES \
                 ('acme.com','email','sent','2026-10-24 09:00:00'), \
                 ('acme.com','email','draft_pending',NULL), \
                 ('acme.com','linkedin','sent','2026-10-25 09:00:00'), \
                 ('new.com','email','draft_pending',NULL), \
                 ('new.com','linkedin','draft_pending',NULL);",
            );
            run("acme.com", "gmail").unwrap();
            assert_eq!(
                rows_of("acme.com"),
                [
                    row("email", "sent", None, Some("2026-10-24 09:00:00")),
                    row("email", "drafted", Some("gmail"), None),
                    row("linkedin", "sent", None, Some("2026-10-25 09:00:00")),
                ]
            );
            assert_eq!(status_of("acme.com"), "sent");

            run("new.com", "r-9").unwrap();
            assert_eq!(
                rows_of("new.com"),
                [
                    row("email", "drafted", Some("r-9"), None),
                    row("linkedin", "draft_pending", None, None),
                ]
            );
            assert_eq!(status_of("new.com"), "drafted");
        });
    }

    /// A reply or a bounce is recorded on what went out, and ends the sequence: a follow-up or
    /// note still waiting leaves Drafts instead of turning into a touch that was never sent.
    #[test]
    fn mark_replied_or_bounced_records_sends_and_drops_waiting_drafts() {
        crate::testutil::with_home("ct-mark-reply-scope", |_| {
            seed(
                "INSERT INTO companies (domain, status) VALUES ('a.com','sent'), ('b.com','sent'); \
                 INSERT INTO outreach (domain, channel, status, sent_at) VALUES \
                 ('a.com','email','sent','2026-10-24 09:00:00'), \
                 ('a.com','email','draft_pending',NULL), \
                 ('a.com','linkedin','drafted',NULL), \
                 ('b.com','email','sent','2026-10-20 09:00:00'), \
                 ('b.com','email','sent','2026-10-24 09:00:00'), \
                 ('b.com','email','draft_pending',NULL);",
            );
            run("a.com", "replied").unwrap();
            assert_eq!(
                rows_of("a.com"),
                [row("email", "replied", None, Some("2026-10-24 09:00:00"))]
            );
            assert_eq!(status_of("a.com"), "replied");

            run("b.com", "bounced").unwrap();
            assert_eq!(
                rows_of("b.com"),
                [
                    row("email", "bounced", None, Some("2026-10-20 09:00:00")),
                    row("email", "bounced", None, Some("2026-10-24 09:00:00")),
                ]
            );
            assert_eq!(status_of("b.com"), "bounced");

            // Changing the outcome later re-labels what went out.
            run("b.com", "replied").unwrap();
            let statuses: Vec<String> = rows_of("b.com").into_iter().map(|r| r.1).collect();
            assert_eq!(statuses, ["replied", "replied"]);
        });
    }

    /// Mark sent with no draft waiting changes nothing and says so: the company keeps its
    /// stage instead of reading as Sent with nothing recorded. The same for a Gmail draft id.
    #[test]
    fn mark_sent_with_nothing_waiting_errors_and_keeps_the_stage() {
        crate::testutil::with_home("ct-mark-sent-nothing", |_| {
            seed(
                "INSERT INTO companies (domain, status) VALUES ('stale.com','skip'), ('done.com','sent'); \
                 INSERT INTO outreach (domain, channel, status, sent_at) VALUES \
                 ('done.com','email','sent','2026-10-24 09:00:00');",
            );
            let err = run("stale.com", "sent").unwrap_err().to_string();
            assert!(err.contains("no draft waiting"), "{err}");
            assert_eq!(status_of("stale.com"), "skip");

            let err = run("done.com", "r-1").unwrap_err().to_string();
            assert!(err.contains("no email draft waiting"), "{err}");
            assert_eq!(
                rows_of("done.com"),
                [row("email", "sent", None, Some("2026-10-24 09:00:00"))]
            );
        });
    }

    /// The agent's `mark <domain> sent` for a company whose only waiting draft is a LinkedIn
    /// note records that note as sent (an invite sent by hand). Drafts' Mark sent and Send now
    /// are about an email only: they never mark a note, and with no email waiting they fail.
    #[test]
    fn mark_sent_records_a_linkedin_note_only_when_no_email_waits() {
        crate::testutil::with_home("ct-mark-sent-linkedin", |_| {
            seed(
                "INSERT INTO companies (domain, status) VALUES ('li.com','drafted'), ('ui.com','drafted'); \
                 INSERT INTO outreach (domain, channel, status) VALUES \
                 ('li.com','linkedin','draft_pending'), ('ui.com','linkedin','draft_pending');",
            );
            run("li.com", "sent").unwrap();
            let rows = rows_of("li.com");
            assert_eq!((rows[0].1.as_str(), rows[0].3.is_some()), ("sent", true));
            assert_eq!(status_of("li.com"), "sent");

            let err = sent("ui.com", Some("email")).unwrap_err().to_string();
            assert!(err.contains("no email draft waiting"), "{err}");
            assert_eq!(
                rows_of("ui.com"),
                [row("linkedin", "draft_pending", None, None)]
            );
            assert_eq!(status_of("ui.com"), "drafted");
        });
    }

    /// Two emails waiting: the newest is the one Drafts shows and sends, so Mark sent, Send now
    /// and Create Gmail draft record that one only. The older one stays waiting, comes up next,
    /// and isn't counted as a send.
    #[test]
    fn mark_acts_on_the_newest_waiting_email_only() {
        crate::testutil::with_home("ct-mark-newest", |_| {
            seed(
                "INSERT INTO companies (domain, status) VALUES ('a.com','drafted'), ('b.com','emailed'); \
                 INSERT INTO outreach (domain, channel, status, gmail_draft_id, created_at) VALUES \
                 ('a.com','email','draft_pending',NULL,'2026-11-04 09:00:00'), \
                 ('a.com','email','drafted','r-1','2026-11-04 09:01:00'), \
                 ('b.com','email','draft_pending',NULL,'2026-11-04 09:01:00'), \
                 ('b.com','email','draft_pending',NULL,'2026-11-04 09:00:00');",
            );
            run("a.com", "sent").unwrap();
            let rows = rows_of("a.com");
            assert_eq!(rows[0], row("email", "draft_pending", None, None));
            assert_eq!((rows[1].1.as_str(), rows[1].3.is_some()), ("sent", true));

            run("b.com", "r-9").unwrap();
            assert_eq!(
                rows_of("b.com"),
                [
                    row("email", "drafted", Some("r-9"), None),
                    row("email", "draft_pending", None, None),
                ]
            );
        });
    }

    /// With nothing sent there is no sequence to end: a first draft is left alone.
    #[test]
    fn mark_replied_without_sends_keeps_the_first_draft() {
        crate::testutil::with_home("ct-mark-reply-unsent", |_| {
            seed(
                "INSERT INTO companies (domain, status) VALUES ('a.com','drafted'); \
                 INSERT INTO outreach (domain, channel, status) VALUES ('a.com','email','draft_pending');",
            );
            run("a.com", "replied").unwrap();
            assert_eq!(
                rows_of("a.com"),
                [row("email", "draft_pending", None, None)]
            );
        });
    }
}
