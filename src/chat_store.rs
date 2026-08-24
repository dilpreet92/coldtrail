//! Chat-history persistence shared by the web chat and scheduled runs.
use anyhow::Result;
use rusqlite::params;

pub fn title_from(msg: &str) -> String {
    let t = msg.trim().replace('\n', " ");
    if t.chars().count() > 60 {
        format!("{}…", t.chars().take(60).collect::<String>())
    } else {
        t
    }
}

/// Persist a chat message (best-effort; never blocks the turn on a DB hiccup).
pub fn insert_message(chat_id: &str, role: &str, content: &str) {
    if let Ok(c) = crate::db::open() {
        let _ = c.execute(
            "INSERT INTO chat_messages (session_id, role, content) VALUES (?1, ?2, ?3)",
            params![chat_id, role, content],
        );
        let _ = c.execute(
            "UPDATE chat_sessions SET updated_at=datetime('now') WHERE id=?1",
            [chat_id],
        );
    }
}

/// Create a fresh chat session row and return (chat_id, agent_session_id).
#[allow(dead_code)] // used by the upcoming scheduled-runs feature
pub fn create_session(title: &str) -> Result<(String, String)> {
    let chat_id = uuid::Uuid::new_v4().to_string();
    let agent_sid = uuid::Uuid::new_v4().to_string();
    let c = crate::db::open()?;
    c.execute(
        "INSERT INTO chat_sessions (id, agent_session_id, title) VALUES (?1, ?2, ?3)",
        params![chat_id, agent_sid, title],
    )?;
    Ok((chat_id, agent_sid))
}

/// Persist a provider-assigned session id (e.g. codex thread id) for later resume.
#[allow(dead_code)] // used by the upcoming scheduled-runs feature
pub fn set_agent_session(chat_id: &str, agent_sid: &str) {
    if let Ok(c) = crate::db::open() {
        let _ = c.execute(
            "UPDATE chat_sessions SET agent_session_id=?1 WHERE id=?2",
            params![agent_sid, chat_id],
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn create_session_inserts_a_titled_row_with_a_message() {
        crate::testutil::with_home("ct-chatstore", |_| {
            crate::db::init().unwrap();
            let (chat_id, agent_sid) = create_session("Scheduled run — 2026-08-24 09:00").unwrap();
            assert!(!chat_id.is_empty() && !agent_sid.is_empty());
            insert_message(&chat_id, "user", "hello");
            let c = crate::db::open().unwrap();
            let n: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM chat_messages WHERE session_id=?1",
                    [&chat_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1);
            let title: String = c
                .query_row(
                    "SELECT title FROM chat_sessions WHERE id=?1",
                    [&chat_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(title.starts_with("Scheduled run"));
        });
    }
}
