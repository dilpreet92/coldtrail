//! Workspace resolution. Everything coldtrail persists lives in one directory —
//! `~/.coldtrail` by default, or `$COLDTRAIL_HOME` when set (used by tests).

use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

/// `$COLDTRAIL_HOME`, if set. In unit tests it is never unset: the variable is process-global
/// and `testutil::with_home` removes it when its closure ends, so a test that doesn't hold a
/// temp home (or runs just after one let go) would otherwise read and write the real
/// `~/.coldtrail` and the real secrets. Such a test gets a throwaway dir under the OS temp dir.
fn home_override() -> Option<PathBuf> {
    let set = std::env::var_os("COLDTRAIL_HOME").map(PathBuf::from);
    if cfg!(test) {
        return set.or_else(|| Some(std::env::temp_dir().join("coldtrail-unit-test-home")));
    }
    set
}

/// Resolve (and create) the workspace directory.
pub fn workspace() -> Result<PathBuf> {
    let dir = match home_override() {
        Some(v) => v,
        None => dirs::home_dir()
            .context("could not resolve home directory")?
            .join(".coldtrail"),
    };
    fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    Ok(dir)
}

/// A path inside the workspace.
pub fn path(name: &str) -> Result<PathBuf> {
    Ok(workspace()?.join(name))
}

/// Where OAuth tokens + the API key live — deliberately OUTSIDE the workspace, because the
/// workspace is the agent's working directory and credentials must not sit in the agent's
/// cwd. With `COLDTRAIL_HOME` set (tests) it's a sibling of that home for isolation;
/// otherwise the OS config dir (`~/.config/coldtrail`, `~/Library/Application Support/…`).
pub fn secret_path() -> Result<PathBuf> {
    let dir = match home_override() {
        Some(v) => PathBuf::from(format!("{}.secrets", v.to_string_lossy())),
        None => dirs::config_dir()
            .or_else(dirs::home_dir)
            .context("could not resolve a config directory")?
            .join("coldtrail"),
    };
    fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    Ok(dir.join("secrets.toml"))
}

/// Write an embedded asset. When `overwrite` is false an existing file is left
/// untouched (user-owned files). Returns whether a write happened.
pub fn write_asset(name: &str, contents: &str, overwrite: bool) -> Result<bool> {
    let p = path(name)?;
    if p.exists() && !overwrite {
        return Ok(false);
    }
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    fs::write(&p, contents).with_context(|| format!("write {}", p.display()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_respects_env_override() {
        crate::testutil::with_home("coldtrail-test-ws", |tmp| {
            let ws = workspace().unwrap();
            assert_eq!(&ws, tmp);
            assert!(tmp.exists());
        });
    }

    #[test]
    fn unit_tests_never_resolve_the_real_workspace_or_secrets() {
        let _guard = crate::testutil::env_guard();
        std::env::remove_var("COLDTRAIL_HOME");
        let tmp = std::env::temp_dir();
        let ws = workspace().unwrap();
        let secrets = secret_path().unwrap();
        assert!(ws.starts_with(&tmp), "workspace {ws:?} is outside {tmp:?}");
        assert!(
            secrets.starts_with(&tmp),
            "secrets {secrets:?} is outside {tmp:?}"
        );
        if let Some(home) = dirs::home_dir() {
            assert!(!ws.starts_with(home.join(".coldtrail")));
        }
    }

    #[test]
    fn write_asset_no_overwrite_preserves() {
        crate::testutil::with_home("coldtrail-test-ow", |tmp| {
            write_asset("f.txt", "first", true).unwrap();
            let wrote = write_asset("f.txt", "second", false).unwrap();
            assert!(!wrote);
            assert_eq!(fs::read_to_string(tmp.join("f.txt")).unwrap(), "first");
            // overwrite=true does replace
            assert!(write_asset("f.txt", "third", true).unwrap());
            assert_eq!(fs::read_to_string(tmp.join("f.txt")).unwrap(), "third");
        });
    }
}
