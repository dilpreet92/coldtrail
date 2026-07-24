//! Best-effort founder-email hunt for companies lacking a verified email.
//! Ports `find_emails.py`: DuckDuckGo HTML search + on-domain page scan, founder
//! name matching, generic/placeholder rejection, and MX (then A) verification.

use anyhow::Result;
use hickory_resolver::config::{ResolverConfig, ResolverOpts};
use hickory_resolver::TokioAsyncResolver;
use regex::Regex;
use rusqlite::{params, OptionalExtension};
use scraper::{Html, Selector};
use std::collections::{HashMap, HashSet};
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

    let mut candidates: HashMap<String, (&'static str, &'static str)> = HashMap::new();
    let mut domain_urls: HashSet<String> = HashSet::new();

    for q in &queries {
        for hit in ddg(q, 8).await {
            let blob = format!("{} {}", hit.title, hit.body);
            for e in domain_emails(&blob, domain) {
                if let Some(conf) = score(&e, founder) {
                    candidates.entry(e).or_insert((conf, "ddg-snippet"));
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
                candidates.entry(e).or_insert((conf, "site-page"));
            }
        }
    }

    // Accept direct (founder-name) match from anywhere; accept inferred ONLY from a
    // real on-domain page (snippet-only inferred = where placeholder junk comes from).
    let mut usable: Vec<(String, (&'static str, &'static str))> = candidates
        .into_iter()
        .filter(|(_, (conf, src))| *conf == "direct" || *src == "site-page")
        .collect();
    if usable.is_empty() {
        return None;
    }
    usable.sort_by_key(|(_, (conf, _))| if *conf == "direct" { 0 } else { 1 });
    let (email, (confidence, source)) = usable.into_iter().next().unwrap();
    Some(Found {
        email,
        confidence,
        source,
    })
}

pub async fn run(max: usize) -> Result<()> {
    crate::db::init()?;
    let conn = crate::db::open()?;
    let mut stmt = conn.prepare(
        "SELECT c.domain, c.name FROM companies c \
         WHERE c.status IN ('sourced','named') \
           AND NOT EXISTS (SELECT 1 FROM contacts k WHERE k.domain=c.domain AND k.email IS NOT NULL AND k.mx_ok=1) \
         ORDER BY c.first_seen LIMIT ?1",
    )?;
    let rows: Vec<(String, Option<String>)> = stmt
        .query_map([max as i64], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    println!("hunting emails for {} companies\n", rows.len());

    for (domain, name) in rows {
        let company = name.clone().unwrap_or_default();
        // seeded founder name if present
        let seeded: Option<String> = conn
            .query_row(
                "SELECT founder_name FROM contacts WHERE domain=?1 AND founder_name IS NOT NULL LIMIT 1",
                [&domain],
                |r| r.get(0),
            )
            .optional()?;
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
}
