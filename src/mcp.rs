//! Pure generation of MCP server config: the `claude mcp add` argv for the Claude
//! path, and merged `~/.codex/config.toml` text for the Codex path. No I/O, no
//! secrets in argv (the Gmail client secret is passed via env at call time).

use anyhow::{anyhow, Result};

#[derive(Debug, Clone)]
pub struct OAuthClient {
    pub client_id: String,
    pub callback_port: u16,
}

#[derive(Debug, Clone)]
pub struct McpServer {
    pub name: String,
    pub url: String,
    pub oauth: Option<OAuthClient>,
}

/// The argv that follows `claude mcp` (i.e. `add ...`) to register `s` at project
/// scope. Excludes the OAuth client secret — that is supplied out-of-band via the
/// `MCP_CLIENT_SECRET` env var on the spawned command.
pub fn claude_add_args(s: &McpServer) -> Vec<String> {
    let mut a = vec![
        "--transport".to_string(),
        "http".to_string(),
        "--scope".to_string(),
        "project".to_string(),
    ];
    if let Some(o) = &s.oauth {
        a.push("--client-id".to_string());
        a.push(o.client_id.clone());
        a.push("--client-secret".to_string()); // flag only; value via MCP_CLIENT_SECRET
        a.push("--callback-port".to_string());
        a.push(o.callback_port.to_string());
    }
    a.push(s.name.clone());
    a.push(s.url.clone());
    a
}

/// Merge `servers` into an existing `~/.codex/config.toml` body, preserving unrelated
/// content and replacing (not duplicating) any same-named server. Idempotent.
pub fn codex_config_merge(existing: &str, servers: &[McpServer]) -> Result<String> {
    let mut root: toml::Table = if existing.trim().is_empty() {
        toml::Table::new()
    } else {
        toml::from_str(existing)
            .map_err(|e| anyhow!("~/.codex/config.toml is not valid TOML: {e}"))?
    };

    if !root.contains_key("mcp_servers") {
        root.insert("mcp_servers".into(), toml::Value::Table(toml::Table::new()));
    }
    let servers_tbl = root
        .get_mut("mcp_servers")
        .and_then(|v| v.as_table_mut())
        .ok_or_else(|| anyhow!("`mcp_servers` in config.toml is not a table"))?;

    for s in servers {
        let mut t = toml::Table::new();
        t.insert("url".into(), toml::Value::String(s.url.clone()));
        servers_tbl.insert(s.name.clone(), toml::Value::Table(t));
    }

    Ok(toml::to_string_pretty(&root)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_args_canonical_plain() {
        let s = McpServer {
            name: "canonical".into(),
            url: "https://trycanonical.ai/mcp/".into(),
            oauth: None,
        };
        assert_eq!(
            claude_add_args(&s),
            vec![
                "--transport",
                "http",
                "--scope",
                "project",
                "canonical",
                "https://trycanonical.ai/mcp/"
            ]
        );
    }

    #[test]
    fn claude_args_gmail_oauth_no_secret_in_argv() {
        let s = McpServer {
            name: "gmail".into(),
            url: "https://gmailmcp.googleapis.com/mcp/v1".into(),
            oauth: Some(OAuthClient {
                client_id: "abc.apps".into(),
                callback_port: 8765,
            }),
        };
        let a = claude_add_args(&s);
        assert!(a.contains(&"--client-id".to_string()) && a.contains(&"abc.apps".to_string()));
        assert!(a.contains(&"--client-secret".to_string())); // flag present (env supplies value)
        assert!(a.contains(&"--callback-port".to_string()) && a.contains(&"8765".to_string()));
        // the secret value is never in argv
        assert!(!a
            .iter()
            .any(|x| x.to_lowercase().contains("secret") && x.contains('=')));
        assert!(a.last().unwrap() == "https://gmailmcp.googleapis.com/mcp/v1");
    }

    #[test]
    fn codex_merge_adds_and_is_idempotent() {
        let servers = vec![McpServer {
            name: "canonical".into(),
            url: "https://trycanonical.ai/mcp/".into(),
            oauth: None,
        }];
        let once = codex_config_merge("", &servers).unwrap();
        assert!(once.contains("[mcp_servers.canonical]"));
        assert!(once.contains("https://trycanonical.ai/mcp/"));

        let twice = codex_config_merge(&once, &servers).unwrap();
        assert_eq!(twice.matches("[mcp_servers.canonical]").count(), 1);

        let with_other = codex_config_merge("model = \"gpt\"\n", &servers).unwrap();
        assert!(with_other.contains("model = \"gpt\""));
        assert!(with_other.contains("[mcp_servers.canonical]"));
        // round-trips
        let _: toml::Table = toml::from_str(&with_other).unwrap();
    }
}
