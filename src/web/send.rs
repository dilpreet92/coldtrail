//! Push a reviewed draft into Gmail as a DRAFT (never sends), via coldtrail's OWN
//! `gmail.compose` OAuth token — the same on every backend, not the provider's connector.
//! The human opens Gmail and sends by hand (the standing guardrail).

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

    let token = match crate::oauth::valid_access("gmail").await {
        Some(t) => t,
        None => {
            return Ok(Json(MsgResp {
                ok: false,
                message: Some(
                    "Gmail isn't connected — connect it in Settings → Destination.".into(),
                ),
                wired: None,
            }))
        }
    };

    match crate::gmail::create_draft(
        &token,
        &to,
        subject.as_deref().unwrap_or(""),
        body.as_deref().unwrap_or(""),
    )
    .await
    {
        Ok(draft_id) => {
            // Record the gmail draft id + status='drafted' (mark's default arm).
            let id = if draft_id.is_empty() { "gmail" } else { &draft_id };
            crate::mark::run(&domain, id)?;
            Ok(Json(MsgResp {
                ok: true,
                message: Some("Created in your Gmail Drafts — open Gmail to review and send.".into()),
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
