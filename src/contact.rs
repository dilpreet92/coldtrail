//! Add a founder email discovered by hand (or via the agent's WebSearch) into the
//! pipeline, MX-verified, so manual finds flow through the same dedupe/draft path.
//! Rejects generic/placeholder locals.

use anyhow::Result;
use rusqlite::{params, OptionalExtension};

use crate::enrich::score;

pub async fn run(domain: &str, name: &str, email: &str, source: Option<&str>) -> Result<()> {
    let domain = domain.to_lowercase();
    let email = email.to_lowercase();
    let source = source.unwrap_or("websearch");

    let conf = match score(&email, Some(name)) {
        Some(c) => c,
        None => {
            eprintln!("REJECTED (generic/placeholder): {email}");
            std::process::exit(2);
        }
    };

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
    println!("added {email} [{conf}, {source}] mx_ok={ok} for {domain}");
    Ok(())
}
