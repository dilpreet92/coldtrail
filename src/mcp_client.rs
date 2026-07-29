//! Minimal MCP client over Streamable HTTP (JSON-RPC 2.0) so the in-Rust BYOK/Ollama
//! backends can call remote MCP servers (Canonical, Gmail) directly. Supports a plain
//! JSON body or an SSE `event: message / data: {…}` frame, and bearer-token auth.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

const PROTOCOL_VERSION: &str = "2025-06-18";

pub struct McpClient {
    url: String,
    token: Option<String>,
    session: Option<String>,
    http: reqwest::Client,
    id: std::sync::atomic::AtomicU64,
}

impl McpClient {
    /// Initialize a session against `url` (optionally bearer-authenticated).
    pub async fn connect(url: &str, token: Option<&str>) -> Result<McpClient> {
        let c = McpClient {
            url: url.to_string(),
            token: token.map(|t| t.to_string()),
            session: None,
            http: reqwest::Client::new(),
            id: std::sync::atomic::AtomicU64::new(1),
        };
        c.initialize().await
    }

    async fn initialize(mut self) -> Result<McpClient> {
        let params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "coldtrail", "version": env!("CARGO_PKG_VERSION")},
        });
        let (value, session) = self.post("initialize", params, true).await?;
        self.session = session;
        value
            .get("result")
            .ok_or_else(|| anyhow!("initialize: no result"))?;
        // best-effort initialized notification
        let _ = self
            .post("notifications/initialized", json!({}), false)
            .await;
        Ok(self)
    }

    pub async fn list_tools(&self) -> Result<Vec<Value>> {
        let (v, _) = self.post("tools/list", json!({}), true).await?;
        Ok(v["result"]["tools"].as_array().cloned().unwrap_or_default())
    }

    /// Call a tool; returns the JSON-RPC `result` object.
    pub async fn call_tool(&self, name: &str, args: Value) -> Result<Value> {
        let (v, _) = self
            .post("tools/call", json!({"name": name, "arguments": args}), true)
            .await?;
        if let Some(err) = v.get("error") {
            return Err(anyhow!("MCP error: {err}"));
        }
        Ok(v.get("result").cloned().unwrap_or(Value::Null))
    }

    /// POST a JSON-RPC message. Returns (parsed_response, session_id_from_headers).
    async fn post(
        &self,
        method: &str,
        params: Value,
        expect_reply: bool,
    ) -> Result<(Value, Option<String>)> {
        let rpc_id = self.id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut body = json!({"jsonrpc": "2.0", "method": method, "params": params});
        if expect_reply {
            body["id"] = json!(rpc_id);
        }
        let mut req = self
            .http
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", PROTOCOL_VERSION)
            .body(body.to_string());
        if let Some(t) = &self.token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        if let Some(s) = &self.session {
            req = req.header("mcp-session-id", s);
        }

        let resp = req
            .send()
            .await
            .map_err(|e| anyhow!("MCP request failed: {e}"))?;
        let status = resp.status();
        let session = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .or_else(|| self.session.clone());
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(anyhow!(
                "MCP {status}: {}",
                text.chars().take(300).collect::<String>()
            ));
        }
        if !expect_reply {
            return Ok((Value::Null, session));
        }
        let value = parse_response(&ct, &text)?;
        Ok((value, session))
    }
}

/// Parse an MCP HTTP reply: a JSON body, or the JSON in an SSE `data:` line.
fn parse_response(content_type: &str, text: &str) -> Result<Value> {
    if content_type.contains("text/event-stream") {
        for line in text.lines() {
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if !data.is_empty() {
                    return serde_json::from_str(data).map_err(|e| anyhow!("bad SSE JSON: {e}"));
                }
            }
        }
        Err(anyhow!("no data frame in SSE response"))
    } else {
        serde_json::from_str(text.trim()).map_err(|e| anyhow!("bad JSON response: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::post, Json, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn parse_json_and_sse() {
        let j = parse_response(
            "application/json",
            r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#,
        )
        .unwrap();
        assert_eq!(j["result"]["ok"], json!(true));
        let s = parse_response(
            "text/event-stream",
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n",
        )
        .unwrap();
        assert_eq!(s["result"]["ok"], json!(true));
    }

    #[tokio::test]
    async fn connect_and_call_tool() {
        // mock MCP server: initialize -> result; tools/call -> canned content
        let calls = Arc::new(AtomicUsize::new(0));
        let c2 = calls.clone();
        let app = Router::new().route(
            "/mcp",
            post(move |Json(body): Json<Value>| {
                let calls = c2.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    let method = body["method"].as_str().unwrap_or("");
                    let id = body.get("id").cloned().unwrap_or(json!(1));
                    let result = match method {
                        "initialize" => json!({"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"mock"}}),
                        "tools/call" => json!({"content":[{"type":"text","text":"[{\"domain\":\"acme.com\"}]"}]}),
                        _ => json!({}),
                    };
                    (
                        [("mcp-session-id", "sess-1")],
                        Json(json!({"jsonrpc":"2.0","id":id,"result":result})),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let client = McpClient::connect(&format!("http://{addr}/mcp"), Some("tok"))
            .await
            .unwrap();
        assert_eq!(client.session.as_deref(), Some("sess-1"));
        let res = client
            .call_tool("search_companies", json!({"query": "x"}))
            .await
            .unwrap();
        assert!(res["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("acme.com"));
    }
}
