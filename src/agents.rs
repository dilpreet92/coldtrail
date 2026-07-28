//! Detect the agent CLIs coldtrail can launch (Claude Code, Codex) and whether
//! they look authenticated. Pure `detect()` for testing; `detect_all()` wires the
//! real PATH/home probes.

use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentKind {
    Claude,
    Codex,
}

impl AgentKind {
    pub fn bin(&self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            AgentKind::Claude => "Claude Code",
            AgentKind::Codex => "Codex",
        }
    }

    pub fn config_value(&self) -> &'static str {
        self.bin()
    }

    pub fn from_str(s: &str) -> Option<AgentKind> {
        match s.trim().to_lowercase().as_str() {
            "claude" => Some(AgentKind::Claude),
            "codex" => Some(AgentKind::Codex),
            _ => None,
        }
    }

    pub fn install_hint(&self) -> &'static str {
        match self {
            AgentKind::Claude => "npm i -g @anthropic-ai/claude-code",
            AgentKind::Codex => "npm i -g @openai/codex",
        }
    }

    pub fn all() -> [AgentKind; 2] {
        [AgentKind::Claude, AgentKind::Codex]
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

/// Auth heuristic: Claude keeps `~/.claude.json`; Codex keeps `~/.codex/auth.json`.
fn authed(kind: AgentKind, home: &Path) -> bool {
    match kind {
        AgentKind::Claude => home.join(".claude.json").exists(),
        AgentKind::Codex => home.join(".codex").join("auth.json").exists(),
    }
}

/// Pure detection: `which` decides PATH presence, `home` the auth-file probe.
pub fn detect(which: impl Fn(&str) -> bool, home: &Path) -> Vec<AgentStatus> {
    AgentKind::all()
        .into_iter()
        .map(|kind| AgentStatus {
            kind,
            present: which(kind.bin()),
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
        assert_eq!(AgentKind::from_str("gpt"), None);
    }
}
