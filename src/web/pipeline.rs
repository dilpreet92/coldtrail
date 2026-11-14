//! Read-only pipeline data for the dashboard, straight from SQLite.

use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter};
use serde::Deserialize;

use super::api::{
    CompaniesPage, CompaniesQuery, CompanyDetail, CompanyDto, ContactDetail, ContactDto, DraftDto,
    DraftEditReq, FollowupDto, MarkReq, MsgResp, OutreachItem, OverviewDto,
};
use super::ApiErr;

/// One row per already-contacted domain, with days-since-send and a derived state.
pub async fn followups() -> Result<Json<Vec<FollowupDto>>, ApiErr> {
    let c = crate::db::open()?;
    Ok(Json(followup_rows(&c)?))
}

/// One pass over outreach, grouped by domain: a domain is listed once anything went out to it.
/// `to` is the address an email went to, so a company reached only on LinkedIn has none, even
/// with an email on file, and gets no drafted email follow-up. `/api/summary` runs this on
/// every poll, so no per-row subquery (that rescans outreach for each row).
const FOLLOWUPS_SQL: &str = "SELECT o.domain, \
                MAX(CASE WHEN COALESCE(o.channel,'email')='email' \
                          AND o.status IN ('sent','replied','bounced') THEN k.email END), \
                CAST(julianday('now') - julianday(MAX(o.sent_at)) AS INTEGER), \
                SUM(CASE WHEN o.status IN ('sent','replied','bounced') THEN 1 ELSE 0 END) AS sends, \
                MAX(CASE WHEN o.status='replied' THEN 1 ELSE 0 END), \
                MAX(CASE WHEN o.status='bounced' THEN 1 ELSE 0 END) \
         FROM outreach o LEFT JOIN contacts k ON k.id = o.contact_id \
         GROUP BY o.domain HAVING sends > 0 ORDER BY MAX(o.sent_at) DESC";

/// The Follow-ups rows, most recent send first. Shared with `/api/summary`, whose "due" count
/// must agree with the list it links to.
pub fn followup_rows(c: &rusqlite::Connection) -> anyhow::Result<Vec<FollowupDto>> {
    let mut stmt = c.prepare(FOLLOWUPS_SQL)?;
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
    Ok(rows)
}

/// Manually mark a contact replied / bounced (fallback to the agent reply-check), or Drafts'
/// Mark sent on an email in Gmail: that records the email only, never a LinkedIn note beside
/// it, and fails when no email waits (e.g. it was discarded in another tab).
pub async fn mark_touch(
    axum::extract::Path(domain): axum::extract::Path<String>,
    Json(req): Json<MarkReq>,
) -> Result<Json<MsgResp>, ApiErr> {
    let domain = domain.to_lowercase();
    match req.value.as_str() {
        "sent" => crate::mark::sent(&domain, Some("email"))?,
        "replied" | "bounced" => crate::mark::run(&domain, &req.value)?,
        _ => {
            return Err(anyhow::anyhow!("mark value must be 'sent', 'replied' or 'bounced'").into())
        }
    }
    Ok(Json(MsgResp::ok()))
}

/// Edit a draft's subject/body before sending (only reviewable drafts). With `channel` only that
/// channel's reviewable rows change (a legacy NULL channel is email), so saving a LinkedIn note
/// never touches the same company's email draft; without it every reviewable row for the domain
/// does, as before.
pub async fn save_draft(
    Path(domain): Path<String>,
    Json(req): Json<DraftEditReq>,
) -> Result<Response, ApiErr> {
    if req
        .channel
        .as_deref()
        .is_some_and(|ch| !matches!(ch, "email" | "linkedin"))
    {
        return Ok((StatusCode::BAD_REQUEST, "channel must be email or linkedin").into_response());
    }
    let domain = domain.to_lowercase();
    let c = crate::db::open()?;
    let n = c.execute(
        "UPDATE outreach SET subject = COALESCE(?2, subject), body = COALESCE(?3, body) \
         WHERE domain = ?1 AND status IN ('draft_pending','drafted') \
           AND (?4 IS NULL OR COALESCE(channel,'email') = ?4)",
        params![domain, req.subject, req.body, req.channel],
    )?;
    if n == 0 {
        let what = match &req.channel {
            Some(ch) => format!("{ch} draft"),
            None => "draft".into(),
        };
        return Err(anyhow::anyhow!("no editable {what} for {domain}").into());
    }
    Ok(Json(MsgResp::ok()).into_response())
}

#[derive(Deserialize)]
pub struct DiscardQuery {
    pub channel: Option<String>,
}

/// `DELETE /api/drafts/:domain?channel=email|linkedin` — throw away a domain's pending draft on
/// one channel: its reviewable rows there go (never sent history, never the other channel's
/// draft). A company never written to with no other draft waiting is set to `skip` (excluded
/// from outreach); one with sent history keeps its stage, since dropping a follow-up doesn't
/// undo what went out, and so does one whose other channel's draft still waits. `skipped` says
/// which happened. DB-only: a Gmail draft already created for a `drafted` row stays in Gmail.
pub async fn discard_draft(
    Path(domain): Path<String>,
    Query(q): Query<DiscardQuery>,
) -> Result<Response, ApiErr> {
    let Some(channel) = q
        .channel
        .as_deref()
        .filter(|ch| matches!(*ch, "email" | "linkedin"))
    else {
        return Ok((StatusCode::BAD_REQUEST, "channel must be email or linkedin").into_response());
    };
    let domain = domain.to_lowercase();
    let mut c = crate::db::open()?;
    // One transaction, so a draft never vanishes while its company stays in the queue.
    let tx = c.transaction()?;
    let n = tx.execute(
        "DELETE FROM outreach WHERE domain = ?1 AND COALESCE(channel,'email') = ?2 \
         AND status IN ('draft_pending','drafted')",
        params![domain, channel],
    )?;
    if n == 0 {
        return Ok(Json(MsgResp {
            ok: false,
            message: Some("no pending draft".into()),
            wired: None,
        })
        .into_response());
    }
    // Skip only a company left with nothing: one written to keeps its stage, and one whose
    // other channel's draft still waits stays in the queue, since that draft can still go out.
    let other_waits: bool = tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM outreach WHERE domain = ?1 \
         AND status IN ('draft_pending','drafted'))",
        [&domain],
        |r| r.get(0),
    )?;
    let skipped = !other_waits && !crate::mark::contacted(&tx, &domain)?;
    if skipped {
        crate::db::set_status(&tx, &domain, "skip")?;
    }
    tx.commit()?;
    Ok(
        Json(serde_json::json!({ "ok": true, "message": null, "skipped": skipped }))
            .into_response(),
    )
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

