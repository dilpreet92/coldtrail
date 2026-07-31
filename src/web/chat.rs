//! Agent chat: start a turn, tee its event stream to the browser (SSE) *and* to the chat
//! history (SQLite), one turn at a time. The chat agent may NOT touch Gmail.

use axum::extract::{Query, State};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::params;
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

use super::api::{ChatReq, ChatResp};
use super::{ApiErr, AppState};
use crate::provider::cli::Tools;
use crate::provider::{resolve, run_turn, AgentEvent, GMAIL_TOOL};

/// How long an unclaimed run (POSTed but never streamed) lingers before eviction.
const RUN_TTL: Duration = Duration::from_secs(45);

fn title_from(msg: &str) -> String {
    let t = msg.trim().replace('\n', " ");
    if t.chars().count() > 60 {
        format!("{}…", t.chars().take(60).collect::<String>())
    } else {
        t
    }
}

/// Persist a chat message (best-effort; never blocks the turn on a DB hiccup).
fn insert_message(chat_id: &str, role: &str, content: &str) {
    if let Ok(c) = crate::db::open() {
        let _ = c.execute(
            "INSERT INTO chat_messages (session_id, role, content) VALUES (?1, ?2, ?3)",
            params![chat_id, role, content],
        );
        let _ = c.execute(
            "UPDATE chat_sessions SET updated_at=datetime('now') WHERE id=?1",
            [chat_id],
        );
    }
}

pub async fn start(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ChatReq>,
) -> Result<Json<ChatResp>, ApiErr> {
    let home = crate::home::workspace()?;

    let run_id = uuid::Uuid::new_v4().to_string();
    let (tx_b, rx_b) = mpsc::channel::<AgentEvent>(128);
    state.runs.lock().await.insert(run_id.clone(), rx_b);

    let msg = req.message;
    let st = state.clone();
    tokio::spawn(async move {
        // one turn at a time — no concurrent --session-id/--resume on one session
        let _turn = st.turn_lock.lock().await;
        let backend = resolve();

        // Decide the active conversation (create one if none).
        let (chat_id, agent_sid, first) = {
            let mut s = st.chat.lock().await;
            if s.chat_id.is_none() {
                s.chat_id = Some(uuid::Uuid::new_v4().to_string());
                s.agent_session_id = Some(uuid::Uuid::new_v4().to_string());
                s.created = false;
            }
            (
                s.chat_id.clone().unwrap(),
                s.agent_session_id.clone().unwrap(),
                !s.created,
            )
        };

        // Ensure the conversation row exists (title from the first message) + log the user turn.
        if let Ok(c) = crate::db::open() {
            let _ = c.execute(
                "INSERT INTO chat_sessions (id, agent_session_id, title) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(id) DO NOTHING",
                params![chat_id, agent_sid, title_from(&msg)],
            );
        }
        insert_message(&chat_id, "user", &msg);

        // Run the turn on an inner channel so we can both persist and forward its events.
        let (tx_a, mut rx_a) = mpsc::channel::<AgentEvent>(128);
        let h = home.clone();
        let sid = agent_sid.clone();
        tokio::spawn(async move {
            let tools = Tools::Disallow(&[GMAIL_TOOL]); // chat never sends / drafts in Gmail
            let _ = run_turn(&backend, &sid, first, &msg, &h, &tools, tx_a).await;
        });

        let mut assistant = String::new();
        let mut ok = false;
        let mut disconnected = false;
        let mut new_session: Option<String> = None;
        while let Some(ev) = rx_a.recv().await {
            match &ev {
                AgentEvent::Text { text } => assistant.push_str(text),
                AgentEvent::Done { ok: o, .. } => ok = *o,
                // codex assigns its own thread id — capture it for resume, don't show it.
                AgentEvent::Session { id } => {
                    new_session = Some(id.clone());
                    continue;
                }
                _ => {}
            }
            // Forward to the browser; if it went away, stop and let the inner turn cancel
            // (dropping rx_a closes tx_a, which run_turn selects on to kill the child).
            if tx_b.send(ev).await.is_err() {
                disconnected = true;
                break;
            }
        }
        drop(rx_a);

        // Persist the provider-assigned session id (codex) so a later resume targets it.
        if let Some(sid) = &new_session {
            if let Ok(c) = crate::db::open() {
                let _ = c.execute(
                    "UPDATE chat_sessions SET agent_session_id=?1 WHERE id=?2",
                    params![sid, chat_id],
                );
            }
        }
        if !assistant.trim().is_empty() {
            insert_message(&chat_id, "assistant", assistant.trim());
        }
        let mut s = st.chat.lock().await;
        if let Some(sid) = new_session {
            s.agent_session_id = Some(sid);
        }
        if ok {
            s.created = true;
        } else if first && !disconnected {
            // A genuine first-turn failure (not a browser disconnect) never produced a real
            // conversation — discard the half-created row so a resend starts clean and no
            // stale agent_session_id is left behind for a later resume.
            if let Ok(c) = crate::db::open() {
                let _ = c.execute("DELETE FROM chat_messages WHERE session_id=?1", [&chat_id]);
                let _ = c.execute("DELETE FROM chat_sessions WHERE id=?1", [&chat_id]);
            }
            s.chat_id = None;
            s.agent_session_id = None;
            s.created = false;
        }
    });

    // Reaper: if the browser never opens the stream, evict the run so its receiver
    // (and, via the dropped tx, the spawned agent) don't linger. No-op once claimed.
    let st2 = state.clone();
    let rid = run_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(RUN_TTL).await;
        st2.runs.lock().await.remove(&rid);
    });

    Ok(Json(ChatResp { run: run_id }))
}

pub async fn stream(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let run = match q.get("run") {
        Some(r) => r.clone(),
        None => return (axum::http::StatusCode::BAD_REQUEST, "missing run").into_response(),
    };
    let rx = state.runs.lock().await.remove(&run);
    let rx = match rx {
        Some(rx) => rx,
        None => return (axum::http::StatusCode::NOT_FOUND, "unknown run").into_response(),
    };
    let stream = ReceiverStream::new(rx).map(|ev| {
        Ok::<Event, Infallible>(
            Event::default()
                .json_data(&ev)
                .unwrap_or_else(|_| Event::default().data("{}")),
        )
    });
    Sse::new(stream).into_response()
}
