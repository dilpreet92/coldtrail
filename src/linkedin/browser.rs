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
pub enum SendMode {
    /// Drive up to the filled note, stop before Send (human clicks).
    Assist,
    /// Drive through Send.
    Auto,
}

#[derive(Debug, Clone, PartialEq, Eq)]
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

/// Why an `assist_open` drive did not reach the Staged (note-filled, pre-Send) state. Lets the
/// web assist handler distinguish "reconnect needed" from a generic failure without threading an
/// `InviteOutcome` back out (the success case now returns a live `AssistSession` instead).
#[derive(Debug)]
#[allow(dead_code)] // unused in the fixture test crate (see the trait's dead_code note)
pub enum AssistError {
    /// The session is no longer logged in — caller should flip state to reconnect-needed.
    LoggedOut,
    /// A step failed (selector/timeout/launch/etc.); carries a short human-readable reason.
    Failed(String),
}

#[async_trait]
pub trait LinkedInBrowser: Send + Sync {
    /// Launch headful at the login page and wait until login is detected or timeout.
    ///
    /// `allow(dead_code)`: `tests/linkedin_browser_fixture.rs` pulls this file in via `#[path]`
    /// as its own separate crate and only exercises `send_connection_request` there, so this
    /// method is unreachable in THAT compilation unit even though the main binary calls it
    /// (`web::linkedin::connect`).
    #[allow(dead_code)]
    async fn connect_and_wait_for_login(&self, timeout_secs: u64) -> Result<LoginOutcome>;
    /// Drive Connect -> Add note -> fill; Auto also clicks Send and verifies.
    async fn send_connection_request(
        &self,
        profile_url: &str,
        note: &str,
        mode: SendMode,
    ) -> Result<InviteOutcome>;
    /// Best-effort: is the persisted session still valid?
    #[allow(dead_code)]
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

/// The two elements we still locate by a stable CSS id/prefix. Everything else (Connect, the "…"
/// overflow, its in-menu Connect item, Add-a-note, Send) is located by TEXT/ROLE in JS — see the
/// `match_` predicates below — because LinkedIn's aria-labels drift but the human-visible text does
/// not. The contract this task guarantees is screenshot-on-failure + never-false-`Sent`, NOT
/// selector perfection.
mod selectors {
    /// The custom-note textarea. Real LinkedIn and the fixture both use this id; the note-fill path
    /// falls back to any visible `<textarea>` inside the open dialog when the id ever changes.
    pub const NOTE_TEXTAREA: &str = "textarea#custom-message";
    /// After a successful invite the profile shows a "Pending" button — the never-false-Sent gate.
    pub const PENDING_MARKER: &str = "button[aria-label^='Pending']";
}

/// The CSS candidate sets each text matcher scans. Kept broad on purpose — a matcher narrows by
/// visible TEXT/aria (see `match_`), not by a brittle attribute, so a class/label rename can't hide
/// the target as long as the human-readable text survives.
mod candidates {
    /// A top-level Connect: a real control anywhere in the document (main bar or sticky header).
    pub const TOP: &str = "button, a, [role=button]";
    /// A primary-action control: the "…" overflow, Add-a-note, and Send all live in this set.
    pub const ACTION: &str = "button, [role=button]";
    /// A Connect item inside the opened "…" dropdown — menus render items as varied tags.
    pub const DROPDOWN: &str = "div[role=button], button, a, li, span";
}

/// JS boolean predicates run against each candidate, with `txt` = its lowercased trimmed text and
/// `aria` = its lowercased `aria-label` in scope. Text/role, never a raw attribute — this is the
/// one place to tweak when a live run reports a step "not found".
mod match_ {
    /// Connect (top-level or the in-menu item): exact visible text, or the invite-to-connect label.
    pub const CONNECT: &str = "txt === 'connect' || /invite .* to connect/i.test(aria)";
    /// The "…" overflow: an aria-label mentioning "more" (but not a see/show/read-more expander), or
    /// the literal ellipsis as visible text. Deliberately looser than the old exact `More actions`.
    pub const MORE: &str =
        r"(/\bmore\b/i.test(aria) && !/(see|show|read) more/i.test(aria)) || txt === '…'";
    /// "Add a note" inside the invite modal.
    pub const ADD_NOTE: &str = "txt === 'add a note'";
    /// Send: "Send", "Send invitation" (current) or "Send now" (older).
    pub const SEND: &str = "/^send( invitation)?$/i.test(txt) || txt === 'send now'";
}

/// Template for the locate-and-tag matcher: scan `__CAND__` for the FIRST *visible* element whose
/// text/aria satisfies `__PRED__`, tag it `data-ct='__TAG__'`, and return whether one was found. Run
/// as a strict expression (an IIFE) via `evaluate_expression`, so chromiumoxide never mis-detects it
/// as a function declaration. Visibility is a real client-rect check so a `position:fixed` sticky
/// header still counts but a `display:none` dropdown item (before the menu opens) does not.
const LOCATE_TEMPLATE: &str = r#"(() => {
  const visible = (el) => {
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  };
  const nodes = document.querySelectorAll('__CAND__');
  for (const el of nodes) {
    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    if ((__PRED__) && visible(el)) {
      el.setAttribute('data-ct', '__TAG__');
      return true;
    }
  }
  return false;
})()"#;

