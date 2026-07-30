//! `coldtrail setup` — the wizard. Ensures the workspace, detects the agent CLIs,
//! picks a default provider, and wires the Canonical + Gmail MCP servers into
//! coldtrail's own scope for that provider. Idempotent and re-runnable.

use anyhow::{anyhow, Result};
use std::path::Path;
use std::process::Command;

use crate::agents::{self, AgentKind, AgentStatus};
use crate::mcp::{self, McpServer, OAuthClient};

pub const CLAUDE_MD: &str = include_str!("../templates/CLAUDE.md");
pub const ENRICHMENT_MD: &str = include_str!("../templates/enrichment.md");
pub const MESSAGE_TOML: &str = include_str!("../templates/message.toml");
pub const CONTACTED_TOML: &str = include_str!("../templates/contacted.toml");
pub const CONFIG_TOML: &str = "agent = \"claude\"\n";

const CANONICAL_URL: &str = "https://trycanonical.ai/mcp/";
const GMAIL_URL: &str = "https://gmailmcp.googleapis.com/mcp/v1";

pub struct SetupOpts {
    pub provider: Option<String>,
    pub gmail_callback_port: u16,
    pub skip_gmail: bool,
    pub force: bool,
}

/// Make sure the workspace has current tool-owned assets and the user files present.
/// `CLAUDE.md` is always refreshed; user files are created only if missing.
pub fn ensure() -> Result<()> {
    crate::home::workspace()?;
    crate::home::write_asset("CLAUDE.md", CLAUDE_MD, true)?;
    crate::home::write_asset("enrichment.md", ENRICHMENT_MD, true)?;
    crate::home::write_asset("message.toml", MESSAGE_TOML, false)?;
    crate::home::write_asset("contacted.toml", CONTACTED_TOML, false)?;
    crate::home::write_asset("config.toml", CONFIG_TOML, false)?;
    crate::db::init()?;
    Ok(())
}

pub fn run(opts: SetupOpts) -> Result<()> {
    let ws = crate::home::workspace()?;
    ensure()?;
    println!("workspace ready at {}\n", ws.display());

    // --- detect agents -------------------------------------------------------
    let statuses = agents::detect_all();
    println!("agents:");
    for s in &statuses {
        let line = if !s.present {
            format!("not found — install: {}", s.kind.install_hint())
        } else if s.authed {
            "found, authenticated".to_string()
        } else {
            format!(
                "found — not signed in yet (run `{}` once to log in)",
                s.kind.bin()
            )
        };
        let mark = if s.present { "✓" } else { "✗" };
        println!("  {mark} {:<12} {line}", s.kind.label());
    }
    println!();

    // --- pick provider -------------------------------------------------------
    let interactive_choice = if crate::prompt::interactive()
        && opts.provider.is_none()
        && statuses.iter().filter(|s| s.present).count() >= 2
    {
        crate::prompt::select("default agent", &["claude", "codex"], "claude")
    } else {
        None
    };

    if let Some(flag) = &opts.provider {
        match AgentKind::from_str(flag) {
            None => {
                return Err(anyhow!(
                    "unknown --provider '{flag}' (expected claude or codex)"
                ));
            }
            Some(k) if !statuses.iter().any(|s| s.kind == k && s.present) => {
                return Err(anyhow!(
                    "--provider '{flag}' is not installed; install it ({}) or choose an available agent",
                    k.install_hint()
                ));
            }
            Some(_) => {}
        }
    }

    let provider = match resolve_provider(
        &statuses,
        opts.provider.as_deref(),
        interactive_choice.as_deref(),
    ) {
        Some(k) => k,
        None => match statuses.iter().find(|s| s.present).map(|s| s.kind) {
            Some(k) => {
                println!("defaulting to {}", k.label());
                k
            }
            None => {
                println!("no agent CLI found — install one, then re-run `coldtrail setup`:");
                for k in AgentKind::all() {
                    println!("  {}: {}", k.label(), k.install_hint());
                }
                return Ok(());
            }
        },
    };
    write_agent(provider)?;
    println!("default provider: {}\n", provider.label());

    // --- wire MCP servers ----------------------------------------------------
    let canonical = McpServer {
        name: "canonical".into(),
        url: CANONICAL_URL.into(),
        oauth: None,
    };
    let gmail_creds = if opts.skip_gmail { None } else { gmail_creds() };

    match provider {
        AgentKind::Claude => {
            claude_wire(&canonical, None, opts.force, &ws)?;
            println!("  ✓ canonical wired");
            if opts.skip_gmail {
                println!("  – gmail skipped (--skip-gmail)");
            } else if let Some((id, secret)) = gmail_creds {
                print_gmail_prereqs(opts.gmail_callback_port);
                let gmail = gmail_server(id, opts.gmail_callback_port);
                claude_wire(&gmail, Some(&secret), opts.force, &ws)?;
                println!("  ✓ gmail wired");
            } else {
                print_gmail_prereqs(opts.gmail_callback_port);
                println!(
                    "  – gmail skipped: set COLDTRAIL_GMAIL_CLIENT_ID + COLDTRAIL_GMAIL_CLIENT_SECRET \
                     (or run setup in a terminal), then re-run."
                );
            }
        }
        AgentKind::Codex => {
            let mut servers = vec![canonical];
            if !opts.skip_gmail {
                if let Some((id, _secret)) = gmail_creds {
                    print_gmail_prereqs(opts.gmail_callback_port);
                    servers.push(gmail_server(id, opts.gmail_callback_port));
                    println!(
                        "  ! Codex can't store the Gmail OAuth secret for you — add it to \
                         ~/.codex/config.toml or Codex's auth flow manually."
                    );
                }
            }
            codex_wire(&servers)?;
            println!(
                "  ✓ wrote {} server(s) to ~/.codex/config.toml",
                servers.len()
            );
            println!(
                "  ! HTTP-MCP support varies by Codex version; if `codex` doesn't pick these up, \
                 check its MCP docs."
            );
        }
    }

    // --- enrichment (OSINT) --------------------------------------------------
    // Auto-install theHarvester so the agent can do deeper founder-email discovery.
    // Best-effort: never fail setup over it — the built-in web finder is the fallback.
    println!("\nenrichment (OSINT):");
    let osint = crate::osint::status();
    if osint.the_harvester {
        println!("  ✓ theHarvester already installed");
    } else if osint.pipx {
        print!("  installing theHarvester via pipx… ");
        use std::io::Write;
        let _ = std::io::stdout().flush();
        match crate::osint::install_the_harvester() {
            Ok(_) => println!("done"),
            Err(e) => println!("skipped ({e})"),
        }
    } else {
        println!(
            "  – pipx not found; skipping theHarvester. Install pipx to enable it \
             (the agent falls back to its built-in web finder either way)."
        );
    }
    if osint.spiderfoot {
        println!("  ✓ SpiderFoot already installed");
    } else if osint.spiderfoot_can_install {
        print!("  installing SpiderFoot (clone + venv, a few minutes)… ");
        use std::io::Write;
        let _ = std::io::stdout().flush();
        match crate::osint::install_spiderfoot() {
            Ok(_) => println!("done"),
            Err(e) => println!("skipped ({e})"),
        }
    } else {
        println!(
            "  – SpiderFoot skipped (needs git + Python 3.10–3.12). Install those to enable it."
        );
    }

    println!("\ndone. run `coldtrail` — OAuth for Canonical/Gmail completes in your browser on first use.");
    Ok(())
}

