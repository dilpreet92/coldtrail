//! Chat history: list past conversations, read a transcript, start a fresh conversation,
//! or reopen (activate) an old one so the next turn resumes it.

use axum::extract::{Path, State};
use axum::Json;
use rusqlite::OptionalExtension;
use std::sync::Arc;

use super::api::{ChatDetail, ChatMessageDto, ChatSummary, MsgResp};
use super::{ApiErr, AppState};

/// All conversations, newest activity first.
pub async fn list(State(state): State<Arc<AppState>>) -> Result<Json<Vec<ChatSummary>>, ApiErr> {
    let active = state.chat.lock().await.chat_id.clone();
    let c = crate::db::open()?;
    let mut stmt = c.prepare(
        "SELECT id, title, COALESCE(updated_at, created_at, '') FROM chat_sessions \
         ORDER BY COALESCE(updated_at, created_at) DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            let id: String = r.get(0)?;
            Ok(ChatSummary {
                active: active.as_deref() == Some(id.as_str()),
                id,
                title: r.get(1)?,
                updated_at: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(rows))
}

/// One conversation's transcript.
pub async fn detail(Path(id): Path<String>) -> Result<Json<ChatDetail>, ApiErr> {
    let c = crate::db::open()?;
    let title: Option<String> = c
        .query_row("SELECT title FROM chat_sessions WHERE id=?1", [&id], |r| {
            r.get(0)
        })
        .optional()?
        .flatten();
    let mut stmt = c.prepare(
        "SELECT role, content, COALESCE(created_at,'') FROM chat_messages \
         WHERE session_id=?1 ORDER BY id",
    )?;
    let messages = stmt
        .query_map([&id], |r| {
            Ok(ChatMessageDto {
                role: r.get(0)?,
                content: r.get(1)?,
                created_at: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(ChatDetail {
        id,
        title,
        messages,
    }))
}

/// Start a fresh conversation — clears the active pointer so the next message opens a new one.
pub async fn new_chat(State(state): State<Arc<AppState>>) -> Result<Json<MsgResp>, ApiErr> {
    let mut s = state.chat.lock().await;
    s.chat_id = None;
    s.agent_session_id = None;
    s.created = false;
    Ok(Json(MsgResp::ok()))
}

/// Reopen a past conversation: make it active and load its provider session so the next
/// turn resumes it.
pub async fn activate(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<MsgResp>, ApiErr> {
    let agent_sid: Option<String> = {
        let c = crate::db::open()?;
        c.query_row(
            "SELECT agent_session_id FROM chat_sessions WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .optional()?
        .flatten()
    };
    if agent_sid.is_none() {
        // no stored provider session (e.g. an empty/legacy row) — still allow reopening
        return Err(anyhow::anyhow!("conversation {id} not found or has no session").into());
    }
    let mut s = state.chat.lock().await;
    s.chat_id = Some(id);
    s.agent_session_id = agent_sid;
    s.created = true; // resume, don't re-seed
    Ok(Json(MsgResp::ok()))
}
