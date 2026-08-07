//! Secrets: the BYOK API key and per-connector OAuth tokens. Stored in
//! `~/.coldtrail/secrets.toml` (0600), never in `config.toml`/repo, never returned by HTTP.
//! `COLDTRAIL_API_KEY` overrides the API key.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenRec {
    pub access: String,
    pub refresh: Option<String>,
    pub expires_at: Option<i64>,
    pub token_endpoint: String,
    pub client_id: String,
    pub client_secret: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Secrets {
    api_key: Option<String>,
    /// A bring-your-own Google OAuth client (id + secret) for Gmail, pasted in Settings.
    #[serde(default)]
    google_client_id: Option<String>,
    #[serde(default)]
    google_client_secret: Option<String>,
    #[serde(default)]
    tokens: BTreeMap<String, TokenRec>,
}

/// Store a user-provided Google OAuth client (for Gmail).
pub fn set_google_client(id: &str, secret: &str) -> Result<()> {
    let mut s = load();
    s.google_client_id = Some(id.trim().to_string());
    s.google_client_secret = Some(secret.trim().to_string());
    save(&s)
}

/// The stored Google client, if any: (client_id, client_secret).
pub fn google_client() -> Option<(String, Option<String>)> {
    let s = load();
    let id = s.google_client_id.filter(|v| !v.trim().is_empty())?;
    Some((id, s.google_client_secret.filter(|v| !v.trim().is_empty())))
}

fn load() -> Secrets {
    crate::home::secret_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| toml::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(s: &Secrets) -> Result<()> {
    let p = crate::home::secret_path()?;
    std::fs::write(&p, toml::to_string(s)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// The BYOK API key, from env or `secrets.toml`. `None` if unset (e.g. local Ollama).
pub fn api_key() -> Option<String> {
    if let Ok(k) = std::env::var("COLDTRAIL_API_KEY") {
        if !k.trim().is_empty() {
            return Some(k);
        }
    }
    load().api_key.filter(|k| !k.trim().is_empty())
}

pub fn set_api_key(key: &str) -> Result<()> {
    let mut s = load();
    s.api_key = Some(key.to_string());
    save(&s)
}

pub fn has_key() -> bool {
    api_key().is_some()
}

pub fn save_token(connector: &str, rec: TokenRec) -> Result<()> {
    let mut s = load();
    s.tokens.insert(connector.to_string(), rec);
    save(&s)
}

pub fn token(connector: &str) -> Option<TokenRec> {
    load().tokens.get(connector).cloned()
}

pub fn has_token(connector: &str) -> bool {
    load().tokens.contains_key(connector)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_roundtrip() {
        crate::testutil::with_home("ct-secrets-test", |_| {
            crate::home::workspace().unwrap();
            save_token(
                "canonical",
                TokenRec {
                    access: "a1".into(),
                    refresh: Some("r1".into()),
                    expires_at: Some(123),
                    token_endpoint: "https://t".into(),
                    client_id: "cid".into(),
                    client_secret: None,
                },
            )
            .unwrap();
            assert!(has_token("canonical"));
            assert_eq!(token("canonical").unwrap().access, "a1");
            assert!(!has_token("gmail"));
        });
    }
}