/// Pure provider resolution. `flag` is `--provider`; `choice` is an interactive pick.
/// Returns the chosen present agent, or None if unresolvable (caller may default).
fn resolve_provider(
    statuses: &[AgentStatus],
    flag: Option<&str>,
    choice: Option<&str>,
) -> Option<AgentKind> {
    let present: Vec<AgentKind> = statuses
        .iter()
        .filter(|s| s.present)
        .map(|s| s.kind)
        .collect();
    if let Some(f) = flag {
        let k = AgentKind::from_str(f)?;
        return present.contains(&k).then_some(k);
    }
    match present.len() {
        0 => None,
        1 => Some(present[0]),
        _ => {
            let k = AgentKind::from_str(choice?)?;
            present.contains(&k).then_some(k)
        }
    }
}

fn gmail_server(client_id: String, callback_port: u16) -> McpServer {
    McpServer {
        name: "gmail".into(),
        url: GMAIL_URL.into(),
        oauth: Some(OAuthClient {
            client_id,
            callback_port,
        }),
    }
}

/// Gmail OAuth client id + secret from env, or interactive prompt. None if unavailable.
fn gmail_creds() -> Option<(String, String)> {
    let id = std::env::var("COLDTRAIL_GMAIL_CLIENT_ID")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| crate::prompt::line("Gmail OAuth client id", None));
    let secret = std::env::var("COLDTRAIL_GMAIL_CLIENT_SECRET")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| crate::prompt::secret("Gmail OAuth client secret"));
    match (id, secret) {
        (Some(i), Some(s)) if !i.trim().is_empty() && !s.trim().is_empty() => Some((i, s)),
        _ => None,
    }
}

fn print_gmail_prereqs(port: u16) {
    println!("Gmail MCP needs a Google Cloud OAuth client (one-time):");
    println!("  1. Enable the Gmail API and Gmail MCP API in a Google Cloud project.");
    println!(
        "  2. Create an OAuth 2.0 Client (type: Web application); note the client id + secret."
    );
    println!("  3. Consent screen scopes: gmail.readonly, gmail.compose.");
    println!("  4. Add redirect URI: http://localhost:{port}/callback");
    println!("     (if Claude reports a different callback URL on first use, add that one too)");
}

