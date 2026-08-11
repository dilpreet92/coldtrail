//! Push a reviewed draft into Gmail from the Drafts screen. By default it creates a DRAFT and
//! the human sends by hand (the standing guardrail). If the human enabled `auto_send`, the same
//! click SENDS immediately, under a per-day cap. All of that lives in `crate::deliver`, shared
//! with the `coldtrail send` CLI and the OpenAI `send_outreach` tool.

use axum::extract::{Path, State};
use axum::Json;
use std::sync::Arc;

use super::api::MsgResp;
use super::{ApiErr, AppState};

pub async fn send(
    State(_state): State<Arc<AppState>>,
    Path(domain): Path<String>,
) -> Result<Json<MsgResp>, ApiErr> {
    let domain = domain.to_lowercase();
    let draft = crate::deliver::reviewable(&domain)?;

    let auto = crate::config::load().auto_send;
    let outcome = if auto {
        crate::deliver::send(&domain, &draft).await
    } else {
        crate::deliver::draft(&domain, &draft)
            .await
            .map(|_| "Created in your Gmail Drafts — open Gmail to review and send.".to_string())
    };

    match outcome {
        Ok(message) => Ok(Json(MsgResp {
            ok: true,
            message: Some(message),
            wired: None,
        })),
        Err(e) => Ok(Json(MsgResp {
            ok: false,
            message: Some(e.to_string()),
            wired: None,
        })),
    }
}
