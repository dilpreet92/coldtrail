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
    /// Keyless Gmail via IMAP app password.
    #[serde(default)]
    gmail_address: Option<String>,
    #[serde(default)]
    gmail_app_password: Option<String>,
    /// Persistent loopback session token so restarting coldtrail doesn't invalidate open tabs.
    #[serde(default)]
    session_token: Option<String>,
    #[serde(default)]
    tokens: BTreeMap<String, TokenRec>,
}

/// The loopback app's session token. Persistent across restarts (created once, stored 0600),
/// so a restart doesn't strand an already-open browser tab with a stale token.
pub fn session_token() -> String {
    let mut s = load();
    if let Some(t) = s.session_token.as_ref().filter(|t| !t.trim().is_empty()) {
        return t.clone();
    }
    let t = uuid::Uuid::new_v4().to_string();
    s.session_token = Some(t.clone());
    let _ = save(&s);
    t
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

/// Store a Gmail app password (keyless IMAP drafting): the address + app password.
pub fn set_gmail_app_password(email: &str, app_password: &str) -> Result<()> {
    let mut s = load();
    s.gmail_address = Some(email.trim().to_string());
    s.gmail_app_password = Some(app_password.trim().to_string());
    save(&s)
}

/// The stored Gmail app-password credentials, if any: (email, app_password).
pub fn gmail_app_password() -> Option<(String, String)> {
    let s = load();
    let email = s.gmail_address.filter(|v| !v.trim().is_empty())?;
    let pw = s.gmail_app_password.filter(|v| !v.trim().is_empty())?;
    Some((email, pw))
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

    #[test]
    fn session_token_is_stable() {
        crate::testutil::with_home("ct-session-token", |_| {
            crate::home::workspace().unwrap();
            let a = session_token();
            assert!(!a.is_empty());
            assert_eq!(
                a,
                session_token(),
                "same token across calls (survives restart)"
            );
        });
    }
}
