//! LinkedIn auto-send: gate order mirrors email, all gates run BEFORE any browser work, so the
//! logic is unit-testable with a FakeBrowser. Assist does NOT go through here (it is human-
//! authorized and cap-free — see the web assist handler).

use anyhow::{anyhow, Result};
use std::time::Duration;

use crate::config::{Config, DEFAULT_LINKEDIN_DAILY_CAP, DEFAULT_LINKEDIN_WEEKLY_CAP};
use crate::deliver::Draft;
use crate::linkedin::browser::{InviteOutcome, LinkedInBrowser, SendMode};

/// Daytime sending window (local hour, 24h). Bursts/off-hours are detection signals.
pub fn within_window(hour: u32) -> bool {
    (8..20).contains(&hour)
}

/// Inter-invite pacing bounds (seconds): every auto send waits until at least a randomized
/// target in this range has elapsed since the previous LinkedIn send, so a run trickles instead
/// of bursting (bursts are a detection signal).
const PACING_MIN_SECS: u64 = 45;
const PACING_MAX_SECS: u64 = 120;

/// Pure pacing math: how much longer to wait so that `target_secs` have elapsed since the last
/// send. `secs_since_last` is `None` when there is no prior LinkedIn send (→ no wait). A gap that
/// already meets/exceeds the target (or a negative/clock-skew value) also yields no wait.
pub fn remaining_pacing_delay(secs_since_last: Option<i64>, target_secs: u64) -> Duration {
    match secs_since_last {
        Some(s) if s >= 0 && (s as u64) < target_secs => {
            Duration::from_secs(target_secs - s as u64)
        }
        _ => Duration::ZERO,
    }
}

/// A randomized pacing target in `PACING_MIN_SECS..=PACING_MAX_SECS`. Jitter is derived from the
/// current time's sub-second nanos — good enough to de-correlate send timing without pulling in an
/// RNG crate. Runtime-only (not unit-tested); the deterministic math lives in
/// `remaining_pacing_delay`.
fn random_pacing_target() -> u64 {
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    PACING_MIN_SECS + jitter % (PACING_MAX_SECS - PACING_MIN_SECS + 1)
}

/// Whole seconds since the most recent `channel='linkedin'` send, or `None` if there is none.
/// Best-effort — a db error is treated as "no prior send" (no wait), never a hard failure.
fn secs_since_last_linkedin_send() -> Option<i64> {
    crate::db::open().ok().and_then(|c| {
        c.query_row(
            "SELECT CAST((julianday('now') - julianday(MAX(sent_at))) * 86400 AS INTEGER) \
             FROM outreach WHERE channel='linkedin' AND status='sent' AND sent_at IS NOT NULL",
            [],
            |r| r.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
    })
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
    // Pacing: trickle sends so a run doesn't burst. Sleep the remaining time until a randomized
    // minimum gap since the last LinkedIn send has elapsed. Done BEFORE taking the profile lock so
    // the (up-to-2-minute) sleep doesn't hold the lock. Auto-send runs in the run subprocess, so
    // sleeping here is fine; the human-authorized assist path never reaches this function.
    let wait = remaining_pacing_delay(secs_since_last_linkedin_send(), random_pacing_target());
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
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

    #[test]
    fn pacing_delay_waits_only_the_remaining_gap() {
        // 30s elapsed, 100s target → wait the remaining 70s.
        assert_eq!(
            remaining_pacing_delay(Some(30), 100),
            Duration::from_secs(70)
        );
        // Gap already meets the target → no wait.
        assert_eq!(remaining_pacing_delay(Some(100), 100), Duration::ZERO);
        // Gap exceeds the target → no wait.
        assert_eq!(remaining_pacing_delay(Some(500), 100), Duration::ZERO);
        // No prior send → no wait.
        assert_eq!(remaining_pacing_delay(None, 100), Duration::ZERO);
        // Clock skew (negative) → no wait, never a panic/overflow.
        assert_eq!(remaining_pacing_delay(Some(-5), 100), Duration::ZERO);
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
