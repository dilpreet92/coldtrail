//! One unattended cycle: plan queries from product.md + history, source -> enrich -> draft, and
//! send within the caps — emails if auto_send, LinkedIn (via `send-pending linkedin`) if
//! linkedin_auto_send. Always returns Ok after recording an outcome so
//! the OS timer never loops on failure. This is what `coldtrail run` and the scheduler invoke.
use crate::provider::cli::Tools;
use crate::provider::{resolve, run_turn, AgentEvent, GMAIL_TOOL};
use anyhow::Result;

pub fn agent_brief() -> String {
    "This is an automated scheduled run — no human is watching, so don't ask questions; act. \
     Read product.md and the workspace history. Plan 3–5 fresh, genuinely diverse angles that \
     AVOID companies already sourced or contacted. Run the full loop: source → enrich (prefer your \
     own web tools) → draft, generously; report coverage. If config.toml has auto_send = true, \
     send the EMAIL drafts with `coldtrail send <domain> --channel email` up to the remaining \
     daily cap. If config.toml has linkedin_auto_send = true, ALSO send the LinkedIn drafts by \
     running `coldtrail send-pending linkedin` once — it drives the connected LinkedIn browser \
     one at a time, paced, and stops on its own at the daily cap. Otherwise leave drafts for \
     review. Never exceed a cap; never re-contact a known domain."
        .to_string()
}

pub fn custom_brief(instruction: &str) -> String {
    format!(
        "This is an automated scheduled run — no human is watching, so don't ask questions; act. \
         Your task for this run: {instruction}\n\n\
         Work within coldtrail's loop: source (`coldtrail source`) → enrich (prefer your own web \
         tools) → draft (`coldtrail draft` for email; `coldtrail linkedin-note` for LinkedIn-only \
         contacts). Never re-contact a known domain. If config.toml has auto_send = true, you may \
         send the email drafts with `coldtrail send <domain> --channel email` up to the remaining \
         daily cap; if linkedin_auto_send = true, ALSO run `coldtrail send-pending linkedin` once \
         (paced, daily-capped) to send the LinkedIn drafts. Otherwise leave drafts for review. \
         Report what you did."
    )
}

/// A run's claim on the chat it writes to: an advisory lock on `.run-locks/<chat id>.lock`,
/// held for as long as `run` works on that chat. The OS drops the lock when the process ends,
/// however it ends (Ctrl+C in the serve terminal, a kill, a shutdown), so a `running` flag a
/// dead run never cleared can be told from a run still going. The file goes with the claim.
pub struct RunLock {
    _file: std::fs::File,
    path: std::path::PathBuf,
}

impl Drop for RunLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// The lock file for `chat_id`; None for an id that isn't a plain uuid-like token.
fn run_lock_path(chat_id: &str) -> Option<std::path::PathBuf> {
    let plain = !chat_id.is_empty()
        && chat_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !plain {
        return None;
    }
    Some(
        crate::home::path(".run-locks")
            .ok()?
            .join(format!("{chat_id}.lock")),
    )
}

/// Take `chat_id`'s run lock. It is locked under a temporary name and then moved into place,
/// so the lock file never exists unlocked while its run is alive: one found unlocked was left
/// by a run that died. (fs2's methods are called by path: std is gaining same-named ones.)
pub fn hold_run_lock(chat_id: &str) -> Result<RunLock> {
    let path = run_lock_path(chat_id).ok_or_else(|| anyhow::anyhow!("bad chat id {chat_id:?}"))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("lock.{}", std::process::id()));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&tmp)?;
    fs2::FileExt::lock_exclusive(&file)?;
    std::fs::rename(&tmp, &path)?;
    Ok(RunLock { _file: file, path })
}

/// What `chat_id`'s run lock says about its run.
#[derive(Debug, PartialEq)]
enum Claim {
    /// No lock file: the run hasn't started yet (or finished cleanly).
    None,
    /// A live run holds the lock.
    Held,
    /// The file is there but nothing holds it: the run died.
    Abandoned,
}

