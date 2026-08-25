//! One unattended cycle: plan queries from product.md + history, source -> enrich -> draft, and
//! (only if auto_send) send within the daily cap. Always returns Ok after recording an outcome so
//! the OS timer never loops on failure. This is what `coldtrail run` and the scheduler invoke.
use crate::provider::cli::Tools;
use crate::provider::{resolve, run_turn, AgentEvent, GMAIL_TOOL};
use anyhow::Result;

pub fn agent_brief() -> String {
    "This is an automated scheduled run — no human is watching, so don't ask questions; act. \
     Read product.md and the workspace history. Plan 3–5 fresh, genuinely diverse angles that \
     AVOID companies already sourced or contacted. Run the full loop: source → enrich (prefer your \
     own web tools) → draft, generously; report coverage. If config.toml has auto_send = true, \
     send the drafts with `coldtrail send <domain>` up to the remaining daily cap; otherwise leave \
     them as drafts for review. Never exceed the cap; never re-contact a known domain."
        .to_string()
}

pub fn custom_brief(instruction: &str) -> String {
    format!(
        "This is an automated scheduled run — no human is watching, so don't ask questions; act. \
         Your task for this run: {instruction}\n\n\
         Work within coldtrail's loop: source (`coldtrail source`) → enrich (prefer your own web \
         tools) → draft (`coldtrail draft`). Never re-contact a known domain. If config.toml has \
         auto_send = true, you may send with `coldtrail send <domain>` up to the remaining daily \
         cap; otherwise leave drafts for review. Report what you did."
    )
}

