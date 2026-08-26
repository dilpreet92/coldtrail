//! Delivery core — the ONE place a reviewed draft turns into a Gmail draft or a real send.
//! Shared by the Drafts-screen button (`web::send`), the `coldtrail send` CLI, and the OpenAI
//! `send_outreach` tool, so the auto-send gate and the daily cap are enforced identically
//! everywhere. Sending is gated on the human's `auto_send` config — the agent can trigger this,
//! but it can't send unless the human turned auto-send on.

use anyhow::{anyhow, Result};
use rusqlite::OptionalExtension;

/// A reviewable draft ready to draft-in-Gmail, send, or deliver via LinkedIn.
pub struct Draft {
    /// "email" | "linkedin"
    #[allow(dead_code)] // read by the LinkedIn send branch added in Task 4
    pub channel: String,
    /// recipient: an email address (email channel) or a LinkedIn profile URL (linkedin channel)
    pub to: String,
    pub subject: String,
    pub body: String,
}

/// The latest reviewable (`draft_pending`|`drafted`) outreach for a domain, with its recipient.
/// Recipient is the contact email for the email channel, or the contact's linkedin_url for the
/// linkedin channel.
pub fn reviewable(domain: &str) -> Result<Draft> {
    let c = crate::db::open()?;
    let row = c
        .query_row(
            "SELECT COALESCE(o.channel,'email'), o.subject, o.body, k.email, k.linkedin_url \
             FROM outreach o LEFT JOIN contacts k ON k.id = o.contact_id \
             WHERE o.domain=?1 AND o.status IN ('draft_pending','drafted') \
             ORDER BY o.created_at DESC LIMIT 1",
            [domain],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?;
    let (channel, subject, body, email, linkedin) =
        row.ok_or_else(|| anyhow!("no reviewable draft for {domain}"))?;
    let to = if channel == "linkedin" {
        linkedin.ok_or_else(|| anyhow!("no LinkedIn URL on file for {domain}"))?
    } else {
        email.ok_or_else(|| anyhow!("no recipient email on file for {domain}"))?
    };
    Ok(Draft {
        channel,
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

/// Email sends today (email channel or legacy NULL), for the email warmup cap.
pub fn sent_today() -> u32 {
    count_sent("status='sent' AND date(sent_at)=date('now') AND COALESCE(channel,'email')='email'")
}

/// LinkedIn connection-invites sent today.
#[allow(dead_code)] // consumed starting in Task 4 (LinkedIn send path)
pub fn linkedin_sent_today() -> u32 {
    count_sent("status='sent' AND channel='linkedin' AND date(sent_at)=date('now')")
}

/// LinkedIn connection-invites sent in the trailing 7 days (rolling weekly cap).
#[allow(dead_code)] // consumed starting in Task 4 (LinkedIn send path)
pub fn linkedin_sent_last_7d() -> u32 {
    count_sent("status='sent' AND channel='linkedin' AND sent_at >= datetime('now','-7 days')")
}

fn count_sent(where_clause: &str) -> u32 {
    crate::db::open()
        .ok()
        .and_then(|c| {
            c.query_row(
                &format!("SELECT COUNT(*) FROM outreach WHERE {where_clause}"),
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
    if std::env::var("COLDTRAIL_NO_SEND").is_ok() {
        return Err(anyhow!("dry run: sending is disabled for this run"));
    }
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
                channel: "email".into(),
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

    // The dry-run gate is the very first statement in `send`, so it fires before config/db
    // are touched at all — no workspace or auto_send setup needed here.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn no_send_env_blocks_send_even_before_config() {
        let _g = crate::testutil::env_guard();
        std::env::set_var("COLDTRAIL_NO_SEND", "1");
        let d = Draft {
            channel: "email".into(),
            to: "a@example.com".into(),
            subject: "s".into(),
            body: "b".into(),
        };
        let res = send("example.com", &d).await;
        std::env::remove_var("COLDTRAIL_NO_SEND");
        let err = res.unwrap_err().to_string();
        assert!(err.contains("dry run"), "got: {err}");
    }
}
