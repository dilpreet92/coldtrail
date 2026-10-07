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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::{ApiErr, AppState};
use crate::linkedin::browser::{
    AssistError, AssistSession, ChromeBrowser, LinkedInBrowser, LoginOutcome,
};
use crate::linkedin::{lock, LinkedinState};

/// One live assist window plus everything it owns for its lifetime: the pre-Send Chrome session
/// and the profile lock (held so no other connect/assist/auto op can launch on the profile until
/// this window closes). Parked in `AppState::assist` between `assist` and `confirm`/timeout.
pub struct AssistHandle {
    session: AssistSession,
    /// Profile lock, released when this handle is dropped/closed. Held for effect, never read.
    #[allow(dead_code)]
    _lock: lock::ProfileLock,
    /// The draft domain this window is staging, so `confirm` closes the right one.
    domain: String,
    /// Monotonic identity so the timeout task only closes the window it itself opened — not a
    /// newer one that replaced it in the slot.
    id: u64,
}

/// Hands out the monotonic `AssistHandle::id`.
static ASSIST_SEQ: AtomicU64 = AtomicU64::new(0);

/// How long a staged assist window stays open waiting for the human before it is auto-closed.
const ASSIST_TIMEOUT: Duration = Duration::from_secs(300);

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
        // Off-request task, so a launch/login failure (e.g. no Chrome installed) can't surface to
        // the caller — log it so it's at least visible in the server log instead of vanishing.
        if let Err(e) = &outcome {
            eprintln!("linkedin connect: launch/login failed: {e}");
        }
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
/// real (human-visible) Chrome window, then LEAVE it open with the modal staged for the human to
/// review and click Send themselves. The channel check runs BEFORE the lock/browser are touched
/// at all, so calling this on an email draft — or a domain with no reviewable draft — never
/// launches Chrome.
///
/// Unlike the old behavior, the window is NOT closed when this returns: the live session (plus the
/// profile lock) is parked in `AppState::assist` and stays alive until `confirm` marks the result
/// or a timeout fires — which is what makes the human-review-then-Send flow actually work. The
/// profile lock is therefore held for the window's whole lifetime, so no other connect/assist/auto
/// op can launch on the profile in the meantime.
pub async fn assist(
    State(state): State<Arc<AppState>>,
    Path(domain): Path<String>,
) -> Result<Response, ApiErr> {
    let domain = domain.to_lowercase();
    let d = crate::deliver::reviewable(&domain)?;
    if d.channel != "linkedin" {
        return Ok((StatusCode::BAD_REQUEST, "not a LinkedIn draft").into_response());
    }
    let Some(lock) = lock::try_acquire()? else {
        return Ok((
            StatusCode::CONFLICT,
            "LinkedIn browser is busy — try again in a moment",
        )
            .into_response());
    };
    let browser = ChromeBrowser::new()?;
    match browser.assist_open(&d.to, &d.body).await {
        Ok(session) => {
            // Move the live window + the profile lock into the shared slot. `lock` is consumed
            // here, so it now lives exactly as long as the window (until confirm/timeout closes).
            let id = ASSIST_SEQ.fetch_add(1, Ordering::SeqCst);
            let handle = AssistHandle {
                session,
                _lock: lock,
                domain: domain.clone(),
                id,
            };
            {
                let mut slot = state.assist.lock().await;
                // Only one window at a time: close any previous occupant before parking this one.
                if let Some(prev) = slot.take() {
                    prev.session.close().await;
                }
                *slot = Some(handle);
            }
            // Timeout guard: close + clear the slot after ASSIST_TIMEOUT if it is STILL this same
            // window (identity check via `id`), so a human who never clicks Send can't leak a
            // Chrome process or pin the profile lock forever. Racing `confirm` is safe — whichever
            // takes the slot first wins; the loser sees it empty or holding a different id.
            let assist_slot = state.assist.clone();
            tokio::spawn(async move {
                tokio::time::sleep(ASSIST_TIMEOUT).await;
                let taken = {
                    let mut slot = assist_slot.lock().await;
                    if slot.as_ref().map(|h| h.id) == Some(id) {
                        slot.take()
                    } else {
                        None
                    }
                };
                if let Some(h) = taken {
                    h.session.close().await;
                }
            });
            Ok(Json(serde_json::json!({ "staged": true })).into_response())
        }
        // assist_open already closed the window on every error path; `lock` drops when this
        // function returns, releasing the profile lock.
        Err(AssistError::LoggedOut) => {
            let mut s = LinkedinState::load();
            s.reconnect_needed = true;
            let _ = s.save();
            Ok((
                StatusCode::CONFLICT,
                "LinkedIn session expired — reconnect from Destination settings",
            )
                .into_response())
        }
        // An earlier invite is still Pending on their profile — record it as sent, nothing to open.
        Err(AssistError::AlreadyInvited) => {
            crate::linkedin::send::mark_linkedin_sent(&domain)?;
            Ok(Json(serde_json::json!({ "already_invited": true })).into_response())
        }
        Err(AssistError::Failed(reason)) => {
            Ok((StatusCode::INTERNAL_SERVER_ERROR, reason).into_response())
        }
    }
}

