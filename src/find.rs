//! Best-effort founder-email hunt for companies lacking a verified email.
//! Ports `find_emails.py`: DuckDuckGo HTML search + on-domain page scan, founder
//! name matching, generic/placeholder rejection, and MX (then A) verification.

use anyhow::Result;
use hickory_resolver::config::{ResolverConfig, ResolverOpts};
use hickory_resolver::TokioAsyncResolver;
use regex::Regex;
use rusqlite::{params, OptionalExtension};
use scraper::{Html, Selector};
use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;

use crate::enrich::{domain_emails, is_title, score};

const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CANDIDATE_PATHS: &[&str] = &[
    "",
    "/about",
    "/about-us",
    "/team",
    "/our-team",
    "/contact",
    "/contact-us",
];

struct SearchHit {
    title: String,
    body: String,
    href: String,
}

struct Found {
    email: String,
    confidence: &'static str,
    source: &'static str,
}

/// MX record → else A record. Mirrors the Python MX-then-A fallback.
pub async fn mx_ok(domain: &str) -> bool {
    if domain.is_empty() {
        return false;
    }
    let resolver = TokioAsyncResolver::tokio(ResolverConfig::default(), ResolverOpts::default());
    if let Ok(mx) = resolver.mx_lookup(domain).await {
        if mx.iter().next().is_some() {
            return true;
        }
    }
    resolver
        .ipv4_lookup(domain)
        .await
        .map(|l| l.iter().next().is_some())
        .unwrap_or(false)
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(12))
        .build()
        .unwrap_or_default()
}

/// DuckDuckGo wraps result hrefs as `//duckduckgo.com/l/?uddg=<encoded target>`.
/// Recover the real URL; pass through anything that isn't wrapped.
fn decode_ddg_href(href: &str) -> String {
    if let Some(idx) = href.find("uddg=") {
        let enc = href[idx + 5..].split('&').next().unwrap_or("");
        if let Ok(decoded) = urlencoding::decode(enc) {
            return decoded.into_owned();
        }
    }
    href.to_string()
}

fn parse_ddg_html(html: &str, max: usize) -> Vec<SearchHit> {
    let doc = Html::parse_document(html);
    let result_sel = Selector::parse("div.result").unwrap();
    let title_sel = Selector::parse("a.result__a").unwrap();
    let snippet_sel = Selector::parse(".result__snippet").unwrap();
    let mut hits = Vec::new();
    for el in doc.select(&result_sel) {
        let title_el = el.select(&title_sel).next();
        let title = title_el
            .map(|t| t.text().collect::<String>())
            .unwrap_or_default();
        let href = title_el
            .and_then(|t| t.value().attr("href"))
            .map(decode_ddg_href)
            .unwrap_or_default();
        let body = el
            .select(&snippet_sel)
            .next()
            .map(|s| s.text().collect::<String>())
            .unwrap_or_default();
        if title.is_empty() && body.is_empty() {
            continue;
        }
        hits.push(SearchHit { title, body, href });
        if hits.len() >= max {
            break;
        }
    }
    hits
}

async fn ddg(query: &str, max: usize) -> Vec<SearchHit> {
    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        urlencoding::encode(query)
    );
    match client().get(&url).send().await {
        Ok(resp) => match resp.text().await {
            Ok(body) => parse_ddg_html(&body, max),
            Err(_) => vec![],
        },
        Err(e) => {
            eprintln!("    ddg error: {e}");
            vec![]
        }
    }
}

async fn fetch(url: &str) -> String {
    match client().get(url).send().await {
        Ok(r) if r.status().is_success() => r.text().await.unwrap_or_default(),
        _ => String::new(),
    }
}

static FOUNDER_RES: LazyLock<[Regex; 2]> = LazyLock::new(|| {
    [
        Regex::new(r"([A-Z][a-z]+ [A-Z][a-z]+)[^.]{0,30}(?:founder|CEO|co-founder)").unwrap(),
        Regex::new(r"(?:founder|CEO|co-founder)[^.]{0,20}?([A-Z][a-z]+ [A-Z][a-z]+)").unwrap(),
    ]
});