/// Wire the chosen provider's MCP servers (canonical + optional gmail) into coldtrail
/// scope. Returns the wired server names. Shared by the CLI wizard and web onboarding.
pub fn wire_mcp(
    provider: AgentKind,
    gmail: Option<(String, String)>,
    callback_port: u16,
    force: bool,
    ws: &Path,
) -> Result<Vec<String>> {
    let canonical = McpServer {
        name: "canonical".into(),
        url: CANONICAL_URL.into(),
        oauth: None,
    };
    let mut wired = Vec::new();
    match provider {
        AgentKind::Claude => {
            claude_wire(&canonical, None, force, ws)?;
            wired.push("canonical".into());
            if let Some((id, secret)) = gmail {
                let g = gmail_server(id, callback_port);
                claude_wire(&g, Some(&secret), force, ws)?;
                wired.push("gmail".into());
            }
        }
        AgentKind::Codex => {
            let mut servers = vec![canonical];
            if let Some((id, _)) = &gmail {
                servers.push(gmail_server(id.clone(), callback_port));
            }
            codex_wire(&servers)?;
            wired = servers.into_iter().map(|s| s.name).collect();
        }
    }
    Ok(wired)
}

pub fn write_agent(kind: AgentKind) -> Result<()> {
    let p = crate::home::path("config.toml")?;
    std::fs::write(&p, format!("agent = \"{}\"\n", kind.config_value()))?;
    Ok(())
}

pub fn read_agent() -> Result<AgentKind> {
    let raw = std::fs::read_to_string(crate::home::path("config.toml")?).unwrap_or_default();
    let table: toml::Table = toml::from_str(&raw).unwrap_or_default();
    let a = table
        .get("agent")
        .and_then(|v| v.as_str())
        .unwrap_or("claude");
    Ok(AgentKind::from_str(a).unwrap_or(AgentKind::Claude))
}

// --- MCP wiring (I/O) --------------------------------------------------------

fn claude_wire(server: &McpServer, secret: Option<&str>, force: bool, ws: &Path) -> Result<()> {
    let exists = Command::new("claude")
        .args(["mcp", "get", &server.name])
        .current_dir(ws)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if exists && !force {
        println!(
            "  · {} already configured (use --force to redo)",
            server.name
        );
        return Ok(());
    }
    if exists && force {
        let _ = Command::new("claude")
            .args(["mcp", "remove", &server.name, "--scope", "project"])
            .current_dir(ws)
            .status();
    }
    let mut cmd = Command::new("claude");
    cmd.arg("mcp")
        .arg("add")
        .args(mcp::claude_add_args(server))
        .current_dir(ws);
    if let Some(sec) = secret {
        cmd.env("MCP_CLIENT_SECRET", sec);
    }
    let status = cmd
        .status()
        .map_err(|e| anyhow!("failed to run `claude mcp add`: {e}"))?;
    if !status.success() {
        return Err(anyhow!("`claude mcp add {}` failed", server.name));
    }
    Ok(())
}

fn codex_wire(servers: &[McpServer]) -> Result<()> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("no home directory"))?;
    let cfg = home.join(".codex").join("config.toml");
    let existing = std::fs::read_to_string(&cfg).unwrap_or_default();
    let merged = mcp::codex_config_merge(&existing, servers)?;
    if let Some(parent) = cfg.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&cfg, merged)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(kind: AgentKind, present: bool) -> AgentStatus {
        AgentStatus {
            kind,
            present,
            authed: present,
        }
    }

    #[test]
    fn setup_ensure_populates_workspace() {
        crate::testutil::with_home("coldtrail-setup-test", |tmp| {
            ensure().unwrap();
            for f in [
                "CLAUDE.md",
                "enrichment.md",
                "config.toml",
                "message.toml",
                "contacted.toml",
                "outreach.db",
            ] {
                assert!(tmp.join(f).exists(), "missing {f}");
            }
        });
    }

    #[test]
    fn resolve_provider_rules() {
        use AgentKind::*;
        let both = vec![st(Claude, true), st(Codex, true)];
        assert_eq!(resolve_provider(&both, Some("codex"), None), Some(Codex));
        assert_eq!(resolve_provider(&both, None, Some("codex")), Some(Codex));
        assert_eq!(resolve_provider(&both, None, None), None); // ambiguous -> caller defaults

        let only_codex = vec![st(Claude, false), st(Codex, true)];
        assert_eq!(resolve_provider(&only_codex, None, None), Some(Codex));

        let none = vec![st(Claude, false), st(Codex, false)];
        assert_eq!(resolve_provider(&none, None, None), None);

        // flag naming an absent agent -> unresolved
        assert_eq!(resolve_provider(&only_codex, Some("claude"), None), None);
    }

    #[test]
    fn agent_config_roundtrip() {
        crate::testutil::with_home("coldtrail-agent-cfg", |_tmp| {
            crate::home::workspace().unwrap();
            write_agent(AgentKind::Codex).unwrap();
            assert_eq!(read_agent().unwrap(), AgentKind::Codex);
            write_agent(AgentKind::Claude).unwrap();
            assert_eq!(read_agent().unwrap(), AgentKind::Claude);
        });
    }
}