/// Locate + tag the note textarea: prefer the stable id, else the first visible `<textarea>` inside
/// an open dialog. Tags it `data-ct='note'` so the fill + verify steps have a stable handle.
const LOCATE_TEXTAREA_JS: &str = r#"(() => {
  const visible = (el) => {
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  };
  let t = document.querySelector('textarea#custom-message');
  if (!t || !visible(t)) {
    const scopes = document.querySelectorAll('[role=dialog], .artdeco-modal, dialog');
    const list = scopes.length ? Array.from(scopes) : [document];
    t = null;
    for (const s of list) {
      for (const ta of s.querySelectorAll('textarea')) {
        if (visible(ta)) { t = ta; break; }
      }
      if (t) break;
    }
  }
  if (!t) return false;
  t.setAttribute('data-ct', 'note');
  return true;
})()"#;

/// Read the tagged note textarea's current value, for post-insert verification.
const READ_NOTE_JS: &str = r#"(() => { const t = document.querySelector("[data-ct='note']"); return t ? t.value : ""; })()"#;

/// Remove a `data-ct` tag so it can never leak into a later matcher pass.
const UNTAG_TEMPLATE: &str = r#"(() => { const e = document.querySelector("[data-ct='__TAG__']"); if (e) e.removeAttribute('data-ct'); return true; })()"#;

/// The origin production always targets. Never overridden outside the test-only constructor.
const LINKEDIN_ORIGIN: &str = "https://www.linkedin.com";
/// Element-wait budget: `WAIT_TRIES * WAIT_INTERVAL` per lookup (~6s).
const WAIT_TRIES: u32 = 20;
const WAIT_INTERVAL: Duration = Duration::from_millis(300);
/// Shorter budget for the top-level Connect and the "…" overflow: enough to absorb late action-bar
/// hydration (~3s), but on a Follow/Message/"…" profile the top-level probe is *expected* to miss,
/// so we don't want to burn the full budget before trying the overflow.
const CONNECT_TRIES: u32 = 10;
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

        // Connect: a top-level button (main bar or sticky header), else the "…" overflow -> the
        // in-menu Connect item. Each target is located by TEXT/ROLE in JS, tagged, and clicked with
        // a REAL (trusted CDP) gesture — LinkedIn may ignore an untrusted synthetic `.click()`.
        if !locate_connect(&page).await {
            return Ok(failed(
                &page,
                "could not find Connect (no top-level button and none in the More \"…\" overflow menu)",
            )
            .await);
        }

        // Add a note.
        match locate_and_click_retry(
            &page,
            "addnote",
            candidates::ACTION,
            match_::ADD_NOTE,
            WAIT_TRIES,
        )
        .await
        {
            Located::Clicked => {}
            Located::ClickFailed => {
                return Ok(failed(&page, "found \"Add a note\" but could not click it").await)
            }
            Located::NotFound => {
                return Ok(failed(
                    &page,
                    "could not find \"Add a note\" (the invite modal did not open)",
                )
                .await)
            }
        }

        // Fill the note: focus the textarea, insert via CDP `Input.insertText`, and VERIFY the value
        // stuck (so a silent fill-failure becomes Failed, not a blank note).
        if let Err(reason) = fill_note(&page, note).await {
            return Ok(failed(&page, &reason).await);
        }

        // Assist stops here with the modal open for the human to click Send.
        if mode == SendMode::Assist {
            return Ok(InviteOutcome::Staged);
        }

        // Auto: click Send, then VERIFY. Never return Sent without observing the confirmation.
        match locate_and_click_retry(&page, "send", candidates::ACTION, match_::SEND, WAIT_TRIES)
            .await
        {
            Located::Clicked => {}
            Located::ClickFailed => {
                return Ok(failed(&page, "found the Send button but could not click it").await)
            }
            Located::NotFound => return Ok(failed(&page, "could not find the Send button").await),
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

    /// Assist keep-alive entry point. Launch a fresh headful Chrome, drive Connect -> Add note ->
    /// fill the note, and — on success — RETURN the live window at the Staged state WITHOUT
    /// closing it, so the human can review and click Send in the visible window. The caller owns
    /// the returned `AssistSession` and MUST `close()` it (on confirm or a timeout) to end Chrome.
    /// On any non-Staged outcome (logged out / step failure / launch error) the window is closed
    /// here and an `AssistError` is returned. Concrete (non-trait) because it hands back a live
    /// session; the trait's `send_connection_request` keeps its close-on-return behavior for the
    /// Auto path and the fixture test.
    #[allow(dead_code)] // unused in the fixture test crate (see the trait's dead_code note)
    pub async fn assist_open(
        &self,
        profile_url: &str,
        note: &str,
    ) -> std::result::Result<AssistSession, AssistError> {
        let session = self
            .launch()
            .await
            .map_err(|e| AssistError::Failed(format!("launch chrome: {e}")))?;
        match self
            .drive_invite(&session.browser, profile_url, note, SendMode::Assist)
            .await
        {
            Ok(InviteOutcome::Staged) => Ok(AssistSession { session }),
            Ok(InviteOutcome::LoggedOut) => {
                session.close().await;
                Err(AssistError::LoggedOut)
            }
            Ok(InviteOutcome::Failed(reason)) => {
                session.close().await;
                Err(AssistError::Failed(reason))
            }
            // Assist never clicks Send, so a real driver should never report this.
            Ok(InviteOutcome::Sent) => {
                session.close().await;
                Err(AssistError::Failed(
                    "unexpected: an Assist drive reported Sent".to_string(),
                ))
            }
            Err(e) => {
                session.close().await;
                Err(AssistError::Failed(e.to_string()))
            }
        }
    }
}

