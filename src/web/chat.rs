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

pub async fn start(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ChatReq>,
) -> Result<Json<ChatResp>, ApiErr> {
    let home = crate::home::workspace()?;

    // Bind the message to the conversation active NOW (creating one if none). The turn may
    // wait on `turn_lock` behind another; if the user opens a different conversation in the
    // meantime, this message must still land where it was sent.
    let chat_id = {
        let mut s = state.chat.lock().await;
        if s.chat_id.is_none() {
            s.chat_id = Some(uuid::Uuid::new_v4().to_string());
            s.agent_session_id = Some(uuid::Uuid::new_v4().to_string());
            s.created = false;
        }
        s.chat_id.clone().unwrap()
    };

    let run_id = uuid::Uuid::new_v4().to_string();
    let (tx_b, rx_b) = mpsc::channel::<AgentEvent>(128);
    state.runs.lock().await.insert(run_id.clone(), rx_b);

    let msg = req.message;
    let st = state.clone();
    tokio::spawn(async move {
        // one turn at a time — no concurrent --session-id/--resume on one session
        let _turn = st.turn_lock.lock().await;
        let backend = resolve();

        // Read the provider session only now: a turn ahead of this one may have just seeded it.
        let (agent_sid, first) = session_for(&st, &chat_id).await;

        // Ensure the conversation row exists (title from the first message) + log the user turn.
        if let Ok(c) = crate::db::open() {
            let _ = c.execute(
                "INSERT INTO chat_sessions (id, agent_session_id, title) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(id) DO NOTHING",
                params![chat_id, agent_sid, crate::chat_store::title_from(&msg)],
            );
        }
        crate::chat_store::insert_message(&chat_id, "user", &msg);

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
                // codex/opencode assign their own session id — capture it for resume, don't show it.
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

        if !assistant.trim().is_empty() {
            crate::chat_store::insert_message(&chat_id, "assistant", assistant.trim());
        }
        finish_turn(
            &st,
            &chat_id,
            TurnEnd {
                new_session,
                ok,
                first,
                disconnected,
            },
        )
        .await;
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

/// The provider session for `chat_id`'s next turn: (agent_session_id, first_turn). While it is
/// still the active conversation its in-memory session is current (a turn ahead may have just
/// seeded it). One the user has since left is resumed from its stored row, as `activate` would;
/// one with no row yet (never persisted, or its failed first turn was discarded) starts fresh.
async fn session_for(st: &AppState, chat_id: &str) -> (String, bool) {
    {
        let s = st.chat.lock().await;
        if s.chat_id.as_deref() == Some(chat_id) {
            if let Some(sid) = &s.agent_session_id {
                return (sid.clone(), !s.created);
            }
        }
    }
    let stored: Option<String> = crate::db::open().ok().and_then(|c| {
        c.query_row(
            "SELECT agent_session_id FROM chat_sessions WHERE id=?1",
            [chat_id],
            |r| r.get(0),
        )
        .ok()
        .flatten()
    });
    match stored {
        Some(sid) => (sid, false),
        None => (uuid::Uuid::new_v4().to_string(), true),
    }
}

/// How a chat turn ended, for `finish_turn`.
struct TurnEnd {
    /// The provider-assigned session id (codex/opencode), if the turn reported one.
    new_session: Option<String>,
    ok: bool,
    first: bool,
    /// The browser went away mid-turn, which cancelled it.
    disconnected: bool,
}

/// End-of-turn bookkeeping for `chat_id`, the conversation the message was bound to. Its row
/// stores the provider-assigned session id. The in-memory active session changes only while it
/// is still `chat_id`: a turn that ends (or is cancelled) after the user switched conversations
/// must not hand its session to the one now active.
async fn finish_turn(st: &AppState, chat_id: &str, end: TurnEnd) {
    // Persist the provider-assigned session id (codex/opencode) so a later resume targets it.
    if let Some(sid) = &end.new_session {
        crate::chat_store::set_agent_session(chat_id, sid);
    }
    // A genuine first-turn failure (not a browser disconnect) never produced a real
    // conversation — discard the half-created row so a resend starts clean and no stale
    // agent_session_id is left behind for a later resume.
    let discard = !end.ok && end.first && !end.disconnected;
    if discard {
        if let Ok(c) = crate::db::open() {
            let _ = c.execute("DELETE FROM chat_messages WHERE session_id=?1", [chat_id]);
            let _ = c.execute("DELETE FROM chat_sessions WHERE id=?1", [chat_id]);
        }
    }
    let mut s = st.chat.lock().await;
    if s.chat_id.as_deref() != Some(chat_id) {
        return;
    }
    if let Some(sid) = end.new_session {
        s.agent_session_id = Some(sid);
    }
    if end.ok {
        s.created = true;
    } else if discard {
        s.chat_id = None;
        s.agent_session_id = None;
        s.created = false;
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::Path;

    /// An OpenAI-compatible mock whose every turn answers `reply` (no tool calls).
    async fn mock_backend(reply: &'static str) -> String {
        use axum::routing::post;
        let app = axum::Router::new().route(
            "/chat/completions",
            post(move |_b: String| async move {
                Json(
                    serde_json::json!({"choices":[{"message":{"role":"assistant",
                    "content":reply},"finish_reason":"stop"}]}),
                )
            }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        format!("http://{addr}")
    }

    /// (role, content) of a conversation's messages, oldest first.
    fn messages_of(chat: &str) -> Vec<(String, String)> {
        crate::db::open()
            .unwrap()
            .prepare("SELECT role, content FROM chat_messages WHERE session_id=?1 ORDER BY id")
            .unwrap()
            .query_map([chat], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    /// A message belongs to the conversation that was active when it was POSTed. A turn still
    /// queued behind another one doesn't follow the user into a conversation they activate in
    /// the meantime, and finishing it doesn't change which conversation is active.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn message_lands_in_the_conversation_active_when_sent() {
        let _g = crate::testutil::env_guard();
        let home = std::env::temp_dir().join("ct-web-chat-bind");
        let _ = std::fs::remove_dir_all(&home);
        std::env::set_var("COLDTRAIL_HOME", &home);
        crate::db::init().unwrap();
        crate::config::save(&crate::config::Config {
            agent: Some("openai".into()),
            provider: Some(crate::config::Provider {
                base_url: Some(mock_backend("Reply for A").await),
                model: Some("m".into()),
            }),
            ..Default::default()
        })
        .unwrap();
        crate::db::open()
            .unwrap()
            .execute_batch(
                "INSERT INTO chat_sessions (id, agent_session_id, title) VALUES \
                 ('a','a-sid','A'), ('b','b-sid','B');",
            )
            .unwrap();
        let st = crate::web::tests::state();
        {
            let mut s = st.chat.lock().await;
            s.chat_id = Some("a".into());
            s.agent_session_id = Some("a-sid".into());
            s.created = true;
        }

        // Another turn holds the lock, so this one queues; the user then opens B.
        let busy = st.turn_lock.lock().await;
        let Json(resp) = start(
            State(st.clone()),
            Json(ChatReq {
                message: "Message for A".into(),
            }),
        )
        .await
        .unwrap();
        let Json(activated) = crate::web::chats::activate(State(st.clone()), Path("b".into()))
            .await
            .unwrap();
        assert!(activated.ok);
        drop(busy);

        // The run's channel closes once the turn and its bookkeeping are done.
        let mut rx = st.runs.lock().await.remove(&resp.run).unwrap();
        while rx.recv().await.is_some() {}

        assert_eq!(
            messages_of("a"),
            pairs(&[("user", "Message for A"), ("assistant", "Reply for A")])
        );
        assert!(messages_of("b").is_empty());
        let s = st.chat.lock().await;
        assert_eq!(s.chat_id.as_deref(), Some("b"));
        assert_eq!(s.agent_session_id.as_deref(), Some("b-sid"));
        drop(s);

        std::env::remove_var("COLDTRAIL_HOME");
    }

    fn agent_session_of(chat: &str) -> Option<String> {
        crate::db::open()
            .unwrap()
            .query_row(
                "SELECT agent_session_id FROM chat_sessions WHERE id=?1",
                [chat],
                |r| r.get(0),
            )
            .ok()
            .flatten()
    }

    /// A turn that ends after the user opened another conversation — e.g. one cancelled by
    /// leaving it — stores its provider session on its own conversation's row and leaves the
    /// now-active conversation's session alone; while it is still active, it updates it.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn turn_end_bookkeeping_targets_the_bound_conversation() {
        let _g = crate::testutil::env_guard();
        let home = std::env::temp_dir().join("ct-web-chat-finish");
        let _ = std::fs::remove_dir_all(&home);
        std::env::set_var("COLDTRAIL_HOME", &home);
        crate::db::init().unwrap();
        crate::db::open()
            .unwrap()
            .execute_batch(
                "INSERT INTO chat_sessions (id, agent_session_id, title) VALUES \
                 ('a','a-sid','A'), ('b','ses_b','B'), ('c','c-sid','C'); \
                 INSERT INTO chat_messages (session_id, role, content) VALUES ('c','user','hi');",
            )
            .unwrap();
        let st = crate::web::tests::state();
        let activate = |id: &'static str, sid: &'static str, created: bool| {
            let st = st.clone();
            async move {
                let mut s = st.chat.lock().await;
                s.chat_id = Some(id.into());
                s.agent_session_id = Some(sid.into());
                s.created = created;
            }
        };
        let active = || async {
            let s = st.chat.lock().await;
            (s.chat_id.clone(), s.agent_session_id.clone(), s.created)
        };
        let some = |v: &str| Some(v.to_string());

        // A's cancelled turn ends while B is active.
        activate("b", "ses_b", true).await;
        let end = TurnEnd {
            new_session: some("ses_a"),
            ok: false,
            first: false,
            disconnected: true,
        };
        finish_turn(&st, "a", end).await;
        assert_eq!(agent_session_of("a"), some("ses_a"));
        assert_eq!(agent_session_of("b"), some("ses_b"));
        assert_eq!(active().await, (some("b"), some("ses_b"), true));

        // C's failed first turn ends while B is active: C's rows go, B stays active.
        let end = TurnEnd {
            new_session: None,
            ok: false,
            first: true,
            disconnected: false,
        };
        finish_turn(&st, "c", end).await;
        assert_eq!(agent_session_of("c"), None);
        assert!(messages_of("c").is_empty());
        assert_eq!(active().await, (some("b"), some("ses_b"), true));

        // While A is still active, its successful first turn seeds the in-memory session.
        activate("a", "a-sid", false).await;
        let end = TurnEnd {
            new_session: some("ses_a2"),
            ok: true,
            first: true,
            disconnected: false,
        };
        finish_turn(&st, "a", end).await;
        assert_eq!(agent_session_of("a"), some("ses_a2"));
        assert_eq!(active().await, (some("a"), some("ses_a2"), true));

        std::env::remove_var("COLDTRAIL_HOME");
    }
}
