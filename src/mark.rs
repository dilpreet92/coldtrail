//! Record a Gmail draft id against a company's outreach row (after the agent
//! creates the draft via the Gmail MCP), or mark it sent / bounced.

use anyhow::Result;
use rusqlite::params;

pub fn run(domain: &str, value: &str) -> Result<()> {
    let conn = crate::db::open()?;
    match value {
        "sent" => {
            conn.execute(
                "UPDATE outreach SET status='sent', sent_at=datetime('now') WHERE domain=?1",
                [domain],
            )?;
            crate::db::set_status(&conn, domain, "sent")?;
        }
        "bounced" => {
            conn.execute(
                "UPDATE outreach SET status='bounced' WHERE domain=?1",
                [domain],
            )?;
            crate::db::set_status(&conn, domain, "bounced")?;
        }
        draft_id => {
            conn.execute(
                "UPDATE outreach SET gmail_draft_id=?1, status='drafted' WHERE domain=?2",
                params![draft_id, domain],
            )?;
            crate::db::set_status(&conn, domain, "drafted")?;
        }
    }
    println!("{domain}: {value}");
    Ok(())
}
