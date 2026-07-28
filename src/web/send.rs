//! Explicit human send: a constrained agent turn that sends exactly one Gmail draft,
//! then marks the company sent. The only path that ever sends.

use axum::extract::{Path, State};
use axum::Json;
use rusqlite::OptionalExtension;
use std::sync::Arc;
use tokio::sync::mpsc;

use super::api::MsgResp;
use super::{ApiErr, AppState};
use crate::provider::AgentEvent;

pub async fn send(
    State(_state): State<Arc<AppState>>,
    Path(domain): Path<String>,
) -> Result<Json<MsgResp>, ApiErr> {
    let domain = domain.to_lowercase();

    // Only allow sending something that's actually a reviewed/pending draft.
    let eligible = {
        let c = crate::db::open()?;
        c.query_row(
            "SELECT 1 FROM outreach WHERE domain=?1 AND status IN ('draft_pending','drafted') LIMIT 1",
            [&domain],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false)
    };
    if !eligible {
        return Err(anyhow::anyhow!("no reviewable draft for {domain}").into());
    }

    let kind = crate::setup::read_agent()?;
    let home = crate::home::workspace()?;
    let sid = uuid::Uuid::new_v4().to_string();
    let msg = format!(
        "Send the Gmail draft addressed to the contact at {domain} now — use the Gmail MCP to \
         send that single existing draft and nothing else. Do NOT source, draft, or contact any \
         other company. If no such Gmail draft exists, say so and stop."
    );

    let (tx, mut rx) = mpsc::channel(64);
    let h = home.clone();
    let worker = tokio::spawn(async move {
        let _ = crate::provider::cli::run_turn(kind, &sid, true, &msg, &h, tx).await;
    });

    let mut ok = false;
    let mut last: Option<String> = None;
    while let Some(ev) = rx.recv().await {
        if let AgentEvent::Done { ok: o, result } = ev {
            ok = o;
            last = result;
        }
    }
    let _ = worker.await;

    if ok {
        crate::mark::run(&domain, "sent")?;
        Ok(Json(MsgResp {
            ok: true,
            message: last,
            wired: None,
        }))
    } else {
        Ok(Json(MsgResp {
            ok: false,
            message: Some(last.unwrap_or_else(|| "send did not complete".into())),
            wired: None,
        }))
    }
}
