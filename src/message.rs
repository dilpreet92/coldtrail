//! The outreach message template (`message.toml`) and per-contact rendering.
//! Plain string substitution — no template engine. Placeholders: {company},
//! {fn}, {slug}, {link}; the paragraph sentinel "__CTA__" is replaced by the CTA.

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::enrich::{first_name, slug};

#[derive(Debug, Deserialize)]
pub struct Message {
    pub link: String,
    pub subject: String,
    pub paragraphs: Vec<String>,
    pub cta_plain: String,
    pub cta_html: String,
}

pub struct Rendered {
    pub subject: String,
    pub body: String,
    pub html: String,
    pub link: String,
}

impl Message {
    /// Load `message.toml` from the workspace.
    pub fn load() -> Result<Message> {
        let p = crate::home::path("message.toml")?;
        let raw = std::fs::read_to_string(&p).with_context(|| {
            format!(
                "no message.toml at {} — run `coldtrail setup`, then edit it with your \
                 name, pitch, and link",
                p.display()
            )
        })?;
        let m: Message = toml::from_str(&raw).context("message.toml is not valid TOML")?;
        Ok(m)
    }

    pub fn render(&self, company: Option<&str>, founder: Option<&str>, domain: &str) -> Rendered {
        let fname = first_name(founder);
        let company = company.unwrap_or("").to_string();
        let link = self.link.replace("{slug}", &slug(domain));

        let fill = |s: &str| s.replace("{company}", &company).replace("{fn}", &fname);
        let cta_plain = self.cta_plain.replace("{link}", &link);
        let cta_html = self.cta_html.replace("{link}", &link);

        let subject = fill(&self.subject);

        let body = self
            .paragraphs
            .iter()
            .map(|p| {
                if p == "__CTA__" {
                    cta_plain.clone()
                } else {
                    fill(p)
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        let html = self
            .paragraphs
            .iter()
            .map(|p| {
                let inner = if p == "__CTA__" {
                    cta_html.clone()
                } else {
                    fill(p)
                };
                format!("<p>{inner}</p>")
            })
            .collect::<String>();

        Rendered {
            subject,
            body,
            html,
            link,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Message {
        Message {
            link: "https://x/?utm_content={slug}".into(),
            subject: "found {company}".into(),
            paragraphs: vec!["Hi {fn},".into(), "__CTA__".into(), "— Me".into()],
            cta_plain: "see {link}".into(),
            cta_html: "see <a href=\"{link}\">x</a>".into(),
        }
    }

    #[test]
    fn render_fills_placeholders_and_cta() {
        let r = sample().render(Some("Acme"), Some("Dilpreet Singh"), "acme.com");
        assert_eq!(r.subject, "found Acme");
        assert!(r.body.starts_with("Hi Dilpreet,"));
        assert!(r.body.contains("see https://x/?utm_content=acme"));
        assert!(r.html.contains("<p>Hi Dilpreet,</p>"));
        assert!(r
            .html
            .contains("<a href=\"https://x/?utm_content=acme\">x</a>"));
        assert!(!r.body.contains("__CTA__"));
        assert!(!r.html.contains("__CTA__"));
    }

    #[test]
    fn render_defaults_missing_founder_to_there() {
        let r = sample().render(Some("Acme"), None, "acme.com");
        assert!(r.body.starts_with("Hi there,"));
    }

    #[test]
    fn embedded_template_parses() {
        let m: Message = toml::from_str(crate::setup::MESSAGE_TOML).unwrap();
        assert!(m.paragraphs.iter().any(|p| p == "__CTA__"));
        assert!(m.link.contains("{slug}"));
    }
}
