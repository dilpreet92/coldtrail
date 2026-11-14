//! Onboarding over HTTP — the browser equivalent of `coldtrail setup`, reusing the
//! same detection + wiring logic.

use std::path::Path;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Json;

use super::api::{AgentDto, McpReq, MsgResp, OpencodeModelsDto, ProviderReq, StatusDto, TomlReq};
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
    // Connected = a Gmail app password (keyless IMAP), a Gmail OAuth token (own client) or a
    // gcloud login, in the order delivery uses them (`deliver::draft`, then `gmail::token`).
    // One rule for every screen. A gcloud login counts only once Gmail has taken a draft or
    // send through it: a plain one lacks the Gmail scope, and the ADC file can't tell. Until
    // then it is only `gcloud_available`, which Drafts' Create Gmail draft still tries.
    let gmail_via = if crate::secrets::gmail_app_password().is_some() {
        Some("app_password")
    } else if crate::secrets::has_token("gmail") {
        Some("google")
    } else if crate::gcloud::gmail_verified() {
        Some("gcloud")
    } else {
        None
    };
    let destination_connected = gmail_via.is_some();
    let _ = (canonical_wired, gmail_wired, message_customized);
    let onboarded = product_set && provider_ready && discovery_connected;
    let li = crate::linkedin::LinkedinState::load();

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
        opencode_model: cfg.opencode_model,
        discovery_connected,
        destination_connected,
        gmail_via: gmail_via.map(String::from),
        auto_send: cfg.auto_send,
        daily_send_cap: cfg
            .daily_send_cap
            .unwrap_or(crate::config::DEFAULT_DAILY_SEND_CAP),
        email_sent_today: crate::deliver::sent_today(),
        osint: crate::osint::status(),
        gmail_client_configured: crate::oauth::google_client().is_some(),
        gcloud_available: crate::gcloud::available(),
        linkedin_connected: li.connected,
        linkedin_reconnect_needed: li.reconnect_needed,
        linkedin_auto_send: cfg.linkedin_auto_send,
        linkedin_weekly_cap: cfg
            .linkedin_weekly_cap
            .unwrap_or(crate::config::DEFAULT_LINKEDIN_WEEKLY_CAP),
        linkedin_daily_cap: cfg
            .linkedin_daily_cap
            .unwrap_or(crate::config::DEFAULT_LINKEDIN_DAILY_CAP),
        linkedin_sent_7d: crate::deliver::linkedin_sent_last_7d(),
        linkedin_sent_today: crate::deliver::linkedin_sent_today(),
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

/// Probe the configured provider with a tiny real turn — the honest "am I signed in?" check.
/// The file-existence heuristic can't see an expired token; this runs the actual CLI/model so
/// an expired login surfaces as a clear, actionable error. Tools disabled; ~45s cap.
pub async fn probe_provider() -> Result<Json<MsgResp>, ApiErr> {
    use crate::probe::{probe, Outcome};
    use crate::provider::resolve;

    let backend = resolve();
    let outcome = probe(&backend).await;

    let agent = crate::config::load()
        .agent
        .unwrap_or_else(|| "claude".into());
    let provider = AgentKind::from_str(&agent)
        .map(|k| k.label())
        .unwrap_or("Your model");

    Ok(Json(match outcome {
        Outcome::Ok => MsgResp {
            ok: true,
            message: Some(format!("{provider} is signed in and responding.")),
            wired: None,
        },
        Outcome::Failed(m) => MsgResp {
            ok: false,
            message: Some(m),
            wired: None,
        },
        Outcome::TimedOut => MsgResp {
            ok: false,
            message: Some(format!(
                "{provider} timed out — check the log at ~/.coldtrail/coldtrail.log"
            )),
            wired: None,
        },
    }))
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

/// Opt into (or out of) auto-send, and set the per-day cap. Off by default — this deliberately
/// relaxes the draft-only guardrail, so it's an explicit human toggle in Settings.
pub async fn set_auto_send(
    Json(req): Json<super::api::AutoSendReq>,
) -> Result<Json<MsgResp>, ApiErr> {
    let mut c = crate::config::load();
    c.auto_send = req.enabled;
    if let Some(cap) = req.daily_cap {
        c.daily_send_cap = Some(cap.max(1));
    }
    crate::config::save(&c)?;
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
            save_cli_agent(kind, req.opencode_model.as_deref())?;
            Ok(Json(MsgResp::ok()))
        }
    }
}

