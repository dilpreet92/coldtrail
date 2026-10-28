//! `GET /api/summary` — one cheap snapshot for Home, the sidebar counts and the top-bar
//! schedule chip: workspace counts, the company funnel, the last and next run, a run in
//! progress, and the problems only the human can fix. The UI polls it, so it is a handful of
//! aggregate queries plus a few small config/secret file reads.

use axum::Json;
use rusqlite::{Connection, OptionalExtension};
use time::{Duration, PrimitiveDateTime, Time};

use super::api::{Attention, LastRun, NextSchedule, RunningChat, SummaryCounts, SummaryDto};
use super::ApiErr;
use crate::agents::{self, AgentKind};

pub async fn summary() -> Result<Json<SummaryDto>, ApiErr> {
    let c = crate::db::open()?;
    Ok(Json(build(
        &c,
        &Health::current(),
        crate::deliver::local_now(),
    )?))
}

/// The connection checks `attention` reports on, read once per request (tests pass their own).
struct Health {
    /// Why the configured agent can't run, if it can't.
    provider_problem: Option<String>,
    /// A Canonical token is stored.
    canonical: bool,
    /// The LinkedIn session expired and needs a fresh sign-in.
    linkedin_reconnect: bool,
}

impl Health {
    fn current() -> Self {
        let cfg = crate::config::load();
        let provider = cfg.agent.clone().unwrap_or_else(|| "claude".into());
        // The same readiness rule as `/api/status`: a CLI agent must be installed; an
        // OpenAI-compatible backend ("Your own model") must have an endpoint.
        let installed = |k| {
            agents::detect_all()
                .iter()
                .any(|s| s.kind == k && s.present)
        };
        let provider_problem = match AgentKind::from_str(&provider) {
            Some(k) if !installed(k) => Some(format!(
                "{} isn't installed, so the agent and scheduled runs can't start",
                k.label()
            )),
            None if cfg.provider.and_then(|p| p.base_url).is_none() => Some(
                "Your own model has no endpoint set, so the agent and scheduled runs can't start"
                    .into(),
            ),
            _ => None,
        };
        Health {
            provider_problem,
            canonical: crate::secrets::has_token("canonical"),
            linkedin_reconnect: crate::linkedin::LinkedinState::load().reconnect_needed,
        }
    }
}

fn build(c: &Connection, health: &Health, now: PrimitiveDateTime) -> anyhow::Result<SummaryDto> {
    // The newest run with its schedule's name, exactly as Schedules' run history lists it.
    let last_run = crate::db::list_runs(1)?.into_iter().next();
    Ok(SummaryDto {
        counts: counts(c)?,
        funnel: funnel(c)?,
        attention: attention(health, last_run.as_ref()),
        last_run: last_run.map(LastRun::from),
        next_schedule: next_schedule(now)?,
        running: running_chat(c)?,
    })
}

fn count(c: &Connection, sql: &str) -> rusqlite::Result<i64> {
    c.query_row(sql, [], |r| r.get(0))
}