/// Pipeline filters as SQL conditions over `companies c` plus their bound values. `q`,
/// `stage` and `query` are always parameters, never spliced into the SQL text.
fn company_filter(
    q: Option<&str>,
    stage: Option<&str>,
    query: Option<&str>,
) -> (Vec<String>, Vec<Value>) {
    let mut conds = Vec::new();
    let mut args = Vec::new();
    if let Some(q) = q {
        args.push(Value::Text(like_pattern(q)));
        let p = format!("?{} ESCAPE '\\'", args.len());
        conds.push(format!(
            "(c.name LIKE {p} OR c.domain LIKE {p} OR EXISTS (SELECT 1 FROM contacts k \
              WHERE k.domain = c.domain AND (k.founder_name LIKE {p} OR k.email LIKE {p})))"
        ));
    }
    if let Some(stage) = stage {
        args.push(Value::Text(stage.into()));
        conds.push(format!("c.status = ?{}", args.len()));
    }
    if let Some(query) = query {
        args.push(Value::Text(query.into()));
        conds.push(format!("c.source_query = ?{}", args.len()));
    }
    (conds, args)
}

fn where_sql(conds: &[String]) -> String {
    if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    }
}

/// `%q%` for `LIKE … ESCAPE '\'`, with the user's own `%`, `_` and `\` matched literally.
fn like_pattern(q: &str) -> String {
    let mut p = String::with_capacity(q.len() + 2);
    p.push('%');
    for ch in q.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            p.push('\\');
        }
        p.push(ch);
    }
    p.push('%');
    p
}

