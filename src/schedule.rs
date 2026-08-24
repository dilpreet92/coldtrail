//! Install/remove an OS timer that fires `coldtrail run` on the user's cadence, even when the app
//! is closed. macOS: a launchd LaunchAgent. Linux: a systemd --user timer (cron fallback). The
//! timer runs with a minimal env, so we bake the current PATH (+ COLDTRAIL_HOME) into the unit.
use crate::config::Schedule;
use anyhow::{Context, Result};

fn hh_mm(time: &str) -> (u32, u32) {
    let mut it = time.split(':');
    let h = it.next().and_then(|s| s.parse().ok()).unwrap_or(9);
    let m = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (h, m)
}

// launchd Weekday: 0/7=Sun,1=Mon..6=Sat — matches our 0=Sun..6=Sat for 0..=6.
pub fn launchd_plist(bin: &str, path_env: &str, home_env: Option<&str>, s: &Schedule) -> String {
    let (h, m) = hh_mm(&s.time);
    let weekday = if s.freq == "weekly" {
        format!(
            "\n        <key>Weekday</key><integer>{}</integer>",
            s.weekday.unwrap_or(1)
        )
    } else {
        String::new()
    };
    let home_kv = home_env
        .map(|h| format!("\n        <key>COLDTRAIL_HOME</key><string>{h}</string>"))
        .unwrap_or_default();
    let home_log = format!("{}/schedule.log", home_env.unwrap_or("/tmp"));
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>Label</key><string>ai.coldtrail.run</string>
    <key>ProgramArguments</key><array><string>{bin}</string><string>run</string></array>
    <key>EnvironmentVariables</key><dict>
        <key>PATH</key><string>{path_env}</string>{home_kv}
    </dict>
    <key>StartCalendarInterval</key><dict>
        <key>Hour</key><integer>{h}</integer>
        <key>Minute</key><integer>{m}</integer>{weekday}
    </dict>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>{home_log}</string>
    <key>StandardErrorPath</key><string>{home_log}</string>
</dict></plist>
"#
    )
}

/// Only reachable from `apply()`'s `target_os = "linux"` path; on macOS it's exercised
/// directly by the unit tests below, so it's dead in the shipped macOS binary.
#[allow(dead_code)]
pub fn systemd_units(
    bin: &str,
    path_env: &str,
    home_env: Option<&str>,
    s: &Schedule,
) -> (String, String) {
    let (h, m) = hh_mm(&s.time);
    let oncal = if s.freq == "weekly" {
        let day =
            ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][s.weekday.unwrap_or(1) as usize % 7];
        format!("{day} {h:02}:{m:02}:00")
    } else {
        format!("*-*-* {h:02}:{m:02}:00")
    };
    let home_env_line = home_env
        .map(|hh| format!("\nEnvironment=COLDTRAIL_HOME={hh}"))
        .unwrap_or_default();
    let service = format!(
        "[Unit]\nDescription=coldtrail scheduled run\n\n[Service]\nType=oneshot\nEnvironment=PATH={path_env}{home_env_line}\nExecStart={bin} run\n"
    );
    let timer = format!(
        "[Unit]\nDescription=coldtrail scheduled run timer\n\n[Timer]\nOnCalendar={oncal}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n"
    );
    (service, timer)
}

fn current_path() -> String {
    std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into())
}
fn home_env() -> Option<String> {
    std::env::var("COLDTRAIL_HOME").ok()
}
fn bin_path() -> Result<String> {
    Ok(std::env::current_exe()?.to_string_lossy().into_owned())
}

