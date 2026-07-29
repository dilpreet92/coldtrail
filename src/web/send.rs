//! Send a reviewed draft for real, via the Gmail API, using coldtrail's own
//! `gmail.compose`-scoped OAuth token. No agent, no draft-only connector — a human
//! clicks Send per draft (the guardrail); coldtrail never sends on its own.

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

    // Only a reviewable draft can be sent.
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

    let token = match crate::oauth::valid_access("gmail").await {
        Some(t) => t,
        None => {
            return Ok(Json(MsgResp {
                ok: false,
                message: Some(
                    "Gmail isn't connected — connect it in Setup → Destination to send.".into(),
                ),
                wired: None,
            }))
        }
    };

    match crate::gmail::send(
        &token,
        &to,
        subject.as_deref().unwrap_or(""),
        body.as_deref().unwrap_or(""),
    )
    .await
    {
        Ok(_) => {
            crate::mark::run(&domain, "sent")?;
            Ok(Json(MsgResp {
                ok: true,
                message: Some(format!("Sent to {to}.")),
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
