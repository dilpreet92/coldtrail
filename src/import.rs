//! Import Canonical search results (JSON) into the companies table, deduped by
//! domain. Accepts a bare list, a `{"results": [...]}` object, or the persisted
//! MCP tool-result wrapper `[{"type":"text","text":"<json string>"}]`.

use anyhow::{Context, Result};
use serde_json::Value;

#[derive(Debug, PartialEq)]
pub struct Company {
    pub domain: String,
    pub name: Option<String>,
    pub hq: Option<String>,
    pub employees: Option<i64>,
    pub founding_year: Option<i64>,
}

fn as_i64(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn as_string(v: Option<&Value>) -> Option<String> {
    v.and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// Parse any of the three accepted shapes into a flat list of companies.
pub fn parse_results(raw: &str) -> Result<Vec<Company>> {
    let v: Value = serde_json::from_str(raw).context("results file is not valid JSON")?;
    parse_value(v)
}

fn parse_value(v: Value) -> Result<Vec<Company>> {
    // MCP tool-result wrapper: [{"type":"text","text":"<json string>"}]
    if let Value::Array(arr) = &v {
        if let Some(Value::Object(first)) = arr.first() {
            if let Some(Value::String(text)) = first.get("text") {
                return parse_results(text);
            }
        }
    }
    let items: Vec<Value> = match v {
        Value::Object(mut o) => match o.remove("results") {
            Some(Value::Array(a)) => a,
            _ => vec![],
        },
        Value::Array(a) => a,
        _ => vec![],
    };
    Ok(items
        .iter()
        .map(|r| Company {
            domain: as_string(r.get("domain")).unwrap_or_default(),
            name: as_string(r.get("name")),
            hq: as_string(r.get("headquarters")),
            employees: as_i64(r.get("employee_count")),
            founding_year: as_i64(r.get("founding_year")),
        })
        .collect())
}

/// Import from a raw JSON string. Returns (added, skipped, total). Shared by the CLI
/// and the agent `import_json` tool.
pub fn import_str(raw: &str, label: &str) -> Result<(u32, u32, usize)> {
    let results = parse_results(raw)?;
    crate::db::init()?;
    let conn = crate::db::open()?;
    let (mut added, mut skipped) = (0u32, 0u32);
    for r in &results {
        let domain = r.domain.trim().to_lowercase();
        if domain.is_empty() {
            continue;
        }
        let is_new = crate::db::upsert_company(
            &conn,
            &domain,
            r.name.as_deref(),
            r.hq.as_deref(),
            r.employees,
            r.founding_year,
            label,
        )?;
        if is_new {
            added += 1;
        } else {
            skipped += 1;
        }
    }
    Ok((added, skipped, results.len()))
}

pub fn run(json_path: &str, label: &str) -> Result<()> {
    let raw = std::fs::read_to_string(json_path).with_context(|| format!("read {json_path}"))?;
    let (added, skipped, total) = import_str(&raw, label)?;
    println!("imported: {added} new, {skipped} already-known (deduped) from {total} results");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bare_list() {
        let v = parse_results(r#"[{"domain":"acme.com","name":"Acme"}]"#).unwrap();
        assert_eq!(v[0].domain, "acme.com");
        assert_eq!(v[0].name.as_deref(), Some("Acme"));
    }

    #[test]
    fn parses_results_wrapper_with_fields() {
        let v = parse_results(
            r#"{"results":[{"domain":"acme.com","headquarters":"NYC","employee_count":42,"founding_year":2019}]}"#,
        )
        .unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].hq.as_deref(), Some("NYC"));
        assert_eq!(v[0].employees, Some(42));
        assert_eq!(v[0].founding_year, Some(2019));
    }

    #[test]
    fn parses_mcp_text_wrapper() {
        let inner = r#"{\"results\":[{\"domain\":\"acme.com\"}]}"#;
        let raw = format!(r#"[{{"type":"text","text":"{inner}"}}]"#);
        let v = parse_results(&raw).unwrap();
        assert_eq!(v[0].domain, "acme.com");
    }

    #[test]
    fn parses_real_canonical_search_envelope() {
        // The actual shape `search_companies` returns: {query,count,results:[…]} with extra
        // per-company fields (description, dimensions, verdict) we ignore.
        let raw = r#"{"query":"x","count":1,"credits_used":1,"results":[
            {"name":"Djinni.ai","domain":"djinni.ai","description":"…","headquarters":"Jersey City, NJ, US",
             "employee_count":1,"founding_year":2023,"funding":null,"dimensions":{},"verdict":"relevant"}
        ]}"#;
        let v = parse_results(raw).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].domain, "djinni.ai");
        assert_eq!(v[0].name.as_deref(), Some("Djinni.ai"));
        assert_eq!(v[0].hq.as_deref(), Some("Jersey City, NJ, US"));
        assert_eq!(v[0].employees, Some(1));
        assert_eq!(v[0].founding_year, Some(2023));
    }

    #[test]
    fn employee_count_as_string_is_coerced() {
        let v = parse_results(r#"[{"domain":"a.com","employee_count":"17"}]"#).unwrap();
        assert_eq!(v[0].employees, Some(17));
    }
}
