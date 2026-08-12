//! Tiny append-only log so testers can see what the agent is doing (and why a backend failed).
//! Every line goes to the server's stderr (visible in the terminal running `coldtrail`) AND to
//! `~/.coldtrail/coldtrail.log`. Best-effort — never panics, never blocks a turn on an IO error.

use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

/// UTC HH:MM:SS from the wall clock (no chrono dependency).
fn hhmmss() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let t = secs % 86_400;
    format!("{:02}:{:02}:{:02}", t / 3600, (t % 3600) / 60, t % 60)
}

/// Append `msg` to the log (terminal + file), timestamped.
pub fn log(msg: &str) {
    let line = format!("[{}] {msg}\n", hhmmss());
    eprint!("{line}");
    if let Ok(p) = crate::home::path("coldtrail.log") {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
        {
            let _ = f.write_all(line.as_bytes());
        }
    }
}
