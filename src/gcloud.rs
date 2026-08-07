//! gcloud Application Default Credentials (ADC) as a KEYLESS Gmail token source. ADC login
//! (`gcloud auth application-default login`) reuses Google's own gcloud OAuth client, so the
//! user never creates a client id/secret. coldtrail reads the ADC file and mints a Gmail
//! access token from its refresh token — and passes the ADC quota project so the Gmail API
//! attributes the call to a project that has the API enabled.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::Value;

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

/// Is gcloud ADC set up on this machine?
pub fn available() -> bool {
    adc_path().is_some()
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
    }
}