/// One unattended cycle, optionally attributed to a schedule and tagged with the trigger that
/// started it ("manual", "cron", "dry", ...). `chat_id`, when given, is a chat the caller
/// (the web run-now endpoint) already pre-created so its UI can open it and watch progress land
/// live; when absent a fresh chat is created here as before. Always returns Ok after recording
/// an outcome so the OS timer never loops on failure.
pub async fn run(schedule_id: Option<&str>, trigger: &str, chat_id: Option<&str>) -> Result<()> {
    let draft_only = trigger == "dry";
    if draft_only {
        std::env::set_var("COLDTRAIL_NO_SEND", "1");
    }
    // Every fallible step below is best-effort: the doc comment above promises this function
    // ALWAYS resolves to Ok, because Task 7 wires it directly to the OS timer — an `Err` here
    // would make the timer loop on a run that otherwise completed fine.
    if let Err(e) = crate::db::init() {
        crate::logf::log(&format!("scheduled run aborted: {e}"));
        if draft_only {
            std::env::remove_var("COLDTRAIL_NO_SEND");
        }
        return Ok(());
    }
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
            let _ =
                crate::db::record_run("auth_failed", z, z, None, Some(&m), schedule_id, trigger);
            if draft_only {
                std::env::remove_var("COLDTRAIL_NO_SEND");
            }
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
            let _ = crate::db::record_run(
                "auth_failed",
                z,
                z,
                None,
                Some("auth probe timed out"),
                schedule_id,
                trigger,
            );
            if draft_only {
                std::env::remove_var("COLDTRAIL_NO_SEND");
            }
            return Ok(());
        }
    }

    let home = match crate::home::workspace() {
        Ok(h) => h,
        Err(e) => {
            crate::logf::log(&format!("scheduled run aborted: {e}"));
            if draft_only {
                std::env::remove_var("COLDTRAIL_NO_SEND");
            }
            return Ok(());
        }
    };

    let zero = crate::db::Counts {
        companies: 0,
        contacts: 0,
        outreach: 0,
        sent_today: 0,
    };
    let before = match crate::db::open().and_then(|c| crate::db::counts(&c)) {
        Ok(c) => c,
        Err(e) => {
            crate::logf::log(&format!(
                "scheduled run: before-snapshot failed, assuming zero counts: {e}"
            ));
            zero
        }
    };
    let (title, mut msg) =
        match schedule_id.and_then(|id| crate::db::get_schedule(id).ok().flatten()) {
            Some(s) if s.task_mode == "custom" => (
                format!("Scheduled run — {}", s.name),
                custom_brief(s.prompt.as_deref().unwrap_or("")),
            ),
            Some(s) => (format!("Scheduled run — {}", s.name), agent_brief()),
            None => ("Manual run".to_string(), agent_brief()),
        };
    if draft_only {
        msg = format!("DRY RUN — do NOT send anything; produce drafts only.\n\n{msg}");
    }
    let (chat_id, agent_sid) = match chat_id {
        Some(id) => {
            let cid = id.to_string();
            let asid = uuid::Uuid::new_v4().to_string();
            // The web pre-creates this row; if it's somehow absent, create it now.
            if let Ok(c) = crate::db::open() {
                let _ = c.execute(
                    "INSERT OR IGNORE INTO chat_sessions (id, agent_session_id, title) \
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![cid, asid, title],
                );
            }
            (cid, asid)
        }
        None => match crate::chat_store::create_session(&title) {
            Ok(v) => v,
            Err(e) => {
                crate::logf::log(&format!("scheduled run aborted: {e}"));
                if draft_only {
                    std::env::remove_var("COLDTRAIL_NO_SEND");
                }
                return Ok(());
            }
        },
    };
    crate::chat_store::insert_message(&chat_id, "user", &msg);
    let _ = crate::db::set_chat_running(&chat_id, true);
    crate::logf::log(&format!("scheduled run started (chat {chat_id})"));

    // Drive one turn; accumulate the reply + capture a provider session id; log events. Text
    // and tool events are persisted as they arrive so the chat UI can show live progress.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<AgentEvent>(128);
    let tools = Tools::Disallow(&[GMAIL_TOOL]);
    let turn = run_turn(&backend, &agent_sid, true, &msg, &home, &tools, tx);
    let mut assistant = String::new();
    let mut new_session: Option<String> = None;
    let mut live_id: i64 = 0;
    let drain = async {
        while let Some(ev) = rx.recv().await {
            match &ev {
                AgentEvent::Text { text } => {
                    assistant.push_str(text);
                    if live_id == 0 {
                        live_id = crate::chat_store::insert_returning_id(
                            &chat_id,
                            "assistant",
                            assistant.trim(),
                        );
                    } else {
                        crate::chat_store::update_content(live_id, assistant.trim());
                    }
                }
                AgentEvent::Session { id } => new_session = Some(id.clone()),
                AgentEvent::ToolStart { name, .. } => {
                    crate::chat_store::insert_message(&chat_id, "tool", name);
                    crate::logf::log(&format!("  tool: {name}"));
                }
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
        if live_id == 0 {
            crate::chat_store::insert_returning_id(&chat_id, "assistant", assistant.trim());
        } else {
            crate::chat_store::update_content(live_id, assistant.trim());
        }
    }

    let after = match crate::db::open().and_then(|c| crate::db::counts(&c)) {
        Ok(c) => c,
        Err(e) => {
            crate::logf::log(&format!(
                "scheduled run: after-snapshot failed, deltas will read as zero: {e}"
            ));
            before
        }
    };
    let status = if ok { "ok" } else { "error" };
    if let Err(e) = crate::db::record_run(
        status,
        before,
        after,
        Some(&chat_id),
        None,
        schedule_id,
        trigger,
    ) {
        crate::logf::log(&format!("scheduled run: failed to record outcome: {e}"));
    }
    crate::logf::log(&format!(
        "scheduled run {status}: sourced {} · contacts {} · drafts {} · sent {}",
        (after.companies - before.companies).max(0),
        (after.contacts - before.contacts).max(0),
        (after.outreach - before.outreach).max(0),
        (after.sent_today - before.sent_today).max(0),
    ));
    let _ = crate::db::set_chat_running(&chat_id, false);
    if draft_only {
        std::env::remove_var("COLDTRAIL_NO_SEND");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brief_mentions_history_and_the_send_gate() {
        let b = agent_brief();
        assert!(b.contains("automated scheduled run"));
        assert!(b.to_lowercase().contains("avoid")); // history-aware
        assert!(b.contains("auto_send")); // the gate
    }

    #[test]
    fn briefs_carry_guardrails_and_instruction() {
        assert!(agent_brief().contains("automated"));
        assert!(agent_brief().to_lowercase().contains("avoid"));
        let c = custom_brief("web-search fintech founders in London");
        assert!(c.contains("web-search fintech founders in London")); // the instruction is embedded
        assert!(c.to_lowercase().contains("auto_send") || c.to_lowercase().contains("send only"));
        assert!(c.to_lowercase().contains("don't ask") || c.to_lowercase().contains("do not ask"));
    }

    // Happy path against a mock OpenAI backend: run() writes a scheduled_runs row + a chat.
    // Async temp-home pattern mirrors src/provider/openai.rs::loop_runs_tool_then_finishes —
    // testutil::with_home is sync-only, so hold env_guard and set COLDTRAIL_HOME manually.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn run_records_a_run_and_a_chat() {
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

        run(None, "manual", None).await.unwrap();

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

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn run_custom_schedule_uses_the_prompt_and_records_trigger() {
        use axum::{routing::post, Json, Router};
        use serde_json::json;
        let _g = crate::testutil::env_guard();
        let home = std::env::temp_dir().join("ct-run-custom");
        let _ = std::fs::remove_dir_all(&home);
        std::env::set_var("COLDTRAIL_HOME", &home);
        let app = Router::new().route(
            "/chat/completions",
            post(|_b: String| async {
                Json(json!({"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}))
            }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        crate::config::save(&crate::config::Config {
            agent: Some("openai".into()),
            provider: Some(crate::config::Provider {
                base_url: Some(format!("http://{addr}")),
                model: Some("m".into()),
            }),
            ..Default::default()
        })
        .unwrap();
        crate::db::init().unwrap();
        crate::db::upsert_schedule(&crate::db::Schedule {
            id: "s1".into(),
            name: "FT".into(),
            enabled: true,
            freq: "daily".into(),
            time: "09:00".into(),
            weekday: None,
            task_mode: "custom".into(),
            prompt: Some("XYZZY-marker instruction".into()),
        })
        .unwrap();

        run(Some("s1"), "manual", None).await.unwrap();

        let runs = crate::db::list_runs(10).unwrap();
        assert_eq!(runs[0].trigger.as_deref(), Some("manual"));
        assert_eq!(runs[0].schedule_id.as_deref(), Some("s1"));
        // the custom instruction reached the chat as the user message
        let c = crate::db::open().unwrap();
        let msg: String = c
            .query_row(
                "SELECT content FROM chat_messages WHERE role='user' ORDER BY id LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(msg.contains("XYZZY-marker instruction"));
        std::env::remove_var("COLDTRAIL_HOME");
    }

    // Drives a tool call then a finishing reply — mirrors
    // src/provider/openai.rs::loop_runs_tool_then_finishes — so the run produces both a
    // ToolStart (persisted as a role='tool' row) and Text (persisted as a live-updated
    // role='assistant' row), and asserts `chat_sessions.running` ends at 0.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn run_persists_progress_and_clears_running() {
        use axum::{routing::post, Json, Router};
        use serde_json::json;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let _g = crate::testutil::env_guard();
        let home = std::env::temp_dir().join("ct-scheduled-progress-test");
        let _ = std::fs::remove_dir_all(&home);
        std::env::set_var("COLDTRAIL_HOME", &home);

        // mock server. Call 0 is `scheduled::run`'s own auth probe (a throwaway "reply with
        // ok" turn) — answer it directly so it doesn't eat the tool-call turn below. Call 1
        // (the real turn's first request) -> a tool_call; call 2 -> content+stop. Same
        // tool_call/content shape as provider::openai's loop_runs_tool_then_finishes.
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = n.clone();
        let app = Router::new().route(
            "/chat/completions",
            post(move |_b: String| {
                let n = n2.clone();
                async move {
                    let i = n.fetch_add(1, Ordering::SeqCst);
                    if i == 0 {
                        Json(json!({"choices":[{"message":{"role":"assistant","content":"ok"},
                            "finish_reason":"stop"}]}))
                    } else if i == 1 {
                        Json(json!({"choices":[{"message":{"role":"assistant","content":null,
                            "tool_calls":[{"id":"c1","type":"function",
                            "function":{"name":"list_companies","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}))
                    } else {
                        Json(json!({"choices":[{"message":{"role":"assistant","content":"All set."},
                            "finish_reason":"stop"}]}))
                    }
                }
            }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });

        crate::config::save(&crate::config::Config {
            agent: Some("openai".into()),
            provider: Some(crate::config::Provider {
                base_url: Some(format!("http://{addr}")),
                model: Some("m".into()),
            }),
            ..Default::default()
        })
        .unwrap();
        crate::db::init().unwrap();

        run(None, "manual", None).await.unwrap();

        let r = crate::db::last_run().unwrap().unwrap();
        let chat_id = r.chat_id.expect("run recorded a chat");

        let c = crate::db::open().unwrap();
        let tool_rows: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM chat_messages WHERE session_id=?1 AND role='tool'",
                [&chat_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(tool_rows >= 1, "expected a persisted tool row");
        let assistant: String = c
            .query_row(
                "SELECT content FROM chat_messages WHERE session_id=?1 AND role='assistant' \
                 ORDER BY id DESC LIMIT 1",
                [&chat_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(assistant.contains("All set"));
        let running: i64 = c
            .query_row(
                "SELECT running FROM chat_sessions WHERE id=?1",
                [&chat_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(running, 0);

        std::env::remove_var("COLDTRAIL_HOME");
    }
}
