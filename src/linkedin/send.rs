//! LinkedIn auto-send: gate order mirrors email, all gates run BEFORE any browser work, so the
//! logic is unit-testable with a FakeBrowser. Assist does NOT go through here (it is human-
//! authorized and cap-free — see the web assist handler).

use anyhow::{anyhow, Result};

use crate::config::{Config, DEFAULT_LINKEDIN_DAILY_CAP, DEFAULT_LINKEDIN_WEEKLY_CAP};
use crate::deliver::Draft;
use crate::linkedin::browser::{InviteOutcome, LinkedInBrowser, SendMode};

/// Daytime sending window (local hour, 24h). Bursts/off-hours are detection signals.
pub fn within_window(hour: u32) -> bool {
    (8..20).contains(&hour)
}

/// Mark this domain's LinkedIn invite as sent, scoped to the `linkedin` channel so a same-domain
/// row on another channel (e.g. an email follow-up created by `draft::followup_add`) is never
/// false-marked. Mirrors the company-status bump the email path does via `mark::run`. Shared by
/// the auto path (`deliver` below) and the web assist `confirm` route.
pub fn mark_linkedin_sent(domain: &str) -> anyhow::Result<()> {
    let conn = crate::db::open()?;
    conn.execute(
        "UPDATE outreach SET status='sent', sent_at=datetime('now') \
         WHERE domain=?1 AND channel='linkedin' AND status IN ('draft_pending','drafted')",
        [domain],
    )?;
    crate::db::set_status(&conn, domain, "sent")?;
    Ok(())
}