/// Make CLI agent `kind` the provider. For opencode, `opencode_model` pins the model chat and
/// scheduled runs pass to `opencode run`: a non-blank value is saved trimmed, a blank one
/// clears the pin (opencode's own default), and `None` keeps what is saved. Other agents
/// ignore it, so switching away and back keeps the pin.
fn save_cli_agent(kind: AgentKind, opencode_model: Option<&str>) -> anyhow::Result<()> {
    let mut c = crate::config::load();
    c.agent = Some(kind.config_value().to_string());
    if let (AgentKind::Opencode, Some(m)) = (kind, opencode_model) {
        let m = m.trim();
        c.opencode_model = (!m.is_empty()).then(|| m.to_string());
    }
    crate::config::save(&c)
}

/// How long a successful `opencode models` listing is reused before it runs again.
const MODELS_TTL: Duration = Duration::from_secs(10 * 60);
/// `opencode models` gets this long before the picker falls back to free text.
const MODELS_TIMEOUT: Duration = Duration::from_secs(5);
/// The last non-empty listing and when it was taken. Failures aren't cached, so installing or
/// signing in to opencode shows up on the next request.
static MODELS_CACHE: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);

/// The models the opencode card's picker offers. When opencode is missing, fails or is slow
/// this is still a 200: the list is empty and `message` says why (the UI then takes free text).
pub async fn opencode_models() -> Result<Json<OpencodeModelsDto>, ApiErr> {
    let cached = MODELS_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .filter(|(at, _)| at.elapsed() < MODELS_TTL)
        .map(|(_, models)| models.clone());
    if let Some(models) = cached {
        return Ok(Json(OpencodeModelsDto {
            models,
            message: None,
        }));
    }
    // The workspace is the cwd opencode turns run in, so a project config there counts too.
    let ws = crate::home::workspace()?;
    let program = agents::program_path(AgentKind::Opencode);
    let (models, message) = match run_models(&program, &ws, MODELS_TIMEOUT).await {
        Some(models) if !models.is_empty() => {
            *MODELS_CACHE.lock().unwrap_or_else(|e| e.into_inner()) =
                Some((Instant::now(), models.clone()));
            (models, None)
        }
        Some(_) => (Vec::new(), Some("opencode didn't list any models".into())),
        None => (
            Vec::new(),
            Some("opencode isn't installed or didn't respond".into()),
        ),
    };
    Ok(Json(OpencodeModelsDto { models, message }))
}

/// Run `<program> models` in `cwd` with the same environment as opencode turns. `None` when it
/// can't start, exits non-zero, or outlives `limit` (the child is killed then).
async fn run_models(program: &Path, cwd: &Path, limit: Duration) -> Option<Vec<String>> {
    let out = tokio::process::Command::new(program)
        .arg("models")
        .envs(crate::provider::cli::OPENCODE_ENV)
        .current_dir(cwd)
        // opencode waits on an open stdin before running — it must be closed.
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(limit, out).await.ok()?.ok()?;
    out.status
        .success()
        .then(|| parse_models(&String::from_utf8_lossy(&out.stdout)))
}