async fn resolve_founder(company: &str, domain: &str) -> Option<String> {
    let queries = [
        format!("{company} {domain} founder CEO"),
        format!("\"{company}\" founder"),
    ];
    for q in queries {
        for hit in ddg(&q, 6).await {
            let blob = format!("{} {}", hit.title, hit.body);
            for re in FOUNDER_RES.iter() {
                if let Some(caps) = re.captures(&blob) {
                    let name = caps.get(1).unwrap().as_str();
                    if !is_title(name) {
                        return Some(name.to_string());
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    None
}

async fn hunt(domain: &str, company: &str, founder: Option<&str>) -> Option<Found> {
    let mut queries: Vec<String> = Vec::new();
    if let Some(f) = founder {
        queries.push(format!("\"{f}\" \"{company}\" email"));
        queries.push(format!("site:{domain} {f}"));
        queries.push(format!("\"{f}\" \"@{domain}\""));
        queries.push(format!("{f} {company} founder email"));
    }
    queries.push(format!("{company} founder email {domain}"));
    queries.push(format!("site:{domain} founder contact"));

    // Insertion-ordered accumulation (first occurrence of an email wins), so tie-breaking
    // is deterministic across runs — matching the original Python's insertion-ordered dict.
    // A std HashMap would randomize iteration order and make the final pick nondeterministic.
    let mut seen: HashSet<String> = HashSet::new();
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut record =
        |email: String, conf: &'static str, src: &'static str, seen: &mut HashSet<String>| {
            if seen.insert(email.clone()) {
                candidates.push((email, (conf, src)));
            }
        };

    let mut domain_urls: HashSet<String> = HashSet::new();

    for q in &queries {
        for hit in ddg(q, 8).await {
            let blob = format!("{} {}", hit.title, hit.body);
            for e in domain_emails(&blob, domain) {
                if let Some(conf) = score(&e, founder) {
                    record(e, conf, "ddg-snippet", &mut seen);
                }
            }
            if hit.href.contains(domain) {
                let clean = hit.href.split('?').next().unwrap_or(&hit.href).to_string();
                domain_urls.insert(clean);
            }
        }
        tokio::time::sleep(Duration::from_millis(1200)).await;
    }

    for path in CANDIDATE_PATHS {
        domain_urls.insert(format!("https://{domain}{path}"));
    }
    for url in domain_urls.iter().take(8) {
        let text = fetch(url).await;
        for e in domain_emails(&text, domain) {
            if let Some(conf) = score(&e, founder) {
                record(e, conf, "site-page", &mut seen);
            }
        }
    }

    pick(candidates).map(|(email, confidence, source)| Found {
        email,
        confidence,
        source,
    })
}

type Candidate = (String, (&'static str, &'static str));

/// Choose the best usable candidate, preserving discovery order on ties.
/// Accept a `direct` (founder-name) match from anywhere; accept `inferred` ONLY from a
/// real on-domain page (snippet-only inferred is where placeholder junk comes from).
fn pick(candidates: Vec<Candidate>) -> Option<(String, &'static str, &'static str)> {
    let mut usable: Vec<Candidate> = candidates
        .into_iter()
        .filter(|(_, (conf, src))| *conf == "direct" || *src == "site-page")
        .collect();
    if usable.is_empty() {
        return None;
    }
    // Stable sort: among equal keys, insertion order (first-discovered) is preserved.
    usable.sort_by_key(|(_, (conf, _))| if *conf == "direct" { 0 } else { 1 });
    let (email, (confidence, source)) = usable.into_iter().next().unwrap();
    Some((email, confidence, source))
}

pub async fn run(max: usize) -> Result<()> {
    crate::db::init()?;
    // Read the worklist into memory, then drop the connection — we must not hold a
    // rusqlite handle across an .await (it's !Send, and this runs inside a spawned task).
    let rows: Vec<(String, Option<String>)> = {
        let conn = crate::db::open()?;
        let mut stmt = conn.prepare(
            // Newest-sourced first: a just-run search should get enriched before older records
            // that already failed to yield an email (which otherwise sit at the front forever).
            "SELECT c.domain, c.name FROM companies c \
             WHERE c.status IN ('sourced','named') \
               AND NOT EXISTS (SELECT 1 FROM contacts k WHERE k.domain=c.domain AND k.email IS NOT NULL AND k.mx_ok=1) \
             ORDER BY c.first_seen DESC LIMIT ?1",
        )?;
        let out = stmt
            .query_map([max as i64], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<(String, Option<String>)>>>()?;
        out
    };
    println!("hunting emails for {} companies\n", rows.len());

    for (domain, name) in rows {
        let company = name.clone().unwrap_or_default();
        // seeded founder name if present (short-lived connection, no await while open)
        let seeded: Option<String> = {
            let conn = crate::db::open()?;
            conn.query_row(
                "SELECT founder_name FROM contacts WHERE domain=?1 AND founder_name IS NOT NULL LIMIT 1",
                [&domain],
                |r| r.get(0),
            )
            .optional()?
        };
        let founder = match seeded {
            Some(f) => Some(f),
            None => resolve_founder(&company, &domain).await,
        };
        println!(
            "- {} ({domain}) founder={}",
            name.as_deref().unwrap_or("?"),
            founder.as_deref().unwrap_or("?")
        );

        match hunt(&domain, &company, founder.as_deref()).await {
            None => {
                println!("    no founder email found");
                let conn = crate::db::open()?;
                crate::db::set_status(
                    &conn,
                    &domain,
                    if founder.is_some() {
                        "named"
                    } else {
                        "sourced"
                    },
                )?;
            }
            Some(res) => {
                let ok = mx_ok(&domain).await;
                let conn = crate::db::open()?;
                conn.execute(
                    "INSERT OR IGNORE INTO contacts \
                     (domain, founder_name, email, email_source, email_confidence, mx_ok) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        domain,
                        founder,
                        res.email,
                        res.source,
                        res.confidence,
                        if ok { 1 } else { 0 }
                    ],
                )?;
                crate::db::set_status(&conn, &domain, if ok { "emailed" } else { "named" })?;
                println!(
                    "    {}  [{}, {}]  mx_ok={ok}",
                    res.email, res.confidence, res.source
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_uddg_href() {
        let h = "//duckduckgo.com/l/?uddg=https%3A%2F%2Facme.com%2Fteam&rut=x";
        assert_eq!(decode_ddg_href(h), "https://acme.com/team");
    }

    #[test]
    fn passes_through_plain_href() {
        assert_eq!(
            decode_ddg_href("https://acme.com/about"),
            "https://acme.com/about"
        );
    }

    #[test]
    fn pick_is_deterministic_and_prefers_direct() {
        // first-discovered direct wins on a tie (mirrors Python insertion order)
        let c = vec![
            ("a@x.com".to_string(), ("direct", "ddg-snippet")),
            ("b@x.com".to_string(), ("direct", "site-page")),
        ];
        assert_eq!(pick(c).unwrap().0, "a@x.com");

        // inferred is usable only from an on-domain page
        let c2 = vec![
            ("g@x.com".to_string(), ("inferred", "ddg-snippet")), // filtered out
            ("h@x.com".to_string(), ("inferred", "site-page")),   // kept
        ];
        assert_eq!(pick(c2).unwrap().0, "h@x.com");

        // a direct match outranks an inferred site-page match regardless of order
        let c3 = vec![
            ("i@x.com".to_string(), ("inferred", "site-page")),
            ("j@x.com".to_string(), ("direct", "ddg-snippet")),
        ];
        assert_eq!(pick(c3).unwrap().0, "j@x.com");

        // nothing usable -> None
        let c4 = vec![("k@x.com".to_string(), ("inferred", "ddg-snippet"))];
        assert!(pick(c4).is_none());
    }
}
