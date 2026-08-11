//! Delivery core — the ONE place a reviewed draft turns into a Gmail draft or a real send.
//! Shared by the Drafts-screen button (`web::send`), the `coldtrail send` CLI, and the OpenAI
//! `send_outreach` tool, so the auto-send gate and the daily cap are enforced identically
//! everywhere. Sending is gated on the human's `auto_send` config — the agent can trigger this,
//! but it can't send unless the human turned auto-send on.

use anyhow::{anyhow, Result};
use rusqlite::OptionalExtension;

/// A reviewable draft ready to draft-in-Gmail or send.
pub struct Draft {
    pub to: String,
    pub subject: String,
    pub body: String,
}

/// The latest reviewable (`draft_pending`|`drafted`) outreach for a domain, with its recipient.
pub fn reviewable(domain: &str) -> Result<Draft> {
    let c = crate::db::open()?;
    let row = c
        .query_row(
            "SELECT o.subject, o.body, k.email FROM outreach o \
             LEFT JOIN contacts k ON k.id = o.contact_id \
             WHERE o.domain=?1 AND o.status IN ('draft_pending','drafted') \
             ORDER BY o.created_at DESC LIMIT 1",
            [domain],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?;
    let (subject, body, to) = row.ok_or_else(|| anyhow!("no reviewable draft for {domain}"))?;
    let to = to.ok_or_else(|| anyhow!("no recipient email on file for {domain}"))?;
    Ok(Draft {
        to,
        subject: subject.unwrap_or_default(),
        body: body.unwrap_or_default(),
    })
}

/// Create a Gmail DRAFT (never sends): keyless IMAP app-password APPEND, else the Gmail API.
/// Marks the row `drafted`.
pub async fn draft(domain: &str, d: &Draft) -> Result<()> {
    if let Some((email, pw)) = crate::secrets::gmail_app_password() {
        let mime = crate::gmail::mime_message(&d.to, &d.subject, &d.body);
        crate::imap_draft::append_draft(&email, &pw, &mime).await?;
    } else {
        let (token, quota) = crate::gmail::token().await?;
        crate::gmail::create_draft(&token, quota.as_deref(), &d.to, &d.subject, &d.body).await?;
    }
    crate::mark::run(domain, "gmail")?; // records a gmail draft + status='drafted'
    Ok(())
}

/// How many real sends have gone out today (for the warmup cap).
pub fn sent_today() -> u32 {
    crate::db::open()
        .ok()
        .and_then(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM outreach WHERE status='sent' AND date(sent_at)=date('now')",
                [],
                |r| r.get(0),
            )
            .ok()
        })
        .unwrap_or(0)
}

/// SEND for real. Refuses unless the human enabled `auto_send`; enforces the per-day cap; sends
/// via SMTP (app-password) or the Gmail API (OAuth); marks the row `sent`. Returns a status line.
pub async fn send(domain: &str, d: &Draft) -> Result<String> {
    let cfg = crate::config::load();
    if !cfg.auto_send {
        return Err(anyhow!(
            "auto-send is off — the human must enable it in Settings → Destination first. \
             Leave the draft for them to send from the Drafts tab."
        ));
    }
    let cap = cfg
        .daily_send_cap
        .unwrap_or(crate::config::DEFAULT_DAILY_SEND_CAP);
    let n = sent_today();
    if n >= cap {
        return Err(anyhow!(
            "daily send cap reached ({n}/{cap}) — stop for today; the rest can go out tomorrow \
             (or the human can raise the cap in Settings)"
        ));
    }
    if let Some((email, pw)) = crate::secrets::gmail_app_password() {
        let mime = crate::gmail::mime_message(&d.to, &d.subject, &d.body);
        crate::smtp::send(&email, &pw, &d.to, &mime).await?;
    } else {
        let (token, quota) = crate::gmail::token().await?;
        crate::gmail::send_message(&token, quota.as_deref(), &d.to, &d.subject, &d.body).await?;
    }
    crate::mark::run(domain, "sent")?; // status='sent', sent_at=now
    Ok(format!("sent to {} ({}/{cap} today)", d.to, n + 1))
}

/// CLI entry: `coldtrail send <domain>` — send a reviewed draft (requires auto-send on).
pub async fn run(domain: &str) -> Result<()> {
    crate::db::init()?;
    let domain = domain.trim().to_lowercase();
    let d = reviewable(&domain)?;
    let msg = send(&domain, &d).await?;
    println!("{domain}: {msg}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_refuses_when_auto_send_off() {
        crate::testutil::with_home("ct-deliver-gate", |_| {
            crate::home::workspace().unwrap();
            // Fresh config → auto_send defaults off.
            let d = Draft {
                to: "a@b.com".into(),
                subject: "hi".into(),
                body: "hello".into(),
            };
            let err = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(send("b.com", &d))
                .unwrap_err()
                .to_string();
            assert!(err.contains("auto-send is off"), "got: {err}");
        });
    }
}
