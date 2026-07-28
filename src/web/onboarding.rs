//! Onboarding over HTTP — the browser equivalent of `coldtrail setup`, reusing the
//! same detection + wiring logic.

use axum::Json;

use super::api::{AgentDto, McpReq, MsgResp, ProviderReq, StatusDto, TomlReq};
use super::ApiErr;
use crate::agents::{self, AgentKind};
use crate::setup;

pub async fn status() -> Result<Json<StatusDto>, ApiErr> {
    setup::ensure()?; // idempotent; guarantees workspace + default files exist
    let provider = setup::read_agent()?;
    let agents = agents::detect_all()
        .into_iter()
        .map(|s| AgentDto {
            kind: s.kind.config_value().to_string(),
            label: s.kind.label().to_string(),
            present: s.present,
            authed: s.authed,
        })
        .collect();

    let canonical_wired = mcp_wired(provider, "canonical");
    let gmail_wired = mcp_wired(provider, "gmail");
    let message_customized = file_differs("message.toml", setup::MESSAGE_TOML);
    let contacted_customized = file_differs("contacted.toml", setup::CONTACTED_TOML);

    let onboarded = canonical_wired && message_customized;
    Ok(Json(StatusDto {
        provider: provider.config_value().to_string(),
        agents,
        canonical_wired,
        gmail_wired,
        message_customized,
        contacted_customized,
        onboarded,
    }))
}

pub async fn set_provider(Json(req): Json<ProviderReq>) -> Result<Json<MsgResp>, ApiErr> {
    let kind = AgentKind::from_str(&req.provider)
        .ok_or_else(|| anyhow::anyhow!("unknown provider '{}'", req.provider))?;
    if !agents::detect_all()
        .iter()
        .any(|s| s.kind == kind && s.present)
    {
        return Err(anyhow::anyhow!("{} is not installed", kind.label()).into());
    }
    setup::write_agent(kind)?;
    Ok(Json(MsgResp::ok()))
}

pub async fn set_mcp(Json(req): Json<McpReq>) -> Result<Json<MsgResp>, ApiErr> {
    let provider = setup::read_agent()?;
    let skip = req.skip_gmail.unwrap_or(false);
    let gmail = if skip {
        None
    } else {
        match (req.gmail_client_id, req.gmail_secret) {
            (Some(i), Some(s)) if !i.trim().is_empty() && !s.trim().is_empty() => Some((i, s)),
            _ => None,
        }
    };
    let port = req.callback_port.unwrap_or(8765);
    let ws = crate::home::workspace()?;
    let wired = setup::wire_mcp(provider, gmail, port, true, &ws)?;
    Ok(Json(MsgResp {
        ok: true,
        message: None,
        wired: Some(wired),
    }))
}

pub async fn files() -> Result<Json<serde_json::Value>, ApiErr> {
    let read = |n: &str| -> String {
        crate::home::path(n)
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .unwrap_or_default()
    };
    Ok(Json(serde_json::json!({
        "message": read("message.toml"),
        "contacted": read("contacted.toml"),
    })))
}

pub async fn set_message(Json(req): Json<TomlReq>) -> Result<Json<MsgResp>, ApiErr> {
    // validate it parses as a message template before writing
    toml::from_str::<crate::message::Message>(&req.toml)
        .map_err(|e| anyhow::anyhow!("invalid message.toml: {e}"))?;
    std::fs::write(crate::home::path("message.toml")?, &req.toml)?;
    Ok(Json(MsgResp::ok()))
}

pub async fn set_contacted(Json(req): Json<TomlReq>) -> Result<Json<MsgResp>, ApiErr> {
    crate::seed::parse(&req.toml).map_err(|e| anyhow::anyhow!("invalid contacted.toml: {e}"))?;
    std::fs::write(crate::home::path("contacted.toml")?, &req.toml)?;
    Ok(Json(MsgResp::ok()))
}

/// Is `name` present in the chosen provider's coldtrail-scoped MCP config?
fn mcp_wired(provider: AgentKind, name: &str) -> bool {
    match provider {
        AgentKind::Claude => crate::home::path(".mcp.json")
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .map(|v| v.get("mcpServers").and_then(|m| m.get(name)).is_some())
            .unwrap_or(false),
        AgentKind::Codex => dirs::home_dir()
            .map(|h| h.join(".codex").join("config.toml"))
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| toml::from_str::<toml::Table>(&s).ok())
            .map(|t| {
                t.get("mcp_servers")
                    .and_then(|m| m.as_table())
                    .map(|m| m.contains_key(name))
                    .unwrap_or(false)
            })
            .unwrap_or(false),
    }
}

fn file_differs(name: &str, default: &str) -> bool {
    crate::home::path(name)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim() != default.trim())
        .unwrap_or(false)
}
