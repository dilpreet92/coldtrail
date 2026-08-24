//! Settings → Schedule: read/write the cadence and install/remove the OS timer.
use super::{ApiErr, AppState};
use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Serialize)]
pub struct ScheduleResp {
    pub enabled: bool,
    pub freq: String,
    pub time: String,
    pub weekday: Option<u8>,
    pub last_run: Option<LastRun>,
}
#[derive(Serialize)]
pub struct LastRun {
    pub started_at: String,
    pub status: String,
    pub sourced: i64,
    pub enriched: i64,
    pub drafted: i64,
    pub sent: i64,
    pub chat_id: Option<String>,
}
#[derive(Deserialize)]
pub struct ScheduleReq {
    pub enabled: bool,
    pub freq: String,
    pub time: String,
    pub weekday: Option<u8>,
}

pub fn validate(freq: &str, time: &str) -> anyhow::Result<()> {
    if freq != "daily" && freq != "weekly" {
        anyhow::bail!("freq must be daily or weekly");
    }
    let (h, m) = time
        .split_once(':')
        .ok_or_else(|| anyhow::anyhow!("time must be HH:MM"))?;
    let h: u32 = h.parse().map_err(|_| anyhow::anyhow!("bad hour"))?;
    let m: u32 = m.parse().map_err(|_| anyhow::anyhow!("bad minute"))?;
    if h > 23 || m > 59 {
        anyhow::bail!("time out of range");
    }
    Ok(())
}

fn current() -> ScheduleResp {
    let s = crate::config::load().schedule.unwrap_or_default();
    let last_run = crate::db::last_run().ok().flatten().map(|r| LastRun {
        started_at: r.started_at,
        status: r.status,
        sourced: r.sourced,
        enriched: r.enriched,
        drafted: r.drafted,
        sent: r.sent,
        chat_id: r.chat_id,
    });
    ScheduleResp {
        enabled: s.enabled,
        freq: if s.freq.is_empty() {
            "daily".into()
        } else {
            s.freq
        },
        time: if s.time.is_empty() {
            "09:00".into()
        } else {
            s.time
        },
        weekday: s.weekday,
        last_run,
    }
}

pub async fn get(State(_s): State<Arc<AppState>>) -> Result<Json<ScheduleResp>, ApiErr> {
    Ok(Json(current()))
}

pub async fn post(
    State(_s): State<Arc<AppState>>,
    Json(req): Json<ScheduleReq>,
) -> Result<Json<ScheduleResp>, ApiErr> {
    if req.enabled {
        validate(&req.freq, &req.time).map_err(ApiErr)?;
    }
    let sched = crate::config::Schedule {
        enabled: req.enabled,
        freq: req.freq,
        time: req.time,
        weekday: req.weekday,
    };
    let mut cfg = crate::config::load();
    cfg.schedule = Some(sched.clone());
    crate::config::save(&cfg).map_err(ApiErr)?;
    crate::schedule::apply(&sched).map_err(ApiErr)?;
    Ok(Json(current()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn post_validates_freq_and_time() {
        assert!(validate("daily", "09:00").is_ok());
        assert!(validate("weekly", "23:59").is_ok());
        assert!(validate("hourly", "09:00").is_err()); // bad freq
        assert!(validate("daily", "9am").is_err()); // bad time
        assert!(validate("daily", "24:00").is_err()); // out of range
    }
}
