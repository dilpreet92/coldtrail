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
    /// Launch the agent (Claude Code) in the coldtrail workspace
    Run,
    /// Write config + templates, then initialize the database
    Setup,
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
    /// Build personalized drafts -> pending_drafts.json (never sends)
    DraftPrep {
        /// Max drafts to prepare (default 20)
        max: Option<usize>,
    },
    /// Record a Gmail draft id, or mark sent / bounced
    Mark { domain: String, value: String },
    /// Load already-contacted domains from contacted.toml (dedupe guard)
    Seed,
    /// Re-download the latest release binary in place
    Update,
}
