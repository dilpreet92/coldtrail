//! Push a reviewed draft into Gmail as a DRAFT (never sends) — the human sends it
//! from Gmail by hand. The connected Gmail MCP is draft/read-only, so this is both the
//! honest capability and the guardrail. Advances the outreach row to `drafted`.
//!
//! Only CLI backends (claude/codex) can do this today: they reach Gmail through the
//! provider's account connector, so there are no keys to configure. BYOK/Ollama has no
//! draft-capable Gmail path yet and is told so plainly.

use axum::extract::{Path, State};
use axum::Json;
use rusqlite::OptionalExtension;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

use super::api::MsgResp;
use super::{ApiErr, AppState};
use crate::provider::cli::Tools;
use crate::provider::{resolve, run_turn, AgentEvent};

/// A stuck agent turn must not leave the UI spinning forever.
const DRAFT_TIMEOUT: Duration = Duration::from_secs(90);

pub async fn send(
    State(_state): State<Arc<AppState>>,
    Path(domain): Path<String>,
) -> Result<Json<MsgResp>, ApiErr> {
    let domain = domain.to_lowercase();

    // Only a reviewable local draft can be pushed to Gmail.
    let (subject, body, to) = {
        let c = crate::db::open()?;
        let row = c
            .query_row(
                "SELECT o.subject, o.body, k.email FROM outreach o \
                 LEFT JOIN contacts k ON k.id = o.contact_id \
                 WHERE o.domain=?1 AND o.status IN ('draft_pending','drafted') \
                 ORDER BY o.created_at DESC LIMIT 1",
                [&domain],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        match row {
            Some(r) => r,
            None => return Err(anyhow::anyhow!("no reviewable draft for {domain}").into()),
        }
    };
    let to = to.ok_or_else(|| anyhow::anyhow!("no recipient email on file for {domain}"))?;
    let subject = subject.unwrap_or_default();
    let body = body.unwrap_or_default();

    let backend = resolve();
    if !backend.is_cli() {
        // BYOK/Ollama: no draft-capable Gmail path yet.
        return Ok(Json(MsgResp {
            ok: false,
            message: Some(
                "Creating a Gmail draft needs a Claude or Codex provider right now (it uses \
                 that account's Gmail connector). Switch provider in Setup, or copy the draft \
                 into Gmail by hand."
                    .into(),
            ),
            wired: None,
        }));
    }

    // CLI backend: a constrained agent turn that creates a Gmail DRAFT and nothing else.
    let home = crate::home::workspace()?;
    let sid = uuid::Uuid::new_v4().to_string();
    let msg = format!(
        "Create a Gmail DRAFT (do NOT send) using the Gmail MCP `create_draft` tool:\n\n\
         To: {to}\nSubject: {subject}\n\n{body}\n\n\
         Create exactly one draft with those fields and do nothing else. Do not send. \
         If you cannot create the draft, say why and stop."
    );
    let (tx, mut rx) = mpsc::channel(64);
    let h = home.clone();
    tokio::spawn(async move {
        // No tool restriction (the connector has no send tool anyway); the prompt forbids sending.
        let _ = run_turn(&backend, &sid, true, &msg, &h, &Tools::Disallow(&[]), tx).await;
    });

    let drain = async {
        let mut used_draft = false;
        let mut done_ok = false;
        let mut last: Option<String> = None;
        while let Some(ev) = rx.recv().await {
            match ev {
                AgentEvent::ToolStart { name, .. } if name.to_lowercase().contains("draft") => {
                    used_draft = true
                }
                AgentEvent::Done { ok, result } => {
                    done_ok = ok;
                    last = result;
                }
                _ => {}
            }
        }
        (used_draft, done_ok, last)
    };

    let (used_draft, done_ok, last) = match tokio::time::timeout(DRAFT_TIMEOUT, drain).await {
        Ok(v) => v,
        Err(_) => {
            return Ok(Json(MsgResp {
                ok: false,
                message: Some(
                    "Timed out creating the Gmail draft. Check that your Gmail connector is \
                     enabled (claude.ai → Connectors), then try again."
                        .into(),
                ),
                wired: None,
            }))
        }
    };

    if used_draft && done_ok {
        crate::mark::run(&domain, "gmail")?; // records a gmail draft + status='drafted'
        Ok(Json(MsgResp {
            ok: true,
            message: Some("Created in your Gmail Drafts — open Gmail to review and send.".into()),
            wired: None,
        }))
    } else {
        Ok(Json(MsgResp {
            ok: false,
            message: Some(
                last.unwrap_or_else(|| "the agent could not create the Gmail draft".into()),
            ),
            wired: None,
        }))
    }
}
