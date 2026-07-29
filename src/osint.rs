//! OSINT enrichment tooling. coldtrail's agent does deeper founder-email discovery with
//! theHarvester and SpiderFoot when they're on the machine; this module detects them and
//! (best-effort) installs them during setup — theHarvester via pipx, SpiderFoot via a
//! self-contained git clone + venv (it isn't pip-installable). Everything degrades
//! gracefully to the built-in web finder when the tools, or their prerequisites, are absent.

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

/// SpiderFoot pins `lxml<5`, whose wheels stop at CPython 3.12 — newer interpreters build
/// from source and fail. Build its venv against one of these (in order), not `python3`.
const SF_PYTHONS: &[&str] = &["python3.12", "python3.11", "python3.10"];
const SF_REPO: &str = "https://github.com/smicallef/spiderfoot.git";

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

/// coldtrail's own SpiderFoot install lives inside the workspace so it's contained.
fn spiderfoot_dir() -> Option<PathBuf> {
    crate::home::workspace()
        .ok()
        .map(|w| w.join("tools").join("spiderfoot"))
}

fn spiderfoot_present() -> bool {
    if on_path("spiderfoot") || on_path("sf") || on_path("sfcli") || home_local_bin("spiderfoot") {
        return true;
    }
    spiderfoot_dir()
        .map(|d| d.join("sf.py").is_file() && d.join(".venv").join("bin").join("python").is_file())
        .unwrap_or(false)
}

/// The first PATH-present Python that can build SpiderFoot's deps, if any.
fn compatible_python() -> Option<&'static str> {
    SF_PYTHONS.iter().copied().find(|p| on_path(p))
}

#[derive(Serialize)]
pub struct OsintStatus {
    /// theHarvester is installed (coldtrail auto-installs it; the agent prefers it).
    pub the_harvester: bool,
    /// pipx present and theHarvester missing — a one-click install is possible.
    pub the_harvester_can_install: bool,
    /// SpiderFoot is installed (via coldtrail's contained git-clone + venv).
    pub spiderfoot: bool,
    /// git + a compatible Python are present and SpiderFoot is missing — installable.
    pub spiderfoot_can_install: bool,
    /// pipx is available (used to explain what's missing in the UI).
    pub pipx: bool,
}

pub fn status() -> OsintStatus {
    let th = the_harvester_present();
    let sf = spiderfoot_present();
    let pipx = on_path("pipx");
    OsintStatus {
        the_harvester: th,
        the_harvester_can_install: pipx && !th,
        spiderfoot: sf,
        spiderfoot_can_install: !sf && on_path("git") && compatible_python().is_some(),
        pipx,
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

fn tail(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .rev()
        .take(400)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

/// Best-effort install of SpiderFoot. It isn't pip-installable (no packaging metadata),
/// so coldtrail clones it into `~/.coldtrail/tools/spiderfoot`, builds a venv with a
/// wheel-compatible Python, installs its requirements, and drops a `spiderfoot` launcher
/// on PATH. Blocking; run it off the async runtime.
pub fn install_spiderfoot() -> Result<String> {
    if spiderfoot_present() {
        return Ok("SpiderFoot is already installed.".into());
    }
    if !on_path("git") {
        return Err(anyhow!(
            "git isn't installed, so coldtrail can't fetch SpiderFoot. Install git and retry."
        ));
    }
    let py = compatible_python().ok_or_else(|| {
        anyhow!(
            "SpiderFoot needs Python 3.10–3.12 (its lxml pin has no wheels for 3.13+). Install \
             one (e.g. `brew install python@3.12`) and retry — theHarvester + the built-in web \
             finder still cover enrichment."
        )
    })?;
    let dir =
        spiderfoot_dir().ok_or_else(|| anyhow!("couldn't resolve the coldtrail workspace"))?;

    // 1. clone (shallow) if we don't already have the source
    if !dir.join("sf.py").is_file() {
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let out = Command::new("git")
            .args(["clone", "--depth", "1", SF_REPO])
            .arg(&dir)
            .output()
            .map_err(|e| anyhow!("git clone couldn't start: {e}"))?;
        if !out.status.success() && !dir.join("sf.py").is_file() {
            return Err(anyhow!("git clone failed: {}", tail(&out.stderr)));
        }
    }

    // 2. venv against a compatible Python
    let venv = dir.join(".venv");
    let vpy = venv.join("bin").join("python");
    if !vpy.is_file() {
        let out = Command::new(py)
            .arg("-m")
            .arg("venv")
            .arg(&venv)
            .output()
            .map_err(|e| anyhow!("couldn't create the venv with {py}: {e}"))?;
        if !out.status.success() {
            return Err(anyhow!("venv creation failed: {}", tail(&out.stderr)));
        }
    }

    // 3. install requirements (pip finds wheels on the compatible Python)
    let vpip = venv.join("bin").join("pip");
    let _ = Command::new(&vpip)
        .args(["install", "--upgrade", "pip"])
        .output();
    let out = Command::new(&vpip)
        .arg("install")
        .arg("-r")
        .arg(dir.join("requirements.txt"))
        .output()
        .map_err(|e| anyhow!("pip couldn't start: {e}"))?;
    if !out.status.success() {
        return Err(anyhow!("pip install failed: {}", tail(&out.stderr)));
    }

    // 4. launcher shim on PATH
    write_spiderfoot_launcher(&vpy, &dir.join("sf.py"))?;
    Ok("Installed SpiderFoot — new enrichment runs can use it.".into())
}

/// Write `~/.local/bin/spiderfoot` → runs the venv's Python against `sf.py`.
fn write_spiderfoot_launcher(venv_python: &Path, sf_py: &Path) -> Result<()> {
    let bin = dirs::home_dir()
        .ok_or_else(|| anyhow!("no home directory"))?
        .join(".local")
        .join("bin");
    std::fs::create_dir_all(&bin)?;
    let launcher = bin.join("spiderfoot");
    let script = format!(
        "#!/bin/sh\nexec \"{}\" \"{}\" \"$@\"\n",
        venv_python.display(),
        sf_py.display()
    );
    std::fs::write(&launcher, script)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
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
        // the install flags are exactly their prerequisite conjunctions.
        assert_eq!(s.the_harvester_can_install, s.pipx && !s.the_harvester);
        if s.spiderfoot {
            assert!(!s.spiderfoot_can_install);
        }
    }
}
