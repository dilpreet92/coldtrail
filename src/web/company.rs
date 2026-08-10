//! The Company profile: an editable markdown document (`product.md`) — the agent's drafting
//! source of truth. No chat; the founder writes/edits it directly and it auto-saves. Never
//! touches Gmail or the DB.

use axum::Json;

use super::api::{CompanyDocReq, CompanyDocResp};
use super::ApiErr;

/// Load the current company profile (`product.md`), or empty if none yet.
pub async fn get_doc() -> Result<Json<CompanyDocResp>, ApiErr> {
    let doc = crate::home::path("product.md")
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    Ok(Json(CompanyDocResp { doc }))
}

/// Save the company profile (`product.md`). Used by the editor's auto-save.
pub async fn save_doc(Json(req): Json<CompanyDocReq>) -> Result<Json<super::api::MsgResp>, ApiErr> {
    std::fs::write(crate::home::path("product.md")?, req.doc.trim_start())?;
    Ok(Json(super::api::MsgResp::ok()))
}
