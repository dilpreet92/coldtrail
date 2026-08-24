//! `/api/schedules` collection API: CRUD over `db::Schedule` rows plus `/:id/run` (kick a
//! detached run now) and `/api/runs` (recent run history across all schedules). Replaces the
//! old singular `/api/schedule` (settings-panel cadence) — see `src/schedule.rs::apply` for the
//! CLI-only installer that still uses that shape until a later task removes it.

use super::{ApiErr, AppState};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Serialize)]
pub struct LastRunDto {
    pub started_at: String,
    pub status: String,
    pub sourced: i64,
    pub enriched: i64,
    pub drafted: i64,
    pub sent: i64,
    pub chat_id: Option<String>,
}

impl From<crate::db::RunRow> for LastRunDto {
    fn from(r: crate::db::RunRow) -> Self {
        LastRunDto {
            started_at: r.started_at,
            status: r.status,
            sourced: r.sourced,
            enriched: r.enriched,
            drafted: r.drafted,
            sent: r.sent,
            chat_id: r.chat_id,
        }
    }
}

#[derive(Serialize)]
pub struct ScheduleDto {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub freq: String,
    pub time: String,
    pub weekday: Option<u8>,
    pub task_mode: String,
    pub prompt: Option<String>,
    pub last_run: Option<LastRunDto>,
}

impl ScheduleDto {
    fn from_schedule(s: crate::db::Schedule, last_run: Option<crate::db::RunRow>) -> Self {
        ScheduleDto {
            id: s.id,
            name: s.name,
            enabled: s.enabled,
            freq: s.freq,
            time: s.time,
            weekday: s.weekday,
            task_mode: s.task_mode,
            prompt: s.prompt,
            last_run: last_run.map(LastRunDto::from),
        }
    }
}

#[derive(Deserialize)]
pub struct ScheduleCreateReq {
    pub name: String,
    pub enabled: bool,
    pub freq: String,
    pub time: String,
    pub weekday: Option<u8>,
    pub task_mode: String,
    pub prompt: Option<String>,
}

#[derive(Deserialize)]
pub struct ScheduleUpdateReq {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub freq: Option<String>,
    pub time: Option<String>,
    pub weekday: Option<u8>,
    pub task_mode: Option<String>,
    pub prompt: Option<String>,
}

#[derive(Deserialize)]
pub struct RunNowReq {
    #[serde(default)]
    pub draft_only: bool,
}

#[derive(Serialize)]
pub struct RunDto {
    pub started_at: String,
    pub status: String,
    pub sourced: i64,
    pub enriched: i64,
    pub drafted: i64,
    pub sent: i64,
    pub chat_id: Option<String>,
    pub trigger: Option<String>,
    pub schedule_name: Option<String>,
}

impl From<crate::db::RunRow> for RunDto {
    fn from(r: crate::db::RunRow) -> Self {
        RunDto {
            started_at: r.started_at,
            status: r.status,
            sourced: r.sourced,
            enriched: r.enriched,
            drafted: r.drafted,
            sent: r.sent,
            chat_id: r.chat_id,
            trigger: r.trigger,
            schedule_name: r.schedule_name,
        }
    }
}

/// Validate the fields that determine when/what a schedule runs. `freq`/`time`/`task_mode` are
/// closed enums; a `custom` task_mode additionally requires a non-blank `prompt`.
pub fn validate(
    freq: &str,
    time: &str,
    task_mode: &str,
    prompt: Option<&str>,
) -> anyhow::Result<()> {
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
    if task_mode != "agent" && task_mode != "custom" {
        anyhow::bail!("task_mode must be agent or custom");
    }
    if task_mode == "custom" && prompt.map(|p| p.trim().is_empty()).unwrap_or(true) {
        anyhow::bail!("a custom task needs an instruction");
    }
    Ok(())
}

/// Newest run per schedule id, from a `list_runs` snapshot (already newest-first).
fn last_run_for<'a>(runs: &'a [crate::db::RunRow], id: &str) -> Option<&'a crate::db::RunRow> {
    runs.iter().find(|r| r.schedule_id.as_deref() == Some(id))
}

pub async fn list(State(_s): State<Arc<AppState>>) -> Result<Json<Vec<ScheduleDto>>, ApiErr> {
    let schedules = crate::db::list_schedules().map_err(ApiErr)?;
    // A generous window covers "last run" for every schedule without one query per row.
    let runs = crate::db::list_runs(500).map_err(ApiErr)?;
    let out = schedules
        .into_iter()
        .map(|s| {
            let last_run = last_run_for(&runs, &s.id).cloned();
            ScheduleDto::from_schedule(s, last_run)
        })
        .collect();
    Ok(Json(out))
}

