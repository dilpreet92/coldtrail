//! OSINT enrichment tooling. coldtrail's agent does deeper founder-email discovery with
//! theHarvester when it's on the machine; this module detects it and (best-effort)
//! installs it via pipx during setup. Everything degrades gracefully to the built-in
//! web finder when the tools — or pipx — aren't available.

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

/// Is `bin` an executable file on the current PATH?
pub fn on_path(bin: &str) -> bool {
    let path = match std::env::var_os("PATH") {
        Some(p) => p,
        None => return false,
    };
    std::env::split_paths(&path).any(|dir| {
        let p: PathBuf = dir.join(bin);
        p.is_file()
    })
}

/// pipx installs console scripts into `~/.local/bin`, which isn't always on our own PATH
/// even when it's on the shell's — so check there too.
fn home_local_bin(name: &str) -> bool {
    dirs::home_dir()
        .map(|h| h.join(".local").join("bin").join(name).is_file())
        .unwrap_or(false)
}

pub fn the_harvester_present() -> bool {
    on_path("theHarvester") || on_path("theharvester") || home_local_bin("theHarvester")
}

fn spiderfoot_present() -> bool {
    on_path("spiderfoot") || on_path("sf") || on_path("sfcli")
}

#[derive(Serialize)]
pub struct OsintStatus {
    /// theHarvester is installed (the tool coldtrail auto-installs and the agent prefers).
    pub the_harvester: bool,
    /// SpiderFoot is installed (optional, detected only — coldtrail doesn't install it).
    pub spiderfoot: bool,
    /// pipx is available, so coldtrail can install theHarvester for the user.
    pub pipx: bool,
    /// pipx is present and theHarvester is missing — i.e. a one-click install is possible.
    pub can_install: bool,
}

pub fn status() -> OsintStatus {
    let th = the_harvester_present();
    let pipx = on_path("pipx");
    OsintStatus {
        the_harvester: th,
        spiderfoot: spiderfoot_present(),
        pipx,
        can_install: pipx && !th,
    }
}

/// Best-effort install of theHarvester via pipx. Blocking (spawn it off the async runtime
/// from the web layer). Idempotent, and honest when pipx is missing.
pub fn install_the_harvester() -> Result<String> {
    if the_harvester_present() {
        return Ok("theHarvester is already installed.".into());
    }
    if !on_path("pipx") {
        return Err(anyhow!(
            "pipx isn't installed, so coldtrail can't auto-install theHarvester. Install pipx \
             (`python3 -m pip install --user pipx && python3 -m pipx ensurepath`) and retry — \
             enrichment still works via the built-in web finder in the meantime."
        ));
    }
    // Install from the GitHub spec, not the PyPI name: the current PyPI release doesn't
    // expose console scripts pipx will accept ("No apps associated"), whereas the repo's
    // packaging registers the `theHarvester` / `restfulHarvest` apps correctly.
    let out = Command::new("pipx")
        .args([
            "install",
            "git+https://github.com/laramies/theHarvester.git",
        ])
        .output()
        .map_err(|e| anyhow!("couldn't run pipx: {e}"))?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success()
        || the_harvester_present()
        || stderr.contains("already seems to be installed")
    {
        Ok("Installed theHarvester via pipx — new enrichment runs will use it.".into())
    } else {
        Err(anyhow!(
            "pipx install theHarvester failed: {}",
            stderr.chars().take(400).collect::<String>()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_path_finds_a_ubiquitous_binary() {
        // `sh` exists on any unix box the tests run on.
        assert!(on_path("sh"));
        assert!(!on_path("definitely-not-a-real-binary-xyzzy"));
    }

    #[test]
    fn status_is_internally_consistent() {
        let s = status();
        // can_install is exactly "pipx present AND theHarvester absent".
        assert_eq!(s.can_install, s.pipx && !s.the_harvester);
    }
}
