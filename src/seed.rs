//! Load already-contacted domains from `contacted.toml` into the DB so the
//! pipeline never re-surfaces or re-contacts them. Idempotent.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
struct Entry {
    name: Option<String>,
    status: String,
}

/// Parse contacted.toml into (domain, name, status) triples, sorted by domain.
pub fn parse(raw: &str) -> Result<Vec<(String, String, String)>> {
    let map: BTreeMap<String, Entry> =
        toml::from_str(raw).context("contacted.toml is not valid TOML")?;
    Ok(map
        .into_iter()
        .map(|(domain, e)| (domain, e.name.unwrap_or_default(), e.status))
        .collect())
}

pub fn run() -> Result<()> {
    let p = crate::home::path("contacted.toml")?;
    let raw = std::fs::read_to_string(&p).with_context(|| {
        format!(
            "no contacted.toml at {} — run `coldtrail setup` first",
            p.display()
        )
    })?;
    let entries = parse(&raw)?;

    crate::db::init()?;
    let conn = crate::db::open()?;
    let mut n = 0u32;
    for (domain, name, status) in entries {
        let domain = domain.trim().to_lowercase();
        if domain.is_empty() {
            continue;
        }
        let name_opt = if name.is_empty() {
            None
        } else {
            Some(name.as_str())
        };
        if crate::db::upsert_company(
            &conn,
            &domain,
            name_opt,
            None,
            None,
            None,
            "seed:already-contacted",
        )? {
            crate::db::set_status(&conn, &domain, &status)?;
            n += 1;
        }
    }
    println!("seeded {n} already-contacted companies (dedupe guard)");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_contacted_toml() {
        let raw = r#"
"a.com" = { name = "A", status = "sent" }
"b.io" = { name = "B", status = "skip" }
"#;
        let v = parse(raw).unwrap();
        assert_eq!(v[0], ("a.com".into(), "A".into(), "sent".into()));
        assert_eq!(v[1], ("b.io".into(), "B".into(), "skip".into()));
    }

    #[test]
    fn embedded_contacted_parses() {
        assert!(parse(crate::setup::CONTACTED_TOML).is_ok());
    }
}