/// Model ids from `opencode models` output: one `provider/model` per line. Blank lines and
/// anything with inner whitespace (log or warning lines) are dropped; repeats keep the first.
pub fn parse_models(stdout: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.contains(char::is_whitespace))
        .filter(|l| seen.insert(*l))
        .map(str::to_string)
        .collect()
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
    // The root cause is the TOML parser's error, which names the line and column; the outer
    // context alone ("not valid TOML") would leave the user guessing where.
    crate::seed::parse(&req.toml)
        .map_err(|e| anyhow::anyhow!("invalid contacted.toml: {}", e.root_cause()))?;
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
        AgentKind::Opencode => false, // nothing is wired into opencode
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
    fn parse_models_trims_dedupes_and_skips_noise() {
        assert_eq!(
            parse_models("a/b\n\n  c/d \na/b\nWARN something\n"),
            vec!["a/b".to_string(), "c/d".to_string()]
        );
        assert!(parse_models("").is_empty());
    }

    #[test]
    fn status_reports_opencode_model() {
        crate::testutil::with_home("ct-web-onboarding-model-status", |dir| {
            crate::home::workspace().unwrap();
            let rt = tokio::runtime::Runtime::new().unwrap();
            std::fs::write(
                dir.join("config.toml"),
                "agent = \"opencode\"\nopencode_model = \"opencode/grok-code\"\n",
            )
            .unwrap();
            let s = rt.block_on(status()).unwrap().0;
            assert_eq!(s.opencode_model.as_deref(), Some("opencode/grok-code"));
            std::fs::write(dir.join("config.toml"), "agent = \"opencode\"\n").unwrap();
            assert_eq!(rt.block_on(status()).unwrap().0.opencode_model, None);
        });
    }

    /// A gcloud user login is offered as the keyless path (`gcloud_available`), but it is a
    /// Gmail connection only once Gmail has taken a draft or send through it: ADC doesn't
    /// record scopes, and a plain `gcloud auth application-default login` lacks the Gmail one.
    /// A new login (or quota project) has to show it again. An app password wins (delivery
    /// uses it first). An ADC file with no user login isn't offered at all.
    #[test]
    fn status_counts_a_gcloud_login_as_gmail_once_it_reached_gmail() {
        crate::testutil::with_home("ct-web-onboarding-gcloud", |dir| {
            let _ = std::fs::remove_dir_all(format!("{}.secrets", dir.display()));
            crate::home::workspace().unwrap();
            let adc = dir.join("adc.json");
            std::env::set_var("GOOGLE_APPLICATION_CREDENTIALS", &adc);
            let rt = tokio::runtime::Runtime::new().unwrap();
            let gmail = || {
                let s = rt.block_on(status()).unwrap().0;
                (s.destination_connected, s.gmail_via, s.gcloud_available)
            };
            let login = |refresh: &str| {
                std::fs::write(
                    &adc,
                    format!(
                        r#"{{"type":"authorized_user","client_id":"c","client_secret":"s","refresh_token":"{refresh}"}}"#
                    ),
                )
                .unwrap()
            };
            let none = gmail();
            std::fs::write(&adc, r#"{"type":"service_account","client_id":"1"}"#).unwrap();
            let service_account = gmail();
            crate::gcloud::gmail_worked();
            let service_account_worked = gmail();
            login("r1");
            let unproven = gmail();
            crate::gcloud::gmail_worked();
            let proven = gmail();
            login("r2");
            let new_login = gmail();
            crate::secrets::set_gmail_app_password("me@gmail.com", "abcd efgh ijkl mnop").unwrap();
            let both = gmail();
            std::env::remove_var("GOOGLE_APPLICATION_CREDENTIALS");
            let _ = std::fs::remove_dir_all(format!("{}.secrets", dir.display()));

            assert_eq!(none, (false, None, false));
            assert_eq!(service_account, (false, None, false));
            assert_eq!(service_account_worked, (false, None, false));
            assert_eq!(unproven, (false, None, true));
            assert_eq!(proven, (true, Some("gcloud".into()), true));
            assert_eq!(new_login, (false, None, true));
            assert_eq!(both, (true, Some("app_password".into()), true));
        });
    }

    /// `email_sent_today` counts today's email sends only (the warmup cap's count), beside the
    /// LinkedIn counters: not yesterday's, not LinkedIn invites, not unsent drafts.
    #[test]
    fn status_reports_email_sent_today() {
        crate::testutil::with_home("ct-web-onboarding-email-today", |_| {
            crate::home::workspace().unwrap();
            crate::db::init().unwrap();
            let rt = tokio::runtime::Runtime::new().unwrap();
            assert_eq!(rt.block_on(status()).unwrap().0.email_sent_today, 0);
            crate::db::open()
                .unwrap()
                .execute_batch(
                    "INSERT INTO companies (domain) VALUES ('a.com'), ('b.com'), ('c.com'), \
                     ('d.com'), ('e.com'); \
                     INSERT INTO outreach (domain, channel, status, sent_at) VALUES \
                     ('a.com','email','sent',datetime('now')), \
                     ('b.com',NULL,'sent',datetime('now')), \
                     ('c.com','email','sent',datetime('now','-2 days')), \
                     ('d.com','linkedin','sent',datetime('now')); \
                     INSERT INTO outreach (domain, channel, status) VALUES ('e.com','email','draft_pending');",
                )
                .unwrap();
            let s = rt.block_on(status()).unwrap().0;
            assert_eq!(s.email_sent_today, 2);
            assert_eq!(s.linkedin_sent_today, 1);
            let v = serde_json::to_value(&s).unwrap();
            assert_eq!(v["email_sent_today"], 2);
        });
    }

    /// Invalid TOML is a 500 whose body carries the parser's location, so the Company profile
    /// screen can say where the mistake is; the file on disk is left alone.
    #[test]
    fn set_contacted_error_names_the_line() {
        use tower::ServiceExt;
        crate::testutil::with_home("ct-web-onboarding-contacted-invalid", |_| {
            crate::home::workspace().unwrap();
            let before = std::fs::read_to_string(crate::home::path("contacted.toml").unwrap()).ok();
            let rt = tokio::runtime::Runtime::new().unwrap();
            let req = axum::http::Request::builder()
                .method("POST")
                .uri("/api/onboarding/contacted?t=secret-tok")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({"toml": "\"ok.com\" = { status = \"sent\" }\nnot a domain\n"})
                        .to_string(),
                ))
                .unwrap();
            let app = crate::web::router(crate::web::tests::state());
            let resp = rt.block_on(app.oneshot(req)).unwrap();
            assert_eq!(resp.status(), axum::http::StatusCode::INTERNAL_SERVER_ERROR);
            let body = rt
                .block_on(axum::body::to_bytes(resp.into_body(), usize::MAX))
                .unwrap();
            let body = String::from_utf8(body.to_vec()).unwrap();
            assert!(body.starts_with("invalid contacted.toml"), "{body}");
            assert!(body.contains("line 2"), "{body}");
            assert_eq!(
                std::fs::read_to_string(crate::home::path("contacted.toml").unwrap()).ok(),
                before
            );
        });
    }

    #[test]
    fn set_provider_saves_and_clears_opencode_model() {
        crate::testutil::with_home("ct-web-onboarding-model-save", |_| {
            crate::home::workspace().unwrap();
            let saved = || crate::config::load().opencode_model;
            save_cli_agent(AgentKind::Opencode, Some("  opencode/grok-code ")).unwrap();
            assert_eq!(crate::config::load().agent.as_deref(), Some("opencode"));
            assert_eq!(saved().as_deref(), Some("opencode/grok-code"));
            // Absent keeps the pin (a plain card click doesn't wipe it).
            save_cli_agent(AgentKind::Opencode, None).unwrap();
            assert_eq!(saved().as_deref(), Some("opencode/grok-code"));
            // Another agent ignores the field and keeps the pin for a switch back.
            save_cli_agent(AgentKind::Claude, Some("x/y")).unwrap();
            assert_eq!(crate::config::load().agent.as_deref(), Some("claude"));
            assert_eq!(saved().as_deref(), Some("opencode/grok-code"));
            // Blank clears it, back to opencode's own default.
            save_cli_agent(AgentKind::Opencode, Some("")).unwrap();
            assert_eq!(saved(), None);
        });
    }

    /// A fresh listing is served as-is, without running opencode again.
    #[test]
    fn opencode_models_reuses_a_fresh_listing() {
        let listing = vec!["cached/model".to_string()];
        *MODELS_CACHE.lock().unwrap() = Some((Instant::now(), listing.clone()));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let got = rt.block_on(opencode_models()).unwrap().0;
        *MODELS_CACHE.lock().unwrap() = None;
        assert_eq!(got.models, listing);
        assert_eq!(got.message, None);
    }

    /// A stand-in `opencode` that runs `body` as a shell script.
    #[cfg(unix)]
    fn fake_opencode(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join("opencode");
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[cfg(unix)]
    #[test]
    fn run_models_lists_and_reports_failures() {
        crate::testutil::with_home("ct-web-onboarding-models", |dir| {
            let ws = crate::home::workspace().unwrap();
            let rt = tokio::runtime::Runtime::new().unwrap();
            let limit = Duration::from_secs(5);
            let ok = fake_opencode(
                &dir.join("ok"),
                r#"[ "$1" = models ] && printf 'b/one\na/two\n'"#,
            );
            assert_eq!(
                rt.block_on(run_models(&ok, &ws, limit)),
                Some(vec!["b/one".to_string(), "a/two".to_string()])
            );
            let failing = fake_opencode(&dir.join("fail"), "echo x/y; exit 1");
            assert_eq!(rt.block_on(run_models(&failing, &ws, limit)), None);
            assert_eq!(
                rt.block_on(run_models(&dir.join("missing"), &ws, limit)),
                None
            );
            // Past the limit the child is killed and the call gives up.
            let slow = fake_opencode(&dir.join("slow"), "exec sleep 5");
            let t = Instant::now();
            assert_eq!(
                rt.block_on(run_models(&slow, &ws, Duration::from_millis(200))),
                None
            );
            assert!(t.elapsed() < Duration::from_secs(3));
        });
    }
}
