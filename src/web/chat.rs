//! Agent chat: start a turn, then stream its events to the browser over SSE.
//! Turns are serialized (one at a time); the chat agent may NOT touch Gmail.

use axum::extract::{Query, State};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
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
use crate::provider::{resolve, run_turn, GMAIL_TOOL};

/// How long an unclaimed run (POSTed but never streamed) lingers before eviction.
const RUN_TTL: Duration = Duration::from_secs(45);

pub async fn start(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ChatReq>,
) -> Result<Json<ChatResp>, ApiErr> {
    let backend = resolve();
    let home = crate::home::workspace()?;

    let run_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel(128);
    state.runs.lock().await.insert(run_id.clone(), rx);

    let msg = req.message;
    let st = state.clone();
    tokio::spawn(async move {
        // one turn at a time — no concurrent --session-id/--resume on one session
        let _turn = st.turn_lock.lock().await;
        let (sid, first) = {
            let mut s = st.chat.lock().await;
            if s.id.is_none() {
                s.id = Some(uuid::Uuid::new_v4().to_string());
            }
            (s.id.clone().unwrap(), !s.created)
        };
        let tools = Tools::Disallow(&[GMAIL_TOOL]); // chat never sends / drafts in Gmail
        let ok = run_turn(&backend, &sid, first, &msg, &home, &tools, tx).await;
        let mut s = st.chat.lock().await;
        if ok {
            s.created = true;
        } else if first {
            // failed first turn never created the session — don't poison the next --resume
            s.id = None;
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
