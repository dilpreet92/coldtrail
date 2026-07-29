//! OAuth 2.0 authorization-code + PKCE for connecting Discovery (Canonical) and
//! Destination (Gmail) on the in-Rust backends. Pure helpers are unit-tested; the
//! interactive browser-consent leg (`run_flow`) is verified live by the user.

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// PKCE pair from a given verifier (S256). Pure — the basis of the tested known-answer.
pub fn pkce_from(verifier: &str) -> Pkce {
    let digest = Sha256::digest(verifier.as_bytes());
    Pkce {
        verifier: verifier.to_string(),
        challenge: URL_SAFE_NO_PAD.encode(digest),
    }
}

/// A fresh random PKCE pair (verifier from two v4 UUIDs → 64 unreserved chars).
pub fn pkce() -> Pkce {
    let v = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    pkce_from(&v)
}

fn enc(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

fn urlencoded(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", enc(k), enc(v)))
        .collect::<Vec<_>>()
        .join("&")
}

const FORM: &str = "application/x-www-form-urlencoded";

/// Build the authorization-request URL (S256, offline access for refresh tokens).
pub fn authorize_url(
    auth_endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    scope: &str,
    state: &str,
    challenge: &str,
) -> String {
    format!(
        "{auth_endpoint}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}\
         &code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent",
        enc(client_id),
        enc(redirect_uri),
        enc(scope),
        enc(state),
        enc(challenge),
    )
}

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<i64>,
}

/// Parse an OAuth token endpoint JSON response.
pub fn parse_tokens(body: &str) -> Result<TokenResponse> {
    serde_json::from_str(body).map_err(|e| anyhow!("bad token response: {e}"))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Exchange an authorization code for tokens; persist under `connector`.
#[allow(clippy::too_many_arguments)]
pub async fn exchange_code(
    connector: &str,
    token_endpoint: &str,
    client_id: &str,
    client_secret: Option<&str>,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
) -> Result<()> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id),
        ("code_verifier", verifier),
    ];
    if let Some(s) = client_secret {
        form.push(("client_secret", s));
    }
    let resp = reqwest::Client::new()
        .post(token_endpoint)
        .header("content-type", FORM)
        .body(urlencoded(&form))
        .send()
        .await
        .context("token request failed")?;
    let ok = resp.status().is_success();
    let body = resp.text().await.unwrap_or_default();
    if !ok {
        return Err(anyhow!(
            "token exchange failed: {}",
            body.chars().take(300).collect::<String>()
        ));
    }
    let t = parse_tokens(&body)?;
    crate::secrets::save_token(
        connector,
        crate::secrets::TokenRec {
            access: t.access_token,
            refresh: t.refresh_token,
            expires_at: t.expires_in.map(|s| now_secs() + s - 60),
            token_endpoint: token_endpoint.to_string(),
            client_id: client_id.to_string(),
            client_secret: client_secret.map(|s| s.to_string()),
        },
    )?;
    Ok(())
}

/// A currently-valid access token for `connector`, refreshing if expired. `None` if not
/// connected or refresh fails.
pub async fn valid_access(connector: &str) -> Option<String> {
    let rec = crate::secrets::token(connector)?;
    let fresh = rec.expires_at.map(|e| e > now_secs()).unwrap_or(true);
    if fresh {
        return Some(rec.access);
    }
    let refresh = rec.refresh.clone()?;
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh.as_str()),
        ("client_id", rec.client_id.as_str()),
    ];
    if let Some(s) = &rec.client_secret {
        form.push(("client_secret", s));
    }
    let resp = reqwest::Client::new()
        .post(&rec.token_endpoint)
        .header("content-type", FORM)
        .body(urlencoded(&form))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let t = parse_tokens(&resp.text().await.ok()?).ok()?;
    let updated = crate::secrets::TokenRec {
        access: t.access_token.clone(),
        refresh: t.refresh_token.or(Some(refresh)),
        expires_at: t.expires_in.map(|s| now_secs() + s - 60),
        ..rec
    };
    let _ = crate::secrets::save_token(connector, updated);
    Some(t.access_token)
}