/// Deliver one LinkedIn invite via the gated auto path. Browser + local hour injected for tests.
pub async fn deliver(
    domain: &str,
    d: &Draft,
    b: &dyn LinkedInBrowser,
    cfg: &Config,
    hour_local: u32,
) -> Result<String> {
    // Gate 1 (COLDTRAIL_NO_SEND) is enforced by the caller deliver::send before this runs.
    // Gate 2: opt-in.
    if !cfg.linkedin_auto_send {
        return Err(anyhow!(
            "LinkedIn auto-send is off — open it from the Drafts tab to send it yourself."
        ));
    }
    // Gate 3/4: caps.
    let weekly = cfg
        .linkedin_weekly_cap
        .unwrap_or(DEFAULT_LINKEDIN_WEEKLY_CAP);
    let w = crate::deliver::linkedin_sent_last_7d();
    if w >= weekly {
        return Err(anyhow!(
            "weekly LinkedIn cap reached ({w}/{weekly}) — resume later this week"
        ));
    }
    let daily = cfg.linkedin_daily_cap.unwrap_or(DEFAULT_LINKEDIN_DAILY_CAP);
    let day = crate::deliver::linkedin_sent_today();
    if day >= daily {
        return Err(anyhow!(
            "daily LinkedIn cap reached ({day}/{daily}) — resume tomorrow"
        ));
    }
    // Gate 5: daytime window.
    if !within_window(hour_local) {
        return Err(anyhow!(
            "outside the LinkedIn sending window (08:00–20:00 local) — deferring"
        ));
    }
    // Gate 6: one Chrome per profile.
    let _lock = crate::linkedin::lock::try_acquire()?
        .ok_or_else(|| anyhow!("LinkedIn browser is busy — try again in a moment"))?;

    match b
        .send_connection_request(&d.to, &d.body, SendMode::Auto)
        .await?
    {
        InviteOutcome::Sent => {
            mark_linkedin_sent(domain)?;
            Ok(format!(
                "invited {} on LinkedIn ({}/{daily} today)",
                d.to,
                day + 1
            ))
        }
        InviteOutcome::LoggedOut => {
            let mut s = crate::linkedin::LinkedinState::load();
            s.reconnect_needed = true;
            s.save().ok();
            Err(anyhow!(
                "LinkedIn session expired — reconnect needed; stopping"
            ))
        }
        InviteOutcome::Failed(reason) => Err(anyhow!("LinkedIn invite failed: {reason}")),
        InviteOutcome::Staged => Err(anyhow!("unexpected Staged outcome from an Auto send")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linkedin::browser::{FakeBrowser, LoginOutcome};

    fn li_draft() -> Draft {
        Draft {
            channel: "linkedin".into(),
            to: "https://www.linkedin.com/in/janedoe".into(),
            subject: String::new(),
            body: "Hi Jane".into(),
        }
    }
    fn cfg_on() -> Config {
        Config {
            linkedin_auto_send: true,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn refuses_when_auto_off() {
        crate::testutil::with_home("ct-lisend-off", |_| {});
        let b = FakeBrowser::default();
        let err = deliver("acme.com", &li_draft(), &b, &Config::default(), 10)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("LinkedIn auto-send is off"), "got: {err}");
    }

    #[tokio::test]
    async fn refuses_outside_window() {
        let b = FakeBrowser::default();
        let err = deliver("acme.com", &li_draft(), &b, &cfg_on(), 23)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("window"), "got: {err}");
    }

    // `deliver` on the LoggedOut/Sent paths touches the on-disk profile lock, LinkedinState, and
    // the outreach db, all resolved from `COLDTRAIL_HOME` — which `with_home` only sets for the
    // duration of its (synchronous) closure. So the async `deliver` call and the post-call
    // assertions must run INSIDE the closure too (blocked on a throwaway runtime, matching the
    // `#[test]` + `Runtime::new().block_on` idiom used elsewhere in this codebase, e.g.
    // `deliver::tests::send_refuses_when_auto_send_off`) — otherwise they'd silently fall back to
    // the real `~/.coldtrail` / OS config dir instead of the sandboxed test home.
    #[test]
    fn logged_out_sets_reconnect_and_errors() {
        crate::testutil::with_home("ct-lisend-out", |_| {
            crate::db::init().unwrap();
            let b = FakeBrowser {
                invite: InviteOutcome::LoggedOut,
                ..Default::default()
            };
            let err = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(deliver("acme.com", &li_draft(), &b, &cfg_on(), 10))
                .unwrap_err()
                .to_string();
            assert!(err.contains("reconnect"), "got: {err}");
            assert!(crate::linkedin::LinkedinState::load().reconnect_needed);
        });
        // login field only matters for the connect flow; silence unused warnings deterministically
        let _ = LoginOutcome::LoggedIn;
    }

    #[test]
    fn linkedin_mark_is_channel_scoped_and_spares_same_domain_email_row() {
        crate::testutil::with_home("ct-lisend-mark-scope", |_| {
            crate::db::init().unwrap();
            let c = crate::db::open().unwrap();
            c.execute(
                "INSERT INTO companies (domain, source_query) VALUES ('acme.com','q')",
                [],
            )
            .unwrap();
            // Same domain, two channels: a LinkedIn invite draft AND an email follow-up draft.
            c.execute(
                "INSERT INTO outreach (domain, channel, subject, body, status) \
                 VALUES ('acme.com','linkedin','','Hi Jane','draft_pending')",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO outreach (domain, channel, subject, body, status) \
                 VALUES ('acme.com','email','Re: hi','following up','draft_pending')",
                [],
            )
            .unwrap();

            mark_linkedin_sent("acme.com").unwrap();

            let li: String = c
                .query_row(
                    "SELECT status FROM outreach WHERE domain='acme.com' AND channel='linkedin'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let em: String = c
                .query_row(
                    "SELECT status FROM outreach WHERE domain='acme.com' AND channel='email'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            // The LinkedIn row is sent; the email follow-up row is left untouched.
            assert_eq!(li, "sent");
            assert_eq!(em, "draft_pending", "email row must NOT be false-marked");
        });
    }

    #[test]
    fn success_marks_sent() {
        crate::testutil::with_home("ct-lisend-ok", |_| {
            crate::db::init().unwrap();
            let c = crate::db::open().unwrap();
            c.execute(
                "INSERT INTO companies (domain, source_query) VALUES ('acme.com','q')",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO contacts (domain, linkedin_url) VALUES ('acme.com','https://www.linkedin.com/in/janedoe')",
                [],
            ).unwrap();
            c.execute(
                "INSERT INTO outreach (domain, channel, subject, body, status) \
                 VALUES ('acme.com','linkedin','','Hi Jane','draft_pending')",
                [],
            )
            .unwrap();

            let b = FakeBrowser::default();
            let msg = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(deliver("acme.com", &li_draft(), &b, &cfg_on(), 10))
                .unwrap();
            assert!(msg.contains("invited"), "got: {msg}");
            let status: String = crate::db::open()
                .unwrap()
                .query_row(
                    "SELECT status FROM outreach WHERE domain='acme.com'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(status, "sent");
        });
    }
}
