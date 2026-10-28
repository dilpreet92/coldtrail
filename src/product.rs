//! Read the workspace `product.md` for the Canonical call-to-action (CTA) link, so the
//! LinkedIn note path (`linkedin::note`) can append the same per-company tracking link the
//! email path already renders via `message.toml`'s `{link}` (see `src/message.rs`).

use std::fs;

/// The CTA link's raw value (may still contain the `{slug}` placeholder — see
/// `crate::enrich::slug`) from product.md's `## Call to Action` section: a markdown list
/// item `- Link: <url>` (case-insensitive `Link:`, tolerant of extra spaces around the list
/// marker and the value). Returns `None` if product.md doesn't exist, has no such
/// section/line, or the value is still placeholder text — bracketed (e.g. `[add your link]`)
/// or the template's `yourproduct.com` example — rather than the user's own URL.
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
/// for any other line, for a value that is still bracketed placeholder text, and for the
/// profile template's example link (see `is_example_link`).
fn link_line_value(line: &str) -> Option<String> {
    let rest = line.strip_prefix('-')?.trim_start();
    // `get` rather than slicing: byte 5 may fall inside a multibyte char (`- ✓✓ done`), and
    // such a line can't start with the ASCII label anyway.
    let label = rest.get(..5)?;
    if !label.eq_ignore_ascii_case("link:") {
        return None;
    }
    let value = rest[5..].trim();
    if value.is_empty() || value.starts_with('[') || is_example_link(value) {
        return None;
    }
    Some(value.to_string())
}

/// The host of the example link the Company profile template ships
/// (`https://yourproduct.com/?utm_content={slug}`).
const EXAMPLE_HOST: &str = "yourproduct.com";

/// Is `value` the template's example link (any scheme, port or subdomain of `EXAMPLE_HOST`)?
/// Saved unedited it isn't the user's CTA, so it must not be appended to their notes.
fn is_example_link(value: &str) -> bool {
    let v = value.trim_start_matches('<');
    let v = v.split_once("://").map_or(v, |(_, rest)| rest);
    let authority = v.split(['/', '?', '#', '>']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("").trim_end_matches('.');
    let host = host.to_ascii_lowercase();
    host == EXAMPLE_HOST || host.ends_with(&format!(".{EXAMPLE_HOST}"))
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

    /// A list item whose 5th byte falls inside a multibyte char is just not a link line — the
    /// label check must not slice through the char (it used to panic).
    #[test]
    fn multibyte_list_item_is_not_a_link_and_does_not_panic() {
        let text = "## Call to Action\n\n- ✓✓ done\n";
        assert_eq!(parse_cta_link(text), None);
        let text = "## Call to Action\n\n- ✓✓ done\n- Link: https://x.test/?utm_content={slug}\n";
        assert_eq!(
            parse_cta_link(text),
            Some("https://x.test/?utm_content={slug}".to_string())
        );
    }

    /// The profile template's example link (yourproduct.com, any scheme or subdomain) saved
    /// unedited is not the user's CTA — it would otherwise ride along on every LinkedIn note.
    #[test]
    fn none_when_still_the_template_example_link() {
        for link in [
            "https://yourproduct.com/?utm_content={slug}",
            "http://www.YourProduct.com/pricing",
            "yourproduct.com",
            "https://go.yourproduct.com:8443/x?utm_content={slug}",
            "<https://yourproduct.com/>",
        ] {
            let text = format!("## Call to Action\n\n- Link: {link}\n");
            assert_eq!(parse_cta_link(&text), None, "{link}");
        }
        // Only that host: a real domain that merely contains the name is kept.
        let text = "## Call to Action\n\n- Link: https://notyourproduct.com/?utm_content={slug}\n";
        assert_eq!(
            parse_cta_link(text),
            Some("https://notyourproduct.com/?utm_content={slug}".to_string())
        );
    }

    #[test]
    fn none_when_product_md_missing() {
        crate::testutil::with_home("ct-product-missing", |_| {
            assert_eq!(cta_link(), None);
        });
    }

    #[test]
    fn cta_link_skips_multibyte_items_and_the_template_link() {
        crate::testutil::with_home("ct-product-multibyte", |_tmp| {
            let doc = "## Call to Action\n\n- ✓✓ done\n- Link: https://yourproduct.com/?utm_content={slug}\n";
            fs::write(crate::home::path("product.md").unwrap(), doc).unwrap();
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
