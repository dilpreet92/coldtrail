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
    let product_set = crate::home::path("product.md")
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
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
    // provider (Canonical via `coldtrail source`, Gmail via the Gmail API). Gmail can be
    // keyless via gcloud ADC, so that also counts as connected.
    let discovery_connected = crate::secrets::has_token("canonical");
    // Connected = a Gmail app password (keyless IMAP) OR a Gmail OAuth token (own client).
    let destination_connected =
        crate::secrets::gmail_app_password().is_some() || crate::secrets::has_token("gmail");
    let _ = (canonical_wired, gmail_wired);
    let onboarded = message_customized && provider_ready && discovery_connected;

    Ok(Json(StatusDto {
        provider,
        agents,
        canonical_wired,
        gmail_wired,
        message_customized,
        product_set,
        contacted_customized,
        onboarded,
        base_url,
        model,
        key_set,
        discovery_connected,
        destination_connected,
        osint: crate::osint::status(),
        gmail_client_configured: crate::oauth::google_client().is_some(),
        gcloud_available: crate::gcloud::available(),
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

/// Turn a connect result into a handled response — a clear `ok:false` message instead of a
/// bare 500, so the browser can show *why* (e.g. no Google client configured, consent denied).
fn connect_result(r: anyhow::Result<()>) -> Json<MsgResp> {
    match r {
        Ok(()) => Json(MsgResp::ok()),
        Err(e) => Json(MsgResp {
            ok: false,
            message: Some(e.to_string()),
            wired: None,
        }),
    }
}

/// Connect Discovery (Canonical): coldtrail's OWN OAuth, on every provider. Sourcing then
/// runs through `coldtrail source` (coldtrail's MCP client), not the provider's connector.
pub async fn connect_discovery() -> Result<Json<MsgResp>, ApiErr> {
    Ok(connect_result(crate::oauth::connect_canonical().await))
}

/// Connect Destination (Gmail). If coldtrail's own Google client is configured, run the
/// browser OAuth (works on every backend). Otherwise use the keyless gcloud ADC path —
/// verify a Gmail token can be minted from `gcloud auth application-default` credentials.
pub async fn connect_destination(
    Json(req): Json<super::api::GmailConnectReq>,
) -> Result<Json<MsgResp>, ApiErr> {
    if crate::oauth::google_client().is_none() {
        return Ok(Json(MsgResp {
            ok: false,
            message: Some(
                "Add your Google OAuth client (client id + secret) below first, then Connect Gmail."
                    .into(),
            ),
            wired: None,
        }));
    }
    let port = req.callback_port.unwrap_or(8765);
    Ok(connect_result(crate::oauth::connect_gmail(port).await))
}

/// Store a bring-your-own Google OAuth client (Desktop app) for Gmail. coldtrail's Connect
/// Gmail then runs its own OAuth with it — the reliable path for a restricted scope you can't
/// get through the shared gcloud client.
pub async fn set_gmail_client(
    Json(req): Json<super::api::GmailClientReq>,
) -> Result<Json<MsgResp>, ApiErr> {
    if req.client_id.trim().is_empty() {
        return Err(anyhow::anyhow!("client id is required").into());
    }
    crate::secrets::set_google_client(&req.client_id, &req.client_secret)?;
    Ok(Json(MsgResp::ok()))
}

/// Connect Gmail keyless via an app password: verify it (IMAP login) before storing, so the
/// user gets immediate feedback. coldtrail then drafts by IMAP APPEND — no OAuth client.
pub async fn set_gmail_app_password(
    Json(req): Json<super::api::AppPasswordReq>,
) -> Result<Json<MsgResp>, ApiErr> {
    let email = req.email.trim();
    let pw = req.app_password.replace(' ', "");
    if email.is_empty() || pw.is_empty() {
        return Ok(Json(MsgResp {
            ok: false,
            message: Some("enter your Gmail address and a 16-character app password".into()),
            wired: None,
        }));
    }
    if let Err(e) = crate::imap_draft::verify(email, &pw).await {
        return Ok(Json(MsgResp {
            ok: false,
            message: Some(e.to_string()),
            wired: None,
        }));
    }
    crate::secrets::set_gmail_app_password(email, &pw)?;
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

/// Assemble the outreach brief (message.toml) from the product form — the user's own words,
/// no invented claims. The agent still personalizes per company at draft time.
pub async fn set_pitch(Json(req): Json<super::api::PitchReq>) -> Result<Json<MsgResp>, ApiErr> {
    let toml = build_brief(&req);
    // Validate it parses as a Message before writing (guards the template shape).
    toml::from_str::<crate::message::Message>(&toml)
        .map_err(|e| anyhow::anyhow!("generated brief didn't parse: {e}"))?;
    std::fs::write(crate::home::path("message.toml")?, &toml)?;
    std::fs::write(crate::home::path("product.md")?, build_product_md(&req))?;
    Ok(Json(MsgResp::ok()))
}

/// Render the rich product brief the agent composes from. Prose, not a template — every
/// email is written fresh per company from this context. Only the user's words; no invented
/// claims (the interview + review gate enforce that upstream).
fn build_product_md(req: &super::api::PitchReq) -> String {
    let line = |label: &str, val: &str| {
        let v = val.trim();
        if v.is_empty() {
            String::new()
        } else {
            format!("**{label}:** {v}\n\n")
        }
    };
    let product = if req.product.trim().is_empty() {
        "your product".to_string()
    } else {
        req.product.trim().to_string()
    };
    let mut s = format!("# {product} — outreach brief\n\n");
    s.push_str(&line("What it does / who it helps", &req.value));
    s.push_str(&line("The pain / value", &req.pain_value));
    s.push_str(&line("Proof / differentiator", &req.proof));
    s.push_str(&line("Offer", &req.offer));
    s.push_str(&line("Voice / tone", &req.voice));
    s.push_str(&line("Call to action", &ensure_slug(&req.link)));
    s.push_str(&line("From", &req.sender));
    s.push_str(
        "---\n\nUse this as context. Write each email fresh for the specific company — \
         reference what they actually do and why it's a fit, in the sender's voice. \
         **Never send this verbatim. Don't invent claims beyond what's here.**\n",
    );
    s
}

/// Keep a `{slug}` in the CTA link so each send gets its own utm_content (attribution).
fn ensure_slug(link: &str) -> String {
    let link = link.trim();
    if link.is_empty() {
        return "https://example.com/?utm_content={slug}".into();
    }
    if link.contains("{slug}") {
        return link.to_string();
    }
    let sep = if link.contains('?') { '&' } else { '?' };
    format!("{link}{sep}utm_content={{slug}}")
}

/// Build a valid message.toml from the product form. Serialized via the toml crate so any
/// quotes/newlines in the user's text are escaped correctly.
fn build_brief(req: &super::api::PitchReq) -> String {
    #[derive(serde::Serialize)]
    struct Brief {
        link: String,
        subject: String,
        paragraphs: Vec<String>,
        cta_plain: String,
        cta_html: String,
    }
    let sender = {
        let s = req.sender.trim();
        if s.is_empty() {
            "Your Name".to_string()
        } else {
            s.to_string()
        }
    };
    let product = req.product.trim();
    let opening = if product.is_empty() {
        "I came across {company} recently and wanted to reach out.".to_string()
    } else {
        format!("I came across {{company}} while looking for teams that might get value from {product}.")
    };
    let mut paragraphs = vec!["Hi {fn},".to_string(), opening];
    let value = req.value.trim();
    if !value.is_empty() {
        paragraphs.push(value.to_string());
    }
    let pain = req.pain_value.trim();
    if !pain.is_empty() {
        paragraphs.push(pain.to_string());
    }
    let offer = req.offer.trim();
    if !offer.is_empty() {
        paragraphs.push(offer.to_string());
    }
    paragraphs.push("__CTA__".to_string());
    paragraphs.push(format!("— {sender}"));

    let subject = if product.is_empty() {
        "{company} — quick idea".to_string()
    } else {
        format!("{product} for {{company}}")
    };
    let brief = Brief {
        link: ensure_slug(&req.link),
        subject,
        paragraphs,
        cta_plain: "Take a look — no need to book a demo: {link}".to_string(),
        cta_html: "Take a look — no need to book a demo: <a href=\"{link}\">here</a>".to_string(),
    };
    toml::to_string_pretty(&brief).unwrap_or_default()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_brief_parses_and_keeps_placeholders() {
        let req = crate::web::api::PitchReq {
            product: "Canonical".into(),
            value: "Plain-English company search that finds the long tail.".into(),
            pain_value: String::new(),
            proof: String::new(),
            offer: "design partners: free credits".into(),
            voice: String::new(),
            link: "https://trycanonical.ai".into(),
            sender: "Dilpreet".into(),
        };
        let toml = build_brief(&req);
        let m: crate::message::Message = toml::from_str(&toml).expect("brief must parse");
        assert!(m.link.contains("{slug}"), "link keeps {{slug}}: {}", m.link);
        assert!(m.paragraphs.iter().any(|p| p == "__CTA__"));
        assert!(m.paragraphs.iter().any(|p| p.contains("Dilpreet")));
        assert!(m.paragraphs.iter().any(|p| p.contains("Plain-English")));
        assert!(m.paragraphs.iter().any(|p| p.contains("Canonical")));
    }

    #[test]
    fn build_brief_folds_pain_value() {
        let req = crate::web::api::PitchReq {
            product: "Canonical".into(),
            value: "Plain-English company search.".into(),
            pain_value: "Standard databases miss the long tail.".into(),
            proof: "Used by 100 outbound teams.".into(),
            offer: "free credits".into(),
            voice: "warm, direct".into(),
            link: "https://trycanonical.ai".into(),
            sender: "Dilpreet".into(),
        };
        let toml = build_brief(&req);
        let m: crate::message::Message = toml::from_str(&toml).expect("brief must parse");
        assert!(m.paragraphs.iter().any(|p| p.contains("long tail")));
    }

    #[test]
    fn product_md_has_link_and_context_note() {
        let req = crate::web::api::PitchReq {
            product: "Canonical".into(),
            value: "Plain-English company search.".into(),
            pain_value: String::new(),
            proof: String::new(),
            offer: String::new(),
            voice: String::new(),
            link: "https://trycanonical.ai".into(),
            sender: "Dilpreet".into(),
        };
        let md = build_product_md(&req);
        assert!(md.contains("trycanonical.ai"), "keeps CTA link");
        assert!(
            md.to_lowercase().contains("never send"),
            "carries the compose-fresh instruction"
        );
        assert!(md.contains("Canonical"));
    }

    #[test]
    fn ensure_slug_appends_when_missing() {
        assert!(ensure_slug("https://x.com").contains("utm_content={slug}"));
        assert_eq!(
            ensure_slug("https://x.com?a=1&utm_content={slug}")
                .matches("{slug}")
                .count(),
            1
        );
    }
}
