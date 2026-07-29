//! API keys for BYOK backends. Stored in `~/.coldtrail/secrets.toml` (0600), never in
//! `config.toml` or the repo, and never returned by any HTTP endpoint. `COLDTRAIL_API_KEY`
//! overrides.

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Default, Serialize, Deserialize)]
struct Secrets {
    api_key: Option<String>,
}

/// The BYOK API key, from env or `secrets.toml`. `None` if unset (e.g. local Ollama).
pub fn api_key() -> Option<String> {
    if let Ok(k) = std::env::var("COLDTRAIL_API_KEY") {
        if !k.trim().is_empty() {
            return Some(k);
        }
    }
    crate::home::path("secrets.toml")
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| toml::from_str::<Secrets>(&s).ok())
        .and_then(|s| s.api_key)
        .filter(|k| !k.trim().is_empty())
}

pub fn set_api_key(key: &str) -> Result<()> {
    let p = crate::home::path("secrets.toml")?;
    let body = toml::to_string(&Secrets {
        api_key: Some(key.to_string()),
    })?;
    std::fs::write(&p, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Whether a key is configured (for status display — never returns the value).
pub fn has_key() -> bool {
    api_key().is_some()
}