/// `sent:true` — the human clicked Send in the staged window. `sent:false` — they closed it
/// without sending; the draft stays `draft_pending` for another attempt.
#[derive(Deserialize)]
pub struct ConfirmReq {
    pub sent: bool,
}

/// `POST /api/drafts/:domain/linkedin/confirm`.
pub async fn confirm(
    State(state): State<Arc<AppState>>,
    Path(domain): Path<String>,
    Json(req): Json<ConfirmReq>,
) -> Result<Json<serde_json::Value>, ApiErr> {
    let domain = domain.to_lowercase();
    if req.sent {
        // Channel-scoped mark (same helper the auto path uses): a domain can carry a separate
        // email row (e.g. a follow-up), so a domain-wide UPDATE would false-mark it.
        crate::linkedin::send::mark_linkedin_sent(&domain)?;
    }
    // Close the live assist window this domain left open, dropping the profile lock with it.
    // Idempotent: the timeout may have already cleared the slot, or there may be none — in which
    // case we just recorded the mark and return. The identity check is by domain so we never
    // close a window a later assist opened for a different draft.
    let taken = {
        let mut slot = state.assist.lock().await;
        match slot.as_ref() {
            Some(h) if h.domain == domain => slot.take(),
            _ => None,
        }
    };
    if let Some(h) = taken {
        h.session.close().await;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// `POST /api/drafts/:domain/linkedin/send` — the AUTO counterpart to `assist`: when LinkedIn
/// auto-send is ON, actually drive Connect -> Add note -> Send (and mark the row sent on success)
/// rather than leaving the Send click to the human. The Drafts "Send" button on a LinkedIn row.
///
/// Like `schedules::run_now`, this SPAWNS A DETACHED `coldtrail send <domain>` subprocess instead
/// of sending in-process. `coldtrail send` routes a linkedin-channel draft through `deliver::send`
/// -> the gated `linkedin::send::deliver` auto path (opt-in + weekly/daily caps + daytime window +
/// inter-invite pacing + the one-Chrome-per-profile lock), which drives a real headful browser and
/// can sleep for up to two minutes pacing before it even launches Chrome — work that must not block
/// the axum handler. A subprocess also keeps this off the server's process-global env (the same
/// reason run_now uses one) and is reaped by a background task while the handler returns at once.
/// The channel + opt-in checks run HERE first so we never spawn a send for an email draft, a domain
/// with no reviewable draft, or when auto-send is off. This does NOT set `COLDTRAIL_NO_SEND`: it is
/// a real send. `deliver::send`'s linkedin branch still enforces every gate, so this can't send
/// outside the caps/window even though the button skips the human confirm.
pub async fn send(
    State(_state): State<Arc<AppState>>,
    Path(domain): Path<String>,
) -> Result<Response, ApiErr> {
    let domain = domain.to_lowercase();
    let d = crate::deliver::reviewable(&domain)?;
    if d.channel != "linkedin" {
        return Ok((StatusCode::BAD_REQUEST, "not a LinkedIn draft").into_response());
    }
    if !crate::config::load().linkedin_auto_send {
        return Ok((
            StatusCode::CONFLICT,
            "LinkedIn auto-send is off — turn it on in Settings, or use Open in LinkedIn",
        )
            .into_response());
    }
    // Detached subprocess re-invoking this same binary (exactly the `schedules::run_now` idiom):
    // find the current exe, spawn `coldtrail send <domain>`, don't wait. A background task awaits
    // the child only so it's reaped; the HTTP handler returns immediately.
    let exe = std::env::current_exe().map_err(|e| ApiErr(anyhow::anyhow!(e)))?;
    tokio::spawn(async move {
        let _ = tokio::process::Command::new(exe)
            .args(["send", &domain])
            .status()
            .await;
    });
    Ok(Json(serde_json::json!({ "sending": true })).into_response())
}

/// `POST /api/drafts/linkedin/send-all` — the Drafts "Send all" button on the LinkedIn (and All)
/// tab: kick the sequential, paced, cap-aware LinkedIn bulk sender. Requires LinkedIn auto-send to
/// be ON — with it off there is no unattended send path here at all (the human sends by hand via
/// "Open in LinkedIn" per row), same gate `send` above enforces per-domain.
///
/// Like `send`, this SPAWNS A DETACHED `coldtrail send-pending linkedin` subprocess (the same
/// `schedules::run_now`/`send` idiom) rather than looping in-process: a full bulk run can take many
/// minutes (inter-invite pacing plus up to the daily cap's worth of browser drives), which must not
/// block the axum handler. Exactly ONE process is spawned — never one per pending domain —
/// because `send-pending` itself loops sequentially over the whole queue; spawning N processes
/// would have them all contend for the same one-Chrome-profile lock instead of pacing in turn.
pub async fn send_all(State(_state): State<Arc<AppState>>) -> Result<Response, ApiErr> {
    if !crate::config::load().linkedin_auto_send {
        return Ok((StatusCode::CONFLICT, "LinkedIn auto-send is off").into_response());
    }
    let exe = std::env::current_exe().map_err(|e| ApiErr(anyhow::anyhow!(e)))?;
    tokio::spawn(async move {
        let _ = tokio::process::Command::new(exe)
            .args(["send-pending", "linkedin"])
            .status()
            .await;
    });
    Ok(Json(serde_json::json!({ "sending": true })).into_response())
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
            assist: Arc::new(Mutex::new(None)),
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
                .block_on(assist(State(state()), Path("acme.com".to_string())))
                .unwrap();
            // BAD_REQUEST (not a 500/panic) proves the channel check ran, and it necessarily ran
            // before any lock::try_acquire/ChromeBrowser call, since those sit later in the fn.
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        });
    }

    #[test]
    fn confirm_sent_marks_linkedin_and_is_idempotent_with_no_staged_window() {
        crate::testutil::with_home("ct-web-li-confirm-mark", |_| {
            crate::db::init().unwrap();
            let c = crate::db::open().unwrap();
            c.execute(
                "INSERT INTO companies (domain, source_query) VALUES ('acme.com','q')",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO outreach (domain, channel, subject, body, status) \
                 VALUES ('acme.com','linkedin','','Hi Jane','draft_pending')",
                [],
            )
            .unwrap();
            // The assist slot is empty (no live window) — confirm must still mark the row sent and
            // return ok without touching a browser or deadlocking on the slot.
            let resp = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(confirm(
                    State(state()),
                    Path("acme.com".to_string()),
                    Json(ConfirmReq { sent: true }),
                ))
                .unwrap();
            assert_eq!(resp.0["ok"].as_bool(), Some(true));
            let status: String = c
                .query_row(
                    "SELECT status FROM outreach WHERE domain='acme.com' AND channel='linkedin'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(status, "sent");
        });
    }

    #[test]
    fn assist_on_missing_draft_errors_without_touching_the_browser() {
        crate::testutil::with_home("ct-web-li-assist-missing", |_| {
            crate::db::init().unwrap();
            let res = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(assist(State(state()), Path("nowhere.com".to_string())));
            assert!(res.is_err());
        });
    }

    #[test]
    fn send_rejects_non_linkedin_draft_without_spawning() {
        crate::testutil::with_home("ct-web-li-send-email", |_| {
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
            // BAD_REQUEST (not a spawned `coldtrail send` child) proves the channel check ran
            // before the spawn, which sits later in the fn.
            let resp = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(send(State(state()), Path("acme.com".to_string())))
                .unwrap();
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        });
    }

    #[test]
    fn send_rejects_when_linkedin_auto_send_off() {
        crate::testutil::with_home("ct-web-li-send-autooff", |_| {
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
            // Fresh config → linkedin_auto_send defaults off. CONFLICT (not a spawned child)
            // proves the opt-in gate ran before any `coldtrail send` subprocess is launched.
            let resp = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(send(State(state()), Path("acme.com".to_string())))
                .unwrap();
            assert_eq!(resp.status(), StatusCode::CONFLICT);
        });
    }

    #[test]
    fn send_all_rejects_when_linkedin_auto_send_off_without_spawning() {
        crate::testutil::with_home("ct-web-li-sendall-autooff", |_| {
            crate::db::init().unwrap();
            // Fresh config → linkedin_auto_send defaults off. CONFLICT (not a spawned
            // `send-pending` child) proves the opt-in gate ran before any subprocess is launched.
            let resp = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(send_all(State(state())))
                .unwrap();
            assert_eq!(resp.status(), StatusCode::CONFLICT);
        });
    }
}
