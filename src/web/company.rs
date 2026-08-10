//! The Company canvas: a stateless turn that co-edits a living markdown profile (`product.md`).
//! The browser holds the current doc; each turn we send it plus the founder's latest message,
//! the agent replies in a sentence or two and re-emits the ENTIRE updated doc in a fenced
//! `company-doc` block. Ephemeral (no session/history — the doc IS the memory); tools disabled
//! so it never touches Gmail or the DB. `product.md` is the agent's drafting source of truth.

use axum::extract::State;
use axum::Json;
use std::sync::Arc;
use tokio::sync::mpsc;

use super::api::{ChatResp, CompanyDocReq, CompanyDocResp, CompanyTurnReq};
use super::{ApiErr, AppState};
use crate::provider::cli::Tools;
use crate::provider::{resolve, run_turn, AgentEvent};

const PREAMBLE: &str = "You help a founder build a company/product profile for cold outreach, \
kept as a living markdown document. You are given the CURRENT document and the founder's latest \
message. Do two things, in order:\n\
(1) Reply in 1-2 short, warm sentences — acknowledge what they said and ask ONE next question to \
fill a gap. Cover, over the conversation: what the product does and who it's for, the concrete \
pain/value, any proof or differentiator, the offer, the call-to-action link, their name/sign-off, \
and voice/tone.\n\
(2) Output the ENTIRE updated document inside one fenced block, LAST, with nothing after it:\n\
```company-doc\n<full markdown document>\n```\n\
Rules: capture ONLY facts the founder gave — never invent claims. Preserve everything already in \
the document unless they correct it; slot each new fact into the right section. If the CTA link \
has a `utm_content={slug}` placeholder, keep it. Keep it well-structured markdown under a short \
heading. Do NOT run any commands or tools — this is a conversation only.";

/// Assemble the single-turn prompt: preamble + current doc + latest message. Pure, for testing.
fn build_prompt(doc: &str, message: &str) -> String {
    let mut s = String::from(PREAMBLE);
    s.push_str("\n\n--- current document ---\n");
    s.push_str(if doc.trim().is_empty() {
        "(empty — the document has not been started)"
    } else {
        doc.trim()
    });
    s.push_str("\n\n--- the founder just said ---\n");
    if message.trim().is_empty() {
        s.push_str("(they just opened the page — greet them in one line, ask your first question, and put an initial skeleton document, with section headings and empty values, in the company-doc block)");
    } else {
        s.push_str(message.trim());
    }
    s
}

/// How long an unclaimed run lingers before eviction (mirrors chat.rs).
const RUN_TTL: std::time::Duration = std::time::Duration::from_secs(45);

pub async fn turn(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CompanyTurnReq>,
) -> Result<Json<ChatResp>, ApiErr> {
    let home = crate::home::workspace()?;
    let prompt = build_prompt(&req.doc, &req.message);

    let run_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<AgentEvent>(128);
    state.runs.lock().await.insert(run_id.clone(), rx);

    let st = state.clone();
    tokio::spawn(async move {
        let _turn = st.turn_lock.lock().await; // serialize with chat turns on one session
        let backend = resolve();
        // Fresh, ephemeral session — no resume, no persistence. Tools off so the agent can't
        // run coldtrail commands / touch Gmail during the conversation.
        let sid = uuid::Uuid::new_v4().to_string();
        let tools = Tools::Disallow(&["Bash", "mcp__gmail", "mcp__canonical"]);
        let _ = run_turn(&backend, &sid, true, &prompt, &home, &tools, tx).await;
    });

    // Reaper: evict if the browser never opens the stream (mirrors chat.rs).
    let st2 = state.clone();
    let rid = run_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(RUN_TTL).await;
        st2.runs.lock().await.remove(&rid);
    });

    Ok(Json(ChatResp { run: run_id }))
}

/// Load the current company profile (`product.md`), or empty if none yet.
pub async fn get_doc() -> Result<Json<CompanyDocResp>, ApiErr> {
    let doc = crate::home::path("product.md")
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    Ok(Json(CompanyDocResp { doc }))
}

/// Save the company profile (`product.md`). Used by auto-save after a turn and by hand-edits.
pub async fn save_doc(Json(req): Json<CompanyDocReq>) -> Result<Json<super::api::MsgResp>, ApiErr> {
    std::fs::write(crate::home::path("product.md")?, req.doc.trim_start())?;
    Ok(Json(super::api::MsgResp::ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_opens_with_a_greeting_and_skeleton() {
        let p = build_prompt("", "");
        assert!(p.contains("company-doc"));
        assert!(p.contains("has not been started"));
        assert!(p.contains("just opened the page"));
    }

    #[test]
    fn includes_current_doc_and_message() {
        let p = build_prompt("# Acme\n\n**Offer:** free trial", "we help ops teams");
        assert!(p.contains("# Acme"));
        assert!(p.contains("free trial"));
        assert!(p.contains("we help ops teams"));
        assert!(p.contains("company-doc"));
    }
}
