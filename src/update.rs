//! Self-update. Bare `coldtrail` checks GitHub for a newer release and, if found, swaps its own
//! binary and re-execs (auto-update-then-run). `coldtrail update` does the same on demand.
//!
//! Safety rails: the launch-time check is best-effort with short timeouts and NEVER blocks or
//! aborts a launch on a network/GitHub failure; the re-exec is loop-guarded via `COLDTRAIL_UPDATED`
//! so the freshly-launched process doesn't re-check; `COLDTRAIL_NO_UPDATE=1` opts out entirely;
//! and `coldtrail serve …` (the explicit subcommand) never auto-updates.

use anyhow::{anyhow, Result};
use std::time::Duration;

const REPO: &str = "dilpreet92/coldtrail";
const INSTALL_URL: &str = "https://raw.githubusercontent.com/dilpreet92/coldtrail/main/install.sh";

/// The release asset target for this platform, or None if we don't publish one.
fn target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-musl"),
        _ => None,
    }
}

fn parse_ver(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches('v');
    let mut it = v.split('.');
    let a = it.next()?.parse().ok()?;
    let b = it.next()?.parse().ok()?;
    let c = it.next().unwrap_or("0").parse().ok()?;
    Some((a, b, c))
}

/// Is `latest` a strictly higher version than `current`? False if either won't parse.
fn is_newer(latest: &str, current: &str) -> bool {
    matches!((parse_ver(latest), parse_ver(current)), (Some(l), Some(c)) if l > c)
}

/// The latest release tag (e.g. "v0.9.4"), read from the `releases/latest` redirect so we don't
/// hit the API rate limit. Best-effort: returns None on any error or timeout.
async fn latest_tag() -> Option<String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(4))
        .build()
        .ok()?;
    let resp = client
        .get(format!("https://github.com/{REPO}/releases/latest"))
        .header("user-agent", "coldtrail-updater")
        .send()
        .await
        .ok()?;
    let loc = resp.headers().get("location")?.to_str().ok()?;
    let tag = loc.rsplit('/').next()?.trim().to_string();
    tag.starts_with('v').then_some(tag)
}

/// Download the latest release for this platform and atomically replace the running binary.
/// On macOS the new binary is de-quarantined + ad-hoc-signed so Gatekeeper allows it.
async fn download_and_swap() -> Result<()> {
    let target = target().ok_or_else(|| {
        anyhow!("no prebuilt binary for this platform — update with the installer")
    })?;
    let url =
        format!("https://github.com/{REPO}/releases/latest/download/coldtrail-{target}.tar.gz");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()?;
    let bytes = client
        .get(&url)
        .header("user-agent", "coldtrail-updater")
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;

    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| anyhow!("could not resolve the install directory"))?;

    let tmp = std::env::temp_dir().join(format!("coldtrail-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;
    let tgz = tmp.join("coldtrail.tar.gz");
    std::fs::write(&tgz, &bytes)?;
    let ok = std::process::Command::new("tar")
        .arg("-xzf")
        .arg(&tgz)
        .arg("-C")
        .arg(&tmp)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        return Err(anyhow!("could not extract the release archive"));
    }
    let newbin = tmp.join("coldtrail");
    if !newbin.exists() {
        return Err(anyhow!(
            "release archive did not contain the coldtrail binary"
        ));
    }

    // Stage next to the real binary (same filesystem) so the swap is an atomic rename.
    let staged = dir.join(".coldtrail.update");
    std::fs::copy(&newbin, &staged)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
    }
    if std::env::consts::OS == "macos" {
        // Quiet: a tar-extracted binary usually has no quarantine attr, and codesign chatters
        // to stderr — neither should show up in the user's update output.
        let quiet = || (std::process::Stdio::null(), std::process::Stdio::null());
        let (o1, e1) = quiet();
        let _ = std::process::Command::new("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(&staged)
            .stdout(o1)
            .stderr(e1)
            .status();
        let (o2, e2) = quiet();
        let _ = std::process::Command::new("codesign")
            .args(["--force", "--sign", "-"])
            .arg(&staged)
            .stdout(o2)
            .stderr(e2)
            .status();
    }
    std::fs::rename(&staged, &exe)?; // replacing a running binary is fine on unix
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(())
}

/// Re-launch the (now updated) binary with the same args, guarded so it won't re-update. Never
/// returns on success.
fn reexec() -> ! {
    let exe = std::env::current_exe().unwrap_or_else(|_| "coldtrail".into());
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = std::process::Command::new(&exe)
            .args(&args)
            .env("COLDTRAIL_UPDATED", "1")
            .exec();
        eprintln!("  relaunch after update failed: {err}");
        std::process::exit(1);
    }
    #[cfg(not(unix))]
    {
        let status = std::process::Command::new(&exe)
            .args(&args)
            .env("COLDTRAIL_UPDATED", "1")
            .status();
        std::process::exit(status.ok().and_then(|s| s.code()).unwrap_or(1));
    }
}

/// Bare-launch hook: if a newer release exists, update in place and relaunch. Best-effort —
/// returns (and the caller proceeds on the current version) on any problem.
pub async fn auto_update() {
    if std::env::var_os("COLDTRAIL_UPDATED").is_some()
        || std::env::var_os("COLDTRAIL_NO_UPDATE").is_some()
        || target().is_none()
    {
        return;
    }
    let current = env!("CARGO_PKG_VERSION");
    let latest = match latest_tag().await {
        Some(t) if is_newer(&t, current) => t,
        _ => return,
    };
    println!("  updating coldtrail {current} → {latest} …");
    match download_and_swap().await {
        Ok(()) => {
            println!("  updated to {latest} — relaunching.\n");
            reexec();
        }
        Err(e) => eprintln!("  auto-update failed ({e}); continuing on {current}."),
    }
}

/// `coldtrail update`: update on demand.
pub async fn run() -> Result<()> {
    let current = env!("CARGO_PKG_VERSION");
    if target().is_none() {
        println!(
            "No prebuilt binary for this platform. Update with:\n  curl -fsSL {INSTALL_URL} | bash"
        );
        return Ok(());
    }
    match latest_tag().await {
        Some(latest) if is_newer(&latest, current) => {
            println!("Updating coldtrail {current} → {latest} …");
            download_and_swap().await?;
            println!("Updated to {latest}. Run `coldtrail` again to use it.");
        }
        Some(latest) => println!("Already on the latest version ({latest})."),
        None => println!(
            "Couldn't reach GitHub to check for updates. Try again later, or:\n  curl -fsSL {INSTALL_URL} | bash"
        ),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_comparison() {
        assert!(is_newer("v0.9.4", "0.9.3"));
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(!is_newer("v0.9.3", "0.9.3"));
        assert!(!is_newer("v0.9.2", "0.9.3"));
        assert!(!is_newer("garbage", "0.9.3")); // unparseable → never "newer"
    }
}
