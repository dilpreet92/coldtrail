//! `/api/destination/linkedin/*` + `/api/drafts/:domain/linkedin/*` — the LinkedIn destination's
//! web routes: connect (drives a real, human-visible Chrome login), status, disconnect, the
//! auto-send toggle, and the per-draft assist/confirm pair. Mirrors `onboarding.rs`'s Gmail
//! destination handlers and `schedules.rs`'s bare-JSON response style. The gated/capped auto-send
//! path lives in `linkedin::send` and is reached only via `deliver::send` (the CLI / scheduled
//! runs / the Drafts "auto" branch) — assist here is human-authorized and deliberately separate.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use super::{ApiErr, AppState};
use crate::linkedin::browser::{
    ChromeBrowser, InviteOutcome, LinkedInBrowser, LoginOutcome, SendMode,
};
use crate::linkedin::{lock, LinkedinState};

/// `POST /api/destination/linkedin/connect` — launch a fresh, human-visible Chrome window at the
/// LinkedIn login page and wait (off the request) for the human to finish logging in. Returns
/// immediately with `{"status":"waiting"}`; the spawned task OWNS the profile lock for its whole
/// lifetime, so the browser's lifetime == the lock's lifetime, and `status` can report `waiting`
/// in the meantime via the `AppState` flag.
pub async fn connect(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, ApiErr> {
    let Some(guard) = lock::try_acquire()? else {
        return Ok(Json(serde_json::json!({ "status": "busy" })));
    };
    state.linkedin_connecting.store(true, Ordering::SeqCst);
    let waiting = state.clone();
    tokio::spawn(async move {
        // Owns the lock for the task's lifetime — dropped (releasing it) whenever this task
        // ends, however it ends (LoggedIn, TimedOut, WindowClosed, or a launch error).
        let _lock = guard;
        // Resets `waiting` on drop rather than a plain store at the end of the task body, so a
        // panic mid-connect can't leave the status endpoint reporting `waiting:true` forever.
        let _reset = WaitingGuard(waiting);
        let outcome = match ChromeBrowser::new() {
            Ok(browser) => browser.connect_and_wait_for_login(180).await,
            Err(e) => Err(e),
        };
        if matches!(outcome, Ok(LoginOutcome::LoggedIn)) {
            let _ = LinkedinState {
                connected: true,
                reconnect_needed: false,
            }
            .save();
        }
        // TimedOut / WindowClosed / a launch error: leave the persisted state as it was.
    });
    Ok(Json(serde_json::json!({ "status": "waiting" })))
}

/// Flips `AppState::linkedin_connecting` back to false when the connect task ends, on every
/// path (including a panic) — see `connect`.
struct WaitingGuard(Arc<AppState>);
impl Drop for WaitingGuard {
    fn drop(&mut self) {
        self.0.linkedin_connecting.store(false, Ordering::SeqCst);
    }
}

/// `GET /api/destination/linkedin/status` — the persisted connect state plus whether a `connect`
/// is currently in flight. `waiting` comes from `AppState` (not a lock probe) so it can't be
/// confused with an unrelated assist/auto-send drive holding the same profile lock.
pub async fn status(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>, ApiErr> {
    let s = LinkedinState::load();
    Ok(Json(serde_json::json!({
        "connected": s.connected,
        "reconnect_needed": s.reconnect_needed,
        "waiting": state.linkedin_connecting.load(Ordering::SeqCst),
    })))
}

/// `POST /api/destination/linkedin/disconnect` — forget the persisted connect state. The Chrome
/// profile on disk (cookies etc.) is left alone; only coldtrail's own "connected" bookkeeping is
/// cleared, so a fresh Connect click starts from a clean status even if a session cookie lingers.
pub async fn disconnect() -> Result<Json<serde_json::Value>, ApiErr> {
    LinkedinState::clear()?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Opt into (or out of) LinkedIn auto-send, and set the weekly/daily caps. Separate from the
/// email `auto_send` toggle (`onboarding::set_auto_send`) — a human can enable one channel
/// without the other.
#[derive(Deserialize)]
pub struct AutoSendReq {
    pub enabled: bool,
    pub weekly_cap: Option<u32>,
    pub daily_cap: Option<u32>,
}

/// `POST /api/destination/linkedin/auto-send`.
pub async fn set_auto_send(
    Json(req): Json<AutoSendReq>,
) -> Result<Json<serde_json::Value>, ApiErr> {
    let mut c = crate::config::load();
    c.linkedin_auto_send = req.enabled;
    if let Some(cap) = req.weekly_cap {
        c.linkedin_weekly_cap = Some(cap.max(1));
    }
    if let Some(cap) = req.daily_cap {
        c.linkedin_daily_cap = Some(cap.max(1));
    }
    crate::config::save(&c)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// `POST /api/drafts/:domain/linkedin/assist` — drive Connect -> Add note -> fill the note in a
/// real (human-visible) Chrome window, then stop with the modal open for the human to click Send
/// themselves. The channel check runs BEFORE the lock/browser are touched at all, so calling this
/// on an email draft — or a domain with no reviewable draft at all — never launches Chrome.
pub async fn assist(Path(domain): Path<String>) -> Result<Response, ApiErr> {
    let domain = domain.to_lowercase();
    let d = crate::deliver::reviewable(&domain)?;
    if d.channel != "linkedin" {
        return Ok((StatusCode::BAD_REQUEST, "not a LinkedIn draft").into_response());
    }
    let Some(_lock) = lock::try_acquire()? else {
        return Ok((
            StatusCode::CONFLICT,
            "LinkedIn browser is busy — try again in a moment",
        )
            .into_response());
    };
    let browser = ChromeBrowser::new()?;
    let outcome = browser
        .send_connection_request(&d.to, &d.body, SendMode::Assist)
        .await?;
    // `_lock` releases right here, when the function returns: assist only holds Chrome for the
    // drive itself. The human then acts in the window it left open, and the result comes back
    // via `confirm` (below), not by holding the browser lock across an unbounded human pause.
    Ok(match outcome {
        InviteOutcome::Staged => Json(serde_json::json!({ "staged": true })).into_response(),
        InviteOutcome::LoggedOut => {
            let mut s = LinkedinState::load();
            s.reconnect_needed = true;
            let _ = s.save();
            (
                StatusCode::CONFLICT,
                "LinkedIn session expired — reconnect from Destination settings",
            )
                .into_response()
        }
        InviteOutcome::Failed(reason) => {
            (StatusCode::INTERNAL_SERVER_ERROR, reason).into_response()
        }
        // Assist never clicks Send, so a real driver should never report this — treat it as a
        // hard failure rather than silently claiming success.
        InviteOutcome::Sent => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "unexpected: an Assist drive reported Sent".to_string(),
        )
            .into_response(),
    })
}

/// `sent:true` — the human clicked Send in the staged window. `sent:false` — they closed it
/// without sending; the draft stays `draft_pending` for another attempt.
#[derive(Deserialize)]
pub struct ConfirmReq {
    pub sent: bool,
}

/// `POST /api/drafts/:domain/linkedin/confirm`.
pub async fn confirm(
    Path(domain): Path<String>,
    Json(req): Json<ConfirmReq>,
) -> Result<Json<serde_json::Value>, ApiErr> {
    let domain = domain.to_lowercase();
    if req.sent {
        // Same UPDATE the auto path uses (`linkedin::send::deliver`) — one outreach row per
        // domain makes a domain-scoped mark safe for the linkedin channel too.
        crate::mark::run(&domain, "sent")?;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::AtomicBool;
    use tokio::sync::Mutex;

    fn state() -> Arc<AppState> {
        Arc::new(AppState {
            token: "t".into(),
            port: 0,
            runs: Mutex::new(HashMap::new()),
            chat: Mutex::new(super::super::ChatSession::default()),
            turn_lock: Mutex::new(()),
            linkedin_connecting: AtomicBool::new(false),
        })
    }

    #[test]
    fn set_auto_send_persists_to_config() {
        crate::testutil::with_home("ct-web-li-autosend", |_| {
            let req = AutoSendReq {
                enabled: true,
                weekly_cap: Some(40),
                daily_cap: Some(10),
            };
            let _ = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(set_auto_send(Json(req)))
                .unwrap();
            let cfg = crate::config::load();
            assert!(cfg.linkedin_auto_send);
            assert_eq!(cfg.linkedin_weekly_cap, Some(40));
            assert_eq!(cfg.linkedin_daily_cap, Some(10));
        });
    }

    #[test]
    fn status_reflects_linkedin_state() {
        crate::testutil::with_home("ct-web-li-status", |_| {
            LinkedinState {
                connected: true,
                reconnect_needed: true,
            }
            .save()
            .unwrap();
            let resp = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(status(State(state())))
                .unwrap();
            let v = resp.0;
            assert_eq!(v["connected"].as_bool(), Some(true));
            assert_eq!(v["reconnect_needed"].as_bool(), Some(true));
            assert_eq!(v["waiting"].as_bool(), Some(false));
        });
    }

    #[test]
    fn disconnect_clears_state() {
        crate::testutil::with_home("ct-web-li-disconnect", |_| {
            LinkedinState {
                connected: true,
                reconnect_needed: false,
            }
            .save()
            .unwrap();
            let _ = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(disconnect())
                .unwrap();
            assert!(!LinkedinState::load().connected);
        });
    }

    #[test]
    fn assist_rejects_non_linkedin_draft_without_touching_the_browser() {
        crate::testutil::with_home("ct-web-li-assist-email", |_| {
            crate::db::init().unwrap();
            let c = crate::db::open().unwrap();
            c.execute(
                "INSERT INTO companies (domain, source_query) VALUES ('acme.com','q')",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO contacts (domain, founder_name, email) \
                 VALUES ('acme.com','Jane','jane@acme.com')",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO outreach (domain, contact_id, channel, subject, body, status) \
                 VALUES ('acme.com', (SELECT id FROM contacts WHERE domain='acme.com'), \
                 'email', 'hi', 'body', 'draft_pending')",
                [],
            )
            .unwrap();
            let resp = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(assist(Path("acme.com".to_string())))
                .unwrap();
            // BAD_REQUEST (not a 500/panic) proves the channel check ran, and it necessarily ran
            // before any lock::try_acquire/ChromeBrowser call, since those sit later in the fn.
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        });
    }

    #[test]
    fn assist_on_missing_draft_errors_without_touching_the_browser() {
        crate::testutil::with_home("ct-web-li-assist-missing", |_| {
            crate::db::init().unwrap();
            let res = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(assist(Path("nowhere.com".to_string())));
            assert!(res.is_err());
        });
    }
}
