//! Local web server: router, shared state, loopback session-token guard, and the
//! embedded single-page UI.

pub mod api;
pub mod chat;
pub mod onboarding;
pub mod pipeline;
pub mod send;

use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Router,
};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

use crate::provider::AgentEvent;

#[derive(rust_embed::RustEmbed)]
#[folder = "ui/"]
struct Assets;

/// Wraps any error into a 500 JSON-ish response for handlers.
pub struct ApiErr(pub anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for ApiErr {
    fn from(e: E) -> Self {
        ApiErr(e.into())
    }
}

impl IntoResponse for ApiErr {
    fn into_response(self) -> Response {
        (StatusCode::INTERNAL_SERVER_ERROR, self.0.to_string()).into_response()
    }
}

/// One agent conversation. `created` flips true only after a turn actually seeds
/// the session, so a failed first turn doesn't poison later `--resume`s.
#[derive(Default)]
pub struct ChatSession {
    pub id: Option<String>,
    pub created: bool,
}

/// Server-wide state. Single local user, so one agent session at a time.
pub struct AppState {
    pub token: String,
    pub port: u16,
    pub runs: Mutex<HashMap<String, mpsc::Receiver<AgentEvent>>>,
    pub chat: Mutex<ChatSession>,
    /// Held for the duration of an agent turn so turns never overlap.
    pub turn_lock: Mutex<()>,
}

fn loopback_hosts(port: u16) -> [String; 2] {
    [format!("127.0.0.1:{port}"), format!("localhost:{port}")]
}
fn loopback_origins(port: u16) -> [String; 2] {
    [
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
    ]
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/assets/*path", get(asset))
        .route("/api/status", get(onboarding::status))
        .route("/api/onboarding/files", get(onboarding::files))
        .route("/api/onboarding/provider", post(onboarding::set_provider))
        .route("/api/onboarding/mcp", post(onboarding::set_mcp))
        .route("/api/onboarding/message", post(onboarding::set_message))
        .route("/api/onboarding/contacted", post(onboarding::set_contacted))
        .route(
            "/api/discovery/canonical/connect",
            post(onboarding::connect_discovery),
        )
        .route(
            "/api/destination/gmail/connect",
            post(onboarding::connect_destination),
        )
        .route("/api/companies", get(pipeline::companies))
        .route("/api/contacts", get(pipeline::contacts))
        .route("/api/drafts", get(pipeline::drafts))
        .route("/api/overview", get(pipeline::overview))
        .route("/api/chat", post(chat::start))
        .route("/api/chat/stream", get(chat::stream))
        .route("/api/drafts/:domain", post(pipeline::save_draft))
        .route("/api/drafts/:domain/send", post(send::send))
        .layer(middleware::from_fn_with_state(state.clone(), auth))
        .with_state(state)
}

/// Read the session token from the `ct_token` cookie or a `?t=` query param.
fn token_from(headers: &HeaderMap, uri_query: Option<&str>) -> Option<String> {
    if let Some(cookie) = headers.get(header::COOKIE).and_then(|c| c.to_str().ok()) {
        for part in cookie.split(';') {
            let part = part.trim();
            if let Some(v) = part.strip_prefix("ct_token=") {
                return Some(v.to_string());
            }
        }
    }
    if let Some(q) = uri_query {
        for pair in q.split('&') {
            if let Some(v) = pair.strip_prefix("t=") {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Loopback is assumed; still require the boot token on every `/api` request so a
/// stray browser tab or other local process can't drive the agent.
async fn auth(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if path.starts_with("/api") {
        let h = req.headers();
        // Anti-DNS-rebinding: a present Host header must be our loopback addr.
        let hosts = loopback_hosts(state.port);
        let host_ok = match h.get(header::HOST).and_then(|v| v.to_str().ok()) {
            Some(host) => hosts.iter().any(|a| a == host),
            None => true,
        };
        // Anti-CSRF: a present Origin must be our own (SameSite doesn't isolate by
        // port, so a co-resident 127.0.0.1:<other> page must still be rejected).
        let origins = loopback_origins(state.port);
        let origin_ok = match h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
            Some(o) => origins.iter().any(|a| a == o),
            None => true,
        };
        let q = req.uri().query().map(|s| s.to_string());
        let token_ok = token_from(h, q.as_deref()).as_deref() == Some(state.token.as_str());
        if !(host_ok && origin_ok && token_ok) {
            return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
        }
    }
    next.run(req).await
}

async fn index() -> Html<String> {
    let html = Assets::get("index.html")
        .map(|f| String::from_utf8_lossy(&f.data).into_owned())
        .unwrap_or_else(|| "<h1>coldtrail</h1><p>UI asset missing</p>".to_string());
    Html(html)
}

async fn asset(axum::extract::Path(path): axum::extract::Path<String>) -> Response {
    match Assets::get(&path) {
        Some(file) => {
            let mime = mime_for(&path);
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, mime)],
                Body::from(file.data.into_owned()),
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    fn state() -> Arc<AppState> {
        Arc::new(AppState {
            token: "secret-tok".into(),
            port: 8787,
            runs: Mutex::new(HashMap::new()),
            chat: Mutex::new(ChatSession::default()),
            turn_lock: Mutex::new(()),
        })
    }

    #[tokio::test]
    async fn api_requires_token() {
        let app = router(state());
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // serializing env access; the await is a single request
    async fn api_allows_with_query_token() {
        let _g = crate::testutil::env_guard();
        let app = router(state());
        // status touches the workspace; a temp COLDTRAIL_HOME keeps it isolated
        std::env::set_var("COLDTRAIL_HOME", std::env::temp_dir().join("ct-web-auth"));
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/status?t=secret-tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        std::env::remove_var("COLDTRAIL_HOME");
        assert_ne!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn cross_origin_rejected_even_with_token() {
        let app = router(state());
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/companies?t=secret-tok")
                    .header("origin", "http://127.0.0.1:9999")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn foreign_host_rejected_even_with_token() {
        let app = router(state());
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/companies?t=secret-tok")
                    .header("host", "evil.example.com")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn index_served_without_token() {
        let app = router(state());
        let resp = app
            .oneshot(HttpRequest::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }
}