fn counts(c: &Connection) -> anyhow::Result<SummaryCounts> {
    // Every status-based outreach count in one pass over the table.
    let (drafts, drafts_email, drafts_linkedin, sent, replied) = c.query_row(
        "SELECT COALESCE(SUM(status IN ('draft_pending','drafted')),0), \
                COALESCE(SUM(status IN ('draft_pending','drafted') \
                             AND COALESCE(channel,'email')='email'),0), \
                COALESCE(SUM(status IN ('draft_pending','drafted') AND channel='linkedin'),0), \
                COALESCE(SUM(status IN ('sent','replied','bounced')),0), \
                COALESCE(SUM(status = 'replied'),0) \
         FROM outreach",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    let followups_due = super::pipeline::followup_rows(c)?
        .iter()
        .filter(|f| f.state == "due")
        .count() as i64;
    Ok(SummaryCounts {
        companies: count(c, "SELECT count(*) FROM companies")?,
        contacts: count(c, "SELECT count(*) FROM contacts")?,
        drafts,
        drafts_email,
        drafts_linkedin,
        followups_due,
        replied,
        sent,
    })
}

/// Companies that reached each stage, in pipeline order. Each counts companies, not rows (two
/// contacts or a follow-up still count once), and only companies in the table, so no stage
/// can exceed `sourced`.
const FUNNEL: [(&str, &str); 5] = [
    ("sourced", "SELECT count(*) FROM companies"),
    (
        "contact_found",
        "SELECT count(DISTINCT k.domain) FROM contacts k JOIN companies c ON c.domain = k.domain \
         WHERE k.email IS NOT NULL OR k.linkedin_url IS NOT NULL",
    ),
    (
        "drafted",
        "SELECT count(DISTINCT o.domain) FROM outreach o JOIN companies c ON c.domain = o.domain",
    ),
    (
        "sent",
        "SELECT count(DISTINCT o.domain) FROM outreach o JOIN companies c ON c.domain = o.domain \
         WHERE o.status IN ('sent','replied','bounced')",
    ),
    (
        "replied",
        "SELECT count(DISTINCT o.domain) FROM outreach o JOIN companies c ON c.domain = o.domain \
         WHERE o.status = 'replied'",
    ),
];

fn funnel(c: &Connection) -> anyhow::Result<Vec<(String, i64)>> {
    FUNNEL
        .iter()
        .map(|(stage, sql)| Ok((stage.to_string(), count(c, sql)?)))
        .collect()
}

/// Connection problems first (in the order the sidebar lists them), then a failed last run.
fn attention(h: &Health, last_run: Option<&crate::db::RunRow>) -> Vec<Attention> {
    let mut out = Vec::new();
    let mut add = |kind: &str, message: String, target: &str| {
        out.push(Attention {
            kind: kind.into(),
            message,
            target: target.into(),
        })
    };
    if let Some(m) = &h.provider_problem {
        add("provider_missing", m.clone(), "#/settings?tab=agent");
    }
    if !h.canonical {
        add(
            "canonical_disconnected",
            "Canonical isn't connected, so the agent can't source new companies".into(),
            "#/settings?tab=connections",
        );
    }
    if h.linkedin_reconnect {
        add(
            "linkedin_reconnect",
            "LinkedIn signed you out, so no invites go out until you reconnect".into(),
            "#/settings?tab=connections",
        );
    }
    if let Some(r) = last_run.filter(|r| r.status == "error" || r.status == "auth_failed") {
        let which = match &r.schedule_name {
            Some(n) => format!("The last run ({n})"),
            None => "The last run".into(),
        };
        let message = if r.status == "auth_failed" {
            format!("{which} didn't start because the agent couldn't sign in")
        } else {
            match r.note.as_deref().and_then(note_summary) {
                Some(why) => format!("{which} ended with an error: {why}"),
                None => format!("{which} ended with an error"),
            }
        };
        add("last_run_failed", message, "#/schedules");
    }
    out
}

/// A run note fit for one line on Home: its first non-blank line, cut to 200 chars.
fn note_summary(note: &str) -> Option<String> {
    const MAX: usize = 200;
    let line = note.lines().map(str::trim).find(|l| !l.is_empty())?;
    if line.chars().count() <= MAX {
        return Some(line.to_string());
    }
    let cut: String = line.chars().take(MAX).collect();
    Some(format!("{}…", cut.trim_end()))
}

/// The enabled schedule whose next slot comes first (the oldest schedule wins a tie).
fn next_schedule(now: PrimitiveDateTime) -> anyhow::Result<Option<NextSchedule>> {
    Ok(crate::db::list_schedules()?
        .into_iter()
        .filter(|s| s.enabled)
        .map(|s| (next_run_at(&s.freq, &s.time, s.weekday, now), s))
        .min_by_key(|(at, _)| *at)
        .map(|(at, s)| NextSchedule {
            id: s.id,
            name: s.name,
            next_at: format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}",
                at.year(),
                u8::from(at.month()),
                at.day(),
                at.hour(),
                at.minute()
            ),
        }))
}

/// The most recently updated conversation a run is still writing to.
fn running_chat(c: &Connection) -> anyhow::Result<Option<RunningChat>> {
    Ok(c.query_row(
        "SELECT id, COALESCE(title,'') FROM chat_sessions WHERE running = 1 \
         ORDER BY updated_at DESC, created_at DESC, rowid DESC LIMIT 1",
        [],
        |r| {
            Ok(RunningChat {
                chat_id: r.get(0)?,
                title: r.get(1)?,
            })
        },
    )
    .optional()?)
}

