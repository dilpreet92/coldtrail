//! Request/response types shared between the Rust server and the browser UI.

use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct AgentDto {
    pub kind: String,
    pub label: String,
    pub present: bool,
    pub authed: bool,
}

#[derive(Serialize)]
pub struct StatusDto {
    pub provider: String,
    pub agents: Vec<AgentDto>,
    pub canonical_wired: bool,
    pub gmail_wired: bool,
    pub message_customized: bool,
    pub contacted_customized: bool,
    pub onboarded: bool,
    /// OpenAI-compatible backend config (never includes the key).
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub key_set: bool,
    /// Unified connected state for the chosen provider (MCP-wired for CLI, token for BYOK).
    pub discovery_connected: bool,
    pub destination_connected: bool,
    /// OSINT enrichment tooling (theHarvester) detection + install-ability.
    pub osint: crate::osint::OsintStatus,
    /// coldtrail's own Google client is configured (COLDTRAIL_GOOGLE_CLIENT_ID/SECRET).
    pub gmail_client_configured: bool,
    /// gcloud Application Default Credentials are present (keyless Gmail path).
    pub gcloud_available: bool,
}

#[derive(Deserialize, Default)]
pub struct GmailConnectReq {
    pub callback_port: Option<u16>,
}

/// A bring-your-own Google OAuth client (Desktop app) for Gmail.
#[derive(Deserialize)]
pub struct GmailClientReq {
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
}

#[derive(Deserialize)]
pub struct DraftEditReq {
    pub subject: Option<String>,
    pub body: Option<String>,
}

#[derive(Serialize)]
pub struct FollowupDto {
    pub domain: String,
    pub to: Option<String>,
    /// Days since the most recent send.
    pub days: i64,
    /// Number of touches sent so far.
    pub touches: i64,
    /// awaiting | due | replied | bounced
    pub state: String,
}

#[derive(Deserialize)]
pub struct MarkReq {
    pub value: String,
}

#[derive(Serialize)]
pub struct OverviewDto {
    pub companies: i64,
    pub contacts: i64,
    pub drafts: i64,
    pub sent: i64,
    /// (company status, count), most common first.
    pub funnel: Vec<(String, i64)>,
    /// (ICP source_query label, company count).
    pub queries: Vec<(String, i64)>,
}

#[derive(Serialize)]
pub struct CompanyDto {
    pub domain: String,
    pub name: Option<String>,
    pub status: String,
    pub first_seen: String,
    /// Best verified contact found for this company (surfaced in the Pipeline row).
    pub founder: Option<String>,
    pub email: Option<String>,
    /// The ICP query that sourced this company (Pipeline "Sourced by").
    pub source_query: Option<String>,
}

#[derive(Serialize)]
pub struct ContactDto {
    pub domain: String,
    pub founder_name: Option<String>,
    pub email: Option<String>,
    pub mx_ok: bool,
    pub confidence: Option<String>,
}

#[derive(Serialize)]
pub struct DraftDto {
    pub domain: String,
    pub to: Option<String>,
    pub subject: Option<String>,
    pub body: Option<String>,
    pub status: String,
    pub gmail_draft_id: Option<String>,
}

#[derive(Deserialize)]
pub struct ChatReq {
    pub message: String,
}

#[derive(Serialize)]
pub struct ChatResp {
    pub run: String,
}

#[derive(Serialize)]
pub struct ChatSummary {
    pub id: String,
    pub title: Option<String>,
    pub updated_at: String,
    /// True when this is the currently-active conversation.
    pub active: bool,
}

#[derive(Serialize)]
pub struct ChatMessageDto {
    pub role: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct ChatDetail {
    pub id: String,
    pub title: Option<String>,
    pub messages: Vec<ChatMessageDto>,
}

#[derive(Deserialize)]
pub struct ProviderReq {
    pub provider: String,
    /// For provider = "openai": endpoint + model + (optional) API key.
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Deserialize)]
pub struct McpReq {
    pub gmail_client_id: Option<String>,
    pub gmail_secret: Option<String>,
    pub callback_port: Option<u16>,
    pub skip_gmail: Option<bool>,
}

#[derive(Deserialize)]
pub struct TomlReq {
    pub toml: String,
}

/// The product form → coldtrail assembles the outreach brief (message.toml) from these.
#[derive(Deserialize)]
pub struct PitchReq {
    pub product: String,
    pub value: String,
    #[serde(default)]
    pub offer: String,
    pub link: String,
    pub sender: String,
}

#[derive(Deserialize)]
pub struct OsintInstallReq {
    /// "the_harvester" | "spiderfoot"
    pub tool: String,
}

#[derive(Serialize)]
pub struct MsgResp {
    pub ok: bool,
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wired: Option<Vec<String>>,
}

impl MsgResp {
    pub fn ok() -> Self {
        MsgResp {
            ok: true,
            message: None,
            wired: None,
        }
    }
}
