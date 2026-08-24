//! One unattended cycle: plan queries from product.md + history, source -> enrich -> draft, and
//! (only if auto_send) send within the daily cap. Always returns Ok after recording an outcome so
//! the OS timer never loops on failure. This is what `coldtrail run` and the scheduler invoke.
use crate::provider::cli::Tools;
use crate::provider::{resolve, run_turn, AgentEvent, GMAIL_TOOL};
use anyhow::Result;

#[allow(dead_code)] // wired into `coldtrail run` / the scheduler by the next task
pub fn brief() -> String {
    "This is an automated scheduled run — no human is watching, so don't ask questions; act. \
     Read product.md and the workspace history. Plan 3–5 fresh, genuinely diverse angles that \
     AVOID companies already sourced or contacted. Run the full loop: source → enrich (prefer your \
     own web tools) → draft, generously; report coverage. If config.toml has auto_send = true, \
     send the drafts with `coldtrail send <domain>` up to the remaining daily cap; otherwise leave \
     them as drafts for review. Never exceed the cap; never re-contact a known domain."
        .to_string()
}

#[allow(dead_code)] // wired into `coldtrail run` / the scheduler by the next task
pub async fn run_once() -> Result<()> {
    crate::db::init()?;
    let backend = resolve();

    // Auth gate first — a doomed turn helps no one. Record + bail cleanly if not signed in.
    match crate::probe::probe(&backend).await {
        crate::probe::Outcome::Ok => {}
        crate::probe::Outcome::Failed(m) => {
            crate::logf::log(&format!(
                "scheduled run skipped: provider not signed in ({m})"
            ));
            let z = crate::db::Counts {
                companies: 0,
                contacts: 0,
                outreach: 0,
                sent_today: 0,
            };
            let _ = crate::db::record_run("auth_failed", z, z, None, Some(&m));
            return Ok(());
        }
        crate::probe::Outcome::TimedOut => {
            crate::logf::log("scheduled run skipped: provider auth probe timed out");
            let z = crate::db::Counts {
                companies: 0,
                contacts: 0,
                outreach: 0,
                sent_today: 0,
            };
            let _ = crate::db::record_run("auth_failed", z, z, None, Some("auth probe timed out"));
            return Ok(());
        }
    }

    let home = crate::home::workspace()?;
    let before = {
        let c = crate::db::open()?;
        crate::db::counts(&c)?
    };
    // Title is just "Scheduled run" — the chat list already shows each row's timestamp
    // (updated_at), so no date crate is needed here.
    let (chat_id, agent_sid) = crate::chat_store::create_session("Scheduled run")?;
    crate::chat_store::insert_message(&chat_id, "user", &brief());
    crate::logf::log(&format!("scheduled run started (chat {chat_id})"));

    // Drive one turn; accumulate the reply + capture a provider session id; log events.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<AgentEvent>(128);
    let tools = Tools::Disallow(&[GMAIL_TOOL]);
    let msg = brief();
    let turn = run_turn(&backend, &agent_sid, true, &msg, &home, &tools, tx);
    let mut assistant = String::new();
    let mut new_session: Option<String> = None;
    let drain = async {
        while let Some(ev) = rx.recv().await {
            match &ev {
                AgentEvent::Text { text } => assistant.push_str(text),
                AgentEvent::Session { id } => new_session = Some(id.clone()),
                AgentEvent::ToolStart { name, .. } => crate::logf::log(&format!("  tool: {name}")),
                AgentEvent::Error { message } => crate::logf::log(&format!("  error: {message}")),
                _ => {}
            }
        }
    };
    let (ok, ()) = tokio::join!(turn, drain);

    if let Some(sid) = &new_session {
        crate::chat_store::set_agent_session(&chat_id, sid);
    }
    if !assistant.trim().is_empty() {
        crate::chat_store::insert_message(&chat_id, "assistant", assistant.trim());
    }

    let after = {
        let c = crate::db::open()?;
        crate::db::counts(&c)?
    };
    let status = if ok { "ok" } else { "error" };
    crate::db::record_run(status, before, after, Some(&chat_id), None)?;
    crate::logf::log(&format!(
        "scheduled run {status}: sourced {} · contacts {} · drafts {} · sent {}",
        (after.companies - before.companies).max(0),
        (after.contacts - before.contacts).max(0),
        (after.outreach - before.outreach).max(0),
        (after.sent_today - before.sent_today).max(0),
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brief_mentions_history_and_the_send_gate() {
        let b = brief();
        assert!(b.contains("automated scheduled run"));
        assert!(b.to_lowercase().contains("avoid")); // history-aware
        assert!(b.contains("auto_send")); // the gate
    }

    // Happy path against a mock OpenAI backend: run_once writes a scheduled_runs row + a chat.
    // Async temp-home pattern mirrors src/provider/openai.rs::loop_runs_tool_then_finishes —
    // testutil::with_home is sync-only, so hold env_guard and set COLDTRAIL_HOME manually.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn run_once_records_a_run_and_a_chat() {
        use axum::{routing::post, Json, Router};
        use serde_json::json;

        let _g = crate::testutil::env_guard();
        let home = std::env::temp_dir().join("ct-scheduled-test");
        let _ = std::fs::remove_dir_all(&home);
        std::env::set_var("COLDTRAIL_HOME", &home);

        // mock server that returns a single assistant reply (no tool calls -> turn finishes)
        let app = Router::new().route(
            "/chat/completions",
            post(|_b: String| async {
                Json(json!({"choices":[{"message":{"role":"assistant","content":"done, drafted 0."},"finish_reason":"stop"}]}))
            }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });

        // point config at the mock (agent=openai) so resolve() -> mock, no real network
        crate::config::save(&crate::config::Config {
            agent: Some("openai".into()),
            provider: Some(crate::config::Provider {
                base_url: Some(format!("http://{addr}")),
                model: Some("m".into()),
            }),
            ..Default::default()
        })
        .unwrap();

        run_once().await.unwrap();

        let r = crate::db::last_run().unwrap().unwrap();
        assert_eq!(r.status, "ok");
        assert!(r.chat_id.is_some());
        let c = crate::db::open().unwrap();
        let chats: i64 = c
            .query_row("SELECT COUNT(*) FROM chat_sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(chats, 1);

        std::env::remove_var("COLDTRAIL_HOME");
    }
}
