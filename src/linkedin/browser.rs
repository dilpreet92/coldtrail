//! The browser boundary. Real driving (Task 5) implements `LinkedInBrowser` with chromiumoxide;
//! tests use `FakeBrowser`. The send-path gate logic (linkedin::send) is written against the
//! trait so it is fully testable without a browser.

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::cdp::browser_protocol::input::InsertTextParams;
use chromiumoxide::element::Element;
use chromiumoxide::page::{Page, ScreenshotParams};
use futures_util::StreamExt;

use crate::linkedin::{chrome_binary, profile_dir};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum SendMode {
    /// Drive up to the filled note, stop before Send (human clicks).
    Assist,
    /// Drive through Send.
    Auto,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub enum LoginOutcome {
    LoggedIn,
    TimedOut,
    WindowClosed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub enum InviteOutcome {
    /// Auto: invite was sent and confirmed on screen. Assist: staged and awaiting the human.
    Sent,
    Staged,
    /// The session is no longer logged in — caller must flip state to reconnect-needed.
    LoggedOut,
    /// A selector/step failed; carries a short reason (a screenshot path may be embedded).
    Failed(String),
}

#[async_trait]
#[allow(dead_code)]
pub trait LinkedInBrowser: Send + Sync {
    /// Launch headful at the login page and wait until login is detected or timeout.
    async fn connect_and_wait_for_login(&self, timeout_secs: u64) -> Result<LoginOutcome>;
    /// Drive Connect -> Add note -> fill; Auto also clicks Send and verifies.
    async fn send_connection_request(
        &self,
        profile_url: &str,
        note: &str,
        mode: SendMode,
    ) -> Result<InviteOutcome>;
    /// Best-effort: is the persisted session still valid?
    async fn is_session_valid(&self) -> Result<bool>;
}

/// A scriptable fake for tests. Records calls; returns the queued outcomes.
#[allow(dead_code)]
pub struct FakeBrowser {
    pub login: LoginOutcome,
    pub invite: InviteOutcome,
    pub session_valid: bool,
}

impl Default for FakeBrowser {
    fn default() -> Self {
        Self {
            login: LoginOutcome::LoggedIn,
            invite: InviteOutcome::Sent,
            session_valid: true,
        }
    }
}

#[async_trait]
impl LinkedInBrowser for FakeBrowser {
    async fn connect_and_wait_for_login(&self, _t: u64) -> Result<LoginOutcome> {
        Ok(self.login.clone())
    }
    async fn send_connection_request(
        &self,
        _u: &str,
        _n: &str,
        _m: SendMode,
    ) -> Result<InviteOutcome> {
        Ok(self.invite.clone())
    }
    async fn is_session_valid(&self) -> Result<bool> {
        Ok(self.session_valid)
    }
}

/// Every LinkedIn selector lives here — LinkedIn changes these often, so this is the one place to
/// patch when a live run reports "… not found". These are best-effort as of 2026-08; the contract
/// this task guarantees is screenshot-on-failure + never-false-`Sent`, NOT selector perfection.
mod selectors {
    /// Primary Connect button on a profile; fall back to the overflow menu when absent.
    pub const CONNECT_BTN: &str = "button[aria-label^='Invite'][aria-label*='connect']";
    /// The "More actions" overflow that hides Connect on some profiles.
    pub const MORE_BTN: &str = "button[aria-label='More actions']";
    /// "Add a note" inside the Connect modal.
    pub const ADD_NOTE_BTN: &str = "button[aria-label='Add a note']";
    /// The custom-note textarea.
    pub const NOTE_TEXTAREA: &str = "textarea#custom-message";
    /// Send: "Send invitation" (current) or "Send now" (older) label.
    pub const SEND_BTN: &str =
        "button[aria-label='Send invitation'], button[aria-label='Send now']";
    /// After a successful invite the profile shows a "Pending" button.
    pub const PENDING_MARKER: &str = "button[aria-label^='Pending']";
}

/// The origin production always targets. Never overridden outside the test-only constructor.
const LINKEDIN_ORIGIN: &str = "https://www.linkedin.com";
/// Element-wait budget: `WAIT_TRIES * WAIT_INTERVAL` per lookup (~6s).
const WAIT_TRIES: u32 = 20;
const WAIT_INTERVAL: Duration = Duration::from_millis(300);
/// Let navigation / redirects settle before reading the URL or cookies.
const SETTLE: Duration = Duration::from_millis(1200);
/// Cap graceful browser teardown so it can never hang the send path; force-kill past this.
const TEARDOWN_BUDGET: Duration = Duration::from_secs(6);

/// Real chromiumoxide-backed browser. Launches a FRESH headful Chrome per operation against the
/// coldtrail-owned profile, drives the invite flow over CDP, and tears the browser down when the
/// op completes. Holds only `Send + Sync` plain data (`base`) — no chromiumoxide handle is stored
/// as a field — so the type is `Send + Sync` and its futures can be held across `.await` under
/// `tokio::spawn` / an axum handler (the LinkedIn send path is both).
pub struct ChromeBrowser {
    /// Origin to drive. Production is always `LINKEDIN_ORIGIN`; only the test-only constructor
    /// can point this at a local fixture server.
    base: String,
}

impl ChromeBrowser {
    /// Production browser: always targets real linkedin.com.
    #[allow(dead_code)]
    pub fn new() -> Result<Self> {
        Ok(Self {
            base: LINKEDIN_ORIGIN.to_string(),
        })
    }

    /// TEST-ONLY constructor. Retargets the driver at a local fixture server via the
    /// `COLDTRAIL_LINKEDIN_BASE` env var so the opt-in fixture test can exercise the real driving
    /// code against a static page. Production NEVER calls this (it uses `new()`), and the env var
    /// is read ONLY here — so production behavior is unchanged and always hits linkedin.com.
    #[doc(hidden)]
    #[allow(dead_code)]
    pub fn for_fixture_from_env() -> Self {
        let base = std::env::var("COLDTRAIL_LINKEDIN_BASE")
            .unwrap_or_else(|_| LINKEDIN_ORIGIN.to_string());
        Self { base }
    }

    /// Login/session gating only applies against the real LinkedIn origin. A fixture base (a local
    /// server) is a static page with no `li_at` cookie, so the gate is skipped there — this is the
    /// ONLY behavioral difference and it can only be reached via the test-only constructor.
    fn requires_login(&self) -> bool {
        self.base.starts_with(LINKEDIN_ORIGIN)
    }

    /// Launch a fresh headful Chrome and start pumping its CDP handler. The returned `Session`
    /// owns the browser + handler task and MUST be `close()`d (or dropped) to end them.
    async fn launch(&self) -> Result<Session> {
        let config = BrowserConfig::builder()
            .chrome_executable(chrome_binary()?)
            .with_head()
            .user_data_dir(profile_dir()?)
            .build()
            .map_err(|e| anyhow!("chrome launch config: {e}"))?;
        let (browser, mut handler) = Browser::launch(config)
            .await
            .map_err(|e| anyhow!("launch chrome: {e}"))?;
        let handle = tokio::spawn(async move { while handler.next().await.is_some() {} });
        Ok(Session { browser, handle })
    }

    /// Poll (~2s) up to `timeout_secs` for a logged-in signal on the login page.
    async fn wait_login(&self, browser: &Browser, timeout_secs: u64) -> Result<LoginOutcome> {
        let page = open(browser, &format!("{}/login", self.base)).await?;
        let deadline = Instant::now() + Duration::from_secs(timeout_secs);
        loop {
            match page.url().await {
                // A closed tab/window makes the target unreachable -> the human bailed out.
                Err(_) => return Ok(LoginOutcome::WindowClosed),
                Ok(Some(u)) if u.contains("/feed") => return Ok(LoginOutcome::LoggedIn),
                Ok(_) => {}
            }
            if has_li_at(&page).await {
                return Ok(LoginOutcome::LoggedIn);
            }
            if Instant::now() >= deadline {
                return Ok(LoginOutcome::TimedOut);
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    /// Load `/feed` and decide whether the persisted session is still valid.
    async fn check_session(&self, browser: &Browser) -> Result<bool> {
        let page = open(browser, &format!("{}/feed", self.base)).await?;
        tokio::time::sleep(SETTLE).await;
        let url = page
            .url()
            .await
            .map_err(|e| anyhow!("read url: {e}"))?
            .unwrap_or_default();
        if url.contains("/login") || url.contains("/authwall") {
            return Ok(false);
        }
        Ok(has_li_at(&page).await)
    }

    /// The invite choreography. Returns an `InviteOutcome`; any missing/failed step screenshots
    /// and returns `Failed`. `Sent` is returned ONLY after the confirmation is observed.
    async fn drive_invite(
        &self,
        browser: &Browser,
        url: &str,
        note: &str,
        mode: SendMode,
    ) -> Result<InviteOutcome> {
        let page = open(browser, url).await?;
        tokio::time::sleep(SETTLE).await;

        // Logged-out detection (real LinkedIn only): redirected to a login/auth wall, or no
        // session cookie. A fixture base skips this — it has no LinkedIn session by design.
        if self.requires_login() {
            let cur = page.url().await.ok().flatten().unwrap_or_default();
            let logged_out = cur.contains("/login")
                || cur.contains("/authwall")
                || cur.contains("/checkpoint")
                || !has_li_at(&page).await;
            if logged_out {
                return Ok(InviteOutcome::LoggedOut);
            }
        }

        // Connect: try the direct button, else the More overflow -> Connect.
        let connect = match require(&page, selectors::CONNECT_BTN, "Connect button").await {
            Ok(el) => el,
            Err(_) => {
                let Ok(more) = require(&page, selectors::MORE_BTN, "More actions button").await
                else {
                    return Ok(
                        failed(&page, "Connect button not found (direct or via More)").await,
                    );
                };
                if more.click().await.is_err() {
                    return Ok(failed(&page, "failed to open the More actions menu").await);
                }
                match require(&page, selectors::CONNECT_BTN, "Connect button (More menu)").await {
                    Ok(el) => el,
                    Err(reason) => return Ok(failed(&page, &reason).await),
                }
            }
        };
        if connect.click().await.is_err() {
            return Ok(failed(&page, "failed to click Connect").await);
        }

        // Add a note.
        let add_note = match require(&page, selectors::ADD_NOTE_BTN, "Add a note button").await {
            Ok(el) => el,
            Err(reason) => return Ok(failed(&page, &reason).await),
        };
        if add_note.click().await.is_err() {
            return Ok(failed(&page, "failed to click Add a note").await);
        }

        // Focus the note textarea, then insert the note.
        let textarea = match require(&page, selectors::NOTE_TEXTAREA, "note textarea").await {
            Ok(el) => el,
            Err(reason) => return Ok(failed(&page, &reason).await),
        };
        if textarea.click().await.is_err() {
            return Ok(failed(&page, "failed to focus the note textarea").await);
        }
        // Insert the note via CDP `Input.insertText` rather than per-key events: it handles
        // arbitrary Unicode (em-dashes, smart quotes, accents, emoji — all common in real notes
        // and names) and fires the input events a React textarea needs. `type_str` errors on any
        // character outside its US-keyboard keymap, so it is unsafe for real note content.
        if page.execute(InsertTextParams::new(note)).await.is_err() {
            return Ok(failed(&page, "failed to type the note").await);
        }

        // Assist stops here with the modal open for the human to click Send.
        if mode == SendMode::Assist {
            return Ok(InviteOutcome::Staged);
        }

        // Auto: click Send, then VERIFY. Never return Sent without observing the confirmation.
        let send = match require(&page, selectors::SEND_BTN, "Send button").await {
            Ok(el) => el,
            Err(reason) => return Ok(failed(&page, &reason).await),
        };
        if send.click().await.is_err() {
            return Ok(failed(&page, "failed to click Send").await);
        }

        // Confirmation = a Pending marker appeared AND the invite modal (its textarea) is gone.
        if let Err(reason) = require(&page, selectors::PENDING_MARKER, "Pending confirmation").await
        {
            return Ok(failed(&page, &reason).await);
        }
        if page.find_element(selectors::NOTE_TEXTAREA).await.is_ok() {
            return Ok(failed(&page, "invite modal did not close after Send").await);
        }
        Ok(InviteOutcome::Sent)
    }
}

/// Owns a launched browser and its CDP handler task; tears both down on `close()`.
struct Session {
    browser: Browser,
    handle: tokio::task::JoinHandle<()>,
}

impl Session {
    /// Close the browser cleanly, reap the child process, and stop the handler task so no Chrome
    /// process is leaked.
    async fn close(mut self) {
        // Prefer a graceful close so a real LinkedIn session is flushed to the on-disk profile,
        // but NEVER let teardown hang the caller (the send path runs under an axum handler). Cap
        // it, then force-kill and reap so no Chrome process is leaked.
        let graceful = tokio::time::timeout(TEARDOWN_BUDGET, async {
            let _ = self.browser.close().await;
            let _ = self.browser.wait().await;
        })
        .await;
        if graceful.is_err() {
            let _ = self.browser.kill().await;
            let _ = self.browser.wait().await;
        }
        self.handle.abort();
    }
}

/// Open a URL in a fresh tab. We create the tab on `about:blank` (which initializes immediately)
/// and then `goto` the target, rather than `new_page(url)` — the latter blocks until the target
/// finishes loading, which can hang indefinitely on a page that never fires a load-complete. The
/// caller then polls for elements (which absorbs load timing) via `require`.
async fn open(browser: &Browser, url: &str) -> Result<Page> {
    let page = browser
        .new_page("about:blank")
        .await
        .map_err(|e| anyhow!("open tab: {e}"))?;
    // Navigate can flake if the fresh target isn't fully attached yet; retry a couple of times.
    let mut last = None;
    for _ in 0..3 {
        match page.goto(url).await {
            Ok(_) => return Ok(page),
            Err(e) => {
                last = Some(e);
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
    Err(anyhow!("navigate: {}", last.unwrap()))
}

/// Find an element, retrying briefly to absorb load/render timing. Maps absence to a clear reason.
async fn require(page: &Page, selector: &str, what: &str) -> std::result::Result<Element, String> {
    for _ in 0..WAIT_TRIES {
        if let Ok(el) = page.find_element(selector).await {
            return Ok(el);
        }
        tokio::time::sleep(WAIT_INTERVAL).await;
    }
    Err(format!("{what} not found (selector: {selector})"))
}

/// True if the page carries a LinkedIn session cookie.
async fn has_li_at(page: &Page) -> bool {
    page.get_cookies()
        .await
        .map(|cookies| cookies.iter().any(|c| c.name == "li_at"))
        .unwrap_or(false)
}

/// Screenshot the current page into `profile_dir()/../linkedin-debug/<ts>.png` for post-mortem.
/// Returns the path when it succeeds. Best-effort — never panics.
async fn debug_screenshot(page: &Page) -> Option<PathBuf> {
    let dir = profile_dir().ok()?.parent()?.join("linkedin-debug");
    std::fs::create_dir_all(&dir).ok()?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    let path = dir.join(format!("{ts}.png"));
    page.save_screenshot(ScreenshotParams::builder().build(), &path)
        .await
        .ok()?;
    Some(path)
}

/// Build a `Failed` outcome, embedding a debug screenshot path when one could be captured.
async fn failed(page: &Page, reason: &str) -> InviteOutcome {
    match debug_screenshot(page).await {
        Some(path) => InviteOutcome::Failed(format!("{reason} — screenshot: {}", path.display())),
        None => InviteOutcome::Failed(reason.to_string()),
    }
}

#[async_trait]
impl LinkedInBrowser for ChromeBrowser {
    async fn connect_and_wait_for_login(&self, timeout_secs: u64) -> Result<LoginOutcome> {
        let session = self.launch().await?;
        let outcome = self.wait_login(&session.browser, timeout_secs).await;
        session.close().await;
        outcome
    }

    async fn send_connection_request(
        &self,
        profile_url: &str,
        note: &str,
        mode: SendMode,
    ) -> Result<InviteOutcome> {
        let session = self.launch().await?;
        let result = self
            .drive_invite(&session.browser, profile_url, note, mode)
            .await;
        session.close().await;
        result
    }

    async fn is_session_valid(&self) -> Result<bool> {
        let session = self.launch().await?;
        let valid = self.check_session(&session.browser).await.unwrap_or(false);
        session.close().await;
        Ok(valid)
    }
}