fn claim_of(chat_id: &str) -> Claim {
    let Some(file) = run_lock_path(chat_id).and_then(|p| std::fs::File::open(p).ok()) else {
        return Claim::None;
    };
    match fs2::FileExt::try_lock_shared(&file) {
        Ok(()) => {
            let _ = fs2::FileExt::unlock(&file);
            Claim::Abandoned
        }
        Err(_) => Claim::Held,
    }
}

/// A conversation a run is writing to right now.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveRun {
    pub chat_id: String,
    pub title: String,
    /// The schedule the run runs; None for a manual `coldtrail run` (or a chat flagged before
    /// runs recorded it).
    pub schedule_id: Option<String>,
}

/// The note on a run that died before it finished, as its run history row says it.
pub const DIED_NOTE: &str =
    "The run stopped before it finished, because coldtrail or this computer stopped while it was working.";

/// Chats a run is writing to right now, most recently updated first. A chat flagged `running`
/// counts while its run holds the run lock. Before the lock exists it counts for a short grace
/// after the chat was made, since Run now flags its chat before the `coldtrail run` it spawns
/// has started. A run that died mid-turn leaves the flag set, but its lock released (or, if it
/// died before starting, the grace runs out): it is recorded once as a failed run
/// (`record_dead_run`), so Schedules, Home and its chat say it stopped.
pub fn running_chats(c: &rusqlite::Connection) -> Result<Vec<LiveRun>> {
    let mut stmt = c.prepare(
        "SELECT id, COALESCE(title,''), schedule_id, \
                COALESCE(created_at > datetime('now','-2 minutes'), 0) \
         FROM chat_sessions WHERE running = 1 \
         ORDER BY updated_at DESC, created_at DESC, rowid DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                LiveRun {
                    chat_id: r.get(0)?,
                    title: r.get(1)?,
                    schedule_id: r.get(2)?,
                },
                r.get::<_, bool>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut live = Vec::new();
    for (run, just_made) in rows {
        let alive = match claim_of(&run.chat_id) {
            Claim::Held => true,
            Claim::None => just_made,
            Claim::Abandoned => false,
        };
        if alive {
            live.push(run);
        } else if let Err(e) = record_dead_run(c, &run.chat_id) {
            crate::logf::log(&format!(
                "recording the run that died in chat {}: {e}",
                run.chat_id
            ));
        }
    }
    Ok(live)
}

/// Record any run that died (see `running_chats`), before the run history is read.
pub fn reap_dead_runs(c: &rusqlite::Connection) -> Result<()> {
    running_chats(c).map(drop)
}

