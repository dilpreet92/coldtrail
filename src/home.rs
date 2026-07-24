//! Workspace resolution. Everything coldtrail persists lives in one directory —
//! `~/.coldtrail` by default, or `$COLDTRAIL_HOME` when set (used by tests).

use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

/// Resolve (and create) the workspace directory.
pub fn workspace() -> Result<PathBuf> {
    let dir = match std::env::var_os("COLDTRAIL_HOME") {
        Some(v) => PathBuf::from(v),
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

/// Write an embedded asset. When `overwrite` is false an existing file is left
/// untouched (user-owned files). Returns whether a write happened.
pub fn write_asset(name: &str, contents: &str, overwrite: bool) -> Result<bool> {
    let p = path(name)?;
    if p.exists() && !overwrite {
        return Ok(false);
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
