//! `coldtrail source "<query>"` — coldtrail OWNS discovery. It fetches a shortlist from
//! Canonical through coldtrail's own MCP client + OAuth (not the provider's connector), then
//! imports it deduped. Same on every backend; the agent just runs this command.

use anyhow::{anyhow, Result};
use serde_json::json;

const CANONICAL_MCP: &str = "https://trycanonical.ai/mcp";

/// Fetch from Canonical via `search_companies` and import (dedupe). The query is stored as
/// each company's `source_query`. Returns (added, deduped, total_results).
pub async fn fetch_and_import(query: &str, limit: Option<usize>) -> Result<(u32, u32, usize)> {
    let token = crate::oauth::valid_access("canonical")
        .await
        .ok_or_else(|| anyhow!("Canonical isn't connected — connect it in Settings → Discovery"))?;
    let client = crate::mcp_client::McpClient::connect(CANONICAL_MCP, Some(&token)).await?;
    // Canonical's search_companies takes `description` (the semantic field) + `top_k`. Sending
    // `query`/`limit` (the obvious guess) is silently ignored → zero results for every search.
    let args = json!({ "description": query, "top_k": limit.unwrap_or(25) });
    let res = client.call_tool("search_companies", args).await?;
    // The payload is the MCP text content (a JSON string); fall back to structuredContent.
    let text = res["content"][0]["text"]
        .as_str()
        .map(|s| s.to_string())
        .or_else(|| {
            let sc = &res["structuredContent"];
            (!sc.is_null()).then(|| sc.to_string())
        })
        .unwrap_or_else(|| "[]".into());
    crate::import::import_str(&text, query)
}

/// CLI entry: `coldtrail source "<query>" [--limit N]`.
pub async fn run(query: &str, limit: Option<usize>) -> Result<()> {
    let (added, deduped, total) = fetch_and_import(query, limit).await?;
    println!(
        "sourced: {added} new, {deduped} already-known (deduped) from {total} results (query: {query:?})"
    );
    Ok(())
}
