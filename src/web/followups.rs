//! Follow-up actions that drive the agent: scan Gmail for replies (mark replied/
//! bounced), and compose a follow-up touch. Both are user-initiated.

use axum::extract::{Path, State};
use axum::Json;
use rusqlite::OptionalExtension;
use std::sync::Arc;
use tokio::sync::mpsc;

use super::api::MsgResp;
use super::{ApiErr, AppState};
use crate::provider::cli::Tools;
use crate::provider::{resolve, run_turn, AgentEvent, GMAIL_TOOL};

/// How an agent turn ended: whether it finished cleanly, its final text, and the errors it
/// reported on the way.
struct Turn {
    ok: bool,
    result: Option<String>,
    errors: Vec<String>,
}

impl Turn {
    /// Why a failed turn failed, for the user: the agent's own errors, else its last words,
    /// else `fallback`.
    fn failure(self, fallback: &str) -> String {
        let mut errors: Vec<String> = Vec::new();
        for e in self.errors.into_iter().map(|e| e.trim().to_string()) {
            if !e.is_empty() && !errors.contains(&e) {
                errors.push(e);
            }
        }
        if !errors.is_empty() {
            return errors.join("\n");
        }
        self.result
            .filter(|r| !r.trim().is_empty())
            .unwrap_or_else(|| fallback.to_string())
    }
}

/// Drain an agent turn to completion.
async fn drive(msg: String, tools: Tools<'_>) -> Turn {
    let backend = resolve();
    let home = match crate::home::workspace() {
        Ok(h) => h,
        Err(e) => {
            return Turn {
                ok: false,
                result: None,
                errors: vec![e.to_string()],
            }
        }
    };
    let sid = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::channel(64);
    // NOTE: Tools moved into the task; build args before spawn.
    let disallow = matches!(tools, Tools::Disallow(_));
    let list: Vec<String> = match tools {
        Tools::Disallow(l) | Tools::AllowOnly(l) => l.iter().map(|s| s.to_string()).collect(),
    };
    tokio::spawn(async move {
        let refs: Vec<&str> = list.iter().map(|s| s.as_str()).collect();
        let t = if disallow {
            Tools::Disallow(&refs)
        } else {
            Tools::AllowOnly(&refs)
        };
        let _ = run_turn(&backend, &sid, true, &msg, &home, &t, tx).await;
    });
    let mut turn = Turn {
        ok: false,
        result: None,
        errors: Vec::new(),
    };
    while let Some(ev) = rx.recv().await {
        match ev {
            AgentEvent::Done { ok, result } => {
                turn.ok = ok;
                turn.result = result;
            }
            AgentEvent::Error { message } => turn.errors.push(message),
            _ => {}
        }
    }
    turn
}

/// A reply check is a clean result only when its turn finished: a failed turn never reads as
/// "no new replies", since Gmail may not have been read at all.
fn check_reply(t: Turn) -> MsgResp {
    if t.ok {
        return MsgResp {
            ok: true,
            message: t.result,
            wired: None,
        };
    }
    MsgResp {
        ok: false,
        message: Some(t.failure(
            "The agent's turn failed before it could read Gmail, so replies weren't checked. \
             Check the agent in Settings → Agent.",
        )),
        wired: None,
    }
}

fn draft_reply(t: Turn) -> MsgResp {
    if t.ok {
        return MsgResp {
            ok: true,
            message: Some("Follow-up drafted — review it in Drafts.".into()),
            wired: None,
        };
    }
    MsgResp {
        ok: false,
        message: Some(t.failure(
            "The agent's turn failed before it wrote a follow-up. Check the agent in Settings → Agent.",
        )),
        wired: None,
    }
}

/// Who the reply check covers, by the Follow-ups list's own rules: every domain awaiting a
/// reply (sent to, no reply or bounce yet), with the address an email went to. One reached
/// only on LinkedIn has none (even with an email on file): Gmail holds no reply to it. One pass
/// grouped by domain, like the Follow-ups list (a per-row subquery rescans outreach per row).
fn awaiting_reply(c: &rusqlite::Connection) -> anyhow::Result<Vec<(String, Option<String>)>> {
    let mut stmt = c.prepare(
        "SELECT o.domain, \
                MAX(CASE WHEN COALESCE(o.channel,'email')='email' AND o.status='sent' \
                         THEN k.email END) \
         FROM outreach o LEFT JOIN contacts k ON k.id=o.contact_id \
         GROUP BY o.domain \
         HAVING SUM(o.status='sent') > 0 AND SUM(o.status IN ('replied','bounced')) = 0",
    )?;
    let out = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(out)
}

