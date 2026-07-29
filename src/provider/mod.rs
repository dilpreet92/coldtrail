//! The agent runtime abstraction. Phase 1 ships the CLI-agent backend (headless
//! Claude Code); BYOK API + local LLM backends come later behind the same events.

pub mod cli;
pub mod openai;
pub mod tools;

use serde::Serialize;
use std::path::Path;
use tokio::sync::mpsc::Sender;

use crate::agents::AgentKind;

/// Claude-Code tool id prefix for the wired Gmail MCP server. Chat turns disallow it
/// (no sending during normal work); the Send turn allows only it.
pub const GMAIL_TOOL: &str = "mcp__gmail";

/// The resolved runtime backend the agent runs on.
pub enum Backend {
    /// Headless Claude Code / Codex (Phase 1) — reuses subscription auth + MCP.
    Cli(AgentKind),
    /// Any OpenAI-compatible endpoint (Ollama, or a BYOK gateway).
    OpenAi {
        base_url: String,
        model: String,
        api_key: Option<String>,
    },
}

impl Backend {
    /// Is this a CLI backend (claude/codex)? Only these can send via Gmail MCP today.
    pub fn is_cli(&self) -> bool {
        matches!(self, Backend::Cli(_))
    }
}

/// Resolve the configured backend from `config.toml` (+ secrets for BYOK keys).
pub fn resolve() -> Backend {
    let c = crate::config::load();
    match c.agent.as_deref().unwrap_or("claude") {
        "openai" => {
            let p = c.provider.unwrap_or_default();
            Backend::OpenAi {
                base_url: p
                    .base_url
                    .unwrap_or_else(|| "http://localhost:11434/v1".into()),
                model: p.model.unwrap_or_else(|| "llama3.1".into()),
                api_key: crate::secrets::api_key(),
            }
        }
        other => Backend::Cli(AgentKind::from_str(other).unwrap_or(AgentKind::Claude)),
    }
}

/// Run one agent turn on `backend`, streaming events into `tx`. Always terminal `Done`.
pub async fn run_turn(
    backend: &Backend,
    session_id: &str,
    first_turn: bool,
    msg: &str,
    home: &Path,
    tools_policy: &cli::Tools<'_>,
    tx: Sender<AgentEvent>,
) -> bool {
    match backend {
        Backend::Cli(kind) => {
            cli::run_turn(*kind, session_id, first_turn, msg, home, tools_policy, tx).await
        }
        Backend::OpenAi {
            base_url,
            model,
            api_key,
        } => openai::run_turn(base_url, model, api_key.as_deref(), msg, home, tx).await,
    }
}

/// A streamed event from an agent turn, forwarded to the browser over SSE.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// Assistant text (may arrive in chunks).
    Text { text: String },
    /// A tool/MCP call the agent started.
    ToolStart {
        name: String,
        input: serde_json::Value,
    },
    /// A tool/MCP call finished.
    ToolEnd { ok: bool },
    /// A non-fatal error message to show the user.
    Error { message: String },
    /// The turn finished.
    Done { ok: bool, result: Option<String> },
}
