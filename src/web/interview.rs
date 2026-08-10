//! The product interview: a stateless, transcript-carrying agent turn. The browser holds the
//! running conversation and re-sends it each turn; we prepend a fixed preamble and run one
//! ephemeral turn (no session, no history), streamed over the shared /api/chat/stream.
//! Tools are disabled — it's a pure conversation that never touches Gmail or the DB.

use axum::extract::State;
use axum::Json;
use std::sync::Arc;
use tokio::sync::mpsc;

use super::api::{ChatResp, InterviewReq, TranscriptTurn};
use super::{ApiErr, AppState};
use crate::provider::cli::Tools;
use crate::provider::{resolve, run_turn, AgentEvent};

const PREAMBLE: &str = "You are helping a founder describe their product so coldtrail can write \
cold outreach. Interview them warmly and briefly — ask ONE short question at a time. Capture \
only what they tell you; never invent claims. Cover: what the product is and who it helps, the \
concrete pain/value, any proof or differentiator, the offer (optional), the call-to-action link, \
their name/sign-off, and voice/tone. After enough (usually 4-6 exchanges), stop asking, write one \
short line like \"Here's what I've got — review and tweak below.\", then output EXACTLY one fenced \
block and nothing after it:\n\
```coldtrail-brief\n\
{\"product\":\"\",\"value\":\"\",\"pain_value\":\"\",\"proof\":\"\",\"offer\":\"\",\"voice\":\"\",\"link\":\"\",\"sender\":\"\"}\n\
```\n\
Fill each field from the conversation; use \"\" for anything not provided. `value` = what it does \
and who it helps. Do NOT run any commands or tools — this is a conversation only.";

/// Assemble the single-turn prompt: preamble + the running transcript. Pure, for testing.
fn build_prompt(transcript: &[TranscriptTurn]) -> String {
    let mut s = String::from(PREAMBLE);
    if transcript.is_empty() {
        s.push_str("\n\n--- The conversation has not started. Greet the founder in one line and ask your first question. ---");
        return s;
    }
    s.push_str("\n\n--- conversation so far ---\n");
    for t in transcript {
        let who = if t.role == "assistant" {
            "you"
        } else {
            "founder"
        };
        s.push_str(&format!("{who}: {}\n", t.text.trim()));
    }
    s.push_str("\nContinue: ask the next short question, or if you have enough, output the coldtrail-brief block now.");
    s
}

/// How long an unclaimed run lingers before eviction (mirrors chat.rs).
const RUN_TTL: std::time::Duration = std::time::Duration::from_secs(45);

pub async fn start(
    State(state): State<Arc<AppState>>,
    Json(req): Json<InterviewReq>,
) -> Result<Json<ChatResp>, ApiErr> {
    let home = crate::home::workspace()?;
    let prompt = build_prompt(&req.transcript);

    let run_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<AgentEvent>(128);
    state.runs.lock().await.insert(run_id.clone(), rx);

    let st = state.clone();
    tokio::spawn(async move {
        let _turn = st.turn_lock.lock().await; // serialize with chat turns on one session
        let backend = resolve();
        // Fresh, ephemeral session every turn — no resume, no persistence. Tools off so the
        // agent can't run coldtrail commands / touch Gmail during the interview.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_transcript_prompts_a_greeting() {
        let p = build_prompt(&[]);
        assert!(p.contains("coldtrail-brief"));
        assert!(p.contains("has not started"));
    }

    #[test]
    fn transcript_is_rendered_with_roles() {
        let t = vec![
            TranscriptTurn {
                role: "assistant".into(),
                text: "What do you sell?".into(),
            },
            TranscriptTurn {
                role: "user".into(),
                text: "A company search tool.".into(),
            },
        ];
        let p = build_prompt(&t);
        assert!(p.contains("you: What do you sell?"));
        assert!(p.contains("founder: A company search tool."));
    }
}