/// A live, human-visible Chrome window left open at the Staged (note-filled, pre-Send) state by
/// [`ChromeBrowser::assist_open`]. The web server parks it (with the profile lock) until the human
/// clicks Send (confirm) or a timeout fires. chromiumoxide's `Browser` is `kill_on_drop`, so
/// merely holding this keeps Chrome alive, and dropping/`close()`ing it kills Chrome — which is
/// exactly what lets confirm/timeout tear the window down. `Send + Sync` (see the static assert
/// below) so it can live in the axum-shared `AppState`.
#[allow(dead_code)] // unused in the fixture test crate (see the trait's dead_code note)
pub struct AssistSession {
    session: Session,
}

impl AssistSession {
    /// Bounded graceful close then force-kill — identical teardown to the internal send path.
    #[allow(dead_code)] // unused in the fixture test crate (see the trait's dead_code note)
    pub async fn close(self) {
        self.session.close().await;
    }
}

/// Compile-time proof the assist session (and the browser handle it owns) is `Send + Sync`, so it
/// can be stored in the axum-shared `AppState` behind a tokio `Mutex`. If a future chromiumoxide
/// bump makes `Browser` non-`Sync`, this fails to compile here rather than at the `AppState` use.
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<AssistSession>();
};

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

/// Outcome of a single locate-then-click attempt.
enum Located {
    /// Matched a visible element and completed a trusted CDP click on it.
    Clicked,
    /// Matched, but the trusted click failed (not clickable / detached mid-click).
    ClickFailed,
    /// No visible element matched the text/role predicate.
    NotFound,
}

/// Build the locate-and-tag matcher expression for `candidates`/`predicate`/`tag`. Simple `replace`
/// (not `format!`) so the JS braces don't need escaping and the inputs stay readable.
fn locate_js(tag: &str, candidates: &str, predicate: &str) -> String {
    LOCATE_TEMPLATE
        .replace("__CAND__", candidates)
        .replace("__PRED__", predicate)
        .replace("__TAG__", tag)
}

/// Run a boolean matcher expression, mapping any error/non-bool result to `false`.
async fn eval_bool(page: &Page, js: impl Into<String>) -> bool {
    page.evaluate_expression(js.into())
        .await
        .ok()
        .and_then(|r| r.into_value::<bool>().ok())
        .unwrap_or(false)
}

/// Drop a `data-ct` tag (best-effort) so it can't be re-matched in a later pass.
async fn untag(page: &Page, tag: &str) {
    let _ = page
        .evaluate_expression(UNTAG_TEMPLATE.replace("__TAG__", tag))
        .await;
}

