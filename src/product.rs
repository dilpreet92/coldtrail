//! Read the workspace `product.md` for the Canonical call-to-action (CTA) link, so the
//! LinkedIn note path (`linkedin::note`) can append the same per-company tracking link the
//! email path already renders via `message.toml`'s `{link}` (see `src/message.rs`).

use std::fs;

/// The CTA link's raw value (may still contain the `{slug}` placeholder — see
/// `crate::enrich::slug`) from product.md's `## Call to Action` section: a markdown list
/// item `- Link: <url>` (case-insensitive `Link:`, tolerant of extra spaces around the list
/// marker and the value). Returns `None` if product.md doesn't exist, has no such
/// section/line, or the value is still bracketed placeholder text (e.g. `[add your link]`)
/// rather than a real URL.
pub fn cta_link() -> Option<String> {
    let path = crate::home::path("product.md").ok()?;
    let text = fs::read_to_string(path).ok()?;
    parse_cta_link(&text)
}

fn parse_cta_link(text: &str) -> Option<String> {
    let mut in_section = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            let heading = trimmed.trim_start_matches('#').trim();
            in_section = heading.eq_ignore_ascii_case("call to action");
            continue;
        }
        if !in_section {
            continue;
        }
        if let Some(value) = link_line_value(trimmed) {
            return Some(value);
        }
    }
    None
}

/// Parses a markdown list item `- Link: <value>` (case-insensitive `Link:`). Returns `None`
/// for any other line, and for a value that is still bracketed placeholder text.
fn link_line_value(line: &str) -> Option<String> {
    let rest = line.strip_prefix('-')?.trim_start();
    if rest.len() < 5 {
        return None;
    }
    let (label, value) = rest.split_at(5);
    if !label.eq_ignore_ascii_case("link:") {
        return None;
    }
    let value = value.trim();
    if value.is_empty() || value.starts_with('[') {
        return None;
    }
    Some(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
# Canonical Company Profile

## Offer

- Offer: [confirm your offer — e.g. free credits]

## Call to Action

- Link: https://trycanonical.ai/?utm_content={slug}

## Sender

- Name: Dilpreet
";

    #[test]
    fn parses_link_under_heading() {
        assert_eq!(
            parse_cta_link(SAMPLE),
            Some("https://trycanonical.ai/?utm_content={slug}".to_string())
        );
    }

    #[test]
    fn tolerates_case_and_extra_spaces() {
        let text = "## call to action\n-   Link:    https://x.test/?utm_content={slug}   \n";
        assert_eq!(
            parse_cta_link(text),
            Some("https://x.test/?utm_content={slug}".to_string())
        );
    }

    #[test]
    fn ignores_link_lines_outside_the_section() {
        let text = "## Offer\n\n- Link: https://not-the-cta.test\n\n## Call to Action\n\n- Name: no link here\n";
        assert_eq!(parse_cta_link(text), None);
    }

    #[test]
    fn none_when_no_cta_section() {
        assert_eq!(parse_cta_link("## Offer\n\n- Offer: something\n"), None);
    }

    #[test]
    fn none_when_still_placeholder() {
        let text = "## Call to Action\n\n- Link: [add your CTA link]\n";
        assert_eq!(parse_cta_link(text), None);
    }

    #[test]
    fn none_when_product_md_missing() {
        crate::testutil::with_home("ct-product-missing", |_| {
            assert_eq!(cta_link(), None);
        });
    }

    #[test]
    fn reads_link_from_workspace_product_md() {
        crate::testutil::with_home("ct-product-present", |_tmp| {
            fs::write(crate::home::path("product.md").unwrap(), SAMPLE).unwrap();
            assert_eq!(
                cta_link(),
                Some("https://trycanonical.ai/?utm_content={slug}".to_string())
            );
        });
    }
}
