//! Direct Gmail API — coldtrail owns the destination (not the provider's connector). With a
//! `gmail.compose` OAuth token it creates a real Gmail DRAFT in the user's mailbox. It never
//! sends: the human opens Gmail and sends by hand (the standing guardrail).

use anyhow::{anyhow, Result};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;

/// Build an RFC822 message and base64url-encode it (Gmail's `raw` field).
fn raw_message(to: &str, subject: &str, body: &str) -> String {
    // Strip CR/LF from the recipient so it can't inject extra headers (e.g. a Bcc:).
    let to = to.replace(['\r', '\n'], " ");
    // RFC 2047-encode the subject so non-ASCII (em dashes etc.) survive the header.
    let subj = format!("=?UTF-8?B?{}?=", STANDARD.encode(subject.as_bytes()));
    let mime = format!(
        "To: {to}\r\nSubject: {subj}\r\nMIME-Version: 1.0\r\n\
         Content-Type: text/plain; charset=\"UTF-8\"\r\n\r\n{body}"
    );
    URL_SAFE_NO_PAD.encode(mime.as_bytes())
}

/// Create a Gmail draft as the authenticated user. Returns the Gmail draft id.
pub async fn create_draft(token: &str, to: &str, subject: &str, body: &str) -> Result<String> {
    let raw = raw_message(to, subject, body);
    let resp = reqwest::Client::new()
        .post("https://gmail.googleapis.com/gmail/v1/users/me/drafts")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(serde_json::json!({ "message": { "raw": raw } }).to_string())
        .send()
        .await
        .map_err(|e| anyhow!("Gmail draft request failed: {e}"))?;

    let ok = resp.status().is_success();
    let text = resp.text().await.unwrap_or_default();
    if !ok {
        return Err(anyhow!(
            "Gmail draft failed: {}",
            text.chars().take(300).collect::<String>()
        ));
    }
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    Ok(v["id"].as_str().unwrap_or_default().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subject_is_rfc2047_and_raw_roundtrips() {
        let raw = raw_message("a@b.com", "coldtrail — hi", "hello");
        let bytes = URL_SAFE_NO_PAD.decode(&raw).unwrap();
        let mime = String::from_utf8(bytes).unwrap();
        assert!(mime.contains("To: a@b.com"));
        assert!(mime.contains("=?UTF-8?B?"));
        assert!(mime.ends_with("hello"));
    }
}
