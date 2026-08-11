//! Command-line surface. The same binary is the launcher and every workflow
//! command the agent calls.

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "coldtrail",
    version,
    about = "Discovery-first, deduped outreach — drafts you send by hand."
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Subcommand)]
pub enum Commands {
    /// (default) Open the coldtrail app in your browser
    Serve {
        /// Port to bind (default 8787; falls back to a free port if taken)
        #[arg(long)]
        port: Option<u16>,
        /// Don't auto-open a browser
        #[arg(long)]
        no_open: bool,
    },
    /// Launch the raw terminal agent in the workspace (advanced)
    Agent,
    /// Detect agents, pick a default provider, and wire Canonical + Gmail MCP
    Setup {
        /// Force a provider (claude|codex) instead of detecting/asking
        #[arg(long)]
        provider: Option<String>,
        /// Fixed OAuth callback port for the Gmail MCP redirect URI
        #[arg(long, default_value_t = 8765)]
        gmail_callback_port: u16,
        /// Don't wire the Gmail MCP server
        #[arg(long)]
        skip_gmail: bool,
        /// Re-wire MCP servers even if already configured
        #[arg(long)]
        force: bool,
    },
    /// Source companies from Canonical (coldtrail's own connection), deduped by domain.
    /// Pass several angles (diverse phrasings / regions / segments) to widen recall — they're
    /// searched in parallel and their union is deduped by domain.
    Source {
        /// One or more plain-English ICP angles
        #[arg(required = true, num_args = 1..)]
        queries: Vec<String>,
        /// Max companies to request per angle
        #[arg(long)]
        limit: Option<usize>,
    },
    /// Send a reviewed draft for real (requires auto-send enabled in Settings)
    Send {
        /// The company domain whose draft to send
        domain: String,
    },
    /// Import Canonical search results (JSON), deduped by domain
    Import {
        /// Path to the saved Canonical results JSON
        json: String,
        /// A short label for this ICP / search
        label: String,
    },
    /// Add an MX-verified founder contact by hand
    AddContact {
        domain: String,
        name: String,
        email: String,
        /// How you found it (default: "websearch")
        source: Option<String>,
    },
    /// Best-effort founder-email finder (OSINT); MX-verified
    FindEmails {
        /// Max companies to process (default 20)
        max: Option<usize>,
    },
    /// Build personalized drafts from the template -> pending_drafts.json (never sends)
    DraftPrep {
        /// Max drafts to prepare (default 20)
        max: Option<usize>,
    },
    /// Store an agent-composed personalized draft for a company (never sends)
    Draft {
        domain: String,
        #[arg(long)]
        subject: String,
        #[arg(long)]
        body: String,
    },
    /// Store a follow-up touch for an already-contacted company (never sends)
    Followup {
        domain: String,
        #[arg(long)]
        subject: String,
        #[arg(long)]
        body: String,
    },
    /// Record a Gmail draft id, or mark sent / bounced
    Mark { domain: String, value: String },
    /// Load already-contacted domains from contacted.toml (dedupe guard)
    Seed,
    /// Re-download the latest release binary in place
    Update,
}
