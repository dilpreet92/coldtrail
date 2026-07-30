//! The local tools the BYOK/Ollama agent loop can call — thin wrappers over coldtrail's
//! existing operations. No Gmail here (sending stays a human step). Results are short
//! strings fed back to the model.

use serde_json::{json, Value};

fn s(args: &Value, k: &str) -> String {
    args.get(k)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// OpenAI-style function-tool definitions. When Canonical (discovery) is connected, a
/// native `discover_companies` tool is offered; otherwise sourcing is via `import_json`.
pub fn defs(canonical_connected: bool) -> Value {
    let mut v = vec![
        json!({"type":"function","function":{
            "name":"import_json",
            "description":"Import Canonical search results (a JSON string) into the pipeline, deduped by domain.",
            "parameters":{"type":"object","properties":{
                "results_json":{"type":"string","description":"Canonical results as a JSON string"},
                "label":{"type":"string","description":"short ICP label"}},
                "required":["results_json","label"]}}}),
        json!({"type":"function","function":{
            "name":"add_contact",
            "description":"Add an MX-verified founder contact. Generic/placeholder addresses are rejected.",
            "parameters":{"type":"object","properties":{
                "domain":{"type":"string"},"name":{"type":"string"},"email":{"type":"string"},
                "source":{"type":"string"}},"required":["domain","name","email"]}}}),
        json!({"type":"function","function":{
            "name":"find_emails",
            "description":"Best-effort OSINT founder-email finder for known companies lacking a verified email.",
            "parameters":{"type":"object","properties":{"max":{"type":"integer"}}}}}),
        json!({"type":"function","function":{
            "name":"draft",
            "description":"Store a PERSONALIZED outreach draft (subject + body you composed) for a company. Never sends.",
            "parameters":{"type":"object","properties":{
                "domain":{"type":"string"},"subject":{"type":"string"},"body":{"type":"string"}},
                "required":["domain","subject","body"]}}}),
        json!({"type":"function","function":{
            "name":"followup",
            "description":"Store a follow-up touch (a new email) for an already-contacted company that didn't reply. Never sends.",
            "parameters":{"type":"object","properties":{
                "domain":{"type":"string"},"subject":{"type":"string"},"body":{"type":"string"}},
                "required":["domain","subject","body"]}}}),
        json!({"type":"function","function":{
            "name":"mark",
            "description":"Advance a company's status: a gmail draft id, or 'sent' / 'bounced'.",
            "parameters":{"type":"object","properties":{
                "domain":{"type":"string"},"value":{"type":"string"}},"required":["domain","value"]}}}),
        json!({"type":"function","function":{
            "name":"list_companies","description":"List companies with their status.",
            "parameters":{"type":"object","properties":{}}}}),
        json!({"type":"function","function":{
            "name":"list_drafts","description":"List prepared drafts (domain, subject, status).",
            "parameters":{"type":"object","properties":{}}}}),
    ];
    if canonical_connected {
        v.push(json!({"type":"function","function":{
            "name":"discover_companies",
            "description":"Discover verified companies from Canonical for a plain-English ICP, imported (deduped) into the pipeline.",
            "parameters":{"type":"object","properties":{
                "query":{"type":"string","description":"plain-English ICP"},
                "label":{"type":"string","description":"short label"}},
                "required":["query"]}}}));
    }
    Value::Array(v)
}

/// Execute a tool call; returns a short result string (errors are returned, never panic).
pub async fn exec(name: &str, args: &Value) -> String {
    match name {
        "import_json" => {
            match crate::import::import_str(&s(args, "results_json"), &s(args, "label")) {
                Ok((a, sk, t)) => {
                    format!("imported {a} new, {sk} already-known (deduped), from {t} results")
                }
                Err(e) => format!("error: {e}"),
            }
        }
        "add_contact" => {
            let src = args.get("source").and_then(|v| v.as_str());
            match crate::contact::add(&s(args, "domain"), &s(args, "name"), &s(args, "email"), src)
                .await
            {
                Ok(m) => m,
                Err(e) => format!("error: {e}"),
            }
        }
        "find_emails" => {
            let max = args.get("max").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
            match crate::find::run(max).await {
                Ok(_) => "finder ran — call list_companies to see verified contacts".to_string(),
                Err(e) => format!("error: {e}"),
            }
        }
        "draft" => {
            match crate::draft::add(&s(args, "domain"), &s(args, "subject"), &s(args, "body")) {
                Ok(_) => format!("drafted {}", s(args, "domain")),
                Err(e) => format!("error: {e}"),
            }
        }
        "followup" => {
            match crate::draft::followup_add(
                &s(args, "domain"),
                &s(args, "subject"),
                &s(args, "body"),
            ) {
                Ok(_) => format!("follow-up drafted for {}", s(args, "domain")),
                Err(e) => format!("error: {e}"),
            }
        }
        "mark" => match crate::mark::run(&s(args, "domain"), &s(args, "value")) {
            Ok(_) => format!("{}: {}", s(args, "domain"), s(args, "value")),
            Err(e) => format!("error: {e}"),
        },
        "list_companies" => query(
            "SELECT domain, COALESCE(name,''), status FROM companies ORDER BY first_seen DESC",
        ),
        "list_drafts" => query(
            "SELECT domain, COALESCE(subject,''), status FROM outreach ORDER BY created_at DESC",
        ),
        "discover_companies" => discover(args).await,
        other => format!("error: unknown tool '{other}'"),
    }
}

/// Source companies from Canonical (coldtrail's own connection), then import (dedupe).
/// Shares one implementation with the `coldtrail source` CLI command.
async fn discover(args: &Value) -> String {
    let query = s(args, "query");
    match crate::source::fetch_and_import(&query, None).await {
        Ok((a, sk, t)) => format!("discovered + imported {a} new, {sk} deduped, from {t}"),
        Err(e) => format!("error: {e}"),
    }
}

fn query(sql: &str) -> String {
    let conn = match crate::db::open() {
        Ok(c) => c,
        Err(e) => return format!("error: {e}"),
    };
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(e) => return format!("error: {e}"),
    };
    let rows = stmt.query_map([], |r| {
        Ok(json!([
            r.get::<_, String>(0).unwrap_or_default(),
            r.get::<_, String>(1).unwrap_or_default(),
            r.get::<_, String>(2).unwrap_or_default()
        ]))
    });
    match rows {
        Ok(it) => {
            let v: Vec<Value> = it.filter_map(|r| r.ok()).collect();
            serde_json::to_string(&v).unwrap_or_else(|_| "[]".into())
        }
        Err(e) => format!("error: {e}"),
    }
}
