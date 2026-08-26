//! `~/.coldtrail/config.toml` — the chosen provider and (for OpenAI-compatible
//! backends) its endpoint. Secrets live separately (see `secrets`).

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Config {
    /// "claude" | "codex" | "openai"
    pub agent: Option<String>,
    pub provider: Option<Provider>,
    /// Opt-in: actually SEND from the Drafts screen instead of only creating a Gmail draft.
    /// Off by default — the standing guardrail is draft-only until the human turns this on.
    #[serde(default)]
    pub auto_send: bool,
    /// Safety cap on auto-sends per calendar day (deliverability / warmup). Defaults to 20.
    pub daily_send_cap: Option<u32>,
    /// Opt-in: let coldtrail click Send on LinkedIn connection requests (separate from email auto_send).
    #[serde(default)]
    pub linkedin_auto_send: bool,
    /// Rolling-7-day LinkedIn invite cap. Defaults to DEFAULT_LINKEDIN_WEEKLY_CAP.
    pub linkedin_weekly_cap: Option<u32>,
    /// Per-day LinkedIn invite sub-cap. Defaults to DEFAULT_LINKEDIN_DAILY_CAP.
    pub linkedin_daily_cap: Option<u32>,
}

/// The effective daily auto-send cap (config value or the default).
pub const DEFAULT_DAILY_SEND_CAP: u32 = 20;
/// Consumed by the LinkedIn send-gate (Task 4+); unused for now.
#[allow(dead_code)]
pub const DEFAULT_LINKEDIN_WEEKLY_CAP: u32 = 80;
#[allow(dead_code)]
pub const DEFAULT_LINKEDIN_DAILY_CAP: u32 = 15;

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
                ..Default::default()
            };
            save(&c).unwrap();
            let got = load();
            assert_eq!(got.agent.as_deref(), Some("openai"));
            assert!(!got.auto_send, "auto_send defaults off");
            assert_eq!(got.provider.unwrap().model.as_deref(), Some("llama3.1"));
        });
    }

    #[test]
    fn auto_send_roundtrips() {
        crate::testutil::with_home("ct-config-autosend", |_| {
            crate::home::workspace().unwrap();
            let c = Config {
                auto_send: true,
                daily_send_cap: Some(7),
                ..Default::default()
            };
            save(&c).unwrap();
            let got = load();
            assert!(got.auto_send);
            assert_eq!(got.daily_send_cap, Some(7));
        });
    }

    #[test]
    fn linkedin_caps_roundtrip() {
        crate::testutil::with_home("ct-config-linkedin", |_| {
            crate::home::workspace().unwrap();
            let defaults = Config::default();
            assert!(
                !defaults.linkedin_auto_send,
                "linkedin_auto_send defaults false"
            );
            let c = Config {
                linkedin_auto_send: true,
                linkedin_weekly_cap: Some(40),
                linkedin_daily_cap: Some(10),
                ..Default::default()
            };
            save(&c).unwrap();
            let got = load();
            assert!(got.linkedin_auto_send);
            assert_eq!(got.linkedin_weekly_cap, Some(40));
            assert_eq!(got.linkedin_daily_cap, Some(10));
        });
    }
}
