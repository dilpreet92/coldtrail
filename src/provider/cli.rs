//! Headless CLI-agent backends: spawn `claude -p --output-format stream-json` or
//! `codex exec --json` in the workspace and map their JSONL events to `AgentEvent`s.
//! Both share `stream_child`; codex assigns its own thread id (surfaced as a `Session` event).

use serde_json::Value;
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::Sender;

use super::AgentEvent;
use crate::agents::AgentKind;

/// Tool policy for a turn — gate Gmail at the process boundary, not in prose.
pub enum Tools<'a> {
    /// Normal chat: the agent may NOT use these tools (e.g. Gmail — no sending).
    Disallow(&'a [&'a str]),
    /// Send turn: the agent may use ONLY these tools.
    AllowOnly(&'a [&'a str]),
}

/// Build the argv for a headless Claude turn. First turn seeds the session id;
/// later turns resume it. Kept pure for testing.
pub fn claude_args(session_id: &str, first_turn: bool, msg: &str, tools: &Tools) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    if first_turn {
        a.push("--session-id".into());
        a.push(session_id.into());
    } else {
        a.push("--resume".into());
        a.push(session_id.into());
    }
    a.push("-p".into());
    a.push(msg.into());
    a.push("--output-format".into());
    a.push("stream-json".into());
    a.push("--verbose".into());
    a.push("--permission-mode".into());
    a.push("bypassPermissions".into());
    // The agent drives coldtrail via its CLI (Bash), never via MCP — so run with NO MCP servers.
    // This isolates it from the user's own (possibly broken/expired) global MCP config, which
    // otherwise crashes the turn on init.
    a.push("--strict-mcp-config".into());
    match tools {
        Tools::Disallow(list) if !list.is_empty() => {
            a.push("--disallowedTools".into());
            a.push(list.join(" "));
        }
        Tools::AllowOnly(list) if !list.is_empty() => {
            a.push("--allowedTools".into());
            a.push(list.join(" "));
        }
        _ => {}
    }
    a
}

/// Turn a raw agent error into a plain, actionable message when it's an auth/expiry failure
/// (the common one: the CLI's login token expired and headless mode can't re-auth). `cli` is the
/// display name, `relogin` the command to run. Returns None for non-auth errors.
fn auth_hint(raw: &str, cli: &str, relogin: &str) -> Option<String> {
    let low = raw.to_lowercase();
    let is_auth = low.contains("authentication_error")
        || low.contains("oauth access token has expired")
        || low.contains("re-authenticate")
        || low.contains("401 unauthorized")
        || (low.contains("\"status\":401") || low.contains("error: 401"));
    is_auth.then(|| {
        format!(
            "{cli} needs to sign in again — its login expired. In a terminal run `{relogin}` and \
             complete sign-in, then re-check in Settings and resend."
        )
    })
}

/// Parse one line of Claude's stream-json output into zero or more events.
/// Ignores hook/system/rate-limit noise; captures assistant text + tool calls + the
/// terminal result. Unparseable lines yield an empty vec.
pub fn parse_stream_line(line: &str) -> Vec<AgentEvent> {
    let line = line.trim();
    if line.is_empty() {
        return vec![];
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("assistant") => content_blocks(&v)
            .iter()
            .filter_map(|b| match b.get("type").and_then(|t| t.as_str()) {
                Some("text") => b
                    .get("text")
                    .and_then(|t| t.as_str())
                    .map(|t| AgentEvent::Text {
                        text: t.to_string(),
                    }),
                Some("tool_use") => Some(AgentEvent::ToolStart {
                    name: b
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("tool")
                        .to_string(),
                    input: b.get("input").cloned().unwrap_or(Value::Null),
                }),
                _ => None,
            })
            .collect(),
        Some("user") => content_blocks(&v)
            .iter()
            .filter_map(|b| match b.get("type").and_then(|t| t.as_str()) {
                Some("tool_result") => Some(AgentEvent::ToolEnd {
                    ok: !b.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false),
                }),
                _ => None,
            })
            .collect(),
        Some("result") => {
            let is_error = v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
            let result = v
                .get("result")
                .and_then(|r| r.as_str())
                .map(|s| s.to_string());
            if is_error {
                // Claude can exit 0 but report an error in the `result` payload (auth, MCP,
                // rate limits). Surface it as a visible Error instead of a silent failed turn —
                // and translate the common expired-login case into an actionable message.
                let raw = result.clone().unwrap_or_default();
                let message = auth_hint(&raw, "Claude Code", "claude  (then /login)")
                    .or_else(|| result.clone().filter(|s| !s.trim().is_empty()))
                    .unwrap_or_else(|| "the agent reported an error (see the log)".into());
                vec![
                    AgentEvent::Error { message },
                    AgentEvent::Done { ok: false, result },
                ]
            } else {
                vec![AgentEvent::Done { ok: true, result }]
            }
        }
        _ => vec![], // system / rate_limit_event / anything else
    }
}

