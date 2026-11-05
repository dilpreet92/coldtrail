//! Push a reviewed draft into Gmail from the Drafts screen. By default it creates a DRAFT and
//! the human sends by hand (the standing guardrail). If the human enabled `auto_send`, the same
//! click SENDS immediately, under a per-day cap. All of that lives in `crate::deliver`, shared
//! with the `coldtrail send` CLI and the OpenAI `send_outreach` tool.

use axum::extract::{Path, State};
use axum::Json;
use std::sync::Arc;

use super::api::MsgResp;
use super::{ApiErr, AppState};

pub async fn send(
    State(_state): State<Arc<AppState>>,
    Path(domain): Path<String>,
) -> Result<Json<MsgResp>, ApiErr> {
    let domain = domain.to_lowercase();

    // This button is the EMAIL send/draft path: it acts on the company's email draft only, even
    // when a newer LinkedIn note waits beside it. A LinkedIn-channel draft has its own flow (the
    // Drafts "Open in LinkedIn" assist button -> `web::linkedin::assist`/`confirm`) — never fall
    // through to Gmail draft-creation or the email transport for it.
    if !crate::deliver::waiting(&domain, "email")? && crate::deliver::waiting(&domain, "linkedin")?
    {
        return Ok(Json(MsgResp {
            ok: false,
            message: Some(
                "This is a LinkedIn draft — use \"Open in LinkedIn\" to send it.".to_string(),
            ),
            wired: None,
        }));
    }
    let draft = crate::deliver::reviewable(&domain, Some("email"))?;

    let auto = crate::config::load().auto_send;
    let outcome = if auto {
        crate::deliver::send(&domain, &draft).await
    } else {
        crate::deliver::draft(&domain, &draft)
            .await
            .map(|_| "Created in your Gmail Drafts — open Gmail to review and send.".to_string())
    };

    match outcome {
        Ok(message) => Ok(Json(MsgResp {
            ok: true,
            message: Some(message),
            wired: None,
        })),
        Err(e) => Ok(Json(MsgResp {
            ok: false,
            message: Some(e.to_string()),
            wired: None,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A company with an email and a newer LinkedIn note waiting: Send now acts on the email
    /// (here it reaches the dry-run gate), never refusing it as a LinkedIn draft. With only the
    /// note waiting it still points at Open in LinkedIn.
    #[test]
    fn send_acts_on_the_email_beside_a_newer_note() {
        crate::testutil::with_home("ct-web-send-xchan", |dir| {
            crate::db::init().unwrap();
            std::fs::write(dir.join("config.toml"), "auto_send = true\n").unwrap();
            crate::db::open()
                .unwrap()
                .execute_batch(
                    "INSERT INTO companies (domain) VALUES ('x.com'), ('li.com'); \
                     INSERT INTO contacts (id, domain, email, linkedin_url) VALUES \
                     (1,'x.com','xena@x.com','https://www.linkedin.com/in/xena'), \
                     (2,'li.com',NULL,'https://www.linkedin.com/in/lee'); \
                     INSERT INTO outreach (domain, contact_id, channel, subject, body, status, created_at) VALUES \
                     ('x.com',1,'email','Re: idea','Following up.','draft_pending','2026-11-04 09:00:00'), \
                     ('x.com',1,'linkedin','','Hi Xena','draft_pending','2026-11-04 10:00:00'), \
                     ('li.com',2,'linkedin','','Hi Lee','draft_pending','2026-11-04 10:00:00');",
                )
                .unwrap();
            let rt = tokio::runtime::Runtime::new().unwrap();
            let push = |domain: &str| {
                rt.block_on(send(
                    State(crate::web::tests::state()),
                    Path(domain.to_string()),
                ))
                .unwrap()
                .0
            };
            std::env::set_var("COLDTRAIL_NO_SEND", "1");
            let r = push("x.com");
            let only_note = push("li.com");
            std::env::remove_var("COLDTRAIL_NO_SEND");
            assert!(!r.ok);
            assert!(r.message.unwrap().contains("dry run"));
            assert!(!only_note.ok);
            assert!(only_note.message.unwrap().contains("Open in LinkedIn"));
        });
    }
}