/// Install (or remove, if `s.enabled` is false) the OS timer for the current platform.
#[allow(dead_code)] // wired into the setup/CLI flow by a later task
pub fn apply(s: &Schedule) -> Result<()> {
    if !s.enabled {
        return uninstall();
    }
    let bin = bin_path()?;
    let path = current_path();
    let home = home_env();
    #[cfg(target_os = "macos")]
    {
        let plist = launchd_plist(&bin, &path, home.as_deref(), s);
        let dir = dirs_home()?.join("Library/LaunchAgents");
        std::fs::create_dir_all(&dir)?;
        let p = dir.join("ai.coldtrail.run.plist");
        std::fs::write(&p, plist)?;
        let uid = users_uid();
        let _ = std::process::Command::new("launchctl")
            .args(["bootout", &format!("gui/{uid}"), p.to_str().unwrap()])
            .output();
        std::process::Command::new("launchctl")
            .args(["bootstrap", &format!("gui/{uid}"), p.to_str().unwrap()])
            .output()
            .context("launchctl bootstrap")?;
    }
    #[cfg(target_os = "linux")]
    {
        let (svc, timer) = systemd_units(&bin, &path, home.as_deref(), s);
        let dir = dirs_home()?.join(".config/systemd/user");
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("coldtrail.service"), svc)?;
        std::fs::write(dir.join("coldtrail.timer"), timer)?;
        std::process::Command::new("systemctl")
            .args(["--user", "daemon-reload"])
            .output()
            .ok();
        std::process::Command::new("systemctl")
            .args(["--user", "enable", "--now", "coldtrail.timer"])
            .output()
            .context("systemctl enable")?;
    }
    Ok(())
}

/// Remove the OS timer (idempotent — safe to call even if nothing is installed).
#[allow(dead_code)] // wired into the setup/CLI flow by a later task
pub fn uninstall() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let uid = users_uid();
        let p = dirs_home()?.join("Library/LaunchAgents/ai.coldtrail.run.plist");
        let _ = std::process::Command::new("launchctl")
            .args(["bootout", &format!("gui/{uid}"), p.to_str().unwrap_or("")])
            .output();
        let _ = std::fs::remove_file(&p);
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("systemctl")
            .args(["--user", "disable", "--now", "coldtrail.timer"])
            .output();
        let dir = dirs_home()?.join(".config/systemd/user");
        let _ = std::fs::remove_file(dir.join("coldtrail.timer"));
        let _ = std::fs::remove_file(dir.join("coldtrail.service"));
    }
    Ok(())
}

// Helpers: reuse whatever the repo already has for the OS home dir + uid. If none, use std::env.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn dirs_home() -> Result<std::path::PathBuf> {
    Ok(std::path::PathBuf::from(
        std::env::var("HOME").context("HOME not set")?,
    ))
}
#[cfg(target_os = "macos")]
fn users_uid() -> String {
    std::process::Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "501".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Schedule;

    #[test]
    fn plist_daily_has_calendar_and_path() {
        let s = Schedule {
            enabled: true,
            freq: "daily".into(),
            time: "09:30".into(),
            weekday: None,
        };
        let p = launchd_plist(
            "/usr/local/bin/coldtrail",
            "/opt/homebrew/bin:/usr/bin",
            None,
            &s,
        );
        assert!(p.contains("<string>run</string>"));
        assert!(p.contains("<key>Hour</key>") && p.contains("<integer>9</integer>"));
        assert!(p.contains("<key>Minute</key>") && p.contains("<integer>30</integer>"));
        assert!(!p.contains("<key>Weekday</key>")); // daily => no weekday
        assert!(p.contains("/opt/homebrew/bin")); // PATH baked in
        assert!(p.contains("/usr/local/bin/coldtrail"));
    }

    #[test]
    fn plist_weekly_includes_weekday() {
        let s = Schedule {
            enabled: true,
            freq: "weekly".into(),
            time: "08:00".into(),
            weekday: Some(1),
        };
        let p = launchd_plist("/x/coldtrail", "/usr/bin", None, &s);
        assert!(p.contains("<key>Weekday</key>") && p.contains("<integer>1</integer>"));
    }

    #[test]
    fn systemd_timer_oncalendar_daily_and_weekly() {
        let daily = Schedule {
            enabled: true,
            freq: "daily".into(),
            time: "09:30".into(),
            weekday: None,
        };
        let (_svc, t) = systemd_units("/x/coldtrail", "/usr/bin", None, &daily);
        assert!(t.contains("OnCalendar=*-*-* 09:30:00"));
        let weekly = Schedule {
            enabled: true,
            freq: "weekly".into(),
            time: "08:00".into(),
            weekday: Some(1),
        };
        let (_s2, t2) = systemd_units("/x/coldtrail", "/usr/bin", None, &weekly);
        assert!(t2.contains("OnCalendar=Mon 08:00:00"));
    }
}