/// (label, count) pairs from a two-column query, in the query's own order.
fn count_pairs(
    c: &rusqlite::Connection,
    sql: &str,
    args: &[Value],
) -> rusqlite::Result<Vec<(String, i64)>> {
    c.prepare(sql)?
        .query_map(params_from_iter(args), |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect()
}

/// `CompanyDto` columns over a `companies c` row, read back by `company_dto`: the best contact
/// that has an email (verified first, then most recent) and whether any contact has a LinkedIn
/// URL. Shared by the Pipeline table and the company drawer so the two never disagree.
const COMPANY_COLS: &str = "c.domain, c.name, c.status, COALESCE(c.first_seen,''), \
    (SELECT k.founder_name FROM contacts k WHERE k.domain=c.domain AND k.email IS NOT NULL \
       ORDER BY k.mx_ok DESC, k.found_at DESC LIMIT 1), \
    (SELECT k.email FROM contacts k WHERE k.domain=c.domain AND k.email IS NOT NULL \
       ORDER BY k.mx_ok DESC, k.found_at DESC LIMIT 1), \
    c.source_query, \
    EXISTS (SELECT 1 FROM contacts k WHERE k.domain=c.domain AND k.linkedin_url IS NOT NULL)";

fn company_dto(r: &rusqlite::Row) -> rusqlite::Result<CompanyDto> {
    Ok(CompanyDto {
        domain: r.get(0)?,
        name: r.get(1)?,
        status: r.get(2)?,
        first_seen: r.get(3)?,
        founder: r.get(4)?,
        email: r.get(5)?,
        source_query: r.get(6)?,
        linkedin: r.get(7)?,
    })
}

/// One page of the Pipeline table, plus the stage and "Sourced by" counts its filters show.
pub async fn companies(Query(q): Query<CompaniesQuery>) -> Result<Json<CompaniesPage>, ApiErr> {
    let page = q.page.unwrap_or(1).max(1);
    let per = q.per.unwrap_or(50).clamp(1, 200);
    let search = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let stage = q.stage.as_deref().filter(|s| !s.is_empty());
    let query = q.query.as_deref().filter(|s| !s.is_empty());
    let c = crate::db::open()?;

    // One WHERE for both the total and the page, so the footer count matches the rows.
    let (conds, mut args) = company_filter(search, stage, query);
    let filter = where_sql(&conds);
    let total: i64 = c.query_row(
        &format!("SELECT count(*) FROM companies c {filter}"),
        params_from_iter(&args),
        |r| r.get(0),
    )?;

    // Slice the page first, then attach the best contact per company (verified first, then
    // most recent) and the LinkedIn flag — so those lookups only run for the rows shown.
    args.push(Value::Integer(per.into()));
    args.push(Value::Integer((i64::from(page) - 1) * i64::from(per)));
    let (limit, offset) = (args.len() - 1, args.len());
    let mut stmt = c.prepare(&format!(
        "SELECT {COMPANY_COLS} \
         FROM (SELECT c.domain, c.name, c.status, c.first_seen, c.source_query FROM companies c \
               {filter} ORDER BY c.first_seen DESC, c.domain ASC LIMIT ?{limit} OFFSET ?{offset}) c \
         ORDER BY c.first_seen DESC, c.domain ASC"
    ))?;
    let rows = stmt
        .query_map(params_from_iter(&args), company_dto)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Stage tabs keep their counts whichever tab is selected: `q` + `query`, not `stage`.
    let (conds, args) = company_filter(search, None, query);
    let stages = count_pairs(
        &c,
        &format!(
            "SELECT c.status, count(*) FROM companies c {} \
             GROUP BY c.status ORDER BY count(*) DESC, c.status ASC",
            where_sql(&conds)
        ),
        &args,
    )?;

    // "Sourced by" options narrow only with `q`. A missing source can't be picked as a
    // filter value, so it isn't offered as one.
    let (mut conds, args) = company_filter(search, None, None);
    conds.push("c.source_query IS NOT NULL AND c.source_query <> ''".into());
    let queries = count_pairs(
        &c,
        &format!(
            "SELECT c.source_query, count(*) FROM companies c {} \
             GROUP BY c.source_query ORDER BY count(*) DESC, c.source_query ASC",
            where_sql(&conds)
        ),
        &args,
    )?;

    Ok(Json(CompaniesPage {
        total,
        page,
        per,
        rows,
        stages,
        queries,
    }))
}

/// Everything the Pipeline company drawer shows for one domain: its Pipeline row, every
/// contact, and the outreach history on every channel. An unknown domain is a 404.
pub async fn company_detail(Path(domain): Path<String>) -> Result<Response, ApiErr> {
    use rusqlite::OptionalExtension;
    let domain = domain.to_lowercase();
    let c = crate::db::open()?;
    let Some(company) = c
        .query_row(
            &format!("SELECT {COMPANY_COLS} FROM companies c WHERE c.domain = ?1"),
            [&domain],
            company_dto,
        )
        .optional()?
    else {
        return Ok((StatusCode::NOT_FOUND, "not found").into_response());
    };
    // Verified first, then newest — the same preference that picks the row's best contact.
    let contacts = c
        .prepare(
            "SELECT founder_name, role, email, email_confidence, COALESCE(mx_ok,0), linkedin_url \
             FROM contacts WHERE domain = ?1 ORDER BY mx_ok DESC, found_at DESC, id DESC",
        )?
        .query_map([&domain], |r| {
            Ok(ContactDetail {
                founder_name: r.get(0)?,
                role: r.get(1)?,
                email: r.get(2)?,
                email_confidence: r.get(3)?,
                mx_ok: r.get::<_, i64>(4)? != 0,
                linkedin_url: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let outreach = c
        .prepare(
            "SELECT COALESCE(channel,'email'), status, created_at, sent_at, subject \
             FROM outreach WHERE domain = ?1 ORDER BY created_at DESC, id DESC",
        )?
        .query_map([&domain], |r| {
            Ok(OutreachItem {
                channel: r.get(0)?,
                status: r.get(1)?,
                created_at: r.get(2)?,
                sent_at: r.get(3)?,
                subject: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(CompanyDetail {
        company,
        contacts,
        outreach,
    })
    .into_response())
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
        // `to` is the contact email for the email channel, or the contact's linkedin_url for
        // the linkedin channel — same recipient rule as `deliver::reviewable`. A blank contact
        // or company name reads as unknown (null).
        "SELECT o.domain, COALESCE(o.channel,'email'), \
                CASE WHEN COALESCE(o.channel,'email')='linkedin' THEN k.linkedin_url ELSE k.email END, \
                o.subject, o.body, o.status, o.gmail_draft_id, o.auto_skip, \
                NULLIF(TRIM(k.founder_name),''), NULLIF(TRIM(co.name),'') \
         FROM outreach o LEFT JOIN contacts k ON k.id = o.contact_id \
         LEFT JOIN companies co ON co.domain = o.domain \
         WHERE o.status IN ('draft_pending','drafted') \
         ORDER BY o.created_at DESC, o.id DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DraftDto {
                domain: r.get(0)?,
                channel: r.get(1)?,
                to: r.get(2)?,
                subject: r.get(3)?,
                body: r.get(4)?,
                status: r.get(5)?,
                gmail_draft_id: r.get(6)?,
                auto_skip: r.get(7)?,
                contact_name: r.get(8)?,
                company_name: r.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(sql: &str) {
        crate::db::init().unwrap();
        crate::db::open().unwrap().execute_batch(sql).unwrap();
    }

    fn list(q: CompaniesQuery) -> CompaniesPage {
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(companies(Query(q)))
            .unwrap()
            .0
    }

    fn domains(p: &CompaniesPage) -> Vec<&str> {
        p.rows.iter().map(|r| r.domain.as_str()).collect()
    }

    fn pairs(v: &[(&str, i64)]) -> Vec<(String, i64)> {
        v.iter().map(|(s, n)| (s.to_string(), *n)).collect()
    }

    /// Five companies, newest first (ties broken by domain); `per`/`page` slice them and
    /// out-of-range values are pulled back to the documented bounds.
    #[test]
    fn companies_paginates_and_reports_total() {
        crate::testutil::with_home("ct-web-pipeline-companies-page", |_| {
            seed(
                "INSERT INTO companies (domain, first_seen) VALUES \
                 ('e.com','2026-10-01 09:00:00'), ('d.com','2026-10-02 09:00:00'), \
                 ('c.com','2026-10-03 09:00:00'), ('b.com','2026-10-04 09:00:00'), \
                 ('a.com','2026-10-04 09:00:00');",
            );
            let all = list(CompaniesQuery::default());
            assert_eq!((all.total, all.page, all.per), (5, 1, 50));
            assert_eq!(domains(&all), ["a.com", "b.com", "c.com", "d.com", "e.com"]);

            let p2 = list(CompaniesQuery {
                per: Some(2),
                page: Some(2),
                ..Default::default()
            });
            assert_eq!((p2.total, p2.page, p2.per), (5, 2, 2));
            assert_eq!(domains(&p2), ["c.com", "d.com"]);

            let p3 = list(CompaniesQuery {
                per: Some(2),
                page: Some(3),
                ..Default::default()
            });
            assert_eq!(domains(&p3), ["e.com"]);

            let big = list(CompaniesQuery {
                per: Some(999),
                ..Default::default()
            });
            assert_eq!((big.per, big.rows.len()), (200, 5));

            let zero = list(CompaniesQuery {
                page: Some(0),
                per: Some(0),
                ..Default::default()
            });
            assert_eq!((zero.page, zero.per), (1, 1));
            assert_eq!(domains(&zero), ["a.com"]);
        });
    }

    /// `q` searches company name, domain and any contact's name/email, case-insensitively;
    /// LIKE wildcards in `q` are literal, and a blank `q` is no filter at all.
    #[test]
    fn companies_q_matches_name_domain_and_contact() {
        crate::testutil::with_home("ct-web-pipeline-companies-q", |_| {
            seed(
                "INSERT INTO companies (domain, name, first_seen) VALUES \
                 ('acme.com','Acme Ltd','2026-10-03'), ('beta.io','Beta','2026-10-02'), \
                 ('gamma.dev','Gamma','2026-10-01'); \
                 INSERT INTO contacts (domain, founder_name, email) VALUES \
                 ('gamma.dev','Jane Roe','jane@gamma.dev'), ('gamma.dev','Jane Two',NULL), \
                 ('beta.io','Bob','hello@bobmail.net');",
            );
            let hits = |q: &str| {
                let p = list(CompaniesQuery {
                    q: Some(q.into()),
                    ..Default::default()
                });
                assert_eq!(p.total as usize, p.rows.len(), "total for {q:?}");
                domains(&p)
                    .into_iter()
                    .map(String::from)
                    .collect::<Vec<_>>()
            };
            assert_eq!(hits("ACME"), ["acme.com"]);
            assert_eq!(hits("beta.io"), ["beta.io"]);
            // Two matching contacts on one company still yield one row.
            assert_eq!(hits("jane"), ["gamma.dev"]);
            assert_eq!(hits("BOBMAIL"), ["beta.io"]);
            assert_eq!(hits("  "), ["acme.com", "beta.io", "gamma.dev"]);
            assert_eq!(hits("%"), Vec::<String>::new());
            assert_eq!(hits("a_m"), Vec::<String>::new());
        });
    }

    /// `stage` and `query` filter exactly; `stages` ignores `stage` (so every tab keeps
    /// its count) and `queries` ignores both, but both honour `q`.
    #[test]
    fn companies_stage_and_query_filters_with_counts() {
        crate::testutil::with_home("ct-web-pipeline-companies-filters", |_| {
            seed(
                "INSERT INTO companies (domain, name, status, source_query, first_seen) VALUES \
                 ('a.com','A','sent','Q1','2026-10-06'), ('b.com','B','sent','Q2','2026-10-05'), \
                 ('c.com','C','sourced','Q1','2026-10-04'), ('d.com','D','emailed','Q1','2026-10-03'), \
                 ('e.com','Zed','sourced','Q2','2026-10-02'), ('f.com','F','sourced',NULL,'2026-10-01');",
            );
            let sent = list(CompaniesQuery {
                stage: Some("sent".into()),
                ..Default::default()
            });
            assert_eq!(sent.total, 2);
            assert_eq!(domains(&sent), ["a.com", "b.com"]);
            assert_eq!(
                sent.stages,
                pairs(&[("sourced", 3), ("sent", 2), ("emailed", 1)])
            );
            // Unsourced companies can't be picked as a filter, so they aren't offered.
            assert_eq!(sent.queries, pairs(&[("Q1", 3), ("Q2", 2)]));

            let sent_q1 = list(CompaniesQuery {
                stage: Some("sent".into()),
                query: Some("Q1".into()),
                ..Default::default()
            });
            assert_eq!(domains(&sent_q1), ["a.com"]);
            assert_eq!(sent_q1.total, 1);
            assert_eq!(
                sent_q1.stages,
                pairs(&[("emailed", 1), ("sent", 1), ("sourced", 1)])
            );
            assert_eq!(sent_q1.queries, pairs(&[("Q1", 3), ("Q2", 2)]));

            let zed = list(CompaniesQuery {
                q: Some("zed".into()),
                ..Default::default()
            });
            assert_eq!(zed.stages, pairs(&[("sourced", 1)]));
            assert_eq!(zed.queries, pairs(&[("Q2", 1)]));

            // Empty filter values (as a URL like `?stage=&query=` sends them) filter nothing.
            let blank = list(CompaniesQuery {
                stage: Some(String::new()),
                query: Some(String::new()),
                ..Default::default()
            });
            assert_eq!(blank.total, 6);
        });
    }

    /// `linkedin` is true when any contact for the domain has a LinkedIn URL, even one with
    /// no email; `founder`/`email` still come from the best contact that has an email.
    #[test]
    fn companies_flags_linkedin_contacts() {
        crate::testutil::with_home("ct-web-pipeline-companies-linkedin", |_| {
            seed(
                "INSERT INTO companies (domain, first_seen) VALUES \
                 ('li.com','2026-10-03'), ('mail.com','2026-10-02'), ('none.com','2026-10-01'); \
                 INSERT INTO contacts (domain, founder_name, linkedin_url) VALUES \
                 ('li.com','Lia','https://www.linkedin.com/in/lia'); \
                 INSERT INTO contacts (domain, founder_name, email, mx_ok, found_at) VALUES \
                 ('mail.com','Old','old@mail.com',1,'2026-10-01'), \
                 ('mail.com','New','new@mail.com',1,'2026-10-02'), \
                 ('mail.com','Bad','bad@mail.com',0,'2026-10-03');",
            );
            let p = list(CompaniesQuery::default());
            let row = |d: &str| p.rows.iter().find(|r| r.domain == d).unwrap();
            assert!(row("li.com").linkedin);
            assert_eq!(row("li.com").founder, None);
            assert!(!row("mail.com").linkedin);
            assert_eq!(row("mail.com").founder.as_deref(), Some("New"));
            assert_eq!(row("mail.com").email.as_deref(), Some("new@mail.com"));
            assert!(!row("none.com").linkedin);
        });
    }

    /// GET through the real router (token guard + route table) → (status, body text).
    fn get(uri: &str) -> (axum::http::StatusCode, String) {
        call("GET", uri)
    }

    /// `method uri` through the real router, with the session token added to the query string.
    fn call(method: &str, uri: &str) -> (axum::http::StatusCode, String) {
        call_with(method, uri, None)
    }

    /// `call` with an optional JSON request body.
    fn call_with(
        method: &str,
        uri: &str,
        json: Option<serde_json::Value>,
    ) -> (axum::http::StatusCode, String) {
        use tower::ServiceExt;
        let rt = tokio::runtime::Runtime::new().unwrap();
        let app = crate::web::router(crate::web::tests::state());
        let sep = if uri.contains('?') { '&' } else { '?' };
        let builder = axum::http::Request::builder()
            .method(method)
            .uri(format!("{uri}{sep}t=secret-tok"));
        let req = match json {
            Some(v) => builder
                .header("content-type", "application/json")
                .body(axum::body::Body::from(v.to_string())),
            None => builder.body(axum::body::Body::empty()),
        }
        .unwrap();
        let resp = rt.block_on(app.oneshot(req)).unwrap();
        let status = resp.status();
        let body = rt
            .block_on(axum::body::to_bytes(resp.into_body(), usize::MAX))
            .unwrap();
        (status, String::from_utf8(body.to_vec()).unwrap())
    }

    /// The drawer's company row matches the Pipeline row (best emailed contact, LinkedIn flag);
    /// contacts list verified first then newest, outreach newest first across channels (a legacy
    /// NULL channel reads as email), and nothing leaks in from another domain. The URL's domain
    /// is lowercased before lookup.
    #[test]
    fn company_detail_returns_contacts_and_outreach() {
        crate::testutil::with_home("ct-web-pipeline-company-detail", |_| {
            seed(
                "INSERT INTO companies (domain, name, status, source_query, first_seen) VALUES \
                 ('acme.com','Acme','sent','ICP one','2026-10-01 09:00:00'), \
                 ('other.com','Other','sourced','ICP two','2026-10-02 09:00:00'); \
                 INSERT INTO contacts (domain, founder_name, role, email, email_confidence, mx_ok, \
                                       linkedin_url, found_at) VALUES \
                 ('acme.com','Old Verified','CEO','old@acme.com','direct',1,NULL,'2026-10-01'), \
                 ('acme.com','New Verified','CTO','new@acme.com','inferred',1,NULL,'2026-10-02'), \
                 ('acme.com','Li Only',NULL,NULL,NULL,NULL,'https://www.linkedin.com/in/li','2026-10-03'), \
                 ('other.com','Not Me','CEO','me@other.com','direct',1,NULL,'2026-10-04'); \
                 INSERT INTO outreach (domain, channel, subject, status, created_at, sent_at) VALUES \
                 ('acme.com',NULL,'first','replied','2026-10-01 10:00:00','2026-10-01 11:00:00'), \
                 ('acme.com','linkedin',NULL,'draft_pending','2026-10-04 10:00:00',NULL), \
                 ('acme.com','email','hi','sent','2026-10-02 10:00:00','2026-10-02 11:00:00'), \
                 ('other.com','email','nope','sent','2026-10-05 10:00:00','2026-10-05 11:00:00');",
            );
            let (status, body) = get("/api/companies/ACME.com");
            assert_eq!(status, axum::http::StatusCode::OK, "{body}");
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!(
                v["company"],
                serde_json::json!({
                    "domain": "acme.com", "name": "Acme", "status": "sent",
                    "first_seen": "2026-10-01 09:00:00", "founder": "New Verified",
                    "email": "new@acme.com", "source_query": "ICP one", "linkedin": true,
                })
            );
            assert_eq!(
                v["contacts"],
                serde_json::json!([
                    {"founder_name": "New Verified", "role": "CTO", "email": "new@acme.com",
                     "email_confidence": "inferred", "mx_ok": true, "linkedin_url": null},
                    {"founder_name": "Old Verified", "role": "CEO", "email": "old@acme.com",
                     "email_confidence": "direct", "mx_ok": true, "linkedin_url": null},
                    {"founder_name": "Li Only", "role": null, "email": null,
                     "email_confidence": null, "mx_ok": false,
                     "linkedin_url": "https://www.linkedin.com/in/li"},
                ])
            );
            assert_eq!(
                v["outreach"],
                serde_json::json!([
                    {"channel": "linkedin", "status": "draft_pending",
                     "created_at": "2026-10-04 10:00:00", "sent_at": null, "subject": null},
                    {"channel": "email", "status": "sent", "created_at": "2026-10-02 10:00:00",
                     "sent_at": "2026-10-02 11:00:00", "subject": "hi"},
                    {"channel": "email", "status": "replied", "created_at": "2026-10-01 10:00:00",
                     "sent_at": "2026-10-01 11:00:00", "subject": "first"},
                ])
            );
        });
    }

    /// An unknown domain is a plain 404 (not a 500, not an empty 200), so the drawer can say so.
    #[test]
    fn company_detail_404_for_unknown_domain() {
        crate::testutil::with_home("ct-web-pipeline-company-detail-404", |_| {
            seed("INSERT INTO companies (domain) VALUES ('acme.com');");
            let (status, body) = get("/api/companies/nope.com");
            assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
            assert_eq!(body, "not found");
        });
    }

    /// The UI mirrors its URL state, so `?page=&per=` must mean "use the defaults" rather
    /// than a 400; the session token `t` rides along and is ignored.
    #[test]
    fn companies_query_blank_numbers_use_defaults() {
        let uri: axum::http::Uri = "/api/companies?q=&page=&per=&stage=&t=tok".parse().unwrap();
        let Query(q) = Query::<CompaniesQuery>::try_from_uri(&uri).unwrap();
        assert_eq!((q.page, q.per), (None, None));
        let uri: axum::http::Uri = "/api/companies?page=3&per=20".parse().unwrap();
        let Query(q) = Query::<CompaniesQuery>::try_from_uri(&uri).unwrap();
        assert_eq!((q.page, q.per), (Some(3), Some(20)));
        let uri: axum::http::Uri = "/api/companies?page=x".parse().unwrap();
        assert!(Query::<CompaniesQuery>::try_from_uri(&uri).is_err());
    }

    /// A linkedin-channel row surfaces its contact's `linkedin_url` as `to` and `channel` as
    /// "linkedin"; a plain (legacy, channel=NULL) email row keeps `to` = email and defaults to
    /// "email" — the two branches the Drafts UI switches its rendering on.
    #[test]
    fn drafts_reports_channel_and_picks_recipient_by_channel() {
        crate::testutil::with_home("ct-web-pipeline-drafts-channel", |_| {
            crate::db::init().unwrap();
            let c = crate::db::open().unwrap();
            c.execute(
                "INSERT INTO companies (domain, source_query) VALUES ('acme.com','q'), ('beta.com','q')",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO contacts (domain, founder_name, linkedin_url) \
                 VALUES ('acme.com','Jane','https://www.linkedin.com/in/janedoe')",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO contacts (domain, founder_name, email) VALUES ('beta.com','Bob','bob@beta.com')",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO outreach (domain, contact_id, channel, subject, body, status) \
                 VALUES ('acme.com', (SELECT id FROM contacts WHERE domain='acme.com'), \
                 'linkedin', '', 'Hi Jane', 'draft_pending')",
                [],
            )
            .unwrap();
            // Legacy row: channel left NULL, as pre-dates the linkedin feature.
            c.execute(
                "INSERT INTO outreach (domain, contact_id, subject, body, status) \
                 VALUES ('beta.com', (SELECT id FROM contacts WHERE domain='beta.com'), \
                 'hi', 'Hi Bob', 'draft_pending')",
                [],
            )
            .unwrap();

            let rows = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(drafts())
                .unwrap()
                .0;
            assert_eq!(rows.len(), 2);
            let li = rows.iter().find(|r| r.domain == "acme.com").unwrap();
            assert_eq!(li.channel, "linkedin");
            assert_eq!(
                li.to.as_deref(),
                Some("https://www.linkedin.com/in/janedoe")
            );
            let email = rows.iter().find(|r| r.domain == "beta.com").unwrap();
            assert_eq!(email.channel, "email");
            assert_eq!(email.to.as_deref(), Some("bob@beta.com"));
            assert_eq!(li.auto_skip, None);
        });
    }

    /// Each draft names its contact and company for the Drafts list — for a LinkedIn-only
    /// contact (no email) as much as an emailed one. Unknown or blank names are null.
    #[test]
    fn drafts_name_the_contact_and_company() {
        crate::testutil::with_home("ct-web-pipeline-drafts-names", |_| {
            seed(
                "INSERT INTO companies (domain, name) VALUES ('acme.com','Acme'), \
                 ('beta.com','Beta Inc'), ('anon.com',NULL); \
                 INSERT INTO contacts (domain, founder_name, linkedin_url) VALUES \
                 ('acme.com','Jane Doe','https://www.linkedin.com/in/janedoe'); \
                 INSERT INTO contacts (domain, founder_name, email) VALUES \
                 ('beta.com','Bob Ray','bob@beta.com'); \
                 INSERT INTO outreach (domain, contact_id, channel, body, status) VALUES \
                 ('acme.com',(SELECT id FROM contacts WHERE domain='acme.com'),'linkedin','Hi Jane','draft_pending'), \
                 ('beta.com',(SELECT id FROM contacts WHERE domain='beta.com'),'email','Hi Bob','drafted'), \
                 ('anon.com',NULL,'email','Hi','draft_pending'); \
                 INSERT INTO companies (domain, name) VALUES ('blank.com','  '); \
                 INSERT INTO contacts (domain, founder_name, email) VALUES \
                 ('blank.com','','x@blank.com'); \
                 INSERT INTO outreach (domain, contact_id, channel, body, status) VALUES \
                 ('blank.com',(SELECT id FROM contacts WHERE domain='blank.com'),'email','Hi','draft_pending');",
            );
            let (status, body) = call("GET", "/api/drafts");
            assert_eq!(status, axum::http::StatusCode::OK, "{body}");
            let rows: Vec<serde_json::Value> = serde_json::from_str(&body).unwrap();
            let by = |d: &str| rows.iter().find(|r| r["domain"] == d).unwrap().clone();
            let li = by("acme.com");
            assert_eq!(li["channel"], "linkedin");
            assert_eq!(li["contact_name"], "Jane Doe");
            assert_eq!(li["company_name"], "Acme");
            let email = by("beta.com");
            assert_eq!(email["contact_name"], "Bob Ray");
            assert_eq!(email["company_name"], "Beta Inc");
            let anon = by("anon.com");
            assert_eq!(anon["contact_name"], serde_json::Value::Null);
            assert_eq!(anon["company_name"], serde_json::Value::Null);
            let blank = by("blank.com");
            assert_eq!(blank["contact_name"], serde_json::Value::Null);
            assert_eq!(blank["company_name"], serde_json::Value::Null);
        });
    }

    /// A LinkedIn draft parked out of auto-send still shows in Drafts (the human can send it by
    /// hand) and carries the reason, so the UI can say why it was skipped.
    #[test]
    fn drafts_surface_why_auto_send_skipped_a_draft() {
        crate::testutil::with_home("ct-web-pipeline-drafts-autoskip", |_| {
            crate::db::init().unwrap();
            let c = crate::db::open().unwrap();
            c.execute(
                "INSERT INTO companies (domain, source_query) VALUES ('acme.com','q')",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO outreach (domain, channel, body, status, auto_skip) \
                 VALUES ('acme.com','linkedin','Hi','draft_pending','LinkedIn asks for their email')",
                [],
            )
            .unwrap();
            let rows = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(drafts())
                .unwrap()
                .0;
            assert_eq!(
                rows[0].auto_skip.as_deref(),
                Some("LinkedIn asks for their email")
            );
        });
    }

    /// (channel, status) of every outreach row for `domain`, oldest first; NULL reads as email.
    fn outreach_of(domain: &str) -> Vec<(String, String)> {
        crate::db::open()
            .unwrap()
            .prepare(
                "SELECT COALESCE(channel,'email'), status FROM outreach WHERE domain = ?1 ORDER BY id",
            )
            .unwrap()
            .query_map([domain], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn status_of(domain: &str) -> String {
        crate::db::open()
            .unwrap()
            .query_row(
                "SELECT status FROM companies WHERE domain = ?1",
                [domain],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn rows(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    /// Discard deletes only the reviewable (draft_pending/drafted) rows on the named channel for
    /// that domain — the other channel's draft, sent history and other domains are untouched.
    /// A company never contacted is skipped so it leaves the queue; one with sent history keeps
    /// its stage. A legacy NULL channel counts as email.
    #[test]
    fn discard_removes_only_pending_rows_on_that_channel() {
        crate::testutil::with_home("ct-web-pipeline-discard", |_| {
            seed(
                "INSERT INTO companies (domain, status) VALUES \
                 ('acme.com','sent'), ('other.com','drafted'), ('fresh.com','drafted'); \
                 INSERT INTO outreach (domain, channel, body, status) VALUES \
                 ('acme.com','linkedin','note','draft_pending'), \
                 ('acme.com','email','hi','draft_pending'), \
                 ('acme.com','linkedin','old note','sent'), \
                 ('acme.com',NULL,'legacy','drafted'), \
                 ('other.com','linkedin','theirs','draft_pending'), \
                 ('fresh.com','email','first','draft_pending');",
            );
            let (status, body) = call("DELETE", "/api/drafts/ACME.com?channel=linkedin");
            assert_eq!(status, axum::http::StatusCode::OK, "{body}");
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!(
                v,
                serde_json::json!({"ok": true, "message": null, "skipped": false})
            );
            assert_eq!(
                outreach_of("acme.com"),
                rows(&[
                    ("email", "draft_pending"),
                    ("linkedin", "sent"),
                    ("email", "drafted")
                ])
            );
            assert_eq!(status_of("acme.com"), "sent");
            assert_eq!(
                outreach_of("other.com"),
                rows(&[("linkedin", "draft_pending")])
            );
            assert_eq!(status_of("other.com"), "drafted");

            // Email takes the legacy NULL-channel draft with it; the sent LinkedIn row stays.
            let (status, body) = call("DELETE", "/api/drafts/acme.com?channel=email");
            assert_eq!(status, axum::http::StatusCode::OK, "{body}");
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!(v["ok"], true);
            assert_eq!(outreach_of("acme.com"), rows(&[("linkedin", "sent")]));
            assert_eq!(status_of("acme.com"), "sent");

            // A company never written to leaves the queue as skipped, and the reply says so.
            let (status, body) = call("DELETE", "/api/drafts/fresh.com?channel=email");
            assert_eq!(status, axum::http::StatusCode::OK, "{body}");
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!((&v["ok"], &v["skipped"]), (&true.into(), &true.into()));
            assert!(outreach_of("fresh.com").is_empty());
            assert_eq!(status_of("fresh.com"), "skip");
        });
    }

    /// A company nothing has gone out to, with an email and a LinkedIn note waiting: discarding
    /// one leaves the other to review and send, so the company isn't skipped (that would show
    /// it as Skip with a draft still queued). Discarding the last one skips it.
    #[test]
    fn discarding_one_channel_keeps_the_company_while_its_other_draft_waits() {
        crate::testutil::with_home("ct-web-pipeline-discard-other", |_| {
            seed(
                "INSERT INTO companies (domain, status) VALUES ('fresh.com','drafted'); \
                 INSERT INTO outreach (domain, channel, body, status) VALUES \
                 ('fresh.com','email','first','draft_pending'), \
                 ('fresh.com','linkedin','note','drafted');",
            );
            let (status, body) = call("DELETE", "/api/drafts/fresh.com?channel=linkedin");
            assert_eq!(status, axum::http::StatusCode::OK, "{body}");
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!((&v["ok"], &v["skipped"]), (&true.into(), &false.into()));
            assert_eq!(
                outreach_of("fresh.com"),
                rows(&[("email", "draft_pending")])
            );
            assert_eq!(status_of("fresh.com"), "drafted");

            let (status, body) = call("DELETE", "/api/drafts/fresh.com?channel=email");
            assert_eq!(status, axum::http::StatusCode::OK, "{body}");
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!((&v["ok"], &v["skipped"]), (&true.into(), &true.into()));
            assert!(outreach_of("fresh.com").is_empty());
            assert_eq!(status_of("fresh.com"), "skip");
        });
    }

    /// Discarding the follow-up `coldtrail followup` stored for an emailed company leaves the
    /// company `sent`: it stays on Pipeline's Sent tab, and Follow-ups still lists it.
    #[test]
    fn discarding_a_follow_up_keeps_the_company_sent() {
        crate::testutil::with_home("ct-web-pipeline-discard-followup", |_| {
            seed(
                "INSERT INTO companies (domain, status) VALUES ('acme.com','sent'); \
                 INSERT INTO contacts (domain, founder_name, email) VALUES ('acme.com','Ann','ann@acme.com'); \
                 INSERT INTO outreach (domain, contact_id, channel, subject, status, sent_at) VALUES \
                 ('acme.com',1,'email','Quick idea','sent',datetime('now','-6 days'));",
            );
            crate::draft::followup_add("acme.com", "Re: Quick idea", "Following up").unwrap();
            let (status, body) = call("DELETE", "/api/drafts/acme.com?channel=email");
            assert_eq!(status, axum::http::StatusCode::OK, "{body}");
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!(v["skipped"], false, "{body}");
            assert_eq!(outreach_of("acme.com"), rows(&[("email", "sent")]));
            assert_eq!(status_of("acme.com"), "sent");
            let c = crate::db::open().unwrap();
            let f = followup_rows(&c).unwrap();
            assert_eq!(
                f.iter()
                    .map(|f| (f.domain.as_str(), f.state.as_str()))
                    .collect::<Vec<_>>(),
                [("acme.com", "due")]
            );
        });
    }

    /// `to` is the address an email went to. A company reached only on LinkedIn has no email
    /// to follow up, even with an address on file, so it offers no drafted email follow-up.
    #[test]
    fn followups_to_is_only_an_address_that_was_emailed() {
        crate::testutil::with_home("ct-web-pipeline-followups-to", |_| {
            seed(
                "INSERT INTO companies (domain, status) VALUES ('li.com','sent'), ('em.com','sent'); \
                 INSERT INTO contacts (id, domain, founder_name, email, linkedin_url) VALUES \
                 (1,'li.com','Lee','lee@li.com','https://www.linkedin.com/in/lee'), \
                 (2,'em.com','Em','em@em.com',NULL); \
                 INSERT INTO outreach (domain, contact_id, channel, status, sent_at) VALUES \
                 ('li.com',1,'linkedin','sent',datetime('now','-6 days')), \
                 ('em.com',2,NULL,'sent',datetime('now','-5 days')), \
                 ('em.com',2,'linkedin','draft_pending',NULL);",
            );
            let c = crate::db::open().unwrap();
            let got: Vec<(String, Option<String>, i64, String)> = followup_rows(&c)
                .unwrap()
                .into_iter()
                .map(|f| (f.domain, f.to, f.touches, f.state))
                .collect();
            assert_eq!(
                got,
                [
                    ("em.com".into(), Some("em@em.com".into()), 1, "due".into()),
                    ("li.com".into(), None, 1, "due".into()),
                ]
            );
        });
    }

    /// `/api/summary` reads the follow-ups on every poll, so the query is one pass over
    /// outreach: no per-row subquery rescanning the table (quadratic on a big workspace).
    #[test]
    fn followups_query_has_no_correlated_subquery() {
        crate::testutil::with_home("ct-web-pipeline-followups-plan", |_| {
            seed("");
            let c = crate::db::open().unwrap();
            let plan: Vec<String> = c
                .prepare(&format!("EXPLAIN QUERY PLAN {FOLLOWUPS_SQL}"))
                .unwrap()
                .query_map([], |r| r.get::<_, String>(3))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            assert!(
                plan.iter().all(|step| !step.contains("CORRELATED")),
                "{plan:?}"
            );
        });
    }

    /// Nothing reviewable on that channel (only sent history, a draft on the other channel, or
    /// an unknown domain) is `ok:false` with a reason — and changes neither rows nor status.
    #[test]
    fn discard_without_pending_returns_ok_false() {
        crate::testutil::with_home("ct-web-pipeline-discard-none", |_| {
            seed(
                "INSERT INTO companies (domain, status) VALUES ('acme.com','sent'); \
                 INSERT INTO outreach (domain, channel, status) VALUES \
                 ('acme.com','email','sent'), ('acme.com','linkedin','draft_pending');",
            );
            for uri in [
                "/api/drafts/acme.com?channel=email",
                "/api/drafts/nope.com?channel=linkedin",
            ] {
                let (status, body) = call("DELETE", uri);
                assert_eq!(status, axum::http::StatusCode::OK, "{uri}: {body}");
                let v: serde_json::Value = serde_json::from_str(&body).unwrap();
                assert_eq!(
                    v,
                    serde_json::json!({"ok": false, "message": "no pending draft"}),
                    "{uri}"
                );
            }
            assert_eq!(
                outreach_of("acme.com"),
                rows(&[("email", "sent"), ("linkedin", "draft_pending")])
            );
            assert_eq!(status_of("acme.com"), "sent");
        });
    }

    /// (channel, subject, body) of every outreach row for `domain`, oldest first.
    fn texts_of(domain: &str) -> Vec<(String, Option<String>, Option<String>)> {
        crate::db::open()
            .unwrap()
            .prepare(
                "SELECT COALESCE(channel,'email'), subject, body FROM outreach WHERE domain = ?1 \
                 ORDER BY id",
            )
            .unwrap()
            .query_map([domain], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn text(
        ch: &str,
        subject: Option<&str>,
        body: &str,
    ) -> (String, Option<String>, Option<String>) {
        (ch.into(), subject.map(Into::into), Some(body.into()))
    }

    /// Saving with a `channel` edits only that channel's reviewable draft (a legacy NULL channel
    /// is email), so autosaving a LinkedIn note can't overwrite the same company's email. Sent
    /// history is never edited.
    #[test]
    fn save_draft_with_channel_edits_only_that_channel() {
        crate::testutil::with_home("ct-web-pipeline-save-channel", |_| {
            seed(
                "INSERT INTO companies (domain, status) VALUES ('acme.com','drafted'); \
                 INSERT INTO outreach (domain, channel, subject, body, status) VALUES \
                 ('acme.com','email','Hi','email body','draft_pending'), \
                 ('acme.com','linkedin','','note','draft_pending'), \
                 ('acme.com','linkedin','','old note','sent'), \
                 ('acme.com',NULL,'Legacy','legacy body','drafted');",
            );
            let (status, body) = call_with(
                "POST",
                "/api/drafts/ACME.com",
                Some(serde_json::json!({"body": "new note", "channel": "linkedin"})),
            );
            assert_eq!(status, axum::http::StatusCode::OK, "{body}");
            assert_eq!(
                texts_of("acme.com"),
                [
                    text("email", Some("Hi"), "email body"),
                    text("linkedin", Some(""), "new note"),
                    text("linkedin", Some(""), "old note"),
                    text("email", Some("Legacy"), "legacy body"),
                ]
            );

            let (status, body) = call_with(
                "POST",
                "/api/drafts/acme.com",
                Some(
                    serde_json::json!({"subject": "Hello", "body": "new email", "channel": "email"}),
                ),
            );
            assert_eq!(status, axum::http::StatusCode::OK, "{body}");
            assert_eq!(
                texts_of("acme.com"),
                [
                    text("email", Some("Hello"), "new email"),
                    text("linkedin", Some(""), "new note"),
                    text("linkedin", Some(""), "old note"),
                    text("email", Some("Hello"), "new email"),
                ]
            );
        });
    }

    /// Without a `channel` the save keeps its original contract: every reviewable row for the
    /// domain. A channel with nothing reviewable is an error; an unknown channel is a 400.
    #[test]
    fn save_draft_without_channel_keeps_editing_every_reviewable_row() {
        crate::testutil::with_home("ct-web-pipeline-save-nochannel", |_| {
            seed(
                "INSERT INTO companies (domain, status) VALUES ('acme.com','drafted'); \
                 INSERT INTO outreach (domain, channel, subject, body, status) VALUES \
                 ('acme.com','email','Hi','email body','draft_pending'), \
                 ('acme.com','linkedin','','old note','sent');",
            );
            let (status, body) = call_with(
                "POST",
                "/api/drafts/acme.com",
                Some(serde_json::json!({"body": "both"})),
            );
            assert_eq!(status, axum::http::StatusCode::OK, "{body}");
            assert_eq!(
                texts_of("acme.com"),
                [
                    text("email", Some("Hi"), "both"),
                    text("linkedin", Some(""), "old note"),
                ]
            );

            let (status, body) = call_with(
                "POST",
                "/api/drafts/acme.com",
                Some(serde_json::json!({"body": "x", "channel": "linkedin"})),
            );
            assert_eq!(
                status,
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "{body}"
            );
            assert_eq!(body, "no editable linkedin draft for acme.com");

            let (status, body) = call_with(
                "POST",
                "/api/drafts/acme.com",
                Some(serde_json::json!({"body": "x", "channel": "sms"})),
            );
            assert_eq!(status, axum::http::StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(body, "channel must be email or linkedin");
            assert_eq!(texts_of("acme.com")[0], text("email", Some("Hi"), "both"));
        });
    }

    /// The channel is required and must be exactly `email` or `linkedin`; anything else is a
    /// 400 that deletes nothing (a missing channel never means "every channel").
    #[test]
    fn discard_rejects_bad_channel() {
        crate::testutil::with_home("ct-web-pipeline-discard-channel", |_| {
            seed(
                "INSERT INTO companies (domain, status) VALUES ('acme.com','drafted'); \
                 INSERT INTO outreach (domain, channel, status) VALUES \
                 ('acme.com','email','draft_pending'), ('acme.com','linkedin','draft_pending');",
            );
            for uri in [
                "/api/drafts/acme.com",
                "/api/drafts/acme.com?channel=",
                "/api/drafts/acme.com?channel=sms",
                "/api/drafts/acme.com?channel=EMAIL",
            ] {
                let (status, body) = call("DELETE", uri);
                assert_eq!(status, axum::http::StatusCode::BAD_REQUEST, "{uri}: {body}");
                assert_eq!(body, "channel must be email or linkedin", "{uri}");
            }
            assert_eq!(
                outreach_of("acme.com"),
                rows(&[("email", "draft_pending"), ("linkedin", "draft_pending")])
            );
            assert_eq!(status_of("acme.com"), "drafted");
        });
    }
}
