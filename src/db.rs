//! SQLite state. Dedupe key = company domain.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

pub const SCHEMA: &str = include_str!("../templates/schema.sql");

/// Open the workspace database with foreign keys enforced.
pub fn open() -> Result<Connection> {
    let c = Connection::open(crate::home::path("outreach.db")?)?;
    c.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;",
    )?;
    Ok(c)
}

/// Create the schema if it does not exist (idempotent).
pub fn init() -> Result<()> {
    let c = open()?;
    c.execute_batch(SCHEMA)?;
    // scheduled_runs predates this feature; add the attribution columns if missing (idempotent).
    for (col, decl) in [("schedule_id", "TEXT"), ("trigger", "TEXT")] {
        let exists: bool = c
            .prepare("SELECT 1 FROM pragma_table_info('scheduled_runs') WHERE name=?1")?
            .exists([col])?;
        if !exists {
            c.execute_batch(&format!(
                "ALTER TABLE scheduled_runs ADD COLUMN {col} {decl};"
            ))?;
        }
    }
    // chat_sessions predates this feature; add the live-progress flag if missing (idempotent).
    let has_running: bool = c
        .prepare("SELECT 1 FROM pragma_table_info('chat_sessions') WHERE name='running'")?
        .exists([])?;
    if !has_running {
        c.execute_batch(
            "ALTER TABLE chat_sessions ADD COLUMN running INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    Ok(())
}

/// Insert a company only if its domain is new. Returns true when newly inserted.
pub fn upsert_company(
    c: &Connection,
    domain: &str,
    name: Option<&str>,
    hq: Option<&str>,
    employees: Option<i64>,
    founding_year: Option<i64>,
    source_query: &str,
) -> Result<bool> {
    let exists: Option<i64> = c
        .query_row("SELECT 1 FROM companies WHERE domain = ?1", [domain], |r| {
            r.get(0)
        })
        .optional()?;
    if exists.is_some() {
        return Ok(false);
    }
    c.execute(
        "INSERT INTO companies (domain, name, hq, employees, founding_year, source_query) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![domain, name, hq, employees, founding_year, source_query],
    )?;
    Ok(true)
}

pub fn set_status(c: &Connection, domain: &str, status: &str) -> Result<()> {
    c.execute(
        "UPDATE companies SET status = ?1 WHERE domain = ?2",
        params![status, domain],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Counts {
    pub companies: i64,
    pub contacts: i64,
    pub outreach: i64,
    pub sent_today: i64,
}

#[allow(dead_code)]
pub fn counts(c: &Connection) -> Result<Counts> {
    let one = |sql: &str| -> Result<i64> { Ok(c.query_row(sql, [], |r| r.get(0))?) };
    Ok(Counts {
        companies: one("SELECT COUNT(*) FROM companies")?,
        contacts: one("SELECT COUNT(*) FROM contacts WHERE email IS NOT NULL AND mx_ok=1")?,
        outreach: one("SELECT COUNT(*) FROM outreach")?,
        sent_today: one(
            "SELECT COUNT(*) FROM outreach WHERE status='sent' AND date(sent_at)=date('now')",
        )?,
    })
}

#[allow(dead_code)]
pub fn record_run(
    status: &str,
    before: Counts,
    after: Counts,
    chat_id: Option<&str>,
    note: Option<&str>,
    schedule_id: Option<&str>,
    trigger: &str,
) -> Result<()> {
    let c = open()?;
    c.execute(
        "INSERT INTO scheduled_runs \
         (finished_at, status, sourced, enriched, drafted, sent, chat_id, note, schedule_id, trigger) \
         VALUES (datetime('now'), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            status,
            (after.companies - before.companies).max(0),
            (after.contacts - before.contacts).max(0),
            (after.outreach - before.outreach).max(0),
            (after.sent_today - before.sent_today).max(0),
            chat_id,
            note,
            schedule_id,
            trigger,
        ],
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct RunRow {
    pub started_at: String,
    pub status: String,
    pub sourced: i64,
    pub enriched: i64,
    pub drafted: i64,
    pub sent: i64,
    pub chat_id: Option<String>,
    pub note: Option<String>,
    pub schedule_id: Option<String>,
    pub trigger: Option<String>,
    pub schedule_name: Option<String>,
}

#[allow(dead_code)]
pub fn last_run() -> Result<Option<RunRow>> {
    let c = open()?;
    let row = c
        .query_row(
            "SELECT started_at, status, sourced, enriched, drafted, sent, chat_id, note, \
                    schedule_id, trigger \
             FROM scheduled_runs ORDER BY id DESC LIMIT 1",
            [],
            |r| {
                Ok(RunRow {
                    started_at: r.get(0)?,
                    status: r.get(1)?,
                    sourced: r.get(2)?,
                    enriched: r.get(3)?,
                    drafted: r.get(4)?,
                    sent: r.get(5)?,
                    chat_id: r.get(6)?,
                    note: r.get(7)?,
                    schedule_id: r.get(8)?,
                    trigger: r.get(9)?,
                    schedule_name: None,
                })
            },
        )
        .optional()?;
    Ok(row)
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct Schedule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub freq: String,
    pub time: String,
    pub weekday: Option<u8>,
    pub task_mode: String,
    pub prompt: Option<String>,
}

fn row_to_schedule(r: &rusqlite::Row) -> rusqlite::Result<Schedule> {
    Ok(Schedule {
        id: r.get(0)?,
        name: r.get(1)?,
        enabled: r.get::<_, i64>(2)? != 0,
        freq: r.get(3)?,
        time: r.get(4)?,
        weekday: r.get::<_, Option<i64>>(5)?.map(|v| v as u8),
        task_mode: r.get(6)?,
        prompt: r.get(7)?,
    })
}

/// List all schedules, oldest first. Not yet wired into a command (later task).
#[allow(dead_code)]
pub fn list_schedules() -> Result<Vec<Schedule>> {
    let c = open()?;
    let mut st = c.prepare(
        "SELECT id,name,enabled,freq,time,weekday,task_mode,prompt FROM schedules ORDER BY created_at",
    )?;
    let out = st
        .query_map([], row_to_schedule)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(out)
}

/// Fetch a single schedule by id. Not yet wired into a command (later task).
#[allow(dead_code)]
pub fn get_schedule(id: &str) -> Result<Option<Schedule>> {
    let c = open()?;
    let s = c
        .query_row(
            "SELECT id,name,enabled,freq,time,weekday,task_mode,prompt FROM schedules WHERE id=?1",
            [id],
            row_to_schedule,
        )
        .optional()?;
    Ok(s)
}

/// Insert or update a schedule by id. Not yet wired into a command (later task).
#[allow(dead_code)]
pub fn upsert_schedule(s: &Schedule) -> Result<()> {
    let c = open()?;
    c.execute(
        "INSERT INTO schedules (id,name,enabled,freq,time,weekday,task_mode,prompt,updated_at) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,datetime('now')) \
         ON CONFLICT(id) DO UPDATE SET name=?2,enabled=?3,freq=?4,time=?5,weekday=?6,task_mode=?7,prompt=?8,updated_at=datetime('now')",
        params![
            s.id,
            s.name,
            s.enabled as i64,
            s.freq,
            s.time,
            s.weekday.map(|w| w as i64),
            s.task_mode,
            s.prompt
        ],
    )?;
    Ok(())
}

/// Delete a schedule by id. Not yet wired into a command (later task).
#[allow(dead_code)]
pub fn delete_schedule(id: &str) -> Result<()> {
    open()?.execute("DELETE FROM schedules WHERE id=?1", [id])?;
    Ok(())
}

/// Mark a chat session's live-progress flag. Not yet wired into a command (later task).
#[allow(dead_code)]
pub fn set_chat_running(chat_id: &str, running: bool) -> Result<()> {
    open()?.execute(
        "UPDATE chat_sessions SET running=?1 WHERE id=?2",
        params![running as i64, chat_id],
    )?;
    Ok(())
}

/// Whether a chat session currently has a live run in progress. Not yet wired into a
/// command (later task).
#[allow(dead_code)]
pub fn chat_running(chat_id: &str) -> Result<bool> {
    let c = open()?;
    let v: Option<i64> = c
        .query_row(
            "SELECT running FROM chat_sessions WHERE id=?1",
            [chat_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v.unwrap_or(0) != 0)
}

/// List recent scheduled runs, newest first, with the triggering schedule's name joined in.
/// Not yet wired into a command (later task).
#[allow(dead_code)]
pub fn list_runs(limit: i64) -> Result<Vec<RunRow>> {
    let c = open()?;
    let mut st = c.prepare(
        "SELECT r.started_at,r.status,r.sourced,r.enriched,r.drafted,r.sent,r.chat_id,r.note,\
                r.schedule_id,r.trigger,s.name \
         FROM scheduled_runs r LEFT JOIN schedules s ON s.id=r.schedule_id \
         ORDER BY r.id DESC LIMIT ?1",
    )?;
    let out = st
        .query_map([limit], |r| {
            Ok(RunRow {
                started_at: r.get(0)?,
                status: r.get(1)?,
                sourced: r.get(2)?,
                enriched: r.get(3)?,
                drafted: r.get(4)?,
                sent: r.get(5)?,
                chat_id: r.get(6)?,
                note: r.get(7)?,
                schedule_id: r.get(8)?,
                trigger: r.get(9)?,
                schedule_name: r.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c
    }

    #[test]
    fn upsert_is_deduped_by_domain() {
        let c = fresh();
        let a = upsert_company(&c, "acme.com", Some("Acme"), None, None, None, "q").unwrap();
        let b = upsert_company(&c, "acme.com", Some("Acme"), None, None, None, "q").unwrap();
        assert!(a);
        assert!(!b);
        let n: i64 = c
            .query_row("SELECT count(*) FROM companies", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn set_status_updates() {
        let c = fresh();
        upsert_company(&c, "acme.com", None, None, None, None, "q").unwrap();
        set_status(&c, "acme.com", "emailed").unwrap();
        let s: String = c
            .query_row(
                "SELECT status FROM companies WHERE domain='acme.com'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(s, "emailed");
    }

    #[test]
    fn records_and_reads_a_scheduled_run() {
        crate::testutil::with_home("ct-db-runs", |_| {
            crate::db::init().unwrap();
            let before = Counts {
                companies: 0,
                contacts: 0,
                outreach: 0,
                sent_today: 0,
            };
            let after = Counts {
                companies: 5,
                contacts: 3,
                outreach: 3,
                sent_today: 1,
            };
            record_run("ok", before, after, Some("chat-1"), None, None, "manual").unwrap();
            let r = last_run().unwrap().unwrap();
            assert_eq!(r.status, "ok");
            assert_eq!(r.sourced, 5);
            assert_eq!(r.enriched, 3);
            assert_eq!(r.drafted, 3);
            assert_eq!(r.sent, 1);
            assert_eq!(r.chat_id.as_deref(), Some("chat-1"));
        });
    }

    #[test]
    fn schedules_crud_and_runs_join() {
        crate::testutil::with_home("ct-db-schedules", |_| {
            crate::db::init().unwrap();
            let s = Schedule {
                id: "s1".into(),
                name: "Fintech".into(),
                enabled: true,
                freq: "weekly".into(),
                time: "09:00".into(),
                weekday: Some(1),
                task_mode: "custom".into(),
                prompt: Some("web-search fintech founders".into()),
            };
            upsert_schedule(&s).unwrap();
            let got = get_schedule("s1").unwrap().unwrap();
            assert_eq!(got.name, "Fintech");
            assert_eq!(got.task_mode, "custom");
            assert_eq!(got.weekday, Some(1));
            // update
            let mut s2 = got.clone();
            s2.enabled = false;
            s2.name = "FT".into();
            upsert_schedule(&s2).unwrap();
            assert_eq!(list_schedules().unwrap().len(), 1);
            assert_eq!(get_schedule("s1").unwrap().unwrap().name, "FT");
            // a run attributed to the schedule shows up in list_runs with the joined name
            let z = Counts {
                companies: 0,
                contacts: 0,
                outreach: 0,
                sent_today: 0,
            };
            record_run("ok", z, z, Some("chat1"), None, None, "manual").unwrap();
            let runs = list_runs(10).unwrap();
            assert_eq!(runs.len(), 1);
            // idempotent init: second call must not error and columns persist
            crate::db::init().unwrap();
            assert!(get_schedule("s1").unwrap().is_some());
            // delete
            delete_schedule("s1").unwrap();
            assert!(get_schedule("s1").unwrap().is_none());
        });
    }

    #[test]
    fn chat_running_flag_roundtrips() {
        crate::testutil::with_home("ct-db-running", |_| {
            crate::db::init().unwrap();
            let c = crate::db::open().unwrap();
            c.execute(
                "INSERT INTO chat_sessions (id, agent_session_id, title) VALUES ('c1','a1','t')",
                [],
            )
            .unwrap();
            assert!(!chat_running("c1").unwrap());
            set_chat_running("c1", true).unwrap();
            assert!(chat_running("c1").unwrap());
            set_chat_running("c1", false).unwrap();
            assert!(!chat_running("c1").unwrap());
            crate::db::init().unwrap(); // idempotent ALTER
            assert!(!chat_running("c1").unwrap());
        });
    }
}
