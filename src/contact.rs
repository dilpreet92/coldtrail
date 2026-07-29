//! Add a founder email (from the agent, WebSearch, or by hand) into the pipeline,
//! MX-verified. Rejects generic/placeholder locals.

use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};

use crate::enrich::score;

/// Core add — returns a summary on success, or `Err` if the address is rejected.
/// Never exits the process (safe to call from the agent tool loop).
pub async fn add(domain: &str, name: &str, email: &str, source: Option<&str>) -> Result<String> {
    let domain = domain.to_lowercase();
    let email = email.to_lowercase();
    let source = source.unwrap_or("websearch");

    let conf = score(&email, Some(name))
        .ok_or_else(|| anyhow!("REJECTED (generic/placeholder): {email}"))?;

    let email_host = email.split('@').nth(1).unwrap_or("");
    let ok = crate::find::mx_ok(email_host).await;

    crate::db::init()?;
    let conn = crate::db::open()?;
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM companies WHERE domain = ?1",
            [&domain],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_none() {
        conn.execute(
            "INSERT INTO companies (domain, source_query) VALUES (?1, 'manual')",
            [&domain],
        )?;
    }
    conn.execute(
        "INSERT OR IGNORE INTO contacts \
         (domain, founder_name, email, email_source, email_confidence, mx_ok) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![domain, name, email, source, conf, if ok { 1 } else { 0 }],
    )?;
    crate::db::set_status(&conn, &domain, if ok { "emailed" } else { "named" })?;
    Ok(format!(
        "added {email} [{conf}, {source}] mx_ok={ok} for {domain}"
    ))
}

/// CLI entry point: prints the result, exits non-zero on rejection.
pub async fn run(domain: &str, name: &str, email: &str, source: Option<&str>) -> Result<()> {
    match add(domain, name, email, source).await {
        Ok(msg) => {
            println!("{msg}");
            Ok(())
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    }
}
