//! Read-only pipeline data for the dashboard, straight from SQLite.

use axum::extract::Path;
use axum::Json;
use rusqlite::params;

use super::api::{
    CompanyDto, ContactDto, DraftDto, DraftEditReq, FollowupDto, MarkReq, MsgResp, OverviewDto,
};
use super::ApiErr;

/// One row per already-contacted domain, with days-since-send and a derived state.
pub async fn followups() -> Result<Json<Vec<FollowupDto>>, ApiErr> {
    let c = crate::db::open()?;
    let mut stmt = c.prepare(
        "SELECT o.domain, MAX(k.email), \
                CAST(julianday('now') - julianday(MAX(o.sent_at)) AS INTEGER), \
                SUM(CASE WHEN o.status IN ('sent','replied','bounced') THEN 1 ELSE 0 END), \
                MAX(CASE WHEN o.status='replied' THEN 1 ELSE 0 END), \
                MAX(CASE WHEN o.status='bounced' THEN 1 ELSE 0 END) \
         FROM outreach o LEFT JOIN contacts k ON k.id = o.contact_id \
         WHERE EXISTS (SELECT 1 FROM outreach s WHERE s.domain=o.domain AND s.status IN ('sent','replied','bounced')) \
         GROUP BY o.domain ORDER BY MAX(o.sent_at) DESC",
    )?;
    let rows: Vec<FollowupDto> = stmt
        .query_map([], |r| {
            let days: Option<i64> = r.get(2)?;
            let sends: i64 = r.get(3)?;
            let replied: i64 = r.get(4)?;
            let bounced: i64 = r.get(5)?;
            let days = days.unwrap_or(0);
            let state = if replied != 0 {
                "replied"
            } else if bounced != 0 {
                "bounced"
            } else if days >= 4 && sends < 3 {
                "due"
            } else {
                "awaiting"
            };
            Ok(FollowupDto {
                domain: r.get(0)?,
                to: r.get(1)?,
                days,
                touches: sends,
                state: state.to_string(),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Json(rows))
}

/// Manually mark a contact replied / bounced (fallback to the agent reply-check).
pub async fn mark_touch(
    axum::extract::Path(domain): axum::extract::Path<String>,
    Json(req): Json<MarkReq>,
) -> Result<Json<MsgResp>, ApiErr> {
    if !["sent", "replied", "bounced"].contains(&req.value.as_str()) {
        return Err(anyhow::anyhow!("mark value must be 'sent', 'replied' or 'bounced'").into());
    }
    crate::mark::run(&domain.to_lowercase(), &req.value)?;
    Ok(Json(MsgResp::ok()))
}

/// Edit a draft's subject/body before sending (only reviewable drafts).
pub async fn save_draft(
    Path(domain): Path<String>,
    Json(req): Json<DraftEditReq>,
) -> Result<Json<MsgResp>, ApiErr> {
    let domain = domain.to_lowercase();
    let c = crate::db::open()?;
    let n = c.execute(
        "UPDATE outreach SET subject = COALESCE(?2, subject), body = COALESCE(?3, body) \
         WHERE domain = ?1 AND status IN ('draft_pending','drafted')",
        params![domain, req.subject, req.body],
    )?;
    if n == 0 {
        return Err(anyhow::anyhow!("no editable draft for {domain}").into());
    }
    Ok(Json(MsgResp::ok()))
}

/// Pipeline summary: totals, the company-status funnel, and per-ICP query counts.
pub async fn overview() -> Result<Json<OverviewDto>, ApiErr> {
    let c = crate::db::open()?;
    let one = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0);
    let companies = one("SELECT count(*) FROM companies");
    let contacts = one("SELECT count(*) FROM contacts WHERE email IS NOT NULL AND mx_ok = 1");
    let drafts = one("SELECT count(*) FROM outreach WHERE status IN ('draft_pending','drafted')");
    let sent = one("SELECT count(*) FROM outreach WHERE status = 'sent'");

    let pairs = |sql: &str| -> Vec<(String, i64)> {
        c.prepare(sql)
            .and_then(|mut s| {
                s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap_or_default()
    };
    let funnel =
        pairs("SELECT status, count(*) FROM companies GROUP BY status ORDER BY count(*) DESC");
    let queries = pairs(
        "SELECT COALESCE(source_query,'—'), count(*) FROM companies GROUP BY source_query ORDER BY count(*) DESC",
    );

    Ok(Json(OverviewDto {
        companies,
        contacts,
        drafts,
        sent,
        funnel,
        queries,
    }))
}

pub async fn companies() -> Result<Json<Vec<CompanyDto>>, ApiErr> {
    let c = crate::db::open()?;
    // Attach the best contact per company (verified first, then most recent) so the
    // Pipeline row can show who we found — the only place contacts surface in the UI.
    let mut stmt = c.prepare(
        "SELECT c.domain, c.name, c.status, COALESCE(c.first_seen,''), \
                (SELECT k.founder_name FROM contacts k WHERE k.domain=c.domain AND k.email IS NOT NULL \
                   ORDER BY k.mx_ok DESC, k.found_at DESC LIMIT 1), \
                (SELECT k.email FROM contacts k WHERE k.domain=c.domain AND k.email IS NOT NULL \
                   ORDER BY k.mx_ok DESC, k.found_at DESC LIMIT 1), \
                c.source_query \
         FROM companies c ORDER BY c.first_seen DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CompanyDto {
                domain: r.get(0)?,
                name: r.get(1)?,
                status: r.get(2)?,
                first_seen: r.get(3)?,
                founder: r.get(4)?,
                email: r.get(5)?,
                source_query: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(rows))
}

/// Curate a company from the Pipeline: `skip` (exclude from outreach) or `restore`
/// (recompute its natural pre-outreach stage). DB-only — no agent involved.
pub async fn set_company_status(
    Path(domain): Path<String>,
    Json(req): Json<MarkReq>,
) -> Result<Json<MsgResp>, ApiErr> {
    use rusqlite::OptionalExtension;
    let domain = domain.to_lowercase();
    let c = crate::db::open()?;
    let new_status = match req.value.as_str() {
        "skip" => "skip".to_string(),
        "restore" => {
            let has_email: bool = c
                .query_row(
                    "SELECT 1 FROM contacts WHERE domain=?1 AND email IS NOT NULL AND mx_ok=1 LIMIT 1",
                    [&domain],
                    |_| Ok(true),
                )
                .optional()?
                .unwrap_or(false);
            let has_name: bool = c
                .query_row(
                    "SELECT 1 FROM contacts WHERE domain=?1 AND founder_name IS NOT NULL LIMIT 1",
                    [&domain],
                    |_| Ok(true),
                )
                .optional()?
                .unwrap_or(false);
            if has_email {
                "emailed".into()
            } else if has_name {
                "named".into()
            } else {
                "sourced".into()
            }
        }
        other => {
            return Err(
                anyhow::anyhow!("status value must be 'skip' or 'restore', got '{other}'").into(),
            )
        }
    };
    crate::db::set_status(&c, &domain, &new_status)?;
    Ok(Json(MsgResp::ok()))
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
        // Drafts is a work queue — only rows still awaiting action. Once a draft is
        // sent/replied/bounced it leaves this list (it lives on in Overview / Follow-ups).
        "SELECT o.domain, k.email, o.subject, o.body, o.status, o.gmail_draft_id \
         FROM outreach o LEFT JOIN contacts k ON k.id = o.contact_id \
         WHERE o.status IN ('draft_pending','drafted') \
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
