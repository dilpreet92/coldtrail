//! Agent chat: start a turn, then stream its events to the browser over SSE.

use axum::extract::{Query, State};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

use super::api::{ChatReq, ChatResp};
use super::{ApiErr, AppState};

pub async fn start(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ChatReq>,
) -> Result<Json<ChatResp>, ApiErr> {
    let kind = crate::setup::read_agent()?;
    let home = crate::home::workspace()?;

    let sid = {
        let mut g = state.session_id.lock().await;
        if g.is_none() {
            *g = Some(uuid::Uuid::new_v4().to_string());
        }
        g.clone().unwrap()
    };
    let first = {
        let mut t = state.turns.lock().await;
        let f = *t == 0;
        *t += 1;
        f
    };

    let run_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel(128);
    state.runs.lock().await.insert(run_id.clone(), rx);

    let msg = req.message;
    tokio::spawn(async move {
        let _ = crate::provider::cli::run_turn(kind, &sid, first, &msg, &home, tx).await;
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
