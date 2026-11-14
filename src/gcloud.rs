//! gcloud Application Default Credentials (ADC) as a KEYLESS Gmail token source. ADC login
//! (`gcloud auth application-default login`) reuses Google's own gcloud OAuth client, so the
//! user never creates a client id/secret. coldtrail reads the ADC file and mints a Gmail
//! access token from its refresh token — and passes the ADC quota project so the Gmail API
//! attributes the call to a project that has the API enabled.

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The gcloud login command that grants coldtrail the Gmail draft scope.
pub const ADC_LOGIN_HINT: &str =
    "gcloud auth application-default login --scopes=https://www.googleapis.com/auth/gmail.compose,https://www.googleapis.com/auth/cloud-platform";

#[derive(Deserialize, Default)]
struct Adc {
    client_id: Option<String>,
    client_secret: Option<String>,
    refresh_token: Option<String>,
    quota_project_id: Option<String>,
}

/// Path to the ADC file: `$GOOGLE_APPLICATION_CREDENTIALS`, else gcloud's default under
/// `~/.config/gcloud/` (gcloud uses `~/.config` on macOS too, not Application Support).
pub fn adc_path() -> Option<std::path::PathBuf> {
    if let Some(p) = std::env::var_os("GOOGLE_APPLICATION_CREDENTIALS") {
        let p = std::path::PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    dirs::home_dir()
        .map(|h| {
            h.join(".config")
                .join("gcloud")
                .join("application_default_credentials.json")
        })
        .filter(|p| p.is_file())
}

/// Is there a gcloud user login (ADC with a user refresh token) on this machine — what Gmail can
/// use keylessly? An ADC file without one (a service account, a half-finished login) can never
/// mint a Gmail token, so it doesn't count.
pub fn available() -> bool {
    load().is_ok_and(|a| usable(&a))
}

fn usable(a: &Adc) -> bool {
    a.client_id.is_some() && a.client_secret.is_some() && a.refresh_token.is_some()
}

/// Has Gmail taken a draft or send made with this gcloud login? The ADC file doesn't record a
/// login's scopes, and a plain `gcloud auth application-default login` lacks the Gmail one (nor
/// does every quota project have the Gmail API on), so a login is a Gmail connection only once
/// a call through it went through (`gmail_worked`). A new login or quota project has to again.
pub fn gmail_verified() -> bool {
    let current = load().ok().as_ref().and_then(login_id);
    current.is_some() && current == crate::secrets::gcloud_gmail()
}

/// Record that Gmail accepted a call made with the current gcloud login (see `gmail_verified`).
/// Best-effort: failing to record it only leaves the login unverified.
pub fn gmail_worked() {
    let Some(id) = load().ok().as_ref().and_then(login_id) else {
        return;
    };
    if crate::secrets::gcloud_gmail().as_deref() != Some(id.as_str()) {
        let _ = crate::secrets::set_gcloud_gmail(&id);
    }
}

/// A fingerprint of a user login: its client, refresh token and quota project, hashed so the
/// record of what Gmail took is never a copy of the token. `None` for a file that isn't one.
fn login_id(a: &Adc) -> Option<String> {
    if !usable(a) {
        return None;
    }
    let mut h = Sha256::new();
    for part in [&a.client_id, &a.refresh_token, &a.quota_project_id] {
        h.update(part.as_deref().unwrap_or_default().as_bytes());
        h.update([0]);
    }
    Some(URL_SAFE_NO_PAD.encode(h.finalize()))
}

fn load() -> Result<Adc> {
    let p = adc_path().ok_or_else(|| anyhow!("gcloud ADC not found — run: {ADC_LOGIN_HINT}"))?;
    let txt = std::fs::read_to_string(&p).with_context(|| format!("read {}", p.display()))?;
    serde_json::from_str(&txt).context("gcloud ADC file isn't valid JSON")
}

/// The ADC quota project (set via `gcloud auth application-default set-quota-project`), if any.
pub fn quota_project() -> Option<String> {
    load().ok().and_then(|a| a.quota_project_id)
}

/// Mint a fresh access token from the ADC user refresh token.
pub async fn access_token() -> Result<String> {
    let a = load()?;
    let (cid, secret, refresh) = match (a.client_id, a.client_secret, a.refresh_token) {
        (Some(c), Some(s), Some(r)) => (c, s, r),
        _ => {
            return Err(anyhow!(
                "gcloud ADC has no user refresh token — run: {ADC_LOGIN_HINT}"
            ))
        }
    };
    let enc = |s: &str| urlencoding::encode(s).into_owned();
    let body = format!(
        "grant_type=refresh_token&client_id={}&client_secret={}&refresh_token={}",
        enc(&cid),
        enc(&secret),
        enc(&refresh)
    );
    let resp = reqwest::Client::new()
        .post("https://oauth2.googleapis.com/token")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .context("gcloud token refresh request failed")?;
    let ok = resp.status().is_success();
    let text = resp.text().await.unwrap_or_default();
    if !ok {
        return Err(anyhow!(
            "gcloud token refresh failed: {}",
            text.chars().take(200).collect::<String>()
        ));
    }
    let v: Value = serde_json::from_str(&text).unwrap_or_default();
    v["access_token"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow!("no access_token in gcloud refresh response"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_adc_fields() {
        let a: Adc = serde_json::from_str(
            r#"{"client_id":"gc.apps","client_secret":"sek","refresh_token":"rt","quota_project_id":"proj-1","type":"authorized_user"}"#,
        )
        .unwrap();
        assert_eq!(a.client_id.as_deref(), Some("gc.apps"));
        assert_eq!(a.quota_project_id.as_deref(), Some("proj-1"));
    }

    #[test]
    fn missing_refresh_token_is_none() {
        let a: Adc = serde_json::from_str(r#"{"client_id":"x"}"#).unwrap();
        assert!(a.refresh_token.is_none());
        assert!(!usable(&a));
    }

    /// A login is told apart by its client, refresh token and quota project: logging in again
    /// or switching the quota project makes it a new one, and a service account is none.
    #[test]
    fn login_id_changes_with_the_login_and_quota_project() {
        let adc = |refresh: &str, quota: &str| -> Adc {
            serde_json::from_str(&format!(
                r#"{{"client_id":"gc.apps","client_secret":"sek","refresh_token":"{refresh}","quota_project_id":"{quota}"}}"#
            ))
            .unwrap()
        };
        let id = login_id(&adc("1//refresh-token", "p1")).unwrap();
        assert_eq!(login_id(&adc("1//refresh-token", "p1")).as_ref(), Some(&id));
        assert_ne!(login_id(&adc("1//new-login", "p1")).as_ref(), Some(&id));
        assert_ne!(login_id(&adc("1//refresh-token", "p2")).as_ref(), Some(&id));
        assert!(!id.contains("refresh-token"));
        let sa: Adc =
            serde_json::from_str(r#"{"type":"service_account","client_id":"1"}"#).unwrap();
        assert_eq!(login_id(&sa), None);
    }

    /// Only a user login counts: its client and refresh token are what mint a Gmail token.
    #[test]
    fn only_a_user_login_is_usable() {
        let a: Adc = serde_json::from_str(
            r#"{"client_id":"gc.apps","client_secret":"sek","refresh_token":"rt","type":"authorized_user"}"#,
        )
        .unwrap();
        assert!(usable(&a));
        let sa: Adc =
            serde_json::from_str(r#"{"type":"service_account","client_id":"1"}"#).unwrap();
        assert!(!usable(&sa));
    }
}
