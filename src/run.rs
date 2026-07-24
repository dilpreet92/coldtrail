//! Launch the agent (Claude Code) in the workspace, and the self-update stub.

use anyhow::Result;
use std::path::Path;

const INSTALL_URL: &str = "https://raw.githubusercontent.com/dilpreet92/coldtrail/main/install.sh";

/// Is `claude` on the PATH?
fn claude_present() -> bool {
    match std::env::var_os("PATH") {
        Some(paths) => std::env::split_paths(&paths).any(|p| p.join("claude").is_file()),
        None => false,
    }
}

pub async fn run() -> Result<()> {
    crate::setup::ensure()?;
    let ws = crate::home::workspace()?;

    if !claude_present() {
        eprintln!("`claude` was not found on your PATH.");
        eprintln!("Install Claude Code:  npm i -g @anthropic-ai/claude-code");
        eprintln!("Then run `coldtrail` again.");
        std::process::exit(127);
    }
    launch(&ws)
}

#[cfg(unix)]
fn launch(ws: &Path) -> Result<()> {
    use std::os::unix::process::CommandExt;
    // exec replaces this process; it only returns if the exec itself failed.
    let err = std::process::Command::new("claude").current_dir(ws).exec();
    Err(anyhow::anyhow!("failed to launch claude: {err}"))
}

#[cfg(not(unix))]
fn launch(ws: &Path) -> Result<()> {
    let status = std::process::Command::new("claude")
        .current_dir(ws)
        .status()?;
    std::process::exit(status.code().unwrap_or(1));
}

pub fn update() -> Result<()> {
    println!("To update coldtrail, re-run the installer:");
    println!("  curl -fsSL {INSTALL_URL} | bash");
    Ok(())
}
