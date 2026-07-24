//! Populate the workspace: write the tool-owned agent brief, seed the user-owned
//! config/templates if absent, and initialize the database.

use anyhow::Result;

pub const CLAUDE_MD: &str = include_str!("../templates/CLAUDE.md");
pub const MESSAGE_TOML: &str = include_str!("../templates/message.toml");
pub const CONTACTED_TOML: &str = include_str!("../templates/contacted.toml");
pub const CONFIG_TOML: &str = "agent = \"claude\"\n";

/// Make sure the workspace has current tool-owned assets and the user files
/// present. `CLAUDE.md` is always refreshed; user files are created only if
/// missing. Called by `run` before launching the agent.
pub fn ensure() -> Result<()> {
    crate::home::workspace()?;
    crate::home::write_asset("CLAUDE.md", CLAUDE_MD, true)?;
    crate::home::write_asset("message.toml", MESSAGE_TOML, false)?;
    crate::home::write_asset("contacted.toml", CONTACTED_TOML, false)?;
    crate::home::write_asset("config.toml", CONFIG_TOML, false)?;
    crate::db::init()?;
    Ok(())
}

pub fn run() -> Result<()> {
    let ws = crate::home::workspace()?;
    crate::home::write_asset("CLAUDE.md", CLAUDE_MD, true)?;
    let wrote_msg = crate::home::write_asset("message.toml", MESSAGE_TOML, false)?;
    let wrote_seed = crate::home::write_asset("contacted.toml", CONTACTED_TOML, false)?;
    crate::home::write_asset("config.toml", CONFIG_TOML, false)?;
    crate::db::init()?;

    println!("workspace ready at {}", ws.display());
    println!(
        "  {} message.toml   (your name, pitch, link)",
        if wrote_msg { "wrote " } else { "kept  " }
    );
    println!(
        "  {} contacted.toml (domains you've already contacted)",
        if wrote_seed { "wrote " } else { "kept  " }
    );
    println!("\nNext:");
    println!("  1. edit {}/message.toml and contacted.toml", ws.display());
    println!("  2. coldtrail seed      # load the dedupe guard");
    println!("  3. coldtrail           # launch the agent");
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn setup_populates_workspace() {
        crate::testutil::with_home("coldtrail-setup-test", |tmp| {
            super::run().unwrap();
            for f in [
                "CLAUDE.md",
                "config.toml",
                "message.toml",
                "contacted.toml",
                "outreach.db",
            ] {
                assert!(tmp.join(f).exists(), "missing {f}");
            }
        });
    }
}
