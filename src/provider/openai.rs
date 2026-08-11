//! BYOK / local-LLM backend: an in-Rust tool-calling agent loop against any
//! OpenAI-compatible `/chat/completions` endpoint (Ollama, OpenRouter, OpenAI, …).
//! Non-streaming LLM calls; we stream *step* events (text + tool chips) to the browser.

use serde_json::{json, Value};
use std::path::Path;
use tokio::sync::mpsc::Sender;

use super::{tools, AgentEvent};

const MAX_ITERS: usize = 12;

pub async fn run_turn(
    base_url: &str,
    model: &str,
    api_key: Option<&str>,
    user_msg: &str,
    home: &Path,
    tx: Sender<AgentEvent>,
) -> bool {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let tool_defs = tools::defs(crate::secrets::has_token("canonical"));

    let mut messages = vec![
        json!({"role": "system", "content": system_prompt(home)}),
        json!({"role": "user", "content": user_msg}),
    ];

    for _ in 0..MAX_ITERS {
        let body = json!({
            "model": model, "messages": messages,
            "tools": tool_defs, "tool_choice": "auto", "stream": false,
        });
        let mut req = client
            .post(&url)
            .header("content-type", "application/json")
            .body(body.to_string());
        if let Some(k) = api_key {
            req = req.header("authorization", format!("Bearer {k}"));
        }

        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => return fail(&tx, format!("could not reach the model at {url}: {e}")).await,
        };
        if !resp.status().is_success() {
            let code = resp.status();
            let t = resp.text().await.unwrap_or_default();
            return fail(
                &tx,
                format!(
                    "model returned {code}: {}",
                    t.chars().take(300).collect::<String>()
                ),
            )
            .await;
        }
        let text = match resp.text().await {
            Ok(t) => t,
            Err(e) => return fail(&tx, format!("failed reading model response: {e}")).await,
        };
        let v: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => return fail(&tx, format!("model response was not valid JSON: {e}")).await,
        };

        let choice = v["choices"]
            .get(0)
            .map(|c| c["message"].clone())
            .unwrap_or(Value::Null);
        let tool_calls = choice
            .get("tool_calls")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();

        if !tool_calls.is_empty() {
            messages.push(choice.clone()); // assistant turn that requested the calls
            for tc in &tool_calls {
                let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
                let args: Value =
                    serde_json::from_str(tc["function"]["arguments"].as_str().unwrap_or("{}"))
                        .unwrap_or(json!({}));
                let _ = tx
                    .send(AgentEvent::ToolStart {
                        name: name.clone(),
                        input: args.clone(),
                    })
                    .await;
                let result = tools::exec(&name, &args).await;
                let ok = !result.starts_with("error:") && !result.starts_with("REJECTED");
                let _ = tx.send(AgentEvent::ToolEnd { ok }).await;
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": tc.get("id").cloned().unwrap_or(json!("")),
                    "content": result,
                }));
            }
            continue;
        }

        if let Some(content) = choice.get("content").and_then(|c| c.as_str()) {
            if !content.is_empty() {
                let _ = tx
                    .send(AgentEvent::Text {
                        text: content.to_string(),
                    })
                    .await;
            }
        }
        let _ = tx
            .send(AgentEvent::Done {
                ok: true,
                result: None,
            })
            .await;
        return true;
    }

    fail(&tx, "reached the step limit for this turn".to_string()).await
}

async fn fail(tx: &Sender<AgentEvent>, msg: String) -> bool {
    let _ = tx.send(AgentEvent::Error { message: msg }).await;
    let _ = tx
        .send(AgentEvent::Done {
            ok: false,
            result: None,
        })
        .await;
    false
}