/// Interactive flow: open the browser to consent, capture the redirect on a one-shot
/// loopback server, exchange the code. Verified live (needs real consent).
#[allow(clippy::too_many_arguments)]
pub async fn run_flow(
    connector: &str,
    auth_endpoint: &str,
    token_endpoint: &str,
    client_id: &str,
    client_secret: Option<&str>,
    scope: &str,
    port: u16,
) -> Result<()> {
    let redirect = format!("http://localhost:{port}/callback");
    let pkce = pkce();
    let state = uuid::Uuid::new_v4().to_string();
    let url = authorize_url(
        auth_endpoint,
        client_id,
        &redirect,
        scope,
        &state,
        &pkce.challenge,
    );

    println!("opening browser to authorize {connector}…\n  {url}");
    let _ = open::that(&url);
    let code = wait_for_code(port, &state).await?;
    exchange_code(
        connector,
        token_endpoint,
        client_id,
        client_secret,
        &redirect,
        &code,
        &pkce.verifier,
    )
    .await
}

/// One-shot loopback server: accept a single request, pull `?code=`, verify `state`.
async fn wait_for_code(port: u16, expect_state: &str) -> Result<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .with_context(|| format!("could not bind callback port {port}"))?;
    let (mut sock, _) = listener.accept().await?;
    let mut buf = vec![0u8; 4096];
    let n = sock.read(&mut buf).await?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let target = req
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("");
    let (code, state) = parse_callback(target);
    let body = "<html><body style='font-family:sans-serif'>coldtrail connected — you can close this tab.</body></html>";
    let _ = sock
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type:text/html\r\nContent-Length:{}\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await;
    if state.as_deref() != Some(expect_state) {
        return Err(anyhow!("OAuth state mismatch (possible CSRF) — aborting"));
    }
    code.ok_or_else(|| anyhow!("no authorization code in callback"))
}

/// Extract (code, state) from a `/callback?code=…&state=…` request target.
fn parse_callback(target: &str) -> (Option<String>, Option<String>) {
    let query = target.split('?').nth(1).unwrap_or("");
    let mut code = None;
    let mut state = None;
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        match (it.next(), it.next()) {
            (Some("code"), Some(v)) => {
                code = Some(urlencoding::decode(v).unwrap_or_default().into_owned())
            }
            (Some("state"), Some(v)) => {
                state = Some(urlencoding::decode(v).unwrap_or_default().into_owned())
            }
            _ => {}
        }
    }
    (code, state)
}

// --- connector-specific entry points ----------------------------------------

const CB_PORT: u16 = 8765;

const GOOGLE_AUTH: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN: &str = "https://oauth2.googleapis.com/token";
const GMAIL_SCOPE: &str =
    "https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.readonly";

/// coldtrail's built-in Google OAuth client (a Desktop client, so users don't create
/// their own). Baked in at build time via `COLDTRAIL_GOOGLE_CLIENT_ID`/`_SECRET`, with a
/// runtime env override. `None` if this build has no client configured.
pub fn google_client() -> Option<(String, Option<String>)> {
    let id = std::env::var("COLDTRAIL_GOOGLE_CLIENT_ID")
        .ok()
        .or_else(|| option_env!("COLDTRAIL_GOOGLE_CLIENT_ID").map(str::to_string))
        .filter(|s| !s.trim().is_empty())?;
    let secret = std::env::var("COLDTRAIL_GOOGLE_CLIENT_SECRET")
        .ok()
        .or_else(|| option_env!("COLDTRAIL_GOOGLE_CLIENT_SECRET").map(str::to_string))
        .filter(|s| !s.trim().is_empty());
    Some((id, secret))
}

/// Connect Gmail (destination) for the in-Rust backends — keyless, using coldtrail's
/// built-in Google client. Users just consent in the browser.
pub async fn connect_gmail(port: u16) -> Result<()> {
    let (client_id, secret) = google_client().ok_or_else(|| {
        anyhow!(
            "this build has no Google client configured. The maintainer must create a Google \
             Desktop OAuth client (with the Gmail API + Gmail MCP API enabled) and build/run with \
             COLDTRAIL_GOOGLE_CLIENT_ID and COLDTRAIL_GOOGLE_CLIENT_SECRET set."
        )
    })?;
    run_flow(
        "gmail",
        GOOGLE_AUTH,
        GOOGLE_TOKEN,
        &client_id,
        secret.as_deref(),
        GMAIL_SCOPE,
        port,
    )
    .await
}

