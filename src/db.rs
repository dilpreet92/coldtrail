//! SQLite state. Dedupe key = company domain.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

pub const SCHEMA: &str = include_str!("../templates/schema.sql");

/// Open the workspace database with foreign keys enforced.
pub fn open() -> Result<Connection> {
    let c = Connection::open(crate::home::path("outreach.db")?)?;
    c.execute_batch("PRAGMA foreign_keys = ON;")?;
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
}