pub async fn create(
    State(_s): State<Arc<AppState>>,
    Json(req): Json<ScheduleCreateReq>,
) -> Result<Json<ScheduleDto>, ApiErr> {
    validate(&req.freq, &req.time, &req.task_mode, req.prompt.as_deref()).map_err(ApiErr)?;
    let id = uuid::Uuid::new_v4().to_string();
    let s = crate::db::Schedule {
        id,
        name: req.name,
        enabled: req.enabled,
        freq: req.freq,
        time: req.time,
        weekday: req.weekday,
        task_mode: req.task_mode,
        prompt: req.prompt,
    };
    // Write the row before installing the timer: if apply_one fails (e.g. launchctl), the
    // schedule still exists and the caller sees the timer error rather than losing the row.
    crate::db::upsert_schedule(&s).map_err(ApiErr)?;
    crate::schedule::apply_one(&s).map_err(ApiErr)?;
    Ok(Json(ScheduleDto::from_schedule(s, None)))
}

pub async fn update(
    State(_s): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<ScheduleUpdateReq>,
) -> Result<Json<ScheduleDto>, ApiErr> {
    let existing = crate::db::get_schedule(&id)
        .map_err(ApiErr)?
        .ok_or_else(|| ApiErr(anyhow::anyhow!("schedule not found")))?;
    let s = crate::db::Schedule {
        id: existing.id,
        name: req.name.unwrap_or(existing.name),
        enabled: req.enabled.unwrap_or(existing.enabled),
        freq: req.freq.unwrap_or(existing.freq),
        time: req.time.unwrap_or(existing.time),
        weekday: req.weekday.or(existing.weekday),
        task_mode: req.task_mode.unwrap_or(existing.task_mode),
        prompt: req.prompt.or(existing.prompt),
    };
    validate(&s.freq, &s.time, &s.task_mode, s.prompt.as_deref()).map_err(ApiErr)?;
    crate::db::upsert_schedule(&s).map_err(ApiErr)?;
    crate::schedule::apply_one(&s).map_err(ApiErr)?;
    Ok(Json(ScheduleDto::from_schedule(s, None)))
}

pub async fn remove(
    State(_s): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiErr> {
    crate::db::delete_schedule(&id).map_err(ApiErr)?;
    crate::schedule::remove_one(&id).map_err(ApiErr)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Kick a run now for schedule `id`. The run is detached (spawned, not awaited): it creates and
/// records its own chat + `scheduled_runs` row, so the UI finds out by polling `/api/runs`
/// rather than from this response. Mirrors `web::chat::start`'s spawn pattern.
pub async fn run_now(
    State(_s): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<RunNowReq>,
) -> Result<Response, ApiErr> {
    if crate::db::get_schedule(&id).map_err(ApiErr)?.is_none() {
        return Ok((StatusCode::NOT_FOUND, "schedule not found").into_response());
    }
    let draft_only = req.draft_only;
    tokio::spawn(async move {
        let _ = crate::scheduled::run(Some(&id), if draft_only { "dry" } else { "manual" }).await;
    });
    Ok(Json(serde_json::json!({ "ok": true })).into_response())
}

pub async fn runs(State(_s): State<Arc<AppState>>) -> Result<Json<Vec<RunDto>>, ApiErr> {
    let rows = crate::db::list_runs(50).map_err(ApiErr)?;
    Ok(Json(rows.into_iter().map(RunDto::from).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validate_rejects_bad_input() {
        assert!(validate("daily", "09:00", "agent", None).is_ok());
        assert!(validate("weekly", "23:59", "custom", Some("do X")).is_ok());
        assert!(validate("hourly", "09:00", "agent", None).is_err()); // bad freq
        assert!(validate("daily", "9am", "agent", None).is_err()); // bad time
        assert!(validate("daily", "24:00", "agent", None).is_err()); // out of range
        assert!(validate("daily", "09:00", "custom", None).is_err()); // custom needs a prompt
        assert!(validate("daily", "09:00", "custom", Some("  ")).is_err()); // blank prompt
        assert!(validate("daily", "09:00", "bogus", None).is_err()); // bad task_mode
    }
}
