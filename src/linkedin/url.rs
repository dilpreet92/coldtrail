//! Validate + canonicalize a LinkedIn profile URL to `https://www.linkedin.com/in/<slug>`.

/// Normalize a raw LinkedIn profile URL. Accepts with/without scheme, with/without
/// `www`, trailing slash, query/fragment, and locale subdomains; returns the canonical
/// `https://www.linkedin.com/in/<slug>` form. Returns None for anything that is not a
/// LinkedIn member profile (`/in/<slug>`).
pub fn normalize(raw: &str) -> Option<String> {
    let s = raw.trim().trim_end_matches('/');
    // strip scheme
    let s = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
        .unwrap_or(s);
    // strip any leading host labels ending in "linkedin.com" (www., in., de., etc.)
    let (host, rest) = s.split_once('/')?;
    if !host.eq_ignore_ascii_case("linkedin.com")
        && !host.to_ascii_lowercase().ends_with(".linkedin.com")
    {
        return None;
    }
    let rest = rest.trim_start_matches('/');
    let after_in = rest.strip_prefix("in/")?;
    // slug = first path segment, minus any query/fragment
    let slug = after_in.split(['/', '?', '#']).next().unwrap_or("").trim();
    if slug.is_empty() {
        return None;
    }
    Some(format!("https://www.linkedin.com/in/{slug}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_and_canonicalizes() {
        for input in [
            "https://www.linkedin.com/in/janedoe",
            "linkedin.com/in/janedoe/",
            "http://linkedin.com/in/janedoe?trk=abc",
            "https://in.linkedin.com/in/janedoe",
            "  https://www.linkedin.com/in/janedoe#section  ",
        ] {
            assert_eq!(
                normalize(input).as_deref(),
                Some("https://www.linkedin.com/in/janedoe"),
                "input: {input}"
            );
        }
    }

    #[test]
    fn rejects_non_profile_urls() {
        for bad in [
            "https://www.linkedin.com/company/acme",
            "https://example.com/in/janedoe",
            "janedoe",
            "",
            "https://www.linkedin.com/feed/",
        ] {
            assert_eq!(normalize(bad), None, "should reject: {bad}");
        }
    }
}
