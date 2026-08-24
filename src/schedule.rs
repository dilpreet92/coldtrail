//! Install/remove an OS timer that fires `coldtrail run` on the user's cadence, even when the app
//! is closed. macOS: a launchd LaunchAgent. Linux: a systemd --user timer (cron fallback). The
//! timer runs with a minimal env, so we bake the current PATH (+ COLDTRAIL_HOME) into the unit.
use crate::config::Schedule;
use crate::db::Schedule as DbSchedule;
use anyhow::{Context, Result};

fn hh_mm(time: &str) -> (u32, u32) {
    let mut it = time.split(':');
    let h = it.next().and_then(|s| s.parse().ok()).unwrap_or(9);
    let m = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (h, m)
}

// launchd Weekday: 0/7=Sun,1=Mon..6=Sat — matches our 0=Sun..6=Sat for 0..=6.
/// Shared core for building a launchd plist body. `label` is the `Label` key, `run_args` become
/// the `ProgramArguments` after `bin` (e.g. `["run"]` for the singular timer, `["run",
/// "--schedule", id]` for a per-schedule one), and `log_file` names the log under `home_env`.
#[allow(clippy::too_many_arguments)]
fn launchd_plist_core(
    label: &str,
    bin: &str,
    path_env: &str,
    home_env: Option<&str>,
    run_args: &[&str],
    freq: &str,
    time: &str,
    weekday: Option<u8>,
    log_file: &str,
) -> String {
    let (h, m) = hh_mm(time);
    let weekday_kv = if freq == "weekly" {
        format!(
            "\n        <key>Weekday</key><integer>{}</integer>",
            weekday.unwrap_or(1)
        )
    } else {
        String::new()
    };
    let home_kv = home_env
        .map(|h| format!("\n        <key>COLDTRAIL_HOME</key><string>{h}</string>"))
        .unwrap_or_default();
    let home_log = format!("{}/{log_file}", home_env.unwrap_or("/tmp"));
    let args_xml: String = std::iter::once(bin)
        .chain(run_args.iter().copied())
        .map(|a| format!("<string>{a}</string>"))
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>Label</key><string>{label}</string>
    <key>ProgramArguments</key><array>{args_xml}</array>
    <key>EnvironmentVariables</key><dict>
        <key>PATH</key><string>{path_env}</string>{home_kv}
    </dict>
    <key>StartCalendarInterval</key><dict>
        <key>Hour</key><integer>{h}</integer>
        <key>Minute</key><integer>{m}</integer>{weekday_kv}
    </dict>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>{home_log}</string>
    <key>StandardErrorPath</key><string>{home_log}</string>
</dict></plist>
"#
    )
}

/// Only reachable from `apply()`'s `target_os = "macos"` path; on Linux it's exercised
/// directly by the unit tests below, so it's dead in the shipped Linux binary.
#[allow(dead_code)]
pub fn launchd_plist(bin: &str, path_env: &str, home_env: Option<&str>, s: &Schedule) -> String {
    launchd_plist_core(
        "ai.coldtrail.run",
        bin,
        path_env,
        home_env,
        &["run"],
        &s.freq,
        &s.time,
        s.weekday,
        "schedule.log",
    )
}

/// Per-schedule variant of [`launchd_plist`]: labels the agent `ai.coldtrail.run.<id>` and points
/// argv at `run --schedule <id>` so launchd fires the right schedule row.
#[allow(dead_code)] // only called from apply_one()'s macos path (later task) + tests
pub fn launchd_plist_for(
    s: &DbSchedule,
    bin: &str,
    path_env: &str,
    home_env: Option<&str>,
) -> String {
    let label = format!("ai.coldtrail.run.{}", s.id);
    let log_file = format!("schedule-{}.log", s.id);
    launchd_plist_core(
        &label,
        bin,
        path_env,
        home_env,
        &["run", "--schedule", s.id.as_str()],
        &s.freq,
        &s.time,
        s.weekday,
        &log_file,
    )
}

/// Shared core for building the systemd `.service`/`.timer` unit bodies. `run_args` is the
/// argv appended after `bin` in `ExecStart` (e.g. `["run"]` vs. `["run", "--schedule", id]`).
fn systemd_units_core(
    bin: &str,
    path_env: &str,
    home_env: Option<&str>,
    run_args: &[&str],
    freq: &str,
    time: &str,
    weekday: Option<u8>,
) -> (String, String) {
    let (h, m) = hh_mm(time);
    let oncal = if freq == "weekly" {
        let day =
            ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday.unwrap_or(1) as usize % 7];
        format!("{day} {h:02}:{m:02}:00")
    } else {
        format!("*-*-* {h:02}:{m:02}:00")
    };
    let home_env_line = home_env
        .map(|hh| format!("\nEnvironment=COLDTRAIL_HOME={hh}"))
        .unwrap_or_default();
    let args = run_args.join(" ");
    let service = format!(
        "[Unit]\nDescription=coldtrail scheduled run\n\n[Service]\nType=oneshot\nEnvironment=PATH={path_env}{home_env_line}\nExecStart={bin} {args}\n"
    );
    let timer = format!(
        "[Unit]\nDescription=coldtrail scheduled run timer\n\n[Timer]\nOnCalendar={oncal}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n"
    );
    (service, timer)
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
    systemd_units_core(
        bin,
        path_env,
        home_env,
        &["run"],
        &s.freq,
        &s.time,
        s.weekday,
    )
}

