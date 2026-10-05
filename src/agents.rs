//! Detect the agent CLIs coldtrail can launch (Claude Code, Codex, opencode) and whether
//! they look authenticated. Pure `detect()` for testing; `detect_all()` wires the
//! real PATH/home probes.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentKind {
    Claude,
    Codex,
    Opencode,
}

impl AgentKind {
    pub fn bin(&self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
            AgentKind::Opencode => "opencode",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            AgentKind::Claude => "Claude Code",
            AgentKind::Codex => "Codex CLI",
            AgentKind::Opencode => "opencode",
        }
    }

    pub fn config_value(&self) -> &'static str {
        self.bin()
    }

    pub fn from_str(s: &str) -> Option<AgentKind> {
        match s.trim().to_lowercase().as_str() {
            "claude" => Some(AgentKind::Claude),
            "codex" => Some(AgentKind::Codex),
            "opencode" => Some(AgentKind::Opencode),
            _ => None,
        }
    }

    pub fn install_hint(&self) -> &'static str {
        match self {
            AgentKind::Claude => "npm i -g @anthropic-ai/claude-code",
            AgentKind::Codex => "npm i -g @openai/codex",
            AgentKind::Opencode => "curl -fsSL https://opencode.ai/install | bash",
        }
    }

    pub fn all() -> [AgentKind; 3] {
        [AgentKind::Claude, AgentKind::Codex, AgentKind::Opencode]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentStatus {
    pub kind: AgentKind,
    pub present: bool,
    pub authed: bool,
}

/// True if `bin` resolves to a file on `PATH`.
pub fn on_path(bin: &str) -> bool {
    match std::env::var_os("PATH") {
        Some(paths) => std::env::split_paths(&paths).any(|p| p.join(bin).is_file()),
        None => false,
    }
}

/// Where the agent's own installer puts it when that dir may not be on PATH (a scheduled run's
/// PATH is whatever was baked into the timer). Only opencode's installer does this.
fn installer_bin(kind: AgentKind, home: &Path) -> Option<PathBuf> {
    match kind {
        AgentKind::Opencode => Some(home.join(".opencode").join("bin").join("opencode")),
        _ => None,
    }
}

/// The program to spawn for `kind`: its bare name when on PATH, else the installer-dir copy if
/// one exists, else the bare name (so a missing CLI still fails with the usual launch error).
pub fn program(kind: AgentKind, which: impl Fn(&str) -> bool, home: &Path) -> PathBuf {
    if !which(kind.bin()) {
        if let Some(p) = installer_bin(kind, home).filter(|p| p.is_file()) {
            return p;
        }
    }
    PathBuf::from(kind.bin())
}

/// `program` against the real PATH + home.
pub fn program_path(kind: AgentKind) -> PathBuf {
    program(kind, on_path, &dirs::home_dir().unwrap_or_default())
}

/// Auth heuristic: Claude keeps `~/.claude.json`; Codex keeps `~/.codex/auth.json`; opencode
/// keeps provider credentials in `~/.local/share/opencode/auth.json`.
fn authed(kind: AgentKind, home: &Path) -> bool {
    match kind {
        AgentKind::Claude => home.join(".claude.json").exists(),
        AgentKind::Codex => home.join(".codex").join("auth.json").exists(),
        AgentKind::Opencode => home
            .join(".local")
            .join("share")
            .join("opencode")
            .join("auth.json")
            .exists(),
    }
}

/// Pure detection: `which` decides PATH presence, `home` the installer-dir + auth-file probes.
pub fn detect(which: impl Fn(&str) -> bool, home: &Path) -> Vec<AgentStatus> {
    AgentKind::all()
        .into_iter()
        .map(|kind| AgentStatus {
            kind,
            present: which(kind.bin()) || installer_bin(kind, home).is_some_and(|p| p.is_file()),
            authed: authed(kind, home),
        })
        .collect()
}

pub fn detect_all() -> Vec<AgentStatus> {
    let home = dirs::home_dir().unwrap_or_default();
    detect(on_path, &home)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_present_and_authed() {
        let home = std::env::temp_dir().join("ct-agents-test");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(home.join(".claude.json"), "{\"x\":1}").unwrap(); // claude authed
                                                                         // no ~/.codex/auth.json -> codex present but not authed
        let which = |b: &str| b == "claude" || b == "codex";
        let v = detect(which, &home);
        let claude = v.iter().find(|s| s.kind == AgentKind::Claude).unwrap();
        let codex = v.iter().find(|s| s.kind == AgentKind::Codex).unwrap();
        assert!(claude.present && claude.authed);
        assert!(codex.present && !codex.authed);
    }

    #[test]
    fn absent_when_not_on_path() {
        let home = std::env::temp_dir().join("ct-agents-test2");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let v = detect(|_| false, &home);
        assert!(v.iter().all(|s| !s.present));
    }

    #[test]
    fn from_str_roundtrip() {
        assert_eq!(AgentKind::from_str("CLAUDE"), Some(AgentKind::Claude));
        assert_eq!(AgentKind::from_str(" codex "), Some(AgentKind::Codex));
        assert_eq!(AgentKind::from_str("OpenCode"), Some(AgentKind::Opencode));
        assert_eq!(AgentKind::from_str("gpt"), None);
        assert_eq!(AgentKind::Opencode.config_value(), "opencode");
    }

    #[test]
    fn opencode_detected_from_installer_dir_and_auth_file() {
        // The opencode installer puts the binary in ~/.opencode/bin, which a launchd timer's
        // baked PATH may not include — it still counts as installed. Auth lives in XDG data.
        let home = std::env::temp_dir().join("ct-agents-test-opencode");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".opencode/bin")).unwrap();
        std::fs::write(home.join(".opencode/bin/opencode"), "").unwrap();
        std::fs::create_dir_all(home.join(".local/share/opencode")).unwrap();
        std::fs::write(home.join(".local/share/opencode/auth.json"), "{}").unwrap();
        let v = detect(|_| false, &home);
        let oc = v.iter().find(|s| s.kind == AgentKind::Opencode).unwrap();
        assert!(oc.present && oc.authed);
    }

    #[test]
    fn program_prefers_path_then_installer_dir() {
        let home = std::env::temp_dir().join("ct-agents-test-program");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".opencode/bin")).unwrap();
        // not installed anywhere -> bare name (spawn reports "not found" as before)
        assert_eq!(
            program(AgentKind::Opencode, |_| false, &home),
            std::path::PathBuf::from("opencode")
        );
        std::fs::write(home.join(".opencode/bin/opencode"), "").unwrap();
        assert_eq!(
            program(AgentKind::Opencode, |_| false, &home),
            home.join(".opencode/bin/opencode")
        );
        // on PATH wins
        assert_eq!(
            program(AgentKind::Opencode, |b| b == "opencode", &home),
            std::path::PathBuf::from("opencode")
        );
        // claude/codex have no installer-dir fallback
        assert_eq!(
            program(AgentKind::Claude, |_| false, &home),
            std::path::PathBuf::from("claude")
        );
    }
}
