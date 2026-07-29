//! Headless CLI-agent backend: spawn `claude -p --output-format stream-json` in the
//! workspace and map its JSONL events to `AgentEvent`s. Codex is best-effort.

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
        Some("result") => vec![AgentEvent::Done {
            ok: !v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false),
            result: v
                .get("result")
                .and_then(|r| r.as_str())
                .map(|s| s.to_string()),
        }],
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
        AgentKind::Codex => {
            let _ = tx
                .send(AgentEvent::Error {
                    message: "The Codex backend isn't wired into the app yet — run \
                              `coldtrail setup --provider claude` to use Claude Code."
                        .into(),
                })
                .await;
            let _ = tx
                .send(AgentEvent::Done {
                    ok: false,
                    result: None,
                })
                .await;
            false
        }
    }
}

async fn run_claude(
    session_id: &str,
    first_turn: bool,
    msg: &str,
    home: &Path,
    tools: &Tools<'_>,
    tx: Sender<AgentEvent>,
) -> bool {
    let spawn = Command::new("claude")
        .args(claude_args(session_id, first_turn, msg, tools))
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match spawn {
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
            return false;
        }
    };

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
                    message: "no stdout from claude".into(),
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
                        for ev in parse_stream_line(&line) {
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
        let _ = tx.send(AgentEvent::Error { message: tail }).await;
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
