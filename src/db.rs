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
) -> Result<()> {
    let c = open()?;
    c.execute(
        "INSERT INTO scheduled_runs \
         (finished_at, status, sourced, enriched, drafted, sent, chat_id, note) \
         VALUES (datetime('now'), ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            status,
            (after.companies - before.companies).max(0),
            (after.contacts - before.contacts).max(0),
            (after.outreach - before.outreach).max(0),
            (after.sent_today - before.sent_today).max(0),
            chat_id,
            note,
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
}

#[allow(dead_code)]
pub fn last_run() -> Result<Option<RunRow>> {
    let c = open()?;
    let row = c
        .query_row(
            "SELECT started_at, status, sourced, enriched, drafted, sent, chat_id, note \
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
                })
            },
        )
        .optional()?;
    Ok(row)
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
            record_run("ok", before, after, Some("chat-1"), None).unwrap();
            let r = last_run().unwrap().unwrap();
            assert_eq!(r.status, "ok");
            assert_eq!(r.sourced, 5);
            assert_eq!(r.enriched, 3);
            assert_eq!(r.drafted, 3);
            assert_eq!(r.sent, 1);
            assert_eq!(r.chat_id.as_deref(), Some("chat-1"));
        });
    }
}