fn content_blocks(v: &Value) -> Vec<Value> {
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default()
}

/// Run one agent turn, streaming events into `tx`. Always emits a terminal `Done`
/// (even on failure). Returns `true` iff the turn finished successfully.
pub async fn run_turn(
    kind: AgentKind,
    session_id: &str,
    first_turn: bool,
    msg: &str,
    home: &Path,
    tools: &Tools<'_>,
    tx: Sender<AgentEvent>,
) -> bool {
    match kind {
        AgentKind::Claude => run_claude(session_id, first_turn, msg, home, tools, tx).await,
        AgentKind::Codex => run_codex(session_id, first_turn, msg, home, tx).await,
    }
}

/// Build the argv for a headless Codex turn (`codex exec … --json`). First turn starts a new
/// thread (codex assigns the id, surfaced via a `thread.started` event); later turns resume
/// it by id. cwd is set on the Command, so no `-C` here.
pub fn codex_args(session_id: &str, first_turn: bool, msg: &str) -> Vec<String> {
    let mut a: Vec<String> = vec!["exec".into()];
    if !first_turn {
        a.push("resume".into());
        a.push(session_id.into());
    }
    a.push("--json".into());
    // Headless automation: run tool/shell commands without approval prompts (the workspace is
    // the user's own machine). Codex has no per-tool gate; the brief (AGENTS.md) forbids Gmail.
    a.push("--dangerously-bypass-approvals-and-sandbox".into());
    a.push("--skip-git-repo-check".into());
    // Skip the user's ~/.codex/config.toml — the agent needs only Bash + the coldtrail CLI, and
    // the user's own MCP servers there (e.g. a broken/expired one) otherwise crash the turn.
    // Auth still comes from CODEX_HOME.
    a.push("--ignore-user-config".into());
    a.push(msg.into());
    a
}

/// Map one line of `codex exec --json` (JSONL) to zero or more events.
fn parse_codex_line(line: &str) -> Vec<AgentEvent> {
    let v: Value = match serde_json::from_str(line.trim()) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    match v["type"].as_str().unwrap_or("") {
        "thread.started" => v["thread_id"]
            .as_str()
            .map(|id| vec![AgentEvent::Session { id: id.to_string() }])
            .unwrap_or_default(),
        "item.started" => {
            let it = &v["item"];
            match it["type"].as_str().unwrap_or("") {
                "agent_message" | "reasoning" => vec![],
                _ => vec![AgentEvent::ToolStart {
                    name: codex_item_name(it),
                    input: it.clone(),
                }],
            }
        }
        "item.completed" => {
            let it = &v["item"];
            match it["type"].as_str().unwrap_or("") {
                "agent_message" => it["text"]
                    .as_str()
                    .filter(|t| !t.is_empty())
                    .map(|t| {
                        vec![AgentEvent::Text {
                            text: t.to_string(),
                        }]
                    })
                    .unwrap_or_default(),
                "reasoning" => vec![],
                _ => {
                    let ok = it["exit_code"]
                        .as_i64()
                        .map(|c| c == 0)
                        .unwrap_or_else(|| it["status"].as_str() != Some("failed"));
                    vec![AgentEvent::ToolEnd { ok }]
                }
            }
        }
        "turn.completed" => vec![AgentEvent::Done {
            ok: true,
            result: None,
        }],
        "turn.failed" | "error" => {
            let raw = v["error"]["message"]
                .as_str()
                .or_else(|| v["message"].as_str())
                .unwrap_or("codex turn failed")
                .to_string();
            let msg = auth_hint(&raw, "Codex CLI", "codex login").unwrap_or(raw);
            vec![
                AgentEvent::Error { message: msg },
                AgentEvent::Done {
                    ok: false,
                    result: None,
                },
            ]
        }
        _ => vec![],
    }
}