/// The check's result when no one awaiting a reply was emailed. With LinkedIn rows still
/// awaiting one on the list, it says what it covers and why they aren't in it.
fn nothing_to_check(linkedin_only: usize) -> String {
    if linkedin_only == 0 {
        return "Nothing is awaiting a reply.".into();
    }
    "No one you emailed is awaiting a reply. Replies to LinkedIn invites aren't checked.".into()
}

/// Scan Gmail (read-only) for replies to already-sent contacts and mark them.
pub async fn check(State(_s): State<Arc<AppState>>) -> Result<Json<MsgResp>, ApiErr> {
    if !resolve().is_cli() {
        return Ok(Json(MsgResp {
            ok: false,
            message: Some(
                "Checking for replies reads Gmail through your agent CLI (Claude Code, Codex or \
                 opencode). With your own model, use Mark replied / Mark bounced on each row."
                    .into(),
            ),
            wired: None,
        }));
    }

    let (emailed, linkedin_only): (Vec<_>, Vec<_>) = awaiting_reply(&crate::db::open()?)?
        .into_iter()
        .partition(|(_, to)| to.is_some());
    if emailed.is_empty() {
        return Ok(Json(MsgResp {
            ok: true,
            message: Some(nothing_to_check(linkedin_only.len())),
            wired: None,
        }));
    }

    let list = emailed
        .iter()
        .filter_map(|(d, e)| Some(format!("- {d} ({})", e.as_deref()?)))
        .collect::<Vec<_>>()
        .join("\n");
    let msg = format!(
        "Check Gmail (READ ONLY) for replies to these already-sent contacts. For each, search your \
         Gmail for a message FROM that address received after we emailed them. If they replied, run \
         `coldtrail mark <domain> replied`. If it hard-bounced, run `coldtrail mark <domain> bounced`. \
         Do NOT send or draft anything. Report a one-line summary. Contacts:\n{list}"
    );
    Ok(Json(check_reply(drive(msg, Tools::Disallow(&[])).await)))
}

