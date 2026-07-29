//! Direct Gmail API send. coldtrail owns sending (not the agent / MCP connector): with a
//! `gmail.compose`-scoped OAuth token it POSTs an RFC822 message to `messages/send`.

use anyhow::{anyhow, Result};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;

/// Send a plain-text email as the authenticated user. Returns the Gmail message id.
pub async fn send(token: &str, to: &str, subject: &str, body: &str) -> Result<String> {
    // RFC 2047-encode the subject so non-ASCII (e.g. em dashes) survive the header.
    let subj = format!("=?UTF-8?B?{}?=", STANDARD.encode(subject.as_bytes()));
    let mime = format!(
        "To: {to}\r\nSubject: {subj}\r\nMIME-Version: 1.0\r\n\
         Content-Type: text/plain; charset=\"UTF-8\"\r\n\r\n{body}"
    );
    let raw = URL_SAFE_NO_PAD.encode(mime.as_bytes());

    let resp = reqwest::Client::new()
        .post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(serde_json::json!({ "raw": raw }).to_string())
        .send()
        .await
        .map_err(|e| anyhow!("Gmail send request failed: {e}"))?;

    let ok = resp.status().is_success();
    let text = resp.text().await.unwrap_or_default();
    if !ok {
        return Err(anyhow!(
            "Gmail send failed: {}",
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
    fn subject_is_rfc2047_encoded() {
        let subj = format!(
            "=?UTF-8?B?{}?=",
            STANDARD.encode("coldtrail — hi".as_bytes())
        );
        assert!(subj.starts_with("=?UTF-8?B?") && subj.ends_with("?="));
        // round-trips back to the original
        let inner = &subj["=?UTF-8?B?".len()..subj.len() - 2];
        assert_eq!(
            String::from_utf8(STANDARD.decode(inner).unwrap()).unwrap(),
            "coldtrail — hi"
        );
    }
}
