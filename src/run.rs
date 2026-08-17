//! Launch the configured agent (Claude Code or Codex) in the workspace.
//! (Self-update lives in `crate::update`.)

use anyhow::Result;
use std::path::Path;

pub async fn run() -> Result<()> {
    crate::setup::ensure()?;
    let ws = crate::home::workspace()?;
    let kind = crate::setup::read_agent()?;
    let bin = kind.bin();

    if !crate::agents::on_path(bin) {
        eprintln!("`{bin}` ({}) was not found on your PATH.", kind.label());
        eprintln!("Install it:  {}", kind.install_hint());
        eprintln!("Or run `coldtrail setup` to choose a different agent.");
        std::process::exit(127);
    }
    launch(bin, &ws)
}

#[cfg(unix)]
fn launch(bin: &str, ws: &Path) -> Result<()> {
    use std::os::unix::process::CommandExt;
    // exec replaces this process; it only returns if the exec itself failed.
    let err = std::process::Command::new(bin).current_dir(ws).exec();
    Err(anyhow::anyhow!("failed to launch {bin}: {err}"))
}

#[cfg(not(unix))]
fn launch(bin: &str, ws: &Path) -> Result<()> {
    let status = std::process::Command::new(bin).current_dir(ws).status()?;
    std::process::exit(status.code().unwrap_or(1));
}
