//! Onboarding over HTTP — the browser equivalent of `coldtrail setup`, reusing the
//! same detection + wiring logic.

use axum::Json;

use super::api::{AgentDto, McpReq, MsgResp, ProviderReq, StatusDto, TomlReq};
use super::ApiErr;
use crate::agents::{self, AgentKind};
use crate::setup;

pub async fn status() -> Result<Json<StatusDto>, ApiErr> {
    setup::ensure()?; // idempotent; guarantees workspace + default files exist
    let cfg = crate::config::load();
    let provider = cfg.agent.clone().unwrap_or_else(|| "claude".into());
    let detected = agents::detect_all();
    let agents: Vec<AgentDto> = detected
        .iter()
        .map(|s| AgentDto {
            kind: s.kind.config_value().to_string(),
            label: s.kind.label().to_string(),
            present: s.present,
            authed: s.authed,
        })
        .collect();

    let kind = AgentKind::from_str(&provider); // None for "openai"
    let canonical_wired = kind.map(|k| mcp_wired(k, "canonical")).unwrap_or(false);
    let gmail_wired = kind.map(|k| mcp_wired(k, "gmail")).unwrap_or(false);
    let message_customized = file_differs("message.toml", setup::MESSAGE_TOML);
    let contacted_customized = file_differs("contacted.toml", setup::CONTACTED_TOML);
    let (base_url, model) = cfg
        .provider
        .map(|p| (p.base_url, p.model))
        .unwrap_or((None, None));
    let key_set = crate::secrets::has_key();

    let provider_ready = match kind {
        Some(k) => detected.iter().any(|s| s.kind == k && s.present),
        None => base_url.is_some(), // openai backend
    };
    // coldtrail OWNS discovery + destination now: its own OAuth token, same on every
    // provider (Canonical via `coldtrail source`, Gmail via the Gmail API).
    let discovery_connected = crate::secrets::has_token("canonical");
    let destination_connected = crate::secrets::has_token("gmail");
    let _ = (canonical_wired, gmail_wired);
    let onboarded = message_customized && provider_ready && discovery_connected;

    Ok(Json(StatusDto {
        provider,
        agents,
        canonical_wired,
        gmail_wired,
        message_customized,
        contacted_customized,
        onboarded,
        base_url,
        model,
        key_set,
        discovery_connected,
        destination_connected,
        osint: crate::osint::status(),
    }))
}

/// Auto-install an OSINT tool on demand from the browser Setup panel. Runs off the async
/// runtime; degrades gracefully when prerequisites (pipx / git / a compatible Python) are
/// missing.
pub async fn install_osint(
    Json(req): Json<super::api::OsintInstallReq>,
) -> Result<Json<MsgResp>, ApiErr> {
    let installer = match req.tool.as_str() {
        "spiderfoot" => crate::osint::install_spiderfoot,
        // default to theHarvester for any other/legacy value
        _ => crate::osint::install_the_harvester,
    };
    let res = tokio::task::spawn_blocking(installer).await;
    let resp = match res {
        Ok(Ok(message)) => MsgResp {
            ok: true,
            message: Some(message),
            wired: None,
        },
        Ok(Err(e)) => MsgResp {
            ok: false,
            message: Some(e.to_string()),
            wired: None,
        },
        Err(e) => MsgResp {
            ok: false,
            message: Some(format!("install task failed: {e}")),
            wired: None,
        },
    };
    Ok(Json(resp))
}

/// Connect Discovery (Canonical): coldtrail's OWN OAuth, on every provider. Sourcing then
/// runs through `coldtrail source` (coldtrail's MCP client), not the provider's connector.
pub async fn connect_discovery() -> Result<Json<MsgResp>, ApiErr> {
    crate::oauth::connect_canonical().await?;
    Ok(Json(MsgResp::ok()))
}

/// Connect Destination (Gmail): coldtrail's OWN `gmail.compose` OAuth (built-in Google
/// client), on every provider. coldtrail creates the Gmail draft itself via the Gmail API.
pub async fn connect_destination(
    Json(req): Json<super::api::GmailConnectReq>,
) -> Result<Json<MsgResp>, ApiErr> {
    let port = req.callback_port.unwrap_or(8765);
    crate::oauth::connect_gmail(port).await?;
    Ok(Json(MsgResp::ok()))
}

pub async fn set_provider(Json(req): Json<ProviderReq>) -> Result<Json<MsgResp>, ApiErr> {
    let ne = |s: &String| !s.trim().is_empty();
    match req.provider.as_str() {
        "openai" => {
            let mut c = crate::config::load();
            c.agent = Some("openai".into());
            c.provider = Some(crate::config::Provider {
                base_url: req.base_url.filter(ne),
                model: req.model.filter(ne),
            });
            crate::config::save(&c)?;
            if let Some(k) = req.api_key.filter(ne) {
                crate::secrets::set_api_key(&k)?;
            }
            Ok(Json(MsgResp::ok()))
        }
        other => {
            let kind = AgentKind::from_str(other)
                .ok_or_else(|| anyhow::anyhow!("unknown provider '{other}'"))?;
            if !agents::detect_all()
                .iter()
                .any(|s| s.kind == kind && s.present)
            {
                return Err(anyhow::anyhow!("{} is not installed", kind.label()).into());
            }
            let mut c = crate::config::load();
            c.agent = Some(kind.config_value().to_string());
            crate::config::save(&c)?;
            Ok(Json(MsgResp::ok()))
        }
    }
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