/// Record the run that died in `chat_id` (its flag set, nothing holding its claim) as a failed
/// run at the time it last wrote, with the schedule and trigger its chat carries, and clear the
/// flag and the lock file it left. Once only: a later look finds the flag cleared, and a run
/// that recorded its own outcome before dying keeps that row.
fn record_dead_run(c: &rusqlite::Connection, chat_id: &str) -> Result<()> {
    let tx = c.unchecked_transaction()?;
    let cleared = tx.execute(
        "UPDATE chat_sessions SET running = 0 WHERE id = ?1 AND running = 1",
        [chat_id],
    )?;
    if cleared > 0 {
        tx.execute(
            "INSERT INTO scheduled_runs (started_at, finished_at, status, chat_id, note, schedule_id, trigger) \
             SELECT COALESCE(updated_at, created_at, datetime('now')), \
                    COALESCE(updated_at, created_at, datetime('now')), 'error', id, ?2, schedule_id, run_trigger \
             FROM chat_sessions WHERE id = ?1 \
               AND NOT EXISTS (SELECT 1 FROM scheduled_runs WHERE chat_id = ?1)",
            rusqlite::params![chat_id, DIED_NOTE],
        )?;
    }
    tx.commit()?;
    if let Some(path) = run_lock_path(chat_id) {
        if claim_of(chat_id) == Claim::Abandoned {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

/// Record a run that never started because the provider check before it failed, and clear
/// the pre-created chat's running flag. Only a failure that looks like a sign-in problem is
/// `auth_failed` (the UI sends the user to sign the agent in again); anything else — a
/// deprecated model, a provider outage, a timeout — is a plain `error`. Either way the
/// provider's message is the run's note.
fn record_probe_failure(
    note: &str,
    precreated: Option<&str>,
    schedule_id: Option<&str>,
    trigger: &str,
) {
    let status = if crate::probe::looks_like_auth(note) {
        crate::logf::log(&format!(
            "scheduled run skipped: provider not signed in ({note})"
        ));
        "auth_failed"
    } else {
        crate::logf::log(&format!(
            "scheduled run skipped: provider check failed ({note})"
        ));
        "error"
    };
    let z = crate::db::Counts {
        companies: 0,
        contacts: 0,
        outreach: 0,
        sent_today: 0,
    };
    let _ = crate::db::record_run(status, z, z, precreated, Some(note), schedule_id, trigger);
    if let Some(id) = precreated {
        let _ = crate::db::set_chat_running(id, false);
    }
}

/// Why a run's turn failed, for its run history note: the agent's own errors (each once),
/// else the last thing it said, else a plain reason.
fn failure_note(errors: &[String], reply: &str) -> String {
    if !errors.is_empty() {
        return errors.join("\n");
    }
    reply
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "The agent's turn ended with an error and gave no reason.".to_string())
}

/// One unattended cycle, optionally attributed to a schedule and tagged with the trigger that
/// started it ("manual", "cron", "dry", ...). `chat_id`, when given, is a chat the caller
/// (the web run-now endpoint) already pre-created so its UI can open it and watch progress land
/// live; when absent a fresh chat is created here as before. Always returns Ok after recording
/// an outcome so the OS timer never loops on failure.
pub async fn run(schedule_id: Option<&str>, trigger: &str, chat_id: Option<&str>) -> Result<()> {
    // The web run-now endpoint pre-creates the chat and marks it running=1 BEFORE spawning this
    // subprocess, so its UI can open the chat and poll for live progress. If we abort below
    // before reaching the point where `running` is normally cleared (the provider and workspace
    // checks all happen before that), we must clear it ourselves or the pre-created chat is
    // stuck "running" forever with zero messages and the UI polls it indefinitely.
    let precreated = chat_id;
    // Claim the pre-created chat first thing, so it never reads as a dead run while this one
    // is alive; it is released however this process ends. A fresh chat is claimed below.
    let mut claim = precreated.and_then(|id| hold_run_lock(id).ok());
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

    // Provider check first — a doomed turn helps no one. Record + bail cleanly if the provider
    // can't answer (not signed in, a deprecated model, an outage, ...).
    let failure = match crate::probe::probe(&backend).await {
        crate::probe::Outcome::Ok => None,
        crate::probe::Outcome::Failed(m) => Some(m),
        crate::probe::Outcome::TimedOut => {
            Some("the agent didn't answer a test prompt within 60 seconds".to_string())
        }
    };
    if let Some(note) = failure {
        record_probe_failure(&note, precreated, schedule_id, trigger);
        if draft_only {
            std::env::remove_var("COLDTRAIL_NO_SEND");
        }
        return Ok(());
    }

    let home = match crate::home::workspace() {
        Ok(h) => h,
        Err(e) => {
            crate::logf::log(&format!("scheduled run aborted: {e}"));
            if let Some(id) = precreated {
                let _ = crate::db::set_chat_running(id, false);
            }
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
    if claim.is_none() {
        claim = hold_run_lock(&chat_id).ok();
    }
    let _ = crate::db::set_chat_run(&chat_id, schedule_id, trigger);
    crate::logf::log(&format!("scheduled run started (chat {chat_id})"));

    // Drive one turn; accumulate the reply + capture a provider session id; log events. Text
    // and tool events are persisted as they arrive so the chat UI can show live progress.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<AgentEvent>(128);
    let tools = Tools::Disallow(&[GMAIL_TOOL]);
    let turn = run_turn(&backend, &agent_sid, true, &msg, &home, &tools, tx);
    let mut assistant = String::new();
    let mut errors: Vec<String> = Vec::new();
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
                AgentEvent::Error { message } => {
                    crate::logf::log(&format!("  error: {message}"));
                    let m = message.trim();
                    if !m.is_empty() && !errors.iter().any(|e| e == m) {
                        errors.push(m.to_string());
                    }
                }
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
    let note = (!ok).then(|| failure_note(&errors, &assistant));
    if let Err(e) = crate::db::record_run(
        status,
        before,
        after,
        Some(&chat_id),
        note.as_deref(),
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
    drop(claim);
    if draft_only {
        std::env::remove_var("COLDTRAIL_NO_SEND");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse;

    #[test]
    fn brief_mentions_history_and_the_send_gate() {
        let b = agent_brief();
        assert!(b.contains("automated scheduled run"));
        assert!(b.to_lowercase().contains("avoid")); // history-aware
        assert!(b.contains("auto_send")); // the email gate
        assert!(b.contains("linkedin_auto_send")); // the LinkedIn gate
        assert!(b.contains("send-pending linkedin")); // the LinkedIn bulk sender
                                                      // Email sends name their channel: a LinkedIn note waiting beside an email isn't sent.
        assert!(b.contains("`coldtrail send <domain> --channel email`"));
        assert!(custom_brief("x").contains("`coldtrail send <domain> --channel email`"));
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
        // The run's chat knows its schedule and trigger, for Schedules' running row and for
        // recording the run should it die.
        let chat: (Option<String>, Option<String>) = c
            .query_row(
                "SELECT schedule_id, run_trigger FROM chat_sessions WHERE id=?1",
                [runs[0].chat_id.as_deref().unwrap()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(chat, (Some("s1".into()), Some("manual".into())));
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

    /// A run claims its chat for the whole turn, so the chat counts as running long after the
    /// start-up grace; the claim (and its lock file) goes when the run ends. A chat flagged
    /// `running` with no claim past the grace is a run that died, and doesn't count.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn run_claims_its_chat_while_it_runs() {
        use axum::{routing::post, Json, Router};
        use serde_json::json;
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::Arc;

        let _g = crate::testutil::env_guard();
        let home = std::env::temp_dir().join("ct-run-claim");
        let _ = std::fs::remove_dir_all(&home);
        std::env::set_var("COLDTRAIL_HOME", &home);

        // Call 0 is the provider probe; call 1 is the real turn, which records what
        // `running_chats` says while the run is under way.
        let n = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(AtomicBool::new(false));
        let (n2, seen2) = (n.clone(), seen.clone());
        let app = Router::new().route(
            "/chat/completions",
            post(move |_b: String| {
                let (n, seen) = (n2.clone(), seen2.clone());
                async move {
                    if n.fetch_add(1, Ordering::SeqCst) == 1 {
                        let c = crate::db::open().unwrap();
                        let ids: Vec<String> = running_chats(&c)
                            .unwrap()
                            .into_iter()
                            .map(|r| r.chat_id)
                            .collect();
                        seen.store(ids == ["pc"], Ordering::SeqCst);
                    }
                    Json(
                        json!({"choices":[{"message":{"role":"assistant","content":"ok"},
                        "finish_reason":"stop"}]}),
                    )
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

        // Run now's pre-created chat, made long enough ago that only the claim keeps it live,
        // and a chat a dead run left flagged.
        let c = crate::db::open().unwrap();
        c.execute_batch(
            "INSERT INTO chat_sessions (id, agent_session_id, title, created_at, running) VALUES \
             ('pc','a','Scheduled run — Live',datetime('now','-1 hour'),1), \
             ('dead','b','Scheduled run — Dead',datetime('now','-1 hour'),1);",
        )
        .unwrap();
        assert!(running_chats(&c).unwrap().is_empty());

        run(None, "dry", Some("pc")).await.unwrap();

        assert!(n.load(Ordering::SeqCst) >= 2, "the turn ran");
        assert!(
            seen.load(Ordering::SeqCst),
            "the run's chat counts while it runs"
        );
        assert!(running_chats(&c).unwrap().is_empty());
        assert!(!home.join(".run-locks").join("pc.lock").exists());

        std::env::remove_var("COLDTRAIL_HOME");
    }

    /// A run whose turn fails after the provider check passed (an agent error mid-run) records
    /// why in its run note, not only in coldtrail.log.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn a_failed_turn_records_why() {
        use axum::{routing::post, Json, Router};
        use serde_json::json;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let _g = crate::testutil::env_guard();
        let home = std::env::temp_dir().join("ct-run-turn-fails");
        let _ = std::fs::remove_dir_all(&home);
        std::env::set_var("COLDTRAIL_HOME", &home);

        // Call 0 is the provider probe, which passes; the real turn then fails.
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = n.clone();
        let app = Router::new().route(
            "/chat/completions",
            post(move |_b: String| {
                let n = n2.clone();
                async move {
                    if n.fetch_add(1, Ordering::SeqCst) == 0 {
                        Json(
                            json!({"choices":[{"message":{"role":"assistant","content":"ok"},
                            "finish_reason":"stop"}]}),
                        )
                        .into_response()
                    } else {
                        (
                            axum::http::StatusCode::TOO_MANY_REQUESTS,
                            "Rate limit reached",
                        )
                            .into_response()
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
        assert_eq!(r.status, "error");
        assert!(r.chat_id.is_some()); // the run started
        let note = r.note.unwrap_or_default();
        assert!(note.contains("Rate limit reached"), "note {note:?}");
        std::env::remove_var("COLDTRAIL_HOME");
    }

    /// A failed turn's note: the agent's errors once each, else its last words, else a reason.
    #[test]
    fn failure_note_says_why() {
        let errs = |v: &[&str]| v.iter().map(|e| e.to_string()).collect::<Vec<_>>();
        assert_eq!(
            failure_note(&errs(&["Fake failure", "exit 1"]), "Working on it."),
            "Fake failure\nexit 1"
        );
        assert_eq!(
            failure_note(&[], "Sourced 3.\nI hit a rate limit, stopping.\n\n"),
            "I hit a rate limit, stopping."
        );
        assert!(failure_note(&[], "  ").contains("no reason"));
    }

    /// A run that died (Ctrl+C in the serve terminal, a kill, a shutdown) is recorded once, as
    /// a failed run that says it stopped, at the time it last wrote and with its schedule and
    /// trigger; its flag and stale lock go. One that died before it took its lock counts once
    /// the start-up grace is over. A run that recorded itself before dying keeps its own row;
    /// live runs are left alone.
    #[test]
    fn a_run_that_died_is_recorded_once() {
        crate::testutil::with_home("ct-run-died", |dir| {
            crate::db::init().unwrap();
            let c = crate::db::open().unwrap();
            c.execute_batch(
                "INSERT INTO chat_sessions (id, title, created_at, updated_at, running, schedule_id, run_trigger) VALUES \
                 ('killed','Scheduled run — Nightly',datetime('now','-1 hour'),'2026-11-04 08:00:00',1,'s1','manual'), \
                 ('unborn','Scheduled run — Nightly',datetime('now','-1 hour'),datetime('now','-1 hour'),1,'s1','dry'), \
                 ('done','Manual run',datetime('now','-1 hour'),datetime('now','-1 hour'),1,NULL,'manual'), \
                 ('live','Scheduled run — Weekly',datetime('now','-1 hour'),datetime('now','-1 hour'),1,'s2','scheduled'), \
                 ('new','Scheduled run — Weekly',datetime('now'),datetime('now'),1,'s2','manual');",
            )
            .unwrap();
            crate::db::record_run(
                "ok",
                crate::db::Counts {
                    companies: 0,
                    contacts: 0,
                    outreach: 0,
                    sent_today: 0,
                },
                crate::db::Counts {
                    companies: 2,
                    contacts: 0,
                    outreach: 0,
                    sent_today: 0,
                },
                Some("done"),
                None,
                None,
                "manual",
            )
            .unwrap();
            let locks = dir.join(".run-locks");
            std::fs::create_dir_all(&locks).unwrap();
            std::fs::write(locks.join("killed.lock"), "").unwrap();
            let _live = hold_run_lock("live").unwrap();

            let ids = |v: Vec<LiveRun>| v.into_iter().map(|r| r.chat_id).collect::<Vec<_>>();
            let mut got = ids(running_chats(&c).unwrap());
            got.sort();
            assert_eq!(got, ["live", "new"]);
            let runs = crate::db::list_runs(10).unwrap();
            let row = |chat: &str| runs.iter().find(|r| r.chat_id.as_deref() == Some(chat));
            let killed = row("killed").unwrap();
            assert_eq!(
                (killed.status.as_str(), killed.note.as_deref()),
                ("error", Some(DIED_NOTE))
            );
            assert_eq!(killed.started_at, "2026-11-04 08:00:00");
            assert_eq!(
                (killed.schedule_id.as_deref(), killed.trigger.as_deref()),
                (Some("s1"), Some("manual"))
            );
            let unborn = row("unborn").unwrap();
            assert_eq!(
                (unborn.status.as_str(), unborn.trigger.as_deref()),
                ("error", Some("dry"))
            );
            assert_eq!(row("done").unwrap().status, "ok");
            assert_eq!(runs.len(), 3);
            for chat in ["killed", "unborn", "done"] {
                assert!(!crate::db::chat_running(chat).unwrap(), "{chat}");
            }
            assert!(!locks.join("killed.lock").exists());

            // Once only.
            reap_dead_runs(&c).unwrap();
            assert_eq!(crate::db::list_runs(10).unwrap().len(), 3);
        });
    }

    /// A chat id that isn't a plain token never names a lock file.
    #[test]
    fn run_lock_path_takes_only_plain_ids() {
        crate::testutil::with_home("ct-run-lock-path", |dir| {
            let p = run_lock_path("3f2b-9c_d").unwrap();
            assert_eq!(p, dir.join(".run-locks").join("3f2b-9c_d.lock"));
            for bad in ["", "../x", "a/b", "a.b", "a b"] {
                assert!(run_lock_path(bad).is_none(), "{bad:?}");
                assert!(hold_run_lock(bad).is_err(), "{bad:?}");
            }
        });
    }

    /// The lock file only ever appears held: a claim is Held while its lock lives, gone (no
    /// file, no temporary left behind) once it drops, and Abandoned when a file is left with
    /// nothing holding it, as a run that died leaves it.
    #[test]
    fn run_lock_claims() {
        crate::testutil::with_home("ct-run-lock-claims", |dir| {
            assert_eq!(claim_of("c1"), Claim::None);
            let lock = hold_run_lock("c1").unwrap();
            assert_eq!(claim_of("c1"), Claim::Held);
            let names = |d: &std::path::Path| -> Vec<String> {
                std::fs::read_dir(d)
                    .unwrap()
                    .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            };
            assert_eq!(names(&dir.join(".run-locks")), ["c1.lock"]);
            drop(lock);
            assert_eq!(claim_of("c1"), Claim::None);
            assert!(names(&dir.join(".run-locks")).is_empty());

            std::fs::write(dir.join(".run-locks").join("c2.lock"), "").unwrap();
            assert_eq!(claim_of("c2"), Claim::Abandoned);
            // A run re-claiming that chat takes it over.
            let _lock = hold_run_lock("c2").unwrap();
            assert_eq!(claim_of("c2"), Claim::Held);
        });
    }

    /// A mock backend whose /chat/completions always answers `code` with `body`.
    async fn failing_backend(code: u16, body: &'static str) -> String {
        use axum::{routing::post, Router};
        let status = axum::http::StatusCode::from_u16(code).unwrap();
        let app = Router::new().route(
            "/chat/completions",
            post(move |_b: String| async move { (status, body) }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        format!("http://{addr}")
    }

    /// The provider check before a run only records `auth_failed` when the failure looks like
    /// a sign-in problem. Anything else — a deprecated model, a provider-side 500 (the two
    /// real failures that were shown as "Sign-in failed") — is a plain `error` whose note
    /// carries the provider's message.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn probe_failure_is_auth_failed_only_for_sign_in_problems() {
        let _g = crate::testutil::env_guard();
        let home = std::env::temp_dir().join("ct-run-probe-classify");
        let _ = std::fs::remove_dir_all(&home);
        std::env::set_var("COLDTRAIL_HOME", &home);
        crate::db::init().unwrap();

        let cases: [(u16, &'static str, &str, &str); 5] = [
            (
                400,
                "Model muse-spark-1.3-contributor-free has been deprecated.",
                "error",
                "has been deprecated",
            ),
            (
                500,
                "Unexpected server error. Check server logs for details.",
                "error",
                "Unexpected server error",
            ),
            (401, "Unauthorized", "auth_failed", "401"),
            (403, "forbidden", "auth_failed", "403"),
            (
                400,
                "Invalid API key provided",
                "auth_failed",
                "Invalid API key",
            ),
        ];
        for (code, body, status, note) in cases {
            let base = failing_backend(code, body).await;
            crate::config::save(&crate::config::Config {
                agent: Some("openai".into()),
                provider: Some(crate::config::Provider {
                    base_url: Some(base),
                    model: Some("m".into()),
                }),
                ..Default::default()
            })
            .unwrap();
            run(None, "scheduled", None).await.unwrap();
            let r = crate::db::last_run().unwrap().unwrap();
            assert_eq!(r.status, status, "{code} {body}");
            let got = r.note.unwrap_or_default();
            assert!(got.contains(note), "{code} {body}: note {got:?}");
            assert!(r.chat_id.is_none()); // the run never started
        }

        std::env::remove_var("COLDTRAIL_HOME");
    }

    // C1 regression: the web run-now endpoint pre-creates the chat and marks it running=1
    // BEFORE spawning `coldtrail run`. The auth-gate probe check happens before `run` would
    // otherwise clear `running`, so a probe failure must clear it on the precreated chat itself
    // or the row is stuck running=1 forever with zero messages. Mirrors
    // src/probe.rs::probe_failed_on_error's 500-response mock, which makes probe() return
    // Outcome::Failed.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn probe_failure_clears_precreated_running_flag() {
        use axum::{routing::post, Router};

        let _g = crate::testutil::env_guard();
        let home = std::env::temp_dir().join("ct-run-probefail");
        let _ = std::fs::remove_dir_all(&home);
        std::env::set_var("COLDTRAIL_HOME", &home);

        // mock backend whose /chat/completions 500s -> probe fails
        let app = Router::new().route(
            "/chat/completions",
            post(|_b: String| async { (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "boom") }),
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

        // pre-create a chat + mark running (as the web run-now endpoint does)
        let c = crate::db::open().unwrap();
        c.execute(
            "INSERT INTO chat_sessions (id, agent_session_id, title) VALUES ('pc','a','Scheduled run')",
            [],
        )
        .unwrap();
        crate::db::set_chat_running("pc", true).unwrap();
        assert!(crate::db::chat_running("pc").unwrap());

        run(None, "dry", Some("pc")).await.unwrap(); // probe fails -> early return

        assert!(
            !crate::db::chat_running("pc").unwrap(),
            "running must be cleared on probe-fail abort"
        );

        std::env::remove_var("COLDTRAIL_HOME");
    }
}
