//! Add a founder contact (from the agent, WebSearch, or by hand) into the pipeline: an
//! email, a LinkedIn URL, or both — at least one is required. An email is MX-verified and
//! rejects generic/placeholder locals; a LinkedIn-only contact is not MX-verified (there's
//! no email to verify) but still makes the company reachable.

use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};

use crate::enrich::score;

/// Core add — returns a summary on success, or `Err` if the contact is rejected (no
/// usable email or LinkedIn URL, or an unscoreable/non-profile value was supplied).
/// Never exits the process (safe to call from the agent tool loop).
pub async fn add(
    domain: &str,
    name: &str,
    email: Option<&str>,
    linkedin: Option<&str>,
    source: Option<&str>,
) -> Result<String> {
    let domain = domain.to_lowercase();
    let source = source.unwrap_or("websearch");

    let li_url = match linkedin {
        Some(raw) => Some(
            crate::linkedin::url::normalize(raw)
                .ok_or_else(|| anyhow!("REJECTED (not a LinkedIn /in/ profile URL): {raw}"))?,
        ),
        None => None,
    };

    // Score/verify the email only when one is supplied.
    let scored = match email {
        Some(e) => {
            let e = e.to_lowercase();
            let conf = score(&e, Some(name))
                .ok_or_else(|| anyhow!("REJECTED (generic/placeholder): {e}"))?;
            let host = e.split('@').nth(1).unwrap_or("").to_string();
            let ok = crate::find::mx_ok(&host).await;
            Some((e, conf, ok))
        }
        None => None,
    };

    if scored.is_none() && li_url.is_none() {
        return Err(anyhow!(
            "need an email or a LinkedIn URL to record a contact for {domain}"
        ));
    }

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

    match &scored {
        Some((e, conf, ok)) => {
            conn.execute(
                "INSERT INTO contacts (domain, founder_name, linkedin_url, email, email_source, email_confidence, mx_ok) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
                 ON CONFLICT(domain, email) DO UPDATE SET \
                   founder_name=COALESCE(excluded.founder_name, founder_name), \
                   linkedin_url=COALESCE(excluded.linkedin_url, linkedin_url)",
                params![domain, name, li_url, e, source, conf, if *ok { 1 } else { 0 }],
            )?;
            crate::db::set_status(&conn, &domain, if *ok { "emailed" } else { "named" })?;
            Ok(format!(
                "added {e} [{conf}, {source}] mx_ok={ok}{} for {domain}",
                li_url
                    .as_ref()
                    .map(|u| format!(" +li {u}"))
                    .unwrap_or_default()
            ))
        }
        None => {
            // LinkedIn-only contact. email column stays NULL (UNIQUE(domain,email) allows
            // multiple NULL-email rows in SQLite, so guard against duplicating the same URL).
            let dup: Option<i64> = conn
                .query_row(
                    "SELECT id FROM contacts WHERE domain=?1 AND linkedin_url=?2",
                    params![domain, li_url],
                    |r| r.get(0),
                )
                .optional()?;
            if dup.is_none() {
                conn.execute(
                    "INSERT INTO contacts (domain, founder_name, linkedin_url, email_source) \
                     VALUES (?1, ?2, ?3, ?4)",
                    params![domain, name, li_url, source],
                )?;
            }
            crate::db::set_status(&conn, &domain, "named")?;
            let url = li_url.unwrap();
            Ok(format!(
                "added LinkedIn contact {url} [{source}] for {domain}"
            ))
        }
    }
}

/// CLI entry point: prints the result, exits non-zero on rejection.
pub async fn run(
    domain: &str,
    name: &str,
    email: Option<&str>,
    linkedin: Option<&str>,
    source: Option<&str>,
) -> Result<()> {
    match add(domain, name, email, linkedin, source).await {
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

#[cfg(test)]
mod tests {
    use super::*;

    // `with_home` is sync-only; async tests hold `env_guard` and set `COLDTRAIL_HOME`
    // manually, mirroring `src/scheduled.rs::run_records_a_run_and_a_chat`.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn records_linkedin_only_contact() {
        let _g = crate::testutil::env_guard();
        let home = std::env::temp_dir().join("ct-contact-li");
        let _ = std::fs::remove_dir_all(&home);
        std::env::set_var("COLDTRAIL_HOME", &home);

        crate::db::init().unwrap();
        let msg = add(
            "acme.com",
            "Jane Doe",
            None,
            Some("linkedin.com/in/janedoe/"),
            Some("canonical"),
        )
        .await
        .unwrap();
        assert!(msg.contains("janedoe"), "got: {msg}");
        let c = crate::db::open().unwrap();
        let url: String = c
            .query_row(
                "SELECT linkedin_url FROM contacts WHERE domain='acme.com'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(url, "https://www.linkedin.com/in/janedoe");

        std::env::remove_var("COLDTRAIL_HOME");
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn rejects_when_neither_email_nor_linkedin() {
        let _g = crate::testutil::env_guard();
        let home = std::env::temp_dir().join("ct-contact-none");
        let _ = std::fs::remove_dir_all(&home);
        std::env::set_var("COLDTRAIL_HOME", &home);

        crate::db::init().unwrap();
        let err = add("acme.com", "Jane", None, None, None)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("email or a LinkedIn"), "got: {err}");

        std::env::remove_var("COLDTRAIL_HOME");
    }
}