/// A short label for a codex tool/command item (shown as a chip).
fn codex_item_name(it: &Value) -> String {
    match it["type"].as_str().unwrap_or("item") {
        "command_execution" => {
            let cmd: String = it["command"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(48)
                .collect();
            if cmd.trim().is_empty() {
                "shell".into()
            } else {
                format!("$ {cmd}")
            }
        }
        "mcp_tool_call" => it["tool"]
            .as_str()
            .or_else(|| it["name"].as_str())
            .unwrap_or("mcp")
            .to_string(),
        other => other.to_string(),
    }
}

async fn run_codex(
    session_id: &str,
    first_turn: bool,
    msg: &str,
    home: &Path,
    tx: Sender<AgentEvent>,
) -> bool {
    crate::logf::log(&format!(
        "codex turn: session={session_id} ({})",
        if first_turn { "new" } else { "resume" }
    ));
    let spawn = Command::new("codex")
        .args(codex_args(session_id, first_turn, msg))
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let child = match spawn {
        Ok(c) => c,
        Err(e) => {
            let _ = tx
                .send(AgentEvent::Error {
                    message: format!("failed to launch codex: {e}"),
                })
                .await;
            let _ = tx
                .send(AgentEvent::Done {
                    ok: false,
                    result: None,
                })
                .await;
            crate::logf::log(&format!("codex failed to launch: {e}"));
            return false;
        }
    };
    stream_child(child, "codex", parse_codex_line, tx).await
}

async fn run_claude(
    session_id: &str,
    first_turn: bool,
    msg: &str,
    home: &Path,
    tools: &Tools<'_>,
    tx: Sender<AgentEvent>,
) -> bool {
    crate::logf::log(&format!(
        "claude turn: session={session_id} ({})",
        if first_turn { "new" } else { "resume" }
    ));
    let spawn = Command::new("claude")
        .args(claude_args(session_id, first_turn, msg, tools))
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let child = match spawn {
        Ok(c) => c,
        Err(e) => {
            let _ = tx
                .send(AgentEvent::Error {
                    message: format!("failed to launch claude: {e}"),
                })
                .await;
            let _ = tx
                .send(AgentEvent::Done {
                    ok: false,
                    result: None,
                })
                .await;
            crate::logf::log(&format!("claude failed to launch: {e}"));
            return false;
        }
    };

    stream_child(child, "claude", parse_stream_line, tx).await
}

/// Stream a spawned agent child's stdout (JSONL) through `parse`, forwarding events to `tx`.
/// Kills the child on browser disconnect, captures stderr, and synthesizes a terminal Done
/// when the child ends without one. Returns true iff the turn finished ok.
async fn stream_child(
    mut child: tokio::process::Child,
    label: &str,
    parse: fn(&str) -> Vec<AgentEvent>,
    tx: Sender<AgentEvent>,
) -> bool {
    // Drain stderr concurrently so its pipe never blocks the child.
    let stderr = child.stderr.take();
    let err_task = tokio::spawn(async move {
        let mut buf = String::new();
        if let Some(e) = stderr {
            let _ = BufReader::new(e).read_to_string(&mut buf).await;
        }
        buf
    });

    let stdout = match child.stdout.take() {
        Some(o) => o,
        None => {
            let _ = tx
                .send(AgentEvent::Error {
                    message: "no stdout from the agent".into(),
                })
                .await;
            let _ = tx
                .send(AgentEvent::Done {
                    ok: false,
                    result: None,
                })
                .await;
            return false;
        }
    };
    let mut lines = BufReader::new(stdout).lines();

    let mut saw_done = false;
    let mut done_ok = false;
    let mut disconnected = false;

    loop {
        tokio::select! {
            // client (browser) went away even while the agent is silent
            _ = tx.closed() => { disconnected = true; break; }
            line = lines.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        for ev in parse(&line) {
                            if let AgentEvent::Done { ok, .. } = &ev {
                                saw_done = true;
                                done_ok = *ok;
                            }
                            if tx.send(ev).await.is_err() { disconnected = true; break; }
                        }
                        if disconnected { break; }
                    }
                    Ok(None) => break, // stdout closed
                    Err(_) => break,
                }
            }
        }
    }

    if disconnected {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return false;
    }

    let status = child.wait().await;
    let err = err_task.await.unwrap_or_default();

    // Log the outcome (+ any stderr) so a tester can see why a backend failed, even when the
    // browser only shows a generic failure.
    let code = status.as_ref().ok().and_then(|s| s.code());
    crate::logf::log(&format!(
        "{label} ended: exit={code:?} saw_result={saw_done} ok={done_ok}"
    ));
    if !err.trim().is_empty() {
        crate::logf::log(&format!("{label} stderr:\n{}", err.trim()));
    }

    if !saw_done {
        let tail: String = {
            let t = err.trim();
            if t.is_empty() {
                match status {
                    Ok(s) if !s.success() => format!("agent exited with {s}"),
                    _ => "the agent ended without a result".to_string(),
                }
            } else {
                t.lines()
                    .rev()
                    .take(6)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        };
        let (cli, relogin) = if label == "codex" {
            ("Codex CLI", "codex login")
        } else {
            ("Claude Code", "claude  (then /login)")
        };
        let message = auth_hint(&err, cli, relogin).unwrap_or(tail);
        let _ = tx.send(AgentEvent::Error { message }).await;
        let _ = tx
            .send(AgentEvent::Done {
                ok: false,
                result: None,
            })
            .await;
        return false;
    }
    done_ok
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Tools = Tools::Disallow(&[]);

    #[test]
    fn auth_hint_detects_expired_login() {
        let raw = r#"401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has expired. Re-authenticate to continue."}}"#;
        let m = super::auth_hint(raw, "Claude Code", "claude").expect("should detect auth error");
        assert!(m.contains("sign in again"));
        assert!(m.contains("claude"));
        assert!(super::auth_hint("some other failure", "Claude Code", "claude").is_none());
    }

    #[test]
    fn codex_args_first_and_resume() {
        let first = codex_args("t-1", true, "hi");
        assert_eq!(first[0], "exec");
        assert!(!first.iter().any(|x| x == "resume"));
        assert!(first.iter().any(|x| x == "--json"));
        assert_eq!(first.last().unwrap(), "hi");
        assert!(first.iter().any(|x| x == "--ignore-user-config")); // isolate from user MCP
        let resume = codex_args("t-1", false, "again");
        assert!(resume.windows(2).any(|w| w == ["resume", "t-1"]));
    }

    #[test]
    fn claude_args_isolate_mcp() {
        let a = claude_args("s", true, "m", &NONE);
        assert!(a.iter().any(|x| x == "--strict-mcp-config")); // no user MCP servers
    }

    #[test]
    fn parse_codex_events() {
        assert_eq!(
            parse_codex_line(r#"{"type":"thread.started","thread_id":"abc"}"#),
            vec![AgentEvent::Session { id: "abc".into() }]
        );
        assert_eq!(
            parse_codex_line(
                r#"{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}"#
            ),
            vec![AgentEvent::Text {
                text: "hello".into()
            }]
        );
        assert_eq!(
            parse_codex_line(r#"{"type":"turn.completed","usage":{}}"#),
            vec![AgentEvent::Done {
                ok: true,
                result: None
            }]
        );
        // a command-execution item becomes a tool chip
        let started = parse_codex_line(
            r#"{"type":"item.started","item":{"type":"command_execution","command":"echo hi"}}"#,
        );
        assert!(matches!(started.as_slice(), [AgentEvent::ToolStart { .. }]));
    }

    #[test]
    fn args_first_turn_seeds_session() {
        let a = claude_args("sid-1", true, "hello", &NONE);
        assert!(a.windows(2).any(|w| w == ["--session-id", "sid-1"]));
        assert!(a.windows(2).any(|w| w == ["-p", "hello"]));
        assert!(a
            .windows(2)
            .any(|w| w == ["--output-format", "stream-json"]));
        assert!(!a.iter().any(|x| x == "--resume"));
    }

    #[test]
    fn args_later_turn_resumes() {
        let a = claude_args("sid-1", false, "again", &NONE);
        assert!(a.windows(2).any(|w| w == ["--resume", "sid-1"]));
        assert!(!a.iter().any(|x| x == "--session-id"));
    }

    #[test]
    fn args_gate_tools() {
        let dis = claude_args("s", true, "m", &Tools::Disallow(&["mcp__gmail"]));
        assert!(dis
            .windows(2)
            .any(|w| w == ["--disallowedTools", "mcp__gmail"]));
        let allow = claude_args("s", true, "m", &Tools::AllowOnly(&["mcp__gmail"]));
        assert!(allow
            .windows(2)
            .any(|w| w == ["--allowedTools", "mcp__gmail"]));
    }

    #[test]
    fn parses_assistant_text() {
        let line =
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hi there"}]}}"#;
        assert_eq!(
            parse_stream_line(line),
            vec![AgentEvent::Text {
                text: "Hi there".into()
            }]
        );
    }

    #[test]
    fn parses_tool_use_and_result() {
        let start = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"coldtrail import x"}}]}}"#;
        match &parse_stream_line(start)[0] {
            AgentEvent::ToolStart { name, .. } => assert_eq!(name, "Bash"),
            e => panic!("expected ToolStart, got {e:?}"),
        }
        let end = r#"{"type":"user","message":{"content":[{"type":"tool_result","is_error":false,"content":"ok"}]}}"#;
        assert_eq!(
            parse_stream_line(end),
            vec![AgentEvent::ToolEnd { ok: true }]
        );
        let fail =
            r#"{"type":"user","message":{"content":[{"type":"tool_result","is_error":true}]}}"#;
        assert_eq!(
            parse_stream_line(fail),
            vec![AgentEvent::ToolEnd { ok: false }]
        );
    }

    #[test]
    fn parses_result_done() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"all done"}"#;
        assert_eq!(
            parse_stream_line(line),
            vec![AgentEvent::Done {
                ok: true,
                result: Some("all done".into())
            }]
        );
    }

    #[test]
    fn ignores_system_and_junk() {
        assert!(parse_stream_line(r#"{"type":"system","subtype":"init"}"#).is_empty());
        assert!(parse_stream_line(r#"{"type":"rate_limit_event"}"#).is_empty());
        assert!(parse_stream_line("not json").is_empty());
        assert!(parse_stream_line("").is_empty());
    }
}
