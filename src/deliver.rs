//! Delivery core — the ONE place a reviewed draft turns into a Gmail draft or a real send.
//! Shared by the Drafts-screen button (`web::send`), the `coldtrail send` CLI, and the OpenAI
//! `send_outreach` tool, so the auto-send gate and the daily cap are enforced identically
//! everywhere. Sending is gated on the human's `auto_send` config — the agent can trigger this,
//! but it can't send unless the human turned auto-send on.

use anyhow::{anyhow, Result};
use rusqlite::OptionalExtension;
use std::sync::OnceLock;

/// The machine's local UTC offset, captured ONCE at process start (see `capture_local_offset`).
static LOCAL_OFFSET: OnceLock<time::UtcOffset> = OnceLock::new();

/// A reviewable draft ready to draft-in-Gmail, send, or deliver via LinkedIn.
#[derive(Debug)]
pub struct Draft {
    /// "email" | "linkedin"
    pub channel: String,
    /// recipient: an email address (email channel) or a LinkedIn profile URL (linkedin channel)
    pub to: String,
    pub subject: String,
    pub body: String,
}

/// The latest reviewable (`draft_pending`|`drafted`) outreach for a domain, with its recipient.
/// Recipient is the contact email for the email channel, or the contact's linkedin_url for the
/// linkedin channel.
pub fn reviewable(domain: &str) -> Result<Draft> {
    let c = crate::db::open()?;
    let row = c
        .query_row(
            "SELECT COALESCE(o.channel,'email'), o.subject, o.body, k.email, k.linkedin_url \
             FROM outreach o LEFT JOIN contacts k ON k.id = o.contact_id \
             WHERE o.domain=?1 AND o.status IN ('draft_pending','drafted') \
             ORDER BY o.created_at DESC LIMIT 1",
            [domain],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?;
    let (channel, subject, body, email, linkedin) =
        row.ok_or_else(|| anyhow!("no reviewable draft for {domain}"))?;
    let to = if channel == "linkedin" {
        linkedin.ok_or_else(|| anyhow!("no LinkedIn URL on file for {domain}"))?
    } else {
        email.ok_or_else(|| anyhow!("no recipient email on file for {domain}"))?
    };
    Ok(Draft {
        channel,
        to,
        subject: subject.unwrap_or_default(),
        body: body.unwrap_or_default(),
    })
}

/// Create a Gmail DRAFT (never sends): keyless IMAP app-password APPEND, else the Gmail API.
/// Marks the row `drafted`.
pub async fn draft(domain: &str, d: &Draft) -> Result<()> {
    if let Some((email, pw)) = crate::secrets::gmail_app_password() {
        let mime = crate::gmail::mime_message(&d.to, &d.subject, &d.body);
        crate::imap_draft::append_draft(&email, &pw, &mime).await?;
    } else {
        let (token, quota) = crate::gmail::token().await?;
        crate::gmail::create_draft(&token, quota.as_deref(), &d.to, &d.subject, &d.body).await?;
    }
    crate::mark::run(domain, "gmail")?; // records a gmail draft + status='drafted'
    Ok(())
}

/// Email sends today (email channel or legacy NULL), for the email warmup cap.
pub fn sent_today() -> u32 {
    count_sent("status='sent' AND date(sent_at)=date('now') AND COALESCE(channel,'email')='email'")
}

/// LinkedIn connection-invites sent today.
pub fn linkedin_sent_today() -> u32 {
    count_sent("status='sent' AND channel='linkedin' AND date(sent_at)=date('now')")
}

/// LinkedIn connection-invites sent in the trailing 7 days (rolling weekly cap).
pub fn linkedin_sent_last_7d() -> u32 {
    count_sent("status='sent' AND channel='linkedin' AND sent_at >= datetime('now','-7 days')")
}

fn count_sent(where_clause: &str) -> u32 {
    crate::db::open()
        .ok()
        .and_then(|c| {
            c.query_row(
                &format!("SELECT COUNT(*) FROM outreach WHERE {where_clause}"),
                [],
                |r| r.get(0),
            )
            .ok()
        })
        .unwrap_or(0)
}

/// Capture the machine's local UTC offset ONCE, while the process is still single-threaded.
/// MUST be called from `main` BEFORE the tokio runtime is built: the `time` crate refuses to read
/// the local offset once other threads exist (a soundness guard), which is exactly why the old
/// `now_local()`-in-`local_hour()` approach always failed under the multi-threaded runtime and
/// left the daytime-window gate inert. Idempotent; only the first successful capture wins. If the
/// lookup fails, the offset stays unset and `local_hour` falls back to real UTC (offset 0).
pub fn capture_local_offset() {
    if let Ok(off) = time::UtcOffset::current_local_offset() {
        let _ = LOCAL_OFFSET.set(off);
    }
}

/// Local hour (0..24) for the LinkedIn daytime-window gate. Uses the offset captured at process
/// start (`capture_local_offset`); if that capture failed, falls back to the real UTC hour
/// (offset 0) rather than a hardcoded noon — so the window still gates on a real wall clock.
fn local_hour() -> u32 {
    let offset = LOCAL_OFFSET.get().copied().unwrap_or(time::UtcOffset::UTC);
    time::OffsetDateTime::now_utc().to_offset(offset).hour() as u32
}

/// SEND for real. Refuses unless the human enabled `auto_send`; enforces the per-day cap; sends
/// via SMTP (app-password) or the Gmail API (OAuth); marks the row `sent`. Returns a status line.
pub async fn send(domain: &str, d: &Draft) -> Result<String> {
    if std::env::var("COLDTRAIL_NO_SEND").is_ok() {
        return Err(anyhow!("dry run: sending is disabled for this run"));
    }
    if d.channel == "linkedin" {
        let cfg = crate::config::load();
        let hour = local_hour();
        let browser = crate::linkedin::browser::ChromeBrowser::new()?;
        return crate::linkedin::send::deliver(domain, d, &browser, &cfg, hour).await;
    }
    let cfg = crate::config::load();
    if !cfg.auto_send {
        return Err(anyhow!(
            "auto-send is off — the human must enable it in Settings → Destination first. \
             Leave the draft for them to send from the Drafts tab."
        ));
    }
    let cap = cfg
        .daily_send_cap
        .unwrap_or(crate::config::DEFAULT_DAILY_SEND_CAP);
    let n = sent_today();
    if n >= cap {
        return Err(anyhow!(
            "daily send cap reached ({n}/{cap}) — stop for today; the rest can go out tomorrow \
             (or the human can raise the cap in Settings)"
        ));
    }
    if let Some((email, pw)) = crate::secrets::gmail_app_password() {
        let mime = crate::gmail::mime_message(&d.to, &d.subject, &d.body);
        crate::smtp::send(&email, &pw, &d.to, &mime).await?;
    } else {
        let (token, quota) = crate::gmail::token().await?;
        crate::gmail::send_message(&token, quota.as_deref(), &d.to, &d.subject, &d.body).await?;
    }
    crate::mark::run(domain, "sent")?; // status='sent', sent_at=now
    Ok(format!("sent to {} ({}/{cap} today)", d.to, n + 1))
}

/// CLI entry: `coldtrail send <domain>` — send a reviewed draft (requires auto-send on).
pub async fn run(domain: &str) -> Result<()> {
    crate::db::init()?;
    let domain = domain.trim().to_lowercase();
    let d = reviewable(&domain)?;
    let msg = send(&domain, &d).await?;
    println!("{domain}: {msg}");
    Ok(())
}

/// Pending LinkedIn drafts eligible for the sequential bulk sender (`send_pending`): outreach rows
/// still `draft_pending`/`drafted` on the `linkedin` channel whose company has a contact with a
/// `linkedin_url` on file — the same recipient rule `reviewable` enforces, checked up front here so
/// the bulk loop never queues a domain it can't actually send — and not parked (`auto_skip`, set by
/// `linkedin::send` when LinkedIn demands the member's email or after `MAX_AUTO_FAILURES` failed
/// drives), so an unsendable draft isn't retried on every run. Oldest-drafted first, so a bulk run
/// works the queue in the order the drafts were created. `limit` bounds how many domains are
/// fetched (`None` = no bound); it is the same knob as the CLI's `max` argument, so passing it
/// through to the query (rather than the loop) keeps "how many to attempt" and "how many exist" in
/// one place.
pub fn pending_linkedin_domains(limit: Option<usize>) -> Result<Vec<String>> {
    let c = crate::db::open()?;
    let lim = limit.map(|n| n as i64).unwrap_or(i64::MAX);
    let mut stmt = c.prepare(
        "SELECT o.domain FROM outreach o JOIN contacts k ON k.id = o.contact_id \
         WHERE COALESCE(o.channel,'email')='linkedin' AND o.status IN ('draft_pending','drafted') \
           AND k.linkedin_url IS NOT NULL AND o.auto_skip IS NULL \
         GROUP BY o.domain ORDER BY MIN(o.created_at) ASC LIMIT ?1",
    )?;
    let rows = stmt
        .query_map([lim], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Whether a `send` error on the `linkedin` channel is a GLOBAL gate — one that every remaining
/// domain in the queue would hit identically (auto-send off, a cap reached, outside the daytime
/// window, the profile lock busy, or the session needing reconnect) — as opposed to a
/// domain-specific failure (e.g. the invite itself failing on that one profile) that's worth
/// skipping past so one bad row can't wedge the whole run. Matched against the exact wording
/// `linkedin::send::deliver` uses for each gate.
fn is_linkedin_stopping_error(msg: &str) -> bool {
    msg.contains("cap reached")
        || msg.contains("auto-send is off")
        || msg.contains("sending window")
        || msg.contains("browser is busy")
        || msg.contains("reconnect")
        || msg.contains("dry run")
}

/// CLI entry: `coldtrail send-pending linkedin [max]` — the sequential, paced, cap-aware bulk
/// LinkedIn sender behind the Drafts "Send all" button on the LinkedIn/All tab
/// (`web::linkedin::send_all` spawns exactly one detached instance of this). Unlike email (which
/// the UI bulk-sends with one quick HTTP call per domain), LinkedIn drives a real browser per
/// invite and must never fire concurrently, so this loops `send` ONE AT A TIME — every gate in
/// `linkedin::send::deliver` (opt-in, weekly/daily caps, the daytime window, inter-invite pacing,
/// the one-Chrome-profile lock) still applies exactly as it does to a single `coldtrail send
/// <domain>`.
///
/// Stops the loop when: a global gate fails (a cap is reached, auto-send is off, outside the
/// sending window, the browser is busy, or the session needs reconnecting) — every domain still
/// queued would fail the same way, so there's nothing to gain by continuing; or the queue (bounded
/// by `max`, if given) is exhausted. A domain-specific failure is logged and skipped — its draft
/// stays `draft_pending` for a later attempt, up to `linkedin::send::MAX_AUTO_FAILURES` failures
/// before it's parked out of this queue — so one bad row can't wedge the whole run. ALWAYS
/// returns `Ok`: every stop condition here (including a cap reached) is a normal outcome for an
/// unattended bulk send, never a process failure.
pub async fn send_pending(channel: &str, max: Option<usize>) -> Result<()> {
    crate::db::init()?;
    if channel != "linkedin" {
        println!("send-pending: unsupported channel '{channel}' (only 'linkedin' is supported)");
        return Ok(());
    }
    let domains = pending_linkedin_domains(max)?;
    if domains.is_empty() {
        println!("send-pending linkedin: nothing pending.");
        return Ok(());
    }
    println!(
        "send-pending linkedin: {} pending draft(s) queued.",
        domains.len()
    );
    let mut sent = 0usize;
    let mut skipped = 0usize;
    let mut stop_reason: Option<String> = None;
    for domain in &domains {
        let d = match reviewable(domain) {
            Ok(d) => d,
            Err(e) => {
                println!("{domain}: skip (no longer reviewable: {e})");
                skipped += 1;
                continue;
            }
        };
        match send(domain, &d).await {
            Ok(msg) => {
                sent += 1;
                println!("{domain}: {msg}");
            }
            Err(e) => {
                let msg = e.to_string();
                if is_linkedin_stopping_error(&msg) {
                    println!("{domain}: {msg} — stopping.");
                    stop_reason = Some(msg);
                    break;
                }
                skipped += 1;
                println!("{domain}: failed, skipping ({msg})");
            }
        }
    }
    let reason = stop_reason.unwrap_or_else(|| "queue exhausted".to_string());
    println!(
        "send-pending linkedin: sent {sent}, skipped {skipped} of {} queued — stopped: {reason}",
        domains.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_hour_returns_a_real_wall_clock_hour() {
        // Safe to call anywhere; under the multi-threaded test runner the offset can't be read,
        // so this exercises the UTC fallback. Either way the result must be a valid 0..24 hour
        // derived from the real clock — never the old hardcoded noon.
        capture_local_offset();
        assert!(local_hour() < 24);
    }

    #[test]
    fn send_refuses_when_auto_send_off() {
        crate::testutil::with_home("ct-deliver-gate", |_| {
            crate::home::workspace().unwrap();
            // Fresh config → auto_send defaults off.
            let d = Draft {
                channel: "email".into(),
                to: "a@b.com".into(),
                subject: "hi".into(),
                body: "hello".into(),
            };
            let err = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(send("b.com", &d))
                .unwrap_err()
                .to_string();
            assert!(err.contains("auto-send is off"), "got: {err}");
        });
    }

    // The dry-run gate is the very first statement in `send`, so it fires before config/db
    // are touched at all — no workspace or auto_send setup needed here.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn no_send_env_blocks_send_even_before_config() {
        let _g = crate::testutil::env_guard();
        std::env::set_var("COLDTRAIL_NO_SEND", "1");
        let d = Draft {
            channel: "email".into(),
            to: "a@example.com".into(),
            subject: "s".into(),
            body: "b".into(),
        };
        let res = send("example.com", &d).await;
        std::env::remove_var("COLDTRAIL_NO_SEND");
        let err = res.unwrap_err().to_string();
        assert!(err.contains("dry run"), "got: {err}");
    }

    #[test]
    fn reviewable_linkedin_channel_returns_linkedin_url_as_to() {
        crate::testutil::with_home("ct-deliver-reviewable-li-ok", |_| {
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
            c.execute(
                "INSERT INTO outreach (domain, contact_id, channel, subject, body, status) \
                 VALUES ('acme.com', (SELECT id FROM contacts WHERE domain='acme.com'), \
                 'linkedin', '', 'Hi Jane', 'draft_pending')",
                [],
            )
            .unwrap();
            let d = reviewable("acme.com").unwrap();
            assert_eq!(d.channel, "linkedin");
            assert_eq!(d.to, "https://www.linkedin.com/in/janedoe");
            assert_eq!(d.body, "Hi Jane");
        });
    }

    #[test]
    fn reviewable_linkedin_channel_without_linkedin_url_errors() {
        crate::testutil::with_home("ct-deliver-reviewable-li-missing", |_| {
            crate::db::init().unwrap();
            let c = crate::db::open().unwrap();
            c.execute(
                "INSERT INTO companies (domain, source_query) VALUES ('acme.com','q')",
                [],
            )
            .unwrap();
            // Contact exists but has no linkedin_url (email-only).
            c.execute(
                "INSERT INTO contacts (domain, founder_name, email) \
                 VALUES ('acme.com','Jane','jane@acme.com')",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO outreach (domain, contact_id, channel, subject, body, status) \
                 VALUES ('acme.com', (SELECT id FROM contacts WHERE domain='acme.com'), \
                 'linkedin', '', 'Hi Jane', 'draft_pending')",
                [],
            )
            .unwrap();
            let err = reviewable("acme.com").unwrap_err().to_string();
            assert!(err.contains("no LinkedIn URL"), "got: {err}");
        });
    }

    #[test]
    fn linkedin_sent_today_counts_only_linkedin_today_and_sent_today_stays_email_only() {
        crate::testutil::with_home("ct-deliver-li-sent-today", |_| {
            crate::db::init().unwrap();
            let c = crate::db::open().unwrap();
            c.execute(
                "INSERT INTO companies (domain, source_query) VALUES ('a.com','q')",
                [],
            )
            .unwrap();
            // A linkedin send today, a linkedin send 10 days ago, and an email send today.
            c.execute(
                "INSERT INTO outreach (domain, channel, status, sent_at) \
                 VALUES ('a.com','linkedin','sent', datetime('now'))",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO outreach (domain, channel, status, sent_at) \
                 VALUES ('a.com','linkedin','sent', datetime('now','-10 days'))",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO outreach (domain, channel, status, sent_at) \
                 VALUES ('a.com','email','sent', datetime('now'))",
                [],
            )
            .unwrap();
            assert_eq!(linkedin_sent_today(), 1);
            // Email-only counter must not pick up the linkedin row sent today.
            assert_eq!(sent_today(), 1);
        });
    }

    #[test]
    fn linkedin_sent_last_7d_counts_trailing_week_only() {
        crate::testutil::with_home("ct-deliver-li-sent-7d", |_| {
            crate::db::init().unwrap();
            let c = crate::db::open().unwrap();
            c.execute(
                "INSERT INTO companies (domain, source_query) VALUES ('a.com','q')",
                [],
            )
            .unwrap();
            // Inside the trailing 7 days: today and 3 days ago. Outside: 10 days ago.
            c.execute(
                "INSERT INTO outreach (domain, channel, status, sent_at) \
                 VALUES ('a.com','linkedin','sent', datetime('now'))",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO outreach (domain, channel, status, sent_at) \
                 VALUES ('a.com','linkedin','sent', datetime('now','-3 days'))",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO outreach (domain, channel, status, sent_at) \
                 VALUES ('a.com','linkedin','sent', datetime('now','-10 days'))",
                [],
            )
            .unwrap();
            assert_eq!(linkedin_sent_last_7d(), 2);
        });
    }

    #[test]
    fn is_linkedin_stopping_error_matches_global_gates_only() {
        assert!(is_linkedin_stopping_error(
            "weekly LinkedIn cap reached (40/40)"
        ));
        assert!(is_linkedin_stopping_error(
            "daily LinkedIn cap reached (10/10)"
        ));
        assert!(is_linkedin_stopping_error(
            "LinkedIn auto-send is off — open it from the Drafts tab"
        ));
        assert!(is_linkedin_stopping_error(
            "outside the LinkedIn sending window (08:00-20:00 local) — deferring"
        ));
        assert!(is_linkedin_stopping_error(
            "LinkedIn browser is busy — try again in a moment"
        ));
        assert!(is_linkedin_stopping_error(
            "LinkedIn session expired — reconnect needed; stopping"
        ));
        // A domain-specific failure must NOT stop the loop — it should be skipped instead.
        assert!(!is_linkedin_stopping_error(
            "LinkedIn invite failed: connect button not found"
        ));
    }

    #[test]
    fn pending_linkedin_domains_requires_linkedin_url_and_orders_oldest_first() {
        crate::testutil::with_home("ct-deliver-pending-li", |_| {
            crate::db::init().unwrap();
            let c = crate::db::open().unwrap();
            c.execute(
                "INSERT INTO companies (domain, source_query) VALUES ('a.com','q'), ('b.com','q'), ('c.com','q')",
                [],
            )
            .unwrap();
            // a.com: linkedin contact + pending linkedin draft, created first (oldest).
            c.execute(
                "INSERT INTO contacts (domain, founder_name, linkedin_url) \
                 VALUES ('a.com','Jane','https://www.linkedin.com/in/janedoe')",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO outreach (domain, contact_id, channel, subject, body, status, created_at) \
                 VALUES ('a.com', (SELECT id FROM contacts WHERE domain='a.com'), \
                 'linkedin', '', 'Hi Jane', 'draft_pending', datetime('now','-2 hours'))",
                [],
            )
            .unwrap();
            // b.com: linkedin contact + pending linkedin draft, created after a.com.
            c.execute(
                "INSERT INTO contacts (domain, founder_name, linkedin_url) \
                 VALUES ('b.com','Bob','https://www.linkedin.com/in/bobsmith')",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO outreach (domain, contact_id, channel, subject, body, status, created_at) \
                 VALUES ('b.com', (SELECT id FROM contacts WHERE domain='b.com'), \
                 'linkedin', '', 'Hi Bob', 'draft_pending', datetime('now','-1 hours'))",
                [],
            )
            .unwrap();
            // c.com: a pending linkedin draft but NO linkedin_url on its contact — must be excluded.
            c.execute(
                "INSERT INTO contacts (domain, founder_name, email) VALUES ('c.com','Carl','carl@c.com')",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO outreach (domain, contact_id, channel, subject, body, status) \
                 VALUES ('c.com', (SELECT id FROM contacts WHERE domain='c.com'), \
                 'linkedin', '', 'Hi Carl', 'draft_pending')",
                [],
            )
            .unwrap();

            let domains = pending_linkedin_domains(None).unwrap();
            assert_eq!(domains, vec!["a.com".to_string(), "b.com".to_string()]);

            // `limit` bounds how many are fetched.
            let limited = pending_linkedin_domains(Some(1)).unwrap();
            assert_eq!(limited, vec!["a.com".to_string()]);
        });
    }

    #[test]
    fn send_pending_rejects_non_linkedin_channel_without_touching_the_db() {
        // No `with_home`/`db::init` here on purpose: an unsupported channel must return before
        // ever touching the database, so this must not panic even with no workspace set up.
        let res = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(send_pending("email", None));
        assert!(res.is_ok());
    }

    #[test]
    fn send_pending_stops_immediately_when_auto_send_off() {
        crate::testutil::with_home("ct-deliver-send-pending-off", |_| {
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
            c.execute(
                "INSERT INTO outreach (domain, contact_id, channel, subject, body, status) \
                 VALUES ('acme.com', (SELECT id FROM contacts WHERE domain='acme.com'), \
                 'linkedin', '', 'Hi Jane', 'draft_pending')",
                [],
            )
            .unwrap();
            // Fresh config → linkedin_auto_send defaults off, so the very first `send` call hits
            // the global "auto-send is off" gate and the loop must stop (not retry/panic/loop).
            let res = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(send_pending("linkedin", None));
            assert!(res.is_ok());
            // The row is untouched (still draft_pending) since the gate ran before any send.
            let status: String = c
                .query_row(
                    "SELECT status FROM outreach WHERE domain='acme.com'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(status, "draft_pending");
        });
    }
}
