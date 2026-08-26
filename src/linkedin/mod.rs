//! LinkedIn destination: connect a managed Chrome profile and deliver cold
//! connection-requests-with-note, human-assisted or capped/paced auto-send.

pub mod browser;
pub mod lock;
pub mod note;
pub mod send;
pub mod url;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The coldtrail-owned Chrome profile dir (holds the LinkedIn session). Lives next to
/// secrets.toml — OUTSIDE the agent workspace — and is created 0700.
pub fn profile_dir() -> Result<PathBuf> {
    let dir = crate::home::secret_path()? // .../coldtrail/secrets.toml
        .parent()
        .ok_or_else(|| anyhow!("no config parent"))?
        .join("linkedin-profile");
    std::fs::create_dir_all(&dir)?;
    set_private(&dir);
    Ok(dir)
}

fn state_path() -> Result<PathBuf> {
    Ok(crate::home::secret_path()?
        .parent()
        .ok_or_else(|| anyhow!("no config parent"))?
        .join("linkedin-state.json"))
}

#[cfg(unix)]
fn set_private(p: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700));
}
#[cfg(not(unix))]
fn set_private(_p: &std::path::Path) {}

/// Persisted connection state (the truth the UI status reads).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LinkedinState {
    pub connected: bool,
    pub reconnect_needed: bool,
}

#[allow(dead_code)]
impl LinkedinState {
    pub fn load() -> Self {
        state_path()
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }
    pub fn save(&self) -> Result<()> {
        std::fs::write(state_path()?, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
    pub fn clear() -> Result<()> {
        let p = state_path()?;
        if p.exists() {
            std::fs::remove_file(p)?;
        }
        Ok(())
    }
}

/// Locate an installed Chromium-family browser to drive. Errors with an install hint if none.
#[allow(dead_code)]
pub fn chrome_binary() -> Result<PathBuf> {
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
    } else if cfg!(target_os = "windows") {
        &[
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ]
    } else {
        &[
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
        ]
    };
    for c in candidates {
        let p = PathBuf::from(c);
        if p.exists() {
            return Ok(p);
        }
    }
    Err(anyhow!(
        "no Chrome/Chromium/Edge found — install Google Chrome to use the LinkedIn destination"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_roundtrips_and_clears() {
        crate::testutil::with_home("ct-li-state", |_| {
            let mut s = LinkedinState::load();
            assert!(!s.connected);
            s.connected = true;
            s.save().unwrap();
            assert!(LinkedinState::load().connected);
            LinkedinState::clear().unwrap();
            assert!(!LinkedinState::load().connected);
        });
    }
}
