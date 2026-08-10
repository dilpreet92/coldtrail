//! `coldtrail source "<angle>" ["<angle>" …]` — coldtrail OWNS discovery. It fetches a
//! shortlist from Canonical through coldtrail's own MCP client + OAuth (not the provider's
//! connector), then imports it deduped by domain.
//!
//! Multi-angle sourcing (the canonical-server "agent mode" idea, adapted): one plain-English
//! ICP rarely has a single best phrasing — acronyms, regions, and adjacent segments each need
//! their own query, and their UNION beats any single guess. The LLM here is the *agent* (it
//! plans the diverse angles and passes them in); coldtrail fans the searches out in parallel
//! and dedupes their union by domain on import, so extra angles are a recall upgrade, not
//! duplicated companies.

use anyhow::{anyhow, Result};
use serde_json::json;

const CANONICAL_MCP: &str = "https://trycanonical.ai/mcp";

/// One Canonical `search_companies` call. Returns the raw result JSON (the MCP text content, or
/// `structuredContent` as a fallback; `[]` if neither is present).
async fn fetch_one(query: &str, top_k: usize, token: &str) -> Result<String> {
    let client = crate::mcp_client::McpClient::connect(CANONICAL_MCP, Some(token)).await?;
    // Canonical's search_companies takes `description` (the semantic field) + `top_k`. Sending
    // `query`/`limit` (the obvious guess) is silently ignored → zero results.
    let args = json!({ "description": query, "top_k": top_k });
    let res = client.call_tool("search_companies", args).await?;
    Ok(res["content"][0]["text"]
        .as_str()
        .map(|s| s.to_string())
        .or_else(|| {
            let sc = &res["structuredContent"];
            (!sc.is_null()).then(|| sc.to_string())
        })
        .unwrap_or_else(|| "[]".into()))
}

/// Fan out one or more angles in parallel, then import each result set sequentially (SQLite is
/// single-writer, and sequential import lets domain-dedupe carry across angles — a company found
/// by two angles is added once, deduped the second time). Each company's `source_query` records
/// the angle that surfaced it. Returns (added, deduped, total_results).
pub async fn fetch_and_import_many(
    angles: &[String],
    limit: Option<usize>,
) -> Result<(u32, u32, usize)> {
    let token = crate::oauth::valid_access("canonical")
        .await
        .ok_or_else(|| anyhow!("Canonical isn't connected — connect it in Settings → Discovery"))?;
    let top_k = limit.unwrap_or(25);

    // Parallel fetch — each angle gets its own connection.
    let fetches = angles.iter().cloned().map(|a| {
        let token = token.clone();
        async move {
            let text = fetch_one(&a, top_k, &token).await;
            (a, text)
        }
    });
    let fetched: Vec<(String, Result<String>)> = futures::future::join_all(fetches).await;

    let verbose = angles.len() > 1;
    let (mut added, mut deduped, mut total) = (0u32, 0u32, 0usize);
    for (angle, text) in fetched {
        match text {
            Ok(t) => match crate::import::import_str(&t, &angle) {
                Ok((a, d, n)) => {
                    added += a;
                    deduped += d;
                    total += n;
                    if verbose {
                        println!("  · {angle:?}: {a} new, {d} deduped, from {n}");
                    }
                }
                Err(e) => eprintln!("  · {angle:?}: import failed: {e}"),
            },
            Err(e) => eprintln!("  · {angle:?}: search failed: {e}"),
        }
    }
    Ok((added, deduped, total))
}

/// CLI entry: `coldtrail source "<angle>" ["<angle>" …] [--limit N]`.
pub async fn run(queries: &[String], limit: Option<usize>) -> Result<()> {
    let (added, deduped, total) = fetch_and_import_many(queries, limit).await?;
    let angles = queries.len();
    println!(
        "sourced: {added} new, {deduped} already-known (deduped) from {total} results \
         across {angles} angle{}",
        if angles == 1 { "" } else { "s" }
    );
    Ok(())
}
