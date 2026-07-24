//! Pure enrichment helpers, ported verbatim from `find_emails.py` semantics:
//! email scoring / rejection, on-domain extraction, and the draft helpers.

use regex::Regex;
use std::collections::BTreeSet;
use std::sync::LazyLock;

static EMAIL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}").unwrap());

static TITLE_WORDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(Executive|Partner|Officer|Chief|Manager|Director|Founder|CEO|President|Head|Sales|Marketing|Team|Owner)\b").unwrap()
});

static SLUG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[a-z.]+$").unwrap());

const GENERIC: &[&str] = &[
    "info",
    "sales",
    "contact",
    "hello",
    "support",
    "admin",
    "team",
    "marketing",
    "help",
    "careers",
    "jobs",
    "press",
    "media",
    "office",
    "enquiries",
    "inquiries",
    "hi",
    "ask",
    "hey",
    "book",
    "demo",
    "no-reply",
    "noreply",
    "privacy",
    "legal",
    "billing",
];

// Example/placeholder locals that appear on "email format" explainer pages — never real.
const PLACEHOLDER: &[&str] = &[
    "jane",
    "janedoe",
    "jane.doe",
    "john",
    "johndoe",
    "john.doe",
    "jdoe",
    "jsmith",
    "j.doe",
    "j.smith",
    "joe",
    "joesmith",
    "example",
    "name",
    "firstname",
    "lastname",
    "first",
    "last",
    "first.last",
    "fname",
    "flast",
    "user",
    "username",
    "test",
    "email",
    "youremail",
    "yourname",
    "your.name",
    "sample",
    "demo",
    "foo",
    "bar",
    "abc",
    "xyz",
    "name.surname",
    "firstname.lastname",
    "first.lastname",
];

/// Confidence for an email given the (optional) founder name, or `None` to reject.
/// `direct`  = a founder-name part appears in the local-part.
/// `inferred` = plausible but no name match.
pub fn score(email: &str, founder: Option<&str>) -> Option<&'static str> {
    let local = email.split('@').next().unwrap_or("").to_lowercase();
    if GENERIC.contains(&local.as_str()) || PLACEHOLDER.contains(&local.as_str()) {
        return None;
    }
    if local.contains("doe") || local.contains("smith") {
        return None; // john/jane doe, j.smith — format-example junk
    }
    if let Some(f) = founder {
        if !TITLE_WORDS.is_match(f) {
            let matched = f
                .split_whitespace()
                .filter(|p| p.len() > 1)
                .any(|p| local.contains(&p.to_lowercase()));
            if matched {
                return Some("direct");
            }
        }
    }
    Some("inferred")
}

/// Whether a string reads like a job title rather than a person's name. Used by
/// the founder resolver to reject "Chief Executive Officer" as a name.
pub fn is_title(s: &str) -> bool {
    TITLE_WORDS.is_match(s)
}

/// Every email in `text` whose host is exactly `domain`, normalized + deduped.
pub fn domain_emails(text: &str, domain: &str) -> BTreeSet<String> {
    let suffix = format!("@{domain}");
    EMAIL_RE
        .find_iter(text)
        .map(|m| m.as_str().trim().trim_matches('.').to_lowercase())
        .filter(|e| e.ends_with(&suffix))
        .collect()
}

/// First name for greeting; `there` when unknown.
pub fn first_name(full: Option<&str>) -> String {
    match full {
        Some(f) if !f.trim().is_empty() => f.split_whitespace().next().unwrap().to_string(),
        _ => "there".to_string(),
    }
}

/// utm_content slug from a domain. Mirrors the Python regex `\.[a-z.]+$`, which is
/// greedy from the first dot: `acme.co.uk` -> `acme`, `sub.acme.com` -> `sub`.
pub fn slug(domain: &str) -> String {
    SLUG_RE.replace(domain, "").replace('.', "-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_generic_and_placeholder() {
        assert!(score("info@acme.com", Some("Jane Roe")).is_none());
        assert!(score("john.doe@acme.com", None).is_none());
        assert!(score("jsmith@acme.com", None).is_none());
        assert!(score("noreply@acme.com", None).is_none());
    }

    #[test]
    fn direct_when_founder_name_in_local() {
        assert_eq!(
            score("dilpreet@acme.com", Some("Dilpreet Singh")),
            Some("direct")
        );
        assert_eq!(
            score("dsingh@acme.com", Some("Dilpreet Singh")),
            Some("direct")
        );
    }

    #[test]
    fn inferred_when_no_name_match_or_title_founder() {
        // real name, but no part appears in the local -> inferred
        assert_eq!(
            score("hey2@acme.com", Some("Dilpreet Singh")),
            Some("inferred")
        );
        // a "founder" string that is actually a title never yields direct -> inferred
        assert_eq!(
            score("randomlocal@acme.com", Some("Head of Sales")),
            Some("inferred")
        );
    }

    #[test]
    fn domain_emails_only_on_domain() {
        let t = "reach me at sam@acme.com or noise@other.com and Sam@Acme.com.";
        let got = domain_emails(t, "acme.com");
        assert!(got.contains("sam@acme.com"));
        assert!(!got.iter().any(|e| e.ends_with("other.com")));
        assert_eq!(got.len(), 1); // case-folded + trailing dot stripped -> one entry
    }

    #[test]
    fn first_name_and_slug() {
        assert_eq!(first_name(Some("Dilpreet Singh")), "Dilpreet");
        assert_eq!(first_name(None), "there");
        assert_eq!(first_name(Some("   ")), "there");
        assert_eq!(slug("acme.com"), "acme");
        assert_eq!(slug("acme.co.uk"), "acme");
        assert_eq!(slug("getbeamer.io"), "getbeamer");
        // documents the greedy-from-first-dot quirk inherited from the Python regex
        assert_eq!(slug("sub.acme.com"), "sub");
    }
}