fn system_prompt(home: &Path) -> String {
    let brief = std::fs::read_to_string(home.join("product.md"))
        .or_else(|_| std::fs::read_to_string(home.join("message.toml")))
        .unwrap_or_default();
    format!(
        "You are coldtrail's outreach agent: discovery-first, deduped cold outreach. Drive the \
         loop with the provided tools; never invent data.\n\n\
         Loop: (1) Source — if `discover_companies` is available, plan 3–5 DIVERSE angles \
         (expand acronyms/regions into distinct phrasings; keep them genuinely different; never \
         negate) and pass them as `queries` in ONE call — parallel-searched, union deduped by \
         domain. Otherwise the user provides Canonical results; import them with `import_json`. \
         (2) Enrich — get a founder contact per company via `add_contact` (or `find_emails`); \
         follow the enrichment methodology below, applying what your tools allow. \
         (3) Compose a PERSONALIZED pitch per company — use the brief below for voice, offer, and \
         link, but write a genuinely tailored subject + body for each company; then store it with \
         `draft`. Use `list_companies` / `list_drafts` to see current state. \
         (4) Hand off — run the WHOLE loop by default (source → enrich → draft a warmup-sized \
         batch of ~5), report the contacts you found and the drafts, then offer to send. \
         SENDING: only via `send_outreach`, and only after the human says yes in chat. It refuses \
         unless the human enabled auto-send — if it refuses, tell them to review and send from the \
         Drafts tab.\n\n\
         Hard rules: never send without `send_outreach` + the human's yes; never touch mail APIs \
         directly. Founder-addressed only; no generic/placeholder addresses. No fabrication. Keep \
         drafts short and human. Pace to ~5/day.\n\n\
         --- enrichment methodology (enrichment.md) ---\n{playbook}\n\n\
         --- product brief ---\n{brief}",
        playbook = crate::setup::ENRICHMENT_MD,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::post, Json, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::sync::mpsc;

    async fn drain(mut rx: mpsc::Receiver<AgentEvent>) -> Vec<AgentEvent> {
        let mut v = Vec::new();
        while let Some(e) = rx.recv().await {
            v.push(e);
        }
        v
    }

    #[test]
    fn system_prompt_prefers_product_md() {
        let tmp = std::env::temp_dir().join("ct-openai-brief-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("message.toml"), "subject='x'").unwrap();
        std::fs::write(
            tmp.join("product.md"),
            "# Acme — outreach brief\nrich context",
        )
        .unwrap();
        let p = super::system_prompt(&tmp);
        assert!(p.contains("rich context"), "uses product.md when present");
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn loop_runs_tool_then_finishes() {
        let _g = crate::testutil::env_guard();
        let home = std::env::temp_dir().join("ct-openai-test");
        let _ = std::fs::remove_dir_all(&home);
        std::env::set_var("COLDTRAIL_HOME", &home);
        crate::db::init().unwrap();

        // mock OpenAI-compatible server: first call -> a tool_call, second -> content+stop
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = n.clone();
        let app = Router::new().route(
            "/chat/completions",
            post(move |_b: String| {
                let n = n2.clone();
                async move {
                    let i = n.fetch_add(1, Ordering::SeqCst);
                    if i == 0 {
                        Json(json!({"choices":[{"message":{"role":"assistant","content":null,
                            "tool_calls":[{"id":"c1","type":"function",
                            "function":{"name":"list_companies","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}))
                    } else {
                        Json(json!({"choices":[{"message":{"role":"assistant","content":"All set."},
                            "finish_reason":"stop"}]}))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let (tx, rx) = mpsc::channel(32);
        let base = format!("http://{addr}");
        let ok = run_turn(&base, "test-model", None, "find companies", &home, tx).await;
        let events = drain(rx).await;

        std::env::remove_var("COLDTRAIL_HOME");
        assert!(ok, "turn should succeed; events={events:?}");
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolStart { name, .. } if name == "list_companies")));
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolEnd { ok: true })));
        assert!(events
            .iter()
            .any(|e| matches!(e, AgentEvent::Text { text } if text.contains("All set"))));
        assert!(matches!(
            events.last(),
            Some(AgentEvent::Done { ok: true, .. })
        ));
    }

    #[tokio::test]
    async fn http_error_emits_terminal_done() {
        let app = Router::new().route(
            "/chat/completions",
            post(|_b: String| async { (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "boom") }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let (tx, rx) = mpsc::channel(32);
        let base = format!("http://{addr}");
        let ok = run_turn(&base, "m", None, "hi", std::path::Path::new("/tmp"), tx).await;
        let events = drain(rx).await;
        assert!(!ok);
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Error { .. })));
        assert!(matches!(
            events.last(),
            Some(AgentEvent::Done { ok: false, .. })
        ));
    }
}
