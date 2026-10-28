//! Shared provider auth probe: run a tiny turn in a CLEAN temp dir (no CLAUDE.md/.mcp.json) so it
//! tests pure sign-in, not MCP init. Used by onboarding ("Test connection") and scheduled runs.
use crate::provider::cli::Tools;
use crate::provider::{run_turn, AgentEvent, Backend};
use regex::Regex;
use std::sync::OnceLock;

pub enum Outcome {
    Ok,
    Failed(String),
    TimedOut,
}

/// Does a failed probe's message look like a sign-in problem (expired login, bad or missing API
/// key, HTTP 401/403) rather than anything else the provider can fail with (a deprecated
/// model, a server error)? Scheduled runs record only these as `auth_failed`. Extends the
/// expired-login check `provider::cli` rewrites into its re-login hint, whose own wording
/// ("sign in again", "auth login") matches too.
pub fn looks_like_auth(msg: &str) -> bool {
    static WORDS: OnceLock<Regex> = OnceLock::new();
    static CODES: OnceLock<Regex> = OnceLock::new();
    let words = WORDS.get_or_init(|| {
        Regex::new(
            r"(?i)\b(?:unauthori[sz]ed|unauthenticated|authenticat|not\s+(?:logged|signed)\s+in|log[\s-]?in\b|sign[\s-]?in\b|forbidden|api[\s_-]*key)",
        )
        .expect("auth words regex")
    });
    // A bare 401/403 status, not part of a longer number, version or name ("gpt-4013", "401.5s").
    let codes = CODES.get_or_init(|| {
        Regex::new(r"(?:^|[^\w.\-])(?:401|403)(?:$|[^\w.\-])").expect("auth codes regex")
    });
    crate::provider::cli::is_expired_login(msg) || words.is_match(msg) || codes.is_match(msg)
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

    #[test]
    fn auth_failures_are_told_apart_from_other_errors() {
        for m in [
            // what auth_hint turns an expired CLI login into
            "opencode needs to sign in again — its login expired. In a terminal run \
             `opencode auth login` and complete sign-in, then re-check in Settings and resend.",
            "model returned 401 Unauthorized: {\"error\":\"bad token\"}",
            "model returned 403 Forbidden: ",
            r#"{"name":"APIError","data":{"message":"nope","statusCode":401}}"#,
            r#"{"status":403,"message":"denied"}"#,
            "HTTP 401",
            "Not logged in · Please run /login",
            "Invalid API key · Fix external API key",
            "Incorrect API key provided: sk-…",
            "authentication_error: OAuth access token has expired",
            "Authentication failed for provider anthropic",
            "unauthorized",
        ] {
            assert!(looks_like_auth(m), "{m}");
        }
        for m in [
            "Model muse-spark-1.3-contributor-free has been deprecated.",
            "Unexpected server error. Check server logs for details.",
            "model returned 500 Internal Server Error: boom",
            "could not reach the model at http://localhost:11434/v1/chat/completions: refused",
            "the provider didn't respond — check the log",
            "model gpt-4013 is overloaded (code 4031)",
            "rate limited: retry after 401.5s",
        ] {
            assert!(!looks_like_auth(m), "{m}");
        }
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