/// Compose a follow-up touch for an emailed-but-unanswered contact. A company reached only on
/// LinkedIn has no email to follow up (the same rule as Follow-ups' `to`).
pub async fn draft(
    Path(domain): Path<String>,
    State(_s): State<Arc<AppState>>,
) -> Result<Json<MsgResp>, ApiErr> {
    let domain = domain.to_lowercase();
    let (subject, to) = {
        let c = crate::db::open()?;
        c.query_row(
            "SELECT MAX(o.subject), MAX(k.email) FROM outreach o LEFT JOIN contacts k ON k.id=o.contact_id \
             WHERE o.domain=?1 AND o.status='sent' AND COALESCE(o.channel,'email')='email'",
            [&domain],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()?
        .unwrap_or((None, None))
    };
    let to = to.ok_or_else(|| anyhow::anyhow!("{domain} has no sent email to follow up"))?;

    let msg = format!(
        "Write a SHORT follow-up email to {to} at {domain}. They didn't reply to the first email \
         (subject: \"{}\"). Reference it lightly, add one new angle or piece of value, keep it to \
         2–3 sentences, friendly and low-pressure — do not resend the original. Then store it by \
         running `coldtrail followup {domain} --subject \"…\" --body \"…\"` (or the `followup` tool). \
         Do not send.",
        subject.as_deref().unwrap_or("")
    );
    // Gmail stays off — follow-up drafting only writes a local touch.
    Ok(Json(draft_reply(
        drive(msg, Tools::Disallow(&[GMAIL_TOOL])).await,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// POST `uri` through the real router; (status, body).
    fn post(uri: &str) -> (axum::http::StatusCode, String) {
        use tower::ServiceExt;
        let rt = tokio::runtime::Runtime::new().unwrap();
        let req = axum::http::Request::builder()
            .method("POST")
            .uri(format!("{uri}?t=secret-tok"))
            .header("content-type", "application/json")
            .body(axum::body::Body::from("{}"))
            .unwrap();
        let resp = rt
            .block_on(crate::web::router(crate::web::tests::state()).oneshot(req))
            .unwrap();
        let status = resp.status();
        let body = rt
            .block_on(axum::body::to_bytes(resp.into_body(), usize::MAX))
            .unwrap();
        (status, String::from_utf8(body.to_vec()).unwrap())
    }

    /// "Your own model" at an address nothing listens on: every turn fails at once.
    fn own_model_offline(dir: &std::path::Path) {
        crate::db::init().unwrap();
        std::fs::write(
            dir.join("config.toml"),
            "agent = \"openai\"\n[provider]\nbase_url = \"http://127.0.0.1:9\"\n",
        )
        .unwrap();
    }

    fn seed(sql: &str) {
        crate::db::open().unwrap().execute_batch(sql).unwrap();
    }

    /// A Draft follow-up whose turn fails says why (the agent's own error), not that the agent
    /// finished without writing one.
    #[test]
    fn draft_says_why_the_turn_failed() {
        crate::testutil::with_home("ct-web-followups-draft-fail", |dir| {
            own_model_offline(dir);
            seed(
                "INSERT INTO companies (domain, status) VALUES ('acme.com','sent'); \
                 INSERT INTO contacts (id, domain, founder_name, email) VALUES (1,'acme.com','Ann','ann@acme.com'); \
                 INSERT INTO outreach (domain, contact_id, channel, subject, status, sent_at) VALUES \
                 ('acme.com',1,'email','Quick idea','sent',datetime('now','-6 days'));",
            );
            let (status, body) = post("/api/followups/acme.com/draft");
            assert_eq!(status, axum::http::StatusCode::OK, "{body}");
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!(v["ok"], false, "{body}");
            let m = v["message"].as_str().unwrap_or_default();
            assert!(m.contains("could not reach the model"), "{body}");
        });
    }

    /// A company reached only on LinkedIn has no email to follow up, even with an address on
    /// file: no agent turn, no email draft.
    #[test]
    fn draft_refuses_a_company_never_emailed() {
        crate::testutil::with_home("ct-web-followups-draft-li", |dir| {
            own_model_offline(dir);
            seed(
                "INSERT INTO companies (domain, status) VALUES ('li.com','sent'); \
                 INSERT INTO contacts (id, domain, founder_name, email, linkedin_url) VALUES \
                 (1,'li.com','Lee','lee@li.com','https://www.linkedin.com/in/lee'); \
                 INSERT INTO outreach (domain, contact_id, channel, subject, status, sent_at) VALUES \
                 ('li.com',1,'linkedin','','sent',datetime('now','-6 days'));",
            );
            let (status, body) = post("/api/followups/li.com/draft");
            assert_eq!(
                status,
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "{body}"
            );
            assert_eq!(body, "li.com has no sent email to follow up");
        });
    }

    /// On your own model the check can't read Gmail; the reason names the row buttons as the
    /// screen labels them.
    #[test]
    fn check_on_own_model_points_at_the_mark_buttons() {
        crate::testutil::with_home("ct-web-followups-check-byok", |dir| {
            own_model_offline(dir);
            let (status, body) = post("/api/followups/check");
            assert_eq!(status, axum::http::StatusCode::OK, "{body}");
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!(v["ok"], false);
            let m = v["message"].as_str().unwrap();
            assert!(
                m.contains("Mark replied") && m.contains("Mark bounced"),
                "{m}"
            );
            assert!(m.contains("opencode"), "{m}");
        });
    }

    /// The reply check covers the Follow-ups list's awaiting rows (sent to, no reply or bounce
    /// yet), each with the address an email went to, the list's `to`. A company reached only on
    /// LinkedIn has none, even with an email on file or one only drafted: Gmail has no reply to
    /// it, and the agent isn't asked to look.
    #[test]
    fn check_lists_domains_awaiting_a_reply() {
        crate::testutil::with_home("ct-web-followups-awaiting", |_| {
            crate::db::init().unwrap();
            seed(
                "INSERT INTO companies (domain) VALUES ('a.com'), ('b.com'), ('c.com'), ('d.com'), \
                 ('e.com'), ('f.com'); \
                 INSERT INTO contacts (id, domain, founder_name, email) VALUES \
                 (1,'a.com','Ann','ann@a.com'), (2,'b.com','Ben','ben@b.com'), \
                 (3,'c.com','Cat','cat@c.com'), (4,'d.com','Dan',NULL), \
                 (5,'e.com','Eve',NULL), (6,'e.com','Eli','eli@e.com'), (7,'f.com','Fay','fay@f.com'); \
                 INSERT INTO outreach (domain, contact_id, channel, status) VALUES \
                 ('a.com',1,'email','sent'), ('a.com',1,'email','draft_pending'), \
                 ('b.com',2,'email','sent'), ('b.com',2,'email','replied'), \
                 ('c.com',3,'email','draft_pending'), \
                 ('d.com',4,'linkedin','sent'), \
                 ('e.com',5,'linkedin','sent'), ('e.com',6,'email','drafted'), \
                 ('f.com',7,'linkedin','sent');",
            );
            let c = crate::db::open().unwrap();
            let mut got = awaiting_reply(&c).unwrap();
            got.sort();
            let addr = |d: &str, e: Option<&str>| (d.to_string(), e.map(String::from));
            assert_eq!(
                got,
                [
                    addr("a.com", Some("ann@a.com")),
                    addr("d.com", None),
                    addr("e.com", None),
                    addr("f.com", None),
                ]
            );
            // Every awaiting row the agent is asked about is one the list shows an address for.
            let listed: Vec<(String, Option<String>)> = crate::web::pipeline::followup_rows(&c)
                .unwrap()
                .into_iter()
                .filter(|f| f.state != "replied" && f.state != "bounced")
                .map(|f| (f.domain, f.to))
                .collect();
            let mut listed = listed;
            listed.sort();
            assert_eq!(listed, got);
        });
    }

    /// With no one emailed awaiting a reply, the check finishes at once; when LinkedIn rows
    /// still await one, it says what it covers instead of "nothing is awaiting a reply".
    #[test]
    fn nothing_to_check_says_what_the_check_covers() {
        assert_eq!(nothing_to_check(0), "Nothing is awaiting a reply.");
        assert_eq!(
            nothing_to_check(3),
            "No one you emailed is awaiting a reply. Replies to LinkedIn invites aren't checked."
        );
    }

    fn turn(ok: bool, result: Option<&str>, errors: &[&str]) -> Turn {
        Turn {
            ok,
            result: result.map(Into::into),
            errors: errors.iter().map(|e| e.to_string()).collect(),
        }
    }

    /// A reply check is only a clean result when the turn finished: a failed turn is ok:false
    /// with the agent's error, its last words, or a plain reason, never "no new replies".
    #[test]
    fn check_reports_a_failed_turn() {
        let r = check_reply(turn(true, Some("Marked 1 replied."), &["tool hiccup"]));
        assert_eq!(
            (r.ok, r.message.as_deref()),
            (true, Some("Marked 1 replied."))
        );
        let r = check_reply(turn(true, None, &[]));
        assert_eq!((r.ok, r.message), (true, None));

        let r = check_reply(turn(false, None, &["Fake failure"]));
        assert_eq!((r.ok, r.message.as_deref()), (false, Some("Fake failure")));
        let r = check_reply(turn(false, Some("Model retired."), &[]));
        assert_eq!(
            (r.ok, r.message.as_deref()),
            (false, Some("Model retired."))
        );
        let r = check_reply(turn(false, Some("  "), &[]));
        assert!(!r.ok);
        assert!(r.message.unwrap().contains("Gmail"));
    }

    /// The same for Draft follow-up, whose success message points at Drafts.
    #[test]
    fn draft_reports_a_failed_turn() {
        let r = draft_reply(turn(true, Some("Done."), &[]));
        assert_eq!(
            (r.ok, r.message.as_deref()),
            (true, Some("Follow-up drafted — review it in Drafts."))
        );
        let r = draft_reply(turn(
            false,
            Some("partial"),
            &["Fake failure", "Fake failure", "exit 1"],
        ));
        assert_eq!(
            (r.ok, r.message.as_deref()),
            (false, Some("Fake failure\nexit 1"))
        );
        let r = draft_reply(turn(false, None, &[]));
        assert!(!r.ok);
        assert!(r.message.unwrap().contains("Settings → Agent"));
    }
}
