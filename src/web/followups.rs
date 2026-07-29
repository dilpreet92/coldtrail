//! Follow-up actions that drive the agent: scan Gmail for replies (mark replied/
//! bounced), and compose a follow-up touch. Both are user-initiated.

use axum::extract::{Path, State};
use axum::Json;
use rusqlite::OptionalExtension;
use std::sync::Arc;
use tokio::sync::mpsc;

use super::api::MsgResp;
use super::{ApiErr, AppState};
use crate::provider::cli::Tools;
use crate::provider::{resolve, run_turn, AgentEvent, GMAIL_TOOL};

/// Drain an agent turn to completion, returning (done_ok, last_result_text).
async fn drive(msg: String, tools: Tools<'_>) -> (bool, Option<String>) {
    let backend = resolve();
    let home = match crate::home::workspace() {
        Ok(h) => h,
        Err(_) => return (false, None),
    };
    let sid = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::channel(64);
    // NOTE: Tools moved into the task; build args before spawn.
    let disallow = matches!(tools, Tools::Disallow(_));
    let list: Vec<String> = match tools {
        Tools::Disallow(l) | Tools::AllowOnly(l) => l.iter().map(|s| s.to_string()).collect(),
    };
    tokio::spawn(async move {
        let refs: Vec<&str> = list.iter().map(|s| s.as_str()).collect();
        let t = if disallow {
            Tools::Disallow(&refs)
        } else {
            Tools::AllowOnly(&refs)
        };
        let _ = run_turn(&backend, &sid, true, &msg, &home, &t, tx).await;
    });
    let mut ok = false;
    let mut last = None;
    while let Some(ev) = rx.recv().await {
        if let AgentEvent::Done { ok: o, result } = ev {
            ok = o;
            last = result;
        }
    }
    (ok, last)
}

/// Scan Gmail (read-only) for replies to already-sent contacts and mark them.
pub async fn check(State(_s): State<Arc<AppState>>) -> Result<Json<MsgResp>, ApiErr> {
    if !resolve().is_cli() {
        return Ok(Json(MsgResp {
            ok: false,
            message: Some(
                "Reply-checking scans your Gmail via the Claude/Codex connector. On BYOK/Ollama, \
                 mark replies with the Replied / Bounced buttons for now."
                    .into(),
            ),
            wired: None,
        }));
    }

    let awaiting: Vec<(String, String)> = {
        let c = crate::db::open()?;
        let mut stmt = c.prepare(
            "SELECT o.domain, MAX(k.email) FROM outreach o LEFT JOIN contacts k ON k.id=o.contact_id \
             WHERE EXISTS (SELECT 1 FROM outreach s WHERE s.domain=o.domain AND s.status='sent') \
               AND NOT EXISTS (SELECT 1 FROM outreach r WHERE r.domain=o.domain AND r.status IN ('replied','bounced')) \
             GROUP BY o.domain HAVING MAX(k.email) IS NOT NULL",
        )?;
        let out = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<(String, String)>>>()?;
        out
    };
    if awaiting.is_empty() {
        return Ok(Json(MsgResp {
            ok: true,
            message: Some("Nothing is awaiting a reply.".into()),
            wired: None,
        }));
    }

    let list = awaiting
        .iter()
        .map(|(d, e)| format!("- {d} ({e})"))
        .collect::<Vec<_>>()
        .join("\n");
    let msg = format!(
        "Check Gmail (READ ONLY) for replies to these already-sent contacts. For each, search your \
         Gmail for a message FROM that address received after we emailed them. If they replied, run \
         `coldtrail mark <domain> replied`. If it hard-bounced, run `coldtrail mark <domain> bounced`. \
         Do NOT send or draft anything. Report a one-line summary. Contacts:\n{list}"
    );
    let (_ok, last) = drive(msg, Tools::Disallow(&[])).await;
    Ok(Json(MsgResp {
        ok: true,
        message: last,
        wired: None,
    }))
}

/// Compose a follow-up touch for a sent-but-unanswered contact.
pub async fn draft(
    Path(domain): Path<String>,
    State(_s): State<Arc<AppState>>,
) -> Result<Json<MsgResp>, ApiErr> {
    let domain = domain.to_lowercase();
    let (subject, to) = {
        let c = crate::db::open()?;
        c.query_row(
            "SELECT MAX(o.subject), MAX(k.email) FROM outreach o LEFT JOIN contacts k ON k.id=o.contact_id \
             WHERE o.domain=?1 AND EXISTS (SELECT 1 FROM outreach s WHERE s.domain=o.domain AND s.status='sent')",
            [&domain],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()?
        .unwrap_or((None, None))
    };
    let to = to.ok_or_else(|| anyhow::anyhow!("{domain} has no sent contact to follow up"))?;

    let msg = format!(
        "Write a SHORT follow-up email to {to} at {domain}. They didn't reply to the first email \
         (subject: \"{}\"). Reference it lightly, add one new angle or piece of value, keep it to \
         2–3 sentences, friendly and low-pressure — do not resend the original. Then store it by \
         running `coldtrail followup {domain} --subject \"…\" --body \"…\"` (or the `followup` tool). \
         Do not send.",
        subject.as_deref().unwrap_or("")
    );
    // Gmail stays off — follow-up drafting only writes a local touch.
    let (ok, last) = drive(msg, Tools::Disallow(&[GMAIL_TOOL])).await;
    if ok {
        Ok(Json(MsgResp {
            ok: true,
            message: Some("Follow-up drafted — review it in Drafts.".into()),
            wired: None,
        }))
    } else {
        Ok(Json(MsgResp {
            ok: false,
            message: last,
            wired: None,
        }))
    }
}