/// Connect Canonical (discovery) for the in-Rust backends via the MCP-standard OAuth
/// discovery (RFC 9728 → 8414 → 7591). Best-effort; verified live.
pub async fn connect_canonical() -> Result<()> {
    let (auth, token, client_id, secret) = discover_canonical(CB_PORT).await?;
    run_flow(
        "canonical",
        &auth,
        &token,
        &client_id,
        secret.as_deref(),
        "",
        CB_PORT,
    )
    .await
}

async fn discover_canonical(port: u16) -> Result<(String, String, String, Option<String>)> {
    let http = reqwest::Client::new();
    let get_json = |url: String| {
        let http = http.clone();
        async move {
            let txt = http.get(&url).send().await?.text().await?;
            serde_json::from_str::<Value>(&txt).with_context(|| format!("not JSON: {url}"))
        }
    };
    // RFC 9728 protected-resource metadata → the authorization server base
    let prm = get_json("https://trycanonical.ai/.well-known/oauth-protected-resource".into())
        .await
        .context("Canonical didn't advertise OAuth protected-resource metadata")?;
    let as_base = prm["authorization_servers"][0]
        .as_str()
        .ok_or_else(|| anyhow!("Canonical metadata has no authorization_servers"))?
        .trim_end_matches('/')
        .to_string();
    // RFC 8414 authorization-server metadata
    let asm = get_json(format!("{as_base}/.well-known/oauth-authorization-server"))
        .await
        .context("Canonical auth-server metadata not found")?;
    let auth = asm["authorization_endpoint"]
        .as_str()
        .ok_or_else(|| anyhow!("no authorization_endpoint"))?
        .to_string();
    let token = asm["token_endpoint"]
        .as_str()
        .ok_or_else(|| anyhow!("no token_endpoint"))?
        .to_string();
    let reg = asm["registration_endpoint"]
        .as_str()
        .ok_or_else(|| anyhow!("Canonical doesn't support dynamic client registration"))?;
    // RFC 7591 dynamic client registration
    let redirect = format!("http://localhost:{port}/callback");
    let reg_body = json!({
        "client_name": "coldtrail",
        "redirect_uris": [redirect],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let reg_txt = http
        .post(reg)
        .header("content-type", "application/json")
        .body(reg_body.to_string())
        .send()
        .await?
        .text()
        .await?;
    let reg_v: Value =
        serde_json::from_str(&reg_txt).context("Canonical client registration failed")?;
    let client_id = reg_v["client_id"]
        .as_str()
        .ok_or_else(|| anyhow!("registration returned no client_id"))?
        .to_string();
    let client_secret = reg_v["client_secret"].as_str().map(|s| s.to_string());
    Ok((auth, token, client_id, client_secret))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_s256_known_answer() {
        // RFC 7636 Appendix B vector
        let p = pkce_from("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
        assert_eq!(p.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn authorize_url_has_pkce_and_scope() {
        let u = authorize_url(
            "https://accounts.google.com/o/oauth2/v2/auth",
            "cid.apps",
            "http://localhost:8765/callback",
            "https://www.googleapis.com/auth/gmail.compose",
            "st8",
            "chal",
        );
        assert!(u.contains("code_challenge=chal"));
        assert!(u.contains("code_challenge_method=S256"));
        assert!(u.contains("client_id=cid.apps"));
        assert!(u.contains("redirect_uri=http%3A%2F%2Flocalhost%3A8765%2Fcallback"));
        assert!(u.contains("gmail.compose"));
    }

    #[test]
    fn parse_tokens_and_callback() {
        let t = parse_tokens(r#"{"access_token":"a1","refresh_token":"r1","expires_in":3600}"#)
            .unwrap();
        assert_eq!(t.access_token, "a1");
        assert_eq!(t.refresh_token.as_deref(), Some("r1"));
        assert_eq!(t.expires_in, Some(3600));

        let (code, state) = parse_callback("/callback?code=abc123&state=xyz");
        assert_eq!(code.as_deref(), Some("abc123"));
        assert_eq!(state.as_deref(), Some("xyz"));
    }
}
