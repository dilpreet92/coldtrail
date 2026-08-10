//! Push a reviewed draft into Gmail. By default it creates a DRAFT and the human sends by
//! hand (the standing guardrail). If the human has opted into `auto_send` (Settings →
//! Destination), the same action SENDS immediately — SMTP for the app-password path, the
//! Gmail API for the OAuth path — under a per-day cap. The chat agent never reaches here.

use axum::extract::{Path, State};
use axum::Json;
use rusqlite::OptionalExtension;
use std::sync::Arc;

use super::api::MsgResp;
use super::{ApiErr, AppState};

pub async fn send(
    State(_state): State<Arc<AppState>>,
    Path(domain): Path<String>,
) -> Result<Json<MsgResp>, ApiErr> {
    let domain = domain.to_lowercase();

    // Only a reviewable draft can be pushed to Gmail.
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
    let subject = subject.as_deref().unwrap_or("");
    let body = body.as_deref().unwrap_or("");

    let cfg = crate::config::load();
    if cfg.auto_send {
        return auto_send(&domain, &to, subject, body, &cfg).await;
    }

    // Default (guardrail): create a DRAFT and let the human send. Prefer the keyless
    // app-password path (IMAP APPEND); fall back to coldtrail's Gmail OAuth token.
    let outcome = if let Some((email, pw)) = crate::secrets::gmail_app_password() {
        let mime = crate::gmail::mime_message(&to, subject, body);
        crate::imap_draft::append_draft(&email, &pw, &mime)
            .await
            .map(|_| ())
    } else {
        match crate::gmail::token().await {
            Ok((token, quota)) => {
                crate::gmail::create_draft(&token, quota.as_deref(), &to, subject, body)
                    .await
                    .map(|_| ())
            }
            Err(e) => Err(e),
        }
    };

    match outcome {
        Ok(()) => {
            crate::mark::run(&domain, "gmail")?; // records a gmail draft + status='drafted'
            Ok(Json(MsgResp {
                ok: true,
                message: Some(
                    "Created in your Gmail Drafts — open Gmail to review and send.".into(),
                ),
                wired: None,
            }))
        }
        Err(e) => Ok(Json(MsgResp {
            ok: false,
            message: Some(e.to_string()),
            wired: None,
        })),
    }
}

/// Actually SEND (opt-in `auto_send`). Enforces a per-day cap first (deliverability/warmup),
/// then sends via SMTP (app-password path) or the Gmail API (OAuth path), and marks 'sent'.
async fn auto_send(
    domain: &str,
    to: &str,
    subject: &str,
    body: &str,
    cfg: &crate::config::Config,
) -> Result<Json<MsgResp>, ApiErr> {
    let cap = cfg
        .daily_send_cap
        .unwrap_or(crate::config::DEFAULT_DAILY_SEND_CAP);
    let sent_today: u32 = {
        let c = crate::db::open()?;
        c.query_row(
            "SELECT COUNT(*) FROM outreach WHERE status='sent' AND date(sent_at)=date('now')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0)
    };
    if sent_today >= cap {
        return Ok(Json(MsgResp {
            ok: false,
            message: Some(format!(
                "Daily send cap reached ({sent_today}/{cap}). Raise it in Settings → Destination, or send the rest tomorrow."
            )),
            wired: None,
        }));
    }

    let outcome = if let Some((email, pw)) = crate::secrets::gmail_app_password() {
        let mime = crate::gmail::mime_message(to, subject, body);
        crate::smtp::send(&email, &pw, to, &mime).await.map(|_| ())
    } else {
        match crate::gmail::token().await {
            Ok((token, quota)) => {
                crate::gmail::send_message(&token, quota.as_deref(), to, subject, body)
                    .await
                    .map(|_| ())
            }
            Err(e) => Err(e),
        }
    };

    match outcome {
        Ok(()) => {
            crate::mark::run(domain, "sent")?; // status='sent', sent_at=now
            Ok(Json(MsgResp {
                ok: true,
                message: Some(format!("Sent to {to}. ({}/{cap} today)", sent_today + 1)),
                wired: None,
            }))
        }
        Err(e) => Ok(Json(MsgResp {
            ok: false,
            message: Some(e.to_string()),
            wired: None,
        })),
    }
}
