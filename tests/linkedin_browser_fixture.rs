//! Drives real Chrome (via ChromeBrowser's CDP path) against a LOCAL static page that mimics
//! LinkedIn's Connect->note->Send DOM. Never touches linkedin.com. Ignored by default because it
//! needs a Chrome binary (and a display, since the driver runs headful); run with:
//!
//!   cargo test --test linkedin_browser_fixture -- --ignored
//!
//! WHY THE `#[path]` INCLUDE + SHIM: coldtrail is a binary-only crate (no `[lib]` target), so an
//! integration test cannot `use coldtrail::...`. Instead we pull the REAL `src/linkedin/browser.rs`
//! into this test crate unchanged and satisfy its only two `crate::linkedin::*` dependencies
//! (`profile_dir`, `chrome_binary`) with test shims below. This exercises the exact production
//! driving code and selectors — nothing is copied or re-implemented. The driver is pointed at the
//! local server strictly through the test-only `ChromeBrowser::for_fixture_from_env()` +
//! `COLDTRAIL_LINKEDIN_BASE`, which production never uses.

use std::io::{Read, Write};
use std::net::TcpListener;

// Shim for the two items `browser.rs` imports from `crate::linkedin`. In production these live in
// `src/linkedin/mod.rs`; here they resolve to throwaway test values (a temp profile dir, and the
// same Chrome discovery as production) so the included module compiles and runs standalone.
mod linkedin {
    use anyhow::{anyhow, Result};
    use std::path::PathBuf;

    pub fn profile_dir() -> Result<PathBuf> {
        // Unique per process so a prior (possibly force-killed) run can't leave a stale Chrome
        // singleton lock that blocks this run's launch.
        let dir = std::env::temp_dir().join(format!(
            "coldtrail-fixture-linkedin-profile-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    pub fn chrome_binary() -> Result<PathBuf> {
        let candidates: &[&str] = if cfg!(target_os = "macos") {
            &[
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            ]
        } else if cfg!(target_os = "windows") {
            &[
                r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            ]
        } else {
            &[
                "/usr/bin/google-chrome",
                "/usr/bin/chromium",
                "/usr/bin/chromium-browser",
                "/snap/bin/chromium",
            ]
        };
        for c in candidates {
            let p = PathBuf::from(c);
            if p.exists() {
                return Ok(p);
            }
        }
        Err(anyhow!(
            "no Chrome/Chromium/Edge found for the fixture test"
        ))
    }
}

// The REAL browser implementation, compiled into this test crate unchanged.
#[path = "../src/linkedin/browser.rs"]
mod browser;

use browser::{ChromeBrowser, InviteOutcome, LinkedInBrowser, SendMode};

/// Serve the fixture HTML for any request on an ephemeral 127.0.0.1 port. Returns the base URL.
/// The server thread runs for the lifetime of the test process.
fn serve_fixture() -> String {
    let html = include_str!("fixtures/fake-linkedin-profile.html").to_string();
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("local addr").port();

    std::thread::spawn(move || {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{}",
            html.len(),
            html
        );
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            // Drain the request line/headers so the client doesn't see a reset; content ignored.
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });

    format!("http://127.0.0.1:{port}")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a real Chrome binary + display; run with --ignored"]
async fn drives_connect_note_send_on_fixture() {
    let base = serve_fixture();
    // Point the driver at the local server via the strictly test-only override.
    std::env::set_var("COLDTRAIL_LINKEDIN_BASE", &base);

    let browser = ChromeBrowser::for_fixture_from_env();
    let profile_url = format!("{base}/in/janedoe");
    // A deliberately non-ASCII note (em-dash) — the driver must insert it verbatim; per-key
    // typing would choke on it, so this guards against that regression.
    let note = "Hi Jane — enjoyed your post on cold outreach.";

    // Assist: drive up to the filled note, stop before Send.
    let staged = browser
        .send_connection_request(&profile_url, note, SendMode::Assist)
        .await
        .expect("assist drive should not error");
    assert_eq!(
        staged,
        InviteOutcome::Staged,
        "Assist should stage the invite"
    );

    // Auto: drive through Send and verify the confirmation.
    let sent = browser
        .send_connection_request(&profile_url, note, SendMode::Auto)
        .await
        .expect("auto drive should not error");
    assert_eq!(
        sent,
        InviteOutcome::Sent,
        "Auto should confirm Sent (got {sent:?})"
    );
}
