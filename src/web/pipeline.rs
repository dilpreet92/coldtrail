//! Read-only pipeline data for the dashboard, straight from SQLite.

use axum::Json;

use super::api::{CompanyDto, ContactDto, DraftDto};
use super::ApiErr;

pub async fn companies() -> Result<Json<Vec<CompanyDto>>, ApiErr> {
    let c = crate::db::open()?;
    let mut stmt = c.prepare(
        "SELECT domain, name, status, COALESCE(first_seen,'') FROM companies ORDER BY first_seen DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CompanyDto {
                domain: r.get(0)?,
                name: r.get(1)?,
                status: r.get(2)?,
                first_seen: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(rows))
}

pub async fn contacts() -> Result<Json<Vec<ContactDto>>, ApiErr> {
    let c = crate::db::open()?;
    let mut stmt = c.prepare(
        "SELECT domain, founder_name, email, COALESCE(mx_ok,0), email_confidence \
         FROM contacts ORDER BY found_at DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ContactDto {
                domain: r.get(0)?,
                founder_name: r.get(1)?,
                email: r.get(2)?,
                mx_ok: r.get::<_, i64>(3)? != 0,
                confidence: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(rows))
}

pub async fn drafts() -> Result<Json<Vec<DraftDto>>, ApiErr> {
    let c = crate::db::open()?;
    let mut stmt = c.prepare(
        "SELECT o.domain, k.email, o.subject, o.body, o.status, o.gmail_draft_id \
         FROM outreach o LEFT JOIN contacts k ON k.id = o.contact_id \
         ORDER BY o.created_at DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DraftDto {
                domain: r.get(0)?,
                to: r.get(1)?,
                subject: r.get(2)?,
                body: r.get(3)?,
                status: r.get(4)?,
                gmail_draft_id: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(rows))
}
