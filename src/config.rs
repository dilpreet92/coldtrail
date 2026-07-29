//! `~/.coldtrail/config.toml` — the chosen provider and (for OpenAI-compatible
//! backends) its endpoint. Secrets live separately (see `secrets`).

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Config {
    /// "claude" | "codex" | "openai"
    pub agent: Option<String>,
    pub provider: Option<Provider>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Provider {
    pub base_url: Option<String>,
    pub model: Option<String>,
}

pub fn load() -> Config {
    crate::home::path("config.toml")
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| toml::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(c: &Config) -> Result<()> {
    let body = toml::to_string_pretty(c)?;
    std::fs::write(crate::home::path("config.toml")?, body)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_openai_provider() {
        crate::testutil::with_home("ct-config-test", |_| {
            crate::home::workspace().unwrap();
            let c = Config {
                agent: Some("openai".into()),
                provider: Some(Provider {
                    base_url: Some("http://localhost:11434/v1".into()),
                    model: Some("llama3.1".into()),
                }),
            };
            save(&c).unwrap();
            let got = load();
            assert_eq!(got.agent.as_deref(), Some("openai"));
            assert_eq!(got.provider.unwrap().model.as_deref(), Some("llama3.1"));
        });
    }
}
