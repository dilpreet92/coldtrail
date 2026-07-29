//! Explicit human send: a constrained agent turn allowed to use ONLY the Gmail MCP,
//! instructed to send exactly one draft. Marks the company sent only on evidence that
//! the Gmail tool actually ran successfully.

use axum::extract::{Path, State};
use axum::Json;
use rusqlite::OptionalExtension;
use std::sync::Arc;
use tokio::sync::mpsc;

use super::api::MsgResp;
use super::{ApiErr, AppState};
use crate::provider::cli::Tools;
use crate::provider::{resolve, run_turn, AgentEvent, GMAIL_TOOL};

pub async fn send(
    State(_state): State<Arc<AppState>>,
    Path(domain): Path<String>,
) -> Result<Json<MsgResp>, ApiErr> {
    let domain = domain.to_lowercase();

    // Only a reviewable draft may be sent.
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

    let backend = resolve();
    if !backend.is_cli() {
        return Ok(Json(MsgResp {
            ok: false,
            message: Some(
                "Sending isn't available on the BYOK/Ollama backend yet — switch to Claude Code \
                 in Setup (the Gmail connector for this backend lands with the MCP client)."
                    .into(),
            ),
            wired: None,
        }));
    }
    let home = crate::home::workspace()?;
    let sid = uuid::Uuid::new_v4().to_string();
    let msg = format!(
        "Send one email via the Gmail MCP and do nothing else:\n\nTo: {to}\nSubject: {}\n\n{}\n\n\
         Send it now to that single recipient. Do not draft, source, or contact anyone else. \
         If you cannot send, say why and stop.",
        subject.as_deref().unwrap_or(""),
        body.as_deref().unwrap_or("")
    );

    // Constrained: the ONLY turn permitted to use Gmail, and ONLY Gmail.
    let tools = Tools::AllowOnly(&[GMAIL_TOOL]);
    let (tx, mut rx) = mpsc::channel(64);
    let h = home.clone();
    tokio::spawn(async move {
        let _ = run_turn(&backend, &sid, true, &msg, &h, &tools, tx).await;
    });

    // Require positive evidence: the Gmail tool actually ran and the turn finished ok.
    let mut used_gmail = false;
    let mut done_ok = false;
    let mut last: Option<String> = None;
    while let Some(ev) = rx.recv().await {
        match ev {
            AgentEvent::ToolStart { name, .. } if name.to_lowercase().contains("gmail") => {
                used_gmail = true
            }
            AgentEvent::Done { ok, result } => {
                done_ok = ok;
                last = result;
            }
            _ => {}
        }
    }

    if used_gmail && done_ok {
        crate::mark::run(&domain, "sent")?;
        Ok(Json(MsgResp {
            ok: true,
            message: last,
            wired: None,
        }))
    } else {
        Ok(Json(MsgResp {
            ok: false,
            message: Some(
                last.unwrap_or_else(|| "the agent did not confirm sending the email".into()),
            ),
            wired: None,
        }))
    }
}