/// Locate a target by TEXT/ROLE (tag it `data-ct=<tag>`), then click the tagged node with a REAL
/// (trusted CDP) gesture — `chromiumoxide`'s `Element::click` scrolls into view and dispatches a
/// mouse event, which LinkedIn treats as a genuine user action (an untrusted JS `.click()` can be
/// ignored/flagged). The tag is always removed afterward.
async fn locate_and_click(page: &Page, tag: &str, candidates: &str, predicate: &str) -> Located {
    if !eval_bool(page, locate_js(tag, candidates, predicate)).await {
        return Located::NotFound;
    }
    let sel = format!("[data-ct='{tag}']");
    let clicked = match page.find_element(&sel).await {
        Ok(el) => el.click().await.is_ok(),
        Err(_) => false,
    };
    untag(page, tag).await;
    if clicked {
        Located::Clicked
    } else {
        Located::ClickFailed
    }
}

/// Retry [`locate_and_click`] up to `tries` times (≈`tries * WAIT_INTERVAL`) to absorb load/animation
/// timing. Returns on the first `Clicked`; otherwise reports the last non-`Clicked` outcome.
async fn locate_and_click_retry(
    page: &Page,
    tag: &str,
    candidates: &str,
    predicate: &str,
    tries: u32,
) -> Located {
    let mut last = Located::NotFound;
    for _ in 0..tries {
        match locate_and_click(page, tag, candidates, predicate).await {
            Located::Clicked => return Located::Clicked,
            other => last = other,
        }
        tokio::time::sleep(WAIT_INTERVAL).await;
    }
    last
}

/// Click a Connect control: a visible top-level button (main bar or sticky header), else open the
/// "…" overflow and click its in-menu Connect item. Returns true once a Connect has been clicked.
async fn locate_connect(page: &Page) -> bool {
    // (a) A top-level Connect (short poll — absent on Follow/Message/"…" profiles, by design).
    if let Located::Clicked = locate_and_click_retry(
        page,
        "connect",
        candidates::TOP,
        match_::CONNECT,
        CONNECT_TRIES,
    )
    .await
    {
        return true;
    }
    // (b) The "…" overflow, then the Connect item inside the dropdown it opens.
    if let Located::Clicked = locate_and_click_retry(
        page,
        "more",
        candidates::ACTION,
        match_::MORE,
        CONNECT_TRIES,
    )
    .await
    {
        if let Located::Clicked = locate_and_click_retry(
            page,
            "connect",
            candidates::DROPDOWN,
            match_::CONNECT,
            WAIT_TRIES,
        )
        .await
        {
            return true;
        }
    }
    false
}

/// Focus the note textarea and insert `note` via CDP `Input.insertText`, then VERIFY the field holds
/// exactly `note`. Insert (not per-key typing) handles arbitrary Unicode — em-dashes, smart quotes,
/// accents, emoji, all common in real notes/names — and fires the input events a React textarea
/// needs; `type_str` errors on any character outside its US-keyboard keymap. Returns a step reason on
/// failure so a blank/short fill becomes a diagnostic `Failed`, never a silently empty note.
async fn fill_note(page: &Page, note: &str) -> std::result::Result<(), String> {
    // Locate + tag the textarea (poll for the modal to render).
    let mut located = false;
    for _ in 0..WAIT_TRIES {
        if eval_bool(page, LOCATE_TEXTAREA_JS).await {
            located = true;
            break;
        }
        tokio::time::sleep(WAIT_INTERVAL).await;
    }
    if !located {
        return Err("could not find the note textarea".to_string());
    }

    // Focus it with a trusted gesture (click), falling back to a plain focus().
    let ta = page
        .find_element("[data-ct='note']")
        .await
        .map_err(|_| "note textarea vanished after tagging".to_string())?;
    let focused = ta.click().await.is_ok() || ta.focus().await.is_ok();
    if !focused {
        untag(page, "note").await;
        return Err("could not focus the note textarea".to_string());
    }

    if page.execute(InsertTextParams::new(note)).await.is_err() {
        untag(page, "note").await;
        return Err("failed to insert the note text".to_string());
    }

    // Verify the value actually landed (React can swallow an insert). Poll a few ticks.
    let mut ok = false;
    for _ in 0..WAIT_TRIES {
        let value = page
            .evaluate_expression(READ_NOTE_JS)
            .await
            .ok()
            .and_then(|r| r.into_value::<String>().ok());
        if value.as_deref() == Some(note) {
            ok = true;
            break;
        }
        tokio::time::sleep(WAIT_INTERVAL).await;
    }
    untag(page, "note").await;
    if ok {
        Ok(())
    } else {
        Err("the note textarea did not accept the text (verification failed)".to_string())
    }
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
    // Screenshots can capture PII from the profile — lock the dir down (0700 on unix), same
    // treatment as the profile dir itself.
    crate::linkedin::set_private(&dir);
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