/// When a schedule next fires, on the same local wall clock as its OS timer (`now` is local
/// time). Daily: today at HH:MM if that is still ahead, else tomorrow. Weekly: the next
/// matching weekday (0=Sun…6=Sat, default Monday), a week out if today's slot has passed.
/// A time that isn't a valid HH:MM falls back to 09:00, the OS timer's default.
pub fn next_run_at(
    freq: &str,
    time: &str,
    weekday: Option<u8>,
    now: PrimitiveDateTime,
) -> PrimitiveDateTime {
    let slot = now.replace_time(slot_time(time));
    let days = if freq == "weekly" {
        let target = i64::from(weekday.unwrap_or(1) % 7);
        let today = i64::from(now.weekday().number_days_from_sunday());
        match (target - today).rem_euclid(7) {
            0 if slot <= now => 7,
            add => add,
        }
    } else if slot <= now {
        1
    } else {
        0
    };
    slot + Duration::days(days)
}

fn slot_time(time: &str) -> Time {
    time.split_once(':')
        .and_then(|(h, m)| Time::from_hms(h.trim().parse().ok()?, m.trim().parse().ok()?, 0).ok())
        .unwrap_or(Time::MIDNIGHT + Duration::hours(9))
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::{Date, Month, PrimitiveDateTime, Time};

    /// 2026 `month`/`day` at `h:m` (Oct 28 2026 is a Wednesday).
    fn at(month: Month, day: u8, h: u8, m: u8) -> PrimitiveDateTime {
        PrimitiveDateTime::new(
            Date::from_calendar_date(2026, month, day).unwrap(),
            Time::from_hms(h, m, 0).unwrap(),
        )
    }

    fn wed(h: u8, m: u8) -> PrimitiveDateTime {
        at(Month::October, 28, h, m)
    }

    /// A slot still ahead today fires today; one already passed (or exactly now) fires
    /// tomorrow, across a month boundary too.
    #[test]
    fn next_run_at_daily_today_or_tomorrow() {
        let now = wed(10, 0);
        assert_eq!(next_run_at("daily", "13:00", None, now), wed(13, 0));
        assert_eq!(
            next_run_at("daily", "09:00", None, now),
            at(Month::October, 29, 9, 0)
        );
        assert_eq!(
            next_run_at("daily", "10:00", None, now),
            at(Month::October, 29, 10, 0)
        );
        // Seconds count: 10:00:30 is past the 10:00 slot.
        let late = now.replace_time(Time::from_hms(10, 0, 30).unwrap());
        assert_eq!(
            next_run_at("daily", "10:00", None, late),
            at(Month::October, 29, 10, 0)
        );
        // A weekday on a daily schedule is ignored.
        assert_eq!(next_run_at("daily", "13:00", Some(5), now), wed(13, 0));
        assert_eq!(
            next_run_at("daily", "08:00", None, at(Month::October, 31, 23, 30)),
            at(Month::November, 1, 8, 0)
        );
    }

    /// Weekly runs on the next matching weekday (0=Sun…6=Sat, default Monday); today's
    /// weekday fires today only while the slot is still ahead, else a week out. A time that
    /// isn't HH:MM falls back to 09:00, like the OS timer.
    #[test]
    fn next_run_at_weekly_wraps_and_defaults() {
        let now = wed(10, 0);
        assert_eq!(
            next_run_at("weekly", "09:00", Some(1), now),
            at(Month::November, 2, 9, 0)
        );
        assert_eq!(
            next_run_at("weekly", "09:00", Some(3), now),
            at(Month::November, 4, 9, 0)
        );
        assert_eq!(next_run_at("weekly", "11:00", Some(3), now), wed(11, 0));
        assert_eq!(
            next_run_at("weekly", "09:00", None, now),
            at(Month::November, 2, 9, 0)
        );
        assert_eq!(
            next_run_at("weekly", "07:15", Some(0), now),
            at(Month::November, 1, 7, 15)
        );
        assert_eq!(
            next_run_at("weekly", "18:00", Some(6), now),
            at(Month::October, 31, 18, 0)
        );
        assert_eq!(
            next_run_at("daily", "bad", None, now),
            at(Month::October, 29, 9, 0)
        );
        assert_eq!(next_run_at("daily", "25:00", None, wed(8, 0)), wed(9, 0));
        assert_eq!(
            next_run_at("weekly", "bad", Some(4), now),
            at(Month::October, 29, 9, 0)
        );
    }

    fn seed(sql: &str) -> rusqlite::Connection {
        crate::db::init().unwrap();
        let c = crate::db::open().unwrap();
        c.execute_batch(sql).unwrap();
        c
    }

    /// Everything connected and installed: only run state can raise attention.
    fn healthy() -> Health {
        Health {
            provider_problem: None,
            canonical: true,
            linkedin_reconnect: false,
        }
    }

    fn pairs(v: &[(&str, i64)]) -> Vec<(String, i64)> {
        v.iter().map(|(s, n)| (s.to_string(), *n)).collect()
    }

    fn kinds(s: &SummaryDto) -> Vec<(&str, &str)> {
        s.attention
            .iter()
            .map(|a| (a.kind.as_str(), a.target.as_str()))
            .collect()
    }

    /// Four companies at different depths. Counts are rows (contacts, outreach by status and
    /// channel; a legacy NULL channel is email); the funnel counts companies, once each.
    #[test]
    fn summary_counts_and_funnel_match_seed() {
        crate::testutil::with_home("ct-web-summary-counts", |_| {
            let c = seed(
                "INSERT INTO companies (domain, status) VALUES \
                 ('a.com','drafted'), ('b.com','sent'), ('c.com','replied'), ('d.com','named'); \
                 INSERT INTO contacts (domain, founder_name, email, mx_ok, linkedin_url) VALUES \
                 ('a.com','Ann','ann@a.com',1,NULL), \
                 ('b.com','Ben',NULL,NULL,'https://www.linkedin.com/in/ben'), \
                 ('c.com','Cat','cat@c.com',1,NULL), \
                 ('d.com','Dan',NULL,NULL,NULL); \
                 INSERT INTO outreach (domain, channel, status, sent_at) VALUES \
                 ('a.com',NULL,'draft_pending',NULL), \
                 ('b.com','linkedin','drafted',NULL), \
                 ('b.com','email','sent',datetime('now','-5 days')), \
                 ('c.com','email','replied',datetime('now','-10 days')), \
                 ('c.com','email','bounced',datetime('now','-6 days'));",
            );
            let s = build(&c, &healthy(), wed(10, 0)).unwrap();
            assert_eq!(
                serde_json::to_value(&s.counts).unwrap(),
                serde_json::json!({
                    "companies": 4, "contacts": 4, "drafts": 2, "drafts_email": 1,
                    "drafts_linkedin": 1, "followups_due": 1, "replied": 1, "sent": 3,
                })
            );
            assert_eq!(
                s.funnel,
                pairs(&[
                    ("sourced", 4),
                    ("contact_found", 3),
                    ("drafted", 3),
                    ("sent", 2),
                    ("replied", 1),
                ])
            );
            assert!(s.attention.is_empty());
            assert!(s.last_run.is_none() && s.next_schedule.is_none() && s.running.is_none());
        });
    }

    /// An empty workspace still reports all five funnel stages, at zero.
    #[test]
    fn summary_of_an_empty_workspace_is_all_zero() {
        crate::testutil::with_home("ct-web-summary-empty", |_| {
            let c = seed("");
            let s = build(&c, &healthy(), wed(10, 0)).unwrap();
            assert_eq!(s.counts.companies + s.counts.drafts + s.counts.sent, 0);
            assert_eq!(
                s.funnel,
                pairs(&[
                    ("sourced", 0),
                    ("contact_found", 0),
                    ("drafted", 0),
                    ("sent", 0),
                    ("replied", 0),
                ])
            );
        });
    }

    /// `last_run` is the newest run row with its schedule's name and the deltas the run
    /// recorded (as Schedules shows them). An `error` or `auth_failed` newest run asks for
    /// attention on Schedules; an `ok` one doesn't.
    #[test]
    fn summary_attention_lists_failed_last_run() {
        crate::testutil::with_home("ct-web-summary-attention", |_| {
            let c = seed("");
            crate::db::upsert_schedule(&crate::db::Schedule {
                id: "s1".into(),
                name: "Lunch Source".into(),
                enabled: true,
                freq: "daily".into(),
                time: "13:00".into(),
                weekday: None,
                task_mode: "agent".into(),
                prompt: None,
            })
            .unwrap();
            let counts = |companies, contacts, outreach, sent_today| crate::db::Counts {
                companies,
                contacts,
                outreach,
                sent_today,
            };
            let z = counts(0, 0, 0, 0);
            crate::db::record_run("ok", z, counts(9, 9, 9, 9), None, None, None, "manual").unwrap();
            crate::db::record_run(
                "error",
                counts(10, 4, 6, 1),
                counts(13, 5, 8, 2),
                Some("chat-9"),
                Some("boom"),
                Some("s1"),
                "scheduled",
            )
            .unwrap();

            let s = build(&c, &healthy(), wed(10, 0)).unwrap();
            let lr = s.last_run.as_ref().unwrap();
            assert_eq!(lr.status, "error");
            assert_eq!(lr.schedule_name.as_deref(), Some("Lunch Source"));
            assert_eq!(lr.chat_id.as_deref(), Some("chat-9"));
            assert_eq!((lr.sourced, lr.drafted, lr.sent), (3, 2, 1));
            assert!(!lr.started_at.is_empty());
            assert_eq!(kinds(&s), [("last_run_failed", "#/schedules")]);
            assert!(s.attention[0].message.contains("Lunch Source"));

            // A run that couldn't sign in is a failure too, even without a schedule.
            crate::db::record_run("auth_failed", z, z, None, Some("nope"), None, "scheduled")
                .unwrap();
            let s = build(&c, &healthy(), wed(10, 0)).unwrap();
            assert_eq!(s.last_run.as_ref().unwrap().schedule_name, None);
            assert_eq!(kinds(&s), [("last_run_failed", "#/schedules")]);
            assert!(!s.attention[0].message.is_empty());

            // Only the newest run counts: a later success clears it.
            crate::db::record_run("ok", z, z, None, None, Some("s1"), "scheduled").unwrap();
            let s = build(&c, &healthy(), wed(10, 0)).unwrap();
            assert_eq!(s.last_run.as_ref().unwrap().status, "ok");
            assert!(s.attention.is_empty());

            // Connection problems come first, each pointing at its Settings tab.
            let broken = Health {
                provider_problem: Some("Codex CLI isn't installed".into()),
                canonical: false,
                linkedin_reconnect: true,
            };
            crate::db::record_run("error", z, z, None, None, None, "manual").unwrap();
            let s = build(&c, &broken, wed(10, 0)).unwrap();
            assert_eq!(
                kinds(&s),
                [
                    ("provider_missing", "#/settings?tab=agent"),
                    ("canonical_disconnected", "#/settings?tab=connections"),
                    ("linkedin_reconnect", "#/settings?tab=connections"),
                    ("last_run_failed", "#/schedules"),
                ]
            );
            assert_eq!(s.attention[0].message, "Codex CLI isn't installed");
            assert!(s.attention.iter().all(|a| !a.message.is_empty()));
        });
    }

    /// A failed run's note (e.g. the provider's message when the check before the run failed)
    /// is on `last_run` and in the attention message, first line only and kept short; a run
    /// without a note keeps the plain wording.
    #[test]
    fn summary_failed_run_says_why() {
        crate::testutil::with_home("ct-web-summary-run-note", |_| {
            let c = seed("");
            let z = crate::db::Counts {
                companies: 0,
                contacts: 0,
                outreach: 0,
                sent_today: 0,
            };
            let note = "Model muse-spark-1.3-contributor-free has been deprecated.";
            crate::db::record_run("error", z, z, None, Some(note), None, "scheduled").unwrap();
            let s = build(&c, &healthy(), wed(10, 0)).unwrap();
            assert_eq!(s.last_run.as_ref().unwrap().note.as_deref(), Some(note));
            assert_eq!(kinds(&s), [("last_run_failed", "#/schedules")]);
            assert_eq!(
                s.attention[0].message,
                format!("The last run ended with an error: {note}")
            );

            let long = format!("{}\nstack line 2\nstack line 3", "x".repeat(400));
            crate::db::record_run("error", z, z, None, Some(&long), None, "scheduled").unwrap();
            let s = build(&c, &healthy(), wed(10, 0)).unwrap();
            let m = &s.attention[0].message;
            assert!(!m.contains('\n') && !m.contains("stack"), "{m}");
            assert!(m.chars().count() < 260 && m.ends_with('…'), "{m}");

            crate::db::record_run("error", z, z, None, None, None, "manual").unwrap();
            let s = build(&c, &healthy(), wed(10, 0)).unwrap();
            assert_eq!(s.last_run.as_ref().unwrap().note, None);
            assert_eq!(s.attention[0].message, "The last run ended with an error");
        });
    }

    /// `running` is the most recently updated conversation a run is still writing to.
    #[test]
    fn summary_running_chat() {
        crate::testutil::with_home("ct-web-summary-running", |_| {
            let c = seed(
                "INSERT INTO chat_sessions (id, title, updated_at, running) VALUES \
                 ('idle','Idle chat','2026-10-28 09:59:00',0), \
                 ('old','Scheduled run — Old','2026-10-27 08:00:00',1), \
                 ('new','Scheduled run — Lunch Source','2026-10-28 09:00:00',1);",
            );
            let s = build(&c, &healthy(), wed(10, 0)).unwrap();
            let r = s.running.unwrap();
            assert_eq!(
                (r.chat_id.as_str(), r.title.as_str()),
                ("new", "Scheduled run — Lunch Source")
            );

            c.execute_batch("UPDATE chat_sessions SET running = 0;")
                .unwrap();
            assert!(build(&c, &healthy(), wed(10, 0)).unwrap().running.is_none());
        });
    }

    /// `next_schedule` is the enabled schedule that fires soonest, as local `YYYY-MM-DDTHH:MM`;
    /// a paused schedule never counts, however soon its slot.
    #[test]
    fn summary_next_schedule_is_earliest_enabled() {
        crate::testutil::with_home("ct-web-summary-next", |_| {
            let c = seed("");
            let sched = |id: &str, name: &str, enabled, freq: &str, time: &str, weekday| {
                crate::db::upsert_schedule(&crate::db::Schedule {
                    id: id.into(),
                    name: name.into(),
                    enabled,
                    freq: freq.into(),
                    time: time.into(),
                    weekday,
                    task_mode: "agent".into(),
                    prompt: None,
                })
                .unwrap()
            };
            sched("weekly", "Thursday sweep", true, "weekly", "08:00", Some(4));
            sched("paused", "Paused", false, "daily", "10:30", None);
            sched("lunch", "Lunch Source", true, "daily", "13:00", None);

            let s = build(&c, &healthy(), wed(10, 0)).unwrap();
            let n = s.next_schedule.unwrap();
            assert_eq!(
                (n.id.as_str(), n.name.as_str(), n.next_at.as_str()),
                ("lunch", "Lunch Source", "2026-10-28T13:00")
            );

            // After lunch, Thursday 08:00 beats tomorrow's 13:00.
            let s = build(&c, &healthy(), wed(14, 0)).unwrap();
            assert_eq!(s.next_schedule.unwrap().next_at, "2026-10-29T08:00");
        });
    }

    /// Through the real router and token guard: the JSON shape the UI reads. With an
    /// OpenAI-compatible endpoint set the provider is ready; no Canonical token is stored.
    #[test]
    fn summary_route_serves_the_contract() {
        use tower::ServiceExt;
        crate::testutil::with_home("ct-web-summary-route", |dir| {
            let _ = std::fs::remove_dir_all(format!("{}.secrets", dir.display()));
            seed("INSERT INTO companies (domain) VALUES ('a.com');");
            std::fs::write(
                dir.join("config.toml"),
                "agent = \"openai\"\n[provider]\nbase_url = \"http://127.0.0.1:9\"\n",
            )
            .unwrap();
            let rt = tokio::runtime::Runtime::new().unwrap();
            let req = axum::http::Request::builder()
                .uri("/api/summary?t=secret-tok")
                .body(axum::body::Body::empty())
                .unwrap();
            let resp = rt
                .block_on(crate::web::router(crate::web::tests::state()).oneshot(req))
                .unwrap();
            assert_eq!(resp.status(), axum::http::StatusCode::OK);
            let body = rt
                .block_on(axum::body::to_bytes(resp.into_body(), usize::MAX))
                .unwrap();
            let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(v["counts"]["companies"], 1);
            assert_eq!(v["funnel"][0], serde_json::json!(["sourced", 1]));
            assert_eq!(v["funnel"].as_array().unwrap().len(), 5);
            assert!(v["last_run"].is_null() && v["next_schedule"].is_null());
            assert!(v["running"].is_null());
            assert_eq!(
                v["attention"],
                serde_json::json!([{
                    "kind": "canonical_disconnected",
                    "message": v["attention"][0]["message"],
                    "target": "#/settings?tab=connections",
                }])
            );
        });
    }
}
