//! Shared provider auth probe: run a tiny turn in a CLEAN temp dir (no CLAUDE.md/.mcp.json) so it
//! tests pure sign-in, not MCP init. Used by onboarding ("Test connection") and scheduled runs.
use crate::provider::cli::Tools;
use crate::provider::{run_turn, AgentEvent, Backend};

pub enum Outcome {
    Ok,
    Failed(String),
    TimedOut,
}

pub async fn probe(backend: &Backend) -> Outcome {
    // Run in a CLEAN temp dir — no CLAUDE.md/.mcp.json — so the CLI starts fast and this tests
    // pure auth, not MCP init (which is what made the probe time out in the real workspace).
    let home = std::env::temp_dir().join(format!("coldtrail-probe-{}", uuid::Uuid::new_v4()));
    let _ = std::fs::create_dir_all(&home);
    let sid = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<AgentEvent>(256);
    let tools = Tools::Disallow(&["Bash", "mcp__gmail", "mcp__canonical"]);
    let turn = run_turn(
        backend,
        &sid,
        true,
        "Reply with exactly: ok",
        &home,
        &tools,
        tx,
    );
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(60), turn).await;
    let _ = std::fs::remove_dir_all(&home);

    let mut err = None;
    while let Ok(ev) = rx.try_recv() {
        if let AgentEvent::Error { message } = ev {
            err = Some(message);
        }
    }
    match outcome {
        Ok(true) => Outcome::Ok,
        Ok(false) => Outcome::Failed(
            err.unwrap_or_else(|| "the provider didn't respond — check the log".into()),
        ),
        Err(_) => Outcome::TimedOut,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::Backend;
    use axum::response::IntoResponse;
    use axum::{routing::post, Json, Router};
    use serde_json::json;

    async fn mock(reply_ok: bool) -> String {
        let app = Router::new().route(
            "/chat/completions",
            post(move |_b: String| async move {
                if reply_ok {
                    Json(json!({"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}))
                        .into_response()
                } else {
                    (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "boom").into_response()
                }
            }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn probe_ok_on_reply() {
        let base = mock(true).await;
        let b = Backend::OpenAi {
            base_url: base,
            model: "m".into(),
            api_key: None,
        };
        assert!(matches!(probe(&b).await, Outcome::Ok));
    }

    #[tokio::test]
    async fn probe_failed_on_error() {
        let base = mock(false).await;
        let b = Backend::OpenAi {
            base_url: base,
            model: "m".into(),
            api_key: None,
        };
        assert!(matches!(probe(&b).await, Outcome::Failed(_)));
    }
}
