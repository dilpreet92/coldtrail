//! The agent runtime abstraction. Phase 1 ships the CLI-agent backend (headless
//! Claude Code); BYOK API + local LLM backends come later behind the same events.

pub mod cli;

use serde::Serialize;

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