/// Per-schedule variant of [`systemd_units`]: `ExecStart` runs `run --schedule <id>` so the unit
/// (named `coldtrail-<id>.{service,timer}` by the caller) fires the right schedule row.
#[allow(dead_code)] // only called from apply_one()/remove_one()'s linux path (later task) + tests
pub fn systemd_units_for(
    s: &DbSchedule,
    bin: &str,
    path_env: &str,
    home_env: Option<&str>,
) -> (String, String) {
    systemd_units_core(
        bin,
        path_env,
        home_env,
        &["run", "--schedule", s.id.as_str()],
        &s.freq,
        &s.time,
        s.weekday,
    )
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
            .args(["bootout", &format!("gui/{uid}"), p.to_str().unwrap_or("")])
            .output();
        std::process::Command::new("launchctl")
            .args(["bootstrap", &format!("gui/{uid}"), p.to_str().unwrap_or("")])
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

/// Install (or remove, if `s.enabled` is false) the OS timer for a single schedule row, keyed by
/// `s.id`. Unlike [`apply`] (the singular `ai.coldtrail.run` timer), each schedule gets its own
/// launchd label / systemd unit pair so multiple schedules can run independently.
#[allow(dead_code)] // wired into the setup/CLI flow by a later task
pub fn apply_one(s: &DbSchedule) -> Result<()> {
    if !s.enabled {
        return remove_one(&s.id);
    }
    let bin = bin_path()?;
    let path = current_path();
    let home = home_env();
    #[cfg(target_os = "macos")]
    {
        let plist = launchd_plist_for(s, &bin, &path, home.as_deref());
        let dir = dirs_home()?.join("Library/LaunchAgents");
        std::fs::create_dir_all(&dir)?;
        let p = dir.join(format!("ai.coldtrail.run.{}.plist", s.id));
        std::fs::write(&p, plist)?;
        let uid = users_uid();
        let _ = std::process::Command::new("launchctl")
            .args(["bootout", &format!("gui/{uid}"), p.to_str().unwrap_or("")])
            .output();
        std::process::Command::new("launchctl")
            .args(["bootstrap", &format!("gui/{uid}"), p.to_str().unwrap_or("")])
            .output()
            .context("launchctl bootstrap")?;
    }
    #[cfg(target_os = "linux")]
    {
        let (svc, timer) = systemd_units_for(s, &bin, &path, home.as_deref());
        let dir = dirs_home()?.join(".config/systemd/user");
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join(format!("coldtrail-{}.service", s.id)), svc)?;
        std::fs::write(dir.join(format!("coldtrail-{}.timer", s.id)), timer)?;
        std::process::Command::new("systemctl")
            .args(["--user", "daemon-reload"])
            .output()
            .ok();
        std::process::Command::new("systemctl")
            .args([
                "--user",
                "enable",
                "--now",
                &format!("coldtrail-{}.timer", s.id),
            ])
            .output()
            .context("systemctl enable")?;
    }
    Ok(())
}

/// Remove the per-schedule OS timer for `id` (idempotent — safe to call even if nothing is
/// installed). Mirrors [`uninstall`] but targets `ai.coldtrail.run.<id>` / `coldtrail-<id>.*`.
#[allow(dead_code)] // wired into the setup/CLI flow by a later task
pub fn remove_one(id: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let uid = users_uid();
        let p = dirs_home()?.join(format!("Library/LaunchAgents/ai.coldtrail.run.{id}.plist"));
        let _ = std::process::Command::new("launchctl")
            .args(["bootout", &format!("gui/{uid}"), p.to_str().unwrap_or("")])
            .output();
        let _ = std::fs::remove_file(&p);
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("systemctl")
            .args([
                "--user",
                "disable",
                "--now",
                &format!("coldtrail-{id}.timer"),
            ])
            .output();
        let dir = dirs_home()?.join(".config/systemd/user");
        let _ = std::fs::remove_file(dir.join(format!("coldtrail-{id}.timer")));
        let _ = std::fs::remove_file(dir.join(format!("coldtrail-{id}.service")));
    }
    Ok(())
}

/// Reconcile installed per-schedule OS timers to the DB: apply_one every schedule row
/// (apply_one itself removes the disabled ones). MVP scope: this does not garbage-collect
/// units whose schedule row was deleted out-of-band — deletion goes through remove_one via the
/// API, so a row dropped directly from the DB (or a unit installed by a since-removed build)
/// would linger on disk. Enumerate-and-prune is a future nicety, not implemented here.
#[allow(dead_code)] // wired into the setup/CLI flow by a later task
pub fn sync() -> Result<()> {
    for s in crate::db::list_schedules()? {
        apply_one(&s)?;
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

    #[test]
    fn plist_per_schedule_labels_and_targets_the_id() {
        let s = crate::db::Schedule {
            id: "abc123".into(),
            name: "FT".into(),
            enabled: true,
            freq: "daily".into(),
            time: "09:30".into(),
            weekday: None,
            task_mode: "agent".into(),
            prompt: None,
        };
        let p = launchd_plist_for(&s, "/x/coldtrail", "/usr/bin", None);
        assert!(p.contains("<string>ai.coldtrail.run.abc123</string>"));
        assert!(p.contains("<string>--schedule</string><string>abc123</string>"));
    }

    #[test]
    fn systemd_unit_names_include_the_id() {
        let s = crate::db::Schedule {
            id: "abc123".into(),
            name: "FT".into(),
            enabled: true,
            freq: "weekly".into(),
            time: "08:00".into(),
            weekday: Some(1),
            task_mode: "agent".into(),
            prompt: None,
        };
        let (svc, timer) = systemd_units_for(&s, "/x/coldtrail", "/usr/bin", None);
        assert!(svc.contains("--schedule abc123"));
        assert!(timer.contains("OnCalendar=Mon 08:00:00"));
    }
}
