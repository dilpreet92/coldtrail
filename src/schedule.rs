//! Install/remove an OS timer that fires `coldtrail run` on the user's cadence, even when the app
//! is closed. macOS: a launchd LaunchAgent. Linux: a systemd --user timer (cron fallback). The
//! timer runs with a minimal env, so we bake the current PATH (+ COLDTRAIL_HOME) into the unit.
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
/// the `ProgramArguments` after `bin` (e.g. `["run", "--schedule", id]`), and `log_file` names
/// the log under `home_env`.
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

/// Per-schedule variant: labels the agent `ai.coldtrail.run.<id>` and points
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

/// Per-schedule variant: `ExecStart` runs `run --schedule <id>` so the unit
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

/// Install (or remove, if `s.enabled` is false) the OS timer for a single schedule row, keyed by
/// `s.id`. Each schedule gets its own launchd label / systemd unit pair so multiple schedules can
/// run independently.
#[allow(dead_code)] // macos/linux cfg-gated bodies; each half is dead on the other OS
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
/// installed). Targets `ai.coldtrail.run.<id>` / `coldtrail-<id>.*`.
#[allow(dead_code)] // macos/linux cfg-gated bodies; each half is dead on the other OS
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

/// One-time upgrade cleanup: removes the v0.9.15 singular `ai.coldtrail.run` timer (macOS) /
/// `coldtrail.{service,timer}` (Linux) that predated per-schedule units, so a user upgrading
/// from v0.9.15 with a schedule already enabled doesn't keep an orphaned timer firing
/// unattended alongside the new per-id ones. Best-effort: every step ignores its own errors.
fn remove_legacy_singular() {
    #[cfg(target_os = "macos")]
    {
        let uid = users_uid();
        let _ = std::process::Command::new("launchctl")
            .args(["bootout", &format!("gui/{uid}/ai.coldtrail.run")])
            .output();
        if let Ok(home) = dirs_home() {
            let _ = std::fs::remove_file(home.join("Library/LaunchAgents/ai.coldtrail.run.plist"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("systemctl")
            .args(["--user", "disable", "--now", "coldtrail.timer"])
            .output();
        if let Ok(dir) = dirs_home().map(|h| h.join(".config/systemd/user")) {
            let _ = std::fs::remove_file(dir.join("coldtrail.timer"));
            let _ = std::fs::remove_file(dir.join("coldtrail.service"));
        }
    }
}

/// Reconcile installed per-schedule OS timers to the DB: apply_one every schedule row
/// (apply_one itself removes the disabled ones). MVP scope: this does not garbage-collect
/// units whose schedule row was deleted out-of-band — deletion goes through remove_one via the
/// API, so a row dropped directly from the DB (or a unit installed by a since-removed build)
/// would linger on disk. Enumerate-and-prune is a future nicety, not implemented here.
#[allow(dead_code)] // exercised via `coldtrail schedule sync`; allow kept for platforms where apply_one/remove_one bodies are cfg'd out
pub fn sync() -> Result<()> {
    remove_legacy_singular(); // upgrade migration: drop the v0.9.15 singular timer, if present
    crate::db::init()?; // matches every other DB-touching CLI entrypoint; needed on a fresh COLDTRAIL_HOME
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
