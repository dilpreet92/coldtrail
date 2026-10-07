//! The browser boundary. Real driving (Task 5) implements `LinkedInBrowser` with chromiumoxide;
//! tests use `FakeBrowser`. The send-path gate logic (linkedin::send) is written against the
//! trait so it is fully testable without a browser.

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::cdp::browser_protocol::input::{
    DispatchMouseEventParams, DispatchMouseEventType, InsertTextParams, MouseButton,
};
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
    /// The invite dialog demands the member's email ("To verify this member knows you, please
    /// enter their email to connect") and keeps Send disabled until it's filled. Not retryable —
    /// every future attempt hits the same gate.
    NeedsEmail,
    /// The profile already shows THIS person's "Pending" invite (no Connect to click) — an earlier
    /// invite went out. Nothing new is sent.
    AlreadyInvited,
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
    /// The profile already shows this person's "Pending" invite — nothing to send.
    AlreadyInvited,
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

/// Everything actionable (Connect, the "…" overflow, its in-menu Connect item, Add-a-note, Send) is
/// located by TEXT/ROLE in JS — see the `match_` predicates below — because LinkedIn's aria-labels
/// drift but the human-visible text does not. The note textarea is located by its stable id inline
/// in `LOCATE_TEXTAREA_JS`. The one remaining named marker is the post-invite "Pending" confirmation,
/// matched by a shadow-piercing JS PREDICATE (not a CSS selector) — see `PENDING_EXISTS_JS`. The
/// contract this task guarantees is screenshot-on-failure + never-false-`Sent`, NOT selector
/// perfection.
mod selectors {
    /// After a successful invite the profile shows a "Pending" marker — the never-false-Sent gate.
    /// On REAL LinkedIn this is an `<a>` (NOT a `<button>`) in the LIGHT DOM carrying an
    /// `href="https://www.linkedin.com/in/<slug>/"` to the invited profile, a
    /// `componentkey="...invitation...pending"`, and an `aria-label` beginning "Pending, click to
    /// withdraw invitation sent to <NAME>". It is matched by the shadow-piercing `PENDING_EXISTS_JS`
    /// predicate — a pending SIGNAL (aria-label starts with "pending", OR componentkey contains
    /// "invitation"+"pending", OR an `<a>`/`<button>` whose text is exactly "pending") that is ALSO
    /// tied to THIS invite by the target's `/in/<slug>` in the marker's own (or nearest ancestor
    /// `<a>`'s) href — NOT a CSS selector, and NOT an unscoped whole-page scan. The slug tie is what
    /// stops a sidebar "Pending" for a DIFFERENT person (e.g. "People also viewed") from ever
    /// confirming THIS send. This value is the human-readable description used in the "not found"
    /// diagnostic.
    pub const PENDING_MARKER: &str = "pending signal (aria-label^='Pending' | componentkey~'invitation'+'pending' | <a>/<button> text='Pending') tied to the target's /in/<slug> href";
}

/// The CSS candidate sets each text matcher scans. Kept broad on purpose — a matcher narrows by
/// visible TEXT/aria (see `match_`), not by a brittle attribute, so a class/label rename can't hide
/// the target as long as the human-readable text survives. The candidate set is always intersected
/// with a *scope* (see `mod scopes`) and an *exclude* (see `EXCLUDE`) so the scan can never wander
/// into the global nav, a sidebar, or the messaging overlay.
mod candidates {
    /// A top-level Connect: the primary action-bar control, scoped to `<main>` (see `scopes::MAIN`).
    pub const TOP: &str = "button, a, [role=button]";
    /// A primary-action control: the "…" overflow, Add-a-note, and Send all live in this set.
    pub const ACTION: &str = "button, [role=button]";
    /// A Connect item inside the opened "…" dropdown — menus render items as varied tags.
    pub const DROPDOWN: &str = "div[role=button], button, a, li, span";
}

/// The container a locate is confined to. A locate builds its candidate list from the FIRST of these
/// selectors that matches an element on the page (falling back to the whole document only when NONE
/// match — e.g. a stripped-down fixture without the expected wrapper). This is the real fix for the
/// live "clicked the wrong element and navigated to the feed" bug: without a scope, a whole-document
/// text/role scan on a Follow/Message/"…" profile matches a global-nav item, a "People also viewed"
/// sidebar Connect, or the messaging overlay's "…" instead of the profile's own control.
mod scopes {
    /// The profile card + its primary action bar (top-level Connect and the "…" More) render inside
    /// LinkedIn's `<main>`.
    pub const MAIN: &[&str] = &["main"];
    /// The open "…" overflow menu — the in-menu Connect item lives here.
    pub const DROPDOWN: &[&str] = &[
        ".artdeco-dropdown__content",
        ".artdeco-dropdown__content--is-open",
        "[role='menu']",
    ];
    /// The open invite modal — Add-a-note and Send. LinkedIn's modal container class/role varies (the
    /// action buttons can sit outside a `[role='dialog']` inner node, and a first/only-dialog scope
    /// lands on the Messaging widget instead), so we search the dialog containers AND fall back to
    /// `<main>`/`<body>`. The EXCLUDE list still keeps the scan off the messaging widget / nav /
    /// sidebars, where "Add a note"/"Send" never appear anyway.
    pub const DIALOG: &[&str] = &[
        "[role='dialog']",
        ".artdeco-modal",
        "dialog",
        "main",
        "body",
    ];
}

/// Regions a profile-action locate must NEVER match into, even when nested inside an allowed scope:
/// the global top-nav (`header`/`nav`/`.global-nav`), either sidebar rail (`aside` /
/// `.scaffold-layout__aside`, e.g. "People also viewed"), and the bottom-right messaging overlay
/// (`.msg-overlay-*`, `[id^='msg-overlay']`). Any candidate whose `.closest()` hits one of these is
/// dropped. Uses only single-quoted attribute selectors so it can be inlined as a JS string literal.
const EXCLUDE: &str = "header, nav, .global-nav, aside, .scaffold-layout__aside, .msg-overlay-list-bubble, [id^='msg-overlay'], .msg-overlay-container";

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

/// Shared JS injected (via `__HELPERS__`) into every DOM-reading snippet so it can SEE the modal
/// LinkedIn now renders inside an OPEN shadow root on a top-level `<div>` (the live capture reached
/// it at `document > div::shadow`). `querySelectorAll` / `Element.closest` / `Node.contains` do NOT
/// cross shadow (or same-origin iframe) boundaries, so:
///  * `walk` recursively descends `el.shadowRoot` (open) and same-origin `iframe.contentDocument`,
///    yielding the flat element set the classic matchers used to get from one `querySelectorAll`.
///  * `visible` is the same real client-rect test as before.
///  * `composedTest` climbs the COMPOSED tree — parentNode, then ShadowRoot→host, then an iframe
///    Document→its frame element — so scope-membership and EXCLUDE still work across the boundary a
///    plain `.closest()` can't see. A shadow-nested candidate is still correctly kept in / out.
const PIERCE_HELPERS: &str = r#"
  const visible = (el) => {
    if (!el.getClientRects) return false;
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  };
  const walk = (root, out) => {
    let els; try { els = root.querySelectorAll('*'); } catch (e) { return; }
    for (const el of els) {
      out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot, out);
      if (el.tagName === 'IFRAME') { try { if (el.contentDocument) walk(el.contentDocument, out); } catch (e) {} }
    }
  };
  const allElements = () => { const out = []; walk(document, out); return out; };
  const composedTest = (el, test) => {
    let n = el;
    while (n) {
      if (n.nodeType === 1 && test(n)) return true;
      if (n.parentNode) n = n.parentNode;
      else if (n.host) n = n.host;                                   // ShadowRoot -> host
      else if (n.defaultView && n.defaultView.frameElement) n = n.defaultView.frameElement; // iframe Document -> frame
      else n = null;
    }
    return false;
  };
"#;

/// Template for the locate-and-tag matcher: over the SHADOW-PIERCING element set, find the FIRST
/// *visible* element that matches `__CAND__`, satisfies the text/aria predicate `__PRED__`, sits
/// (in the composed tree) inside a `__SCOPES__` container (falling back to document-wide when none
/// match — which is how the DIALOG scope's `body` entry reaches a top-level shadow-hosted modal),
/// and is NOT inside an `__EXCLUDE__` region. It scrolls the match into view, tags it
/// `data-ct='__TAG__'`, and RETURNS its viewport-center `[x, y]` (or `null`). The coordinates let the
/// caller dispatch a TRUSTED CDP mouse click, which — unlike `find_element` — resolves a shadow-
/// nested node. Run as a strict expression (an IIFE) via `evaluate_expression`.
const LOCATE_TEMPLATE: &str = r#"(() => {
__HELPERS__
  const scopeSels = __SCOPES__;
  const excludeSel = "__EXCLUDE__";
  const all = allElements();
  // Scope containers, matched anywhere in the pierced set. Empty => the whole document is in scope.
  const scopeRoots = [];
  for (const el of all) {
    if (!el.matches) continue;
    for (const s of scopeSels) {
      try { if (el.matches(s)) { scopeRoots.push(el); break; } } catch (e) {}
    }
  }
  const inScope = (el) => !scopeRoots.length || composedTest(el, (n) => scopeRoots.indexOf(n) !== -1);
  const excluded = (el) => !!excludeSel && composedTest(el, (n) => { try { return n.matches(excludeSel); } catch (e) { return false; } });
  for (const el of all) {
    if (!el.matches) continue;
    let isCand = false; try { isCand = el.matches('__CAND__'); } catch (e) { isCand = false; }
    if (!isCand) continue;
    if (excluded(el)) continue;
    if (!inScope(el)) continue;
    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    if ((__PRED__) && visible(el)) {
      el.setAttribute('data-ct', '__TAG__');
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      const b = el.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    }
  }
  return null;
})()"#;

/// Locate + tag the note textarea across the shadow boundary: prefer the stable id, else the first
/// visible `<textarea>` whose composed ancestry includes an open dialog/modal. Tags it
/// `data-ct='note'`, scrolls it into view, and RETURNS its viewport-center `[x, y]` (or `null`).
const LOCATE_TEXTAREA_JS: &str = r#"(() => {
__HELPERS__
  const all = allElements();
  let t = null;
  for (const el of all) {
    if (el.matches && el.matches('textarea#custom-message') && visible(el)) { t = el; break; }
  }
  if (!t) {
    for (const el of all) {
      if (el.tagName === 'TEXTAREA' && visible(el) &&
          composedTest(el, (n) => n.matches && (n.matches("[role='dialog']") || n.matches('.artdeco-modal') || n.tagName === 'DIALOG'))) {
        t = el; break;
      }
    }
  }
  if (!t) return null;
  t.setAttribute('data-ct', 'note');
  try { t.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  const b = t.getBoundingClientRect();
  return [b.left + b.width / 2, b.top + b.height / 2];
})()"#;

/// Read a tagged element's current `.value` (shadow-piercing), for post-insert verification.
const READ_TAGGED_TEMPLATE: &str = r#"(() => {
__HELPERS__
  for (const el of allElements()) {
    if (el.getAttribute && el.getAttribute('data-ct') === '__TAG__') return el.value != null ? el.value : "";
  }
  return "";
})()"#;

/// Click a tagged element (shadow-piercing) — the untrusted `.click()` fallback for when a trusted
/// CDP coordinate click could not be dispatched.
const CLICK_TAGGED_TEMPLATE: &str = r#"(() => {
__HELPERS__
  for (const el of allElements()) {
    if (el.getAttribute && el.getAttribute('data-ct') === '__TAG__') { try { el.click(); return true; } catch (e) { return false; } }
  }
  return false;
})()"#;

/// Focus a tagged element (shadow-piercing). Plain `focus()` works inside an OPEN shadow root, so
/// this is enough to arm the CDP `Input.insertText` that follows.
const FOCUS_TAGGED_TEMPLATE: &str = r#"(() => {
__HELPERS__
  for (const el of allElements()) {
    if (el.getAttribute && el.getAttribute('data-ct') === '__TAG__') { try { el.focus(); return true; } catch (e) { return false; } }
  }
  return false;
})()"#;

/// Shadow-piercing existence check for the post-invite "Pending" marker — the AUTHORITATIVE
/// "invite sent" signal, tied to THIS invite's target so a stray "Pending" for a DIFFERENT person
/// can never confirm. Real LinkedIn renders it in the LIGHT DOM as an `<a>` (NOT a `<button>`) with
/// obfuscated classes, e.g.
///   <a href="https://www.linkedin.com/in/<slug>/"
///      componentkey="ConnectButtonstate:invitation:urn:li:member:<id>_pending"
///      aria-label="Pending, click to withdraw invitation sent to <NAME>"><span>Pending</span></a>
/// The href carries the invited profile's `/in/<slug>` — the same slug the driver navigated to.
///
/// The old check matched ANY visible pending signal ANYWHERE on the page with NO scope. That is the
/// last way never-false-`Sent` could break: if the Send click is intercepted (e.g. a "confirm you
/// know this person / enter their email" checkpoint) and the invite does NOT register, the right-rail
/// "People also viewed" `<aside>` still shows the Pending state of OTHER people you invited earlier —
/// and a stray sidebar Pending would satisfy confirmation and record a FALSE `Sent`. So the predicate
/// now requires BOTH a pending signal AND that the marker belong to THIS target.
///
/// Over the SHADOW-PIERCING element set (the same recursive `walk` — open `shadowRoot`s + same-origin
/// iframes — the locators use), and dropping anything inside an EXCLUDE region (nav / sidebars /
/// messaging) as defense-in-depth, a VISIBLE element is a pending SIGNAL when its:
///  * `aria-label` starts with "pending" (case-insensitive), OR
///  * `componentkey` contains BOTH "invitation" and "pending", OR
///  * it is an `<a>`/`<button>` whose trimmed text is exactly "pending".
///
/// Confirmation is then two passes:
///  1. PREFERRED: a pending signal whose OWN href, or its nearest composed-ancestor `<a>`'s href,
///     has a `/in/<slug>` segment EXACTLY equal to one of the target slugs (`__SLUGS__`). A DIFFERENT person's
///     marker (different slug) fails this.
///  2. FALLBACK (defensive, only if no slug match): a pending signal inside `<main>` that carries NO
///     href at all — for a legitimate marker that lost its href. A marker with an href to a DIFFERENT
///     slug is matched by NEITHER pass (slug mismatch above; has-an-href here), so it can't confirm.
///
/// Requiring a real client rect keeps a hidden/stale template marker from confirming. `__SLUGS__` is
/// the target's slugs (lowercased JS array): the one it was given AND the one LinkedIn landed on
/// after redirecting an old profile URL to the member's vanity URL — both name the same person. An
/// empty array disables pass 1 (fail-safe: only the no-href fallback remains). `__ALLOW_NOHREF__`
/// gates pass 2: on for the post-Send confirmation, off for the pre-Connect "already invited" check,
/// which must be tied to this target by slug. Run as an IIFE via `evaluate_expression`.
const PENDING_EXISTS_JS: &str = r#"(() => {
__HELPERS__
  const slugs = __SLUGS__;
  const excludeSel = "__EXCLUDE__";
  const excluded = (el) => !!excludeSel && composedTest(el, (n) => { try { return n.matches(excludeSel); } catch (e) { return false; } });
  const inMain = (el) => composedTest(el, (n) => { try { return n.matches('main'); } catch (e) { return false; } });
  // The href of `el` itself or of its nearest composed-ancestor <a> (lowercased; '' if none).
  const hrefOf = (el) => {
    let n = el;
    while (n) {
      if (n.nodeType === 1 && n.tagName === 'A' && n.getAttribute) {
        const h = n.getAttribute('href');
        if (h) return h.toLowerCase();
      }
      if (n.parentNode) n = n.parentNode;
      else if (n.host) n = n.host;
      else if (n.defaultView && n.defaultView.frameElement) n = n.defaultView.frameElement;
      else n = null;
    }
    return '';
  };
  // The /in/<slug> segment inside an href (lowercased; '' if none).
  const slugOf = (href) => {
    const i = href.indexOf('/in/');
    if (i === -1) return '';
    return href.slice(i + 4).split('/')[0].split('?')[0].split('#')[0].trim();
  };
  const isPending = (el) => {
    const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
    if (aria.startsWith('pending')) return true;
    const ck = (el.getAttribute('componentkey') || '').toLowerCase();
    if (ck.indexOf('invitation') !== -1 && ck.indexOf('pending') !== -1) return true;
    if (el.tagName === 'A' || el.tagName === 'BUTTON') {
      const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (txt === 'pending') return true;
    }
    return false;
  };
  const all = allElements();
  // Pass 1 (PREFERRED): a pending signal tied to THIS target by its /in/<slug> href.
  for (const el of all) {
    if (!el.getAttribute || !visible(el) || excluded(el)) continue;
    if (!isPending(el)) continue;
    const s = slugOf(hrefOf(el));
    if (s && slugs.includes(s)) return true;
  }
  if (!__ALLOW_NOHREF__) return false;
  // Pass 2 (FALLBACK): a pending signal in <main> with NO href — defensive, prefer the slug match.
  for (const el of all) {
    if (!el.getAttribute || !visible(el) || excluded(el)) continue;
    if (!isPending(el)) continue;
    if (hrefOf(el) !== '') continue;
    if (inMain(el)) return true;
  }
  return false;
})()"#;

/// LinkedIn's "To verify this member knows you, please enter their email to connect" gate: a
/// visible email input inside the open invite dialog (shadow-piercing, EXCLUDE regions dropped).
/// When it shows, Send stays disabled until the member's email is typed, so an Auto send can never
/// go through. Run as an IIFE via `evaluate_expression`.
const EMAIL_GATE_JS: &str = r#"(() => {
__HELPERS__
  const excludeSel = "__EXCLUDE__";
  const excluded = (el) => !!excludeSel && composedTest(el, (n) => { try { return n.matches(excludeSel); } catch (e) { return false; } });
  const inDialog = (el) => composedTest(el, (n) => { try { return n.matches("[role='dialog'], .artdeco-modal, dialog"); } catch (e) { return false; } });
  for (const el of allElements()) {
    if (el.tagName !== 'INPUT') continue;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const name = (el.getAttribute('name') || '').toLowerCase();
    if (type !== 'email' && name !== 'email') continue;
    if (visible(el) && !excluded(el) && inDialog(el)) return true;
  }
  return false;
})()"#;

/// Remove a `data-ct` tag (shadow-piercing) so it can never leak into a later matcher pass.
const UNTAG_TEMPLATE: &str = r#"(() => {
__HELPERS__
  for (const el of allElements()) {
    if (el.getAttribute && el.getAttribute('data-ct') === '__TAG__') { el.removeAttribute('data-ct'); return true; }
  }
  return true;
})()"#;

/// The origin production always targets. Never overridden outside the test-only constructor.
const LINKEDIN_ORIGIN: &str = "https://www.linkedin.com";
/// Element-wait budget: `WAIT_TRIES * WAIT_INTERVAL` per lookup (~6s).
const WAIT_TRIES: u32 = 20;
const WAIT_INTERVAL: Duration = Duration::from_millis(300);
/// Post-Send Pending-confirmation budget: `CONFIRM_TRIES * WAIT_INTERVAL` (~18s), deliberately LONGER
/// than the per-element locate budget. LinkedIn can render the Pending marker slowly after Send, and
/// the old ~6s could false-NEGATIVE a real, recorded send — leaving a stuck `draft_pending` row. A
/// longer wait carries NO double-send risk: a re-drive of an already-invited profile finds no Connect
/// and fails safe. Poll interval is unchanged.
const CONFIRM_TRIES: u32 = 60;
/// Shorter budget for the top-level Connect and the "…" overflow: enough to absorb late action-bar
/// hydration (~3s), but on a Follow/Message/"…" profile the top-level probe is *expected* to miss,
/// so we don't want to burn the full budget before trying the overflow.
const CONNECT_TRIES: u32 = 10;
/// Let navigation / redirects settle before reading the URL or cookies.
const SETTLE: Duration = Duration::from_millis(1200);
/// Cap graceful browser teardown so it can never hang the send path; force-kill past this.
const TEARDOWN_BUDGET: Duration = Duration::from_secs(6);

/// Human-like PACING between the major invite steps (this is pacing, NOT fingerprint evasion — the
/// "controlled by automated test software" banner stays; no webdriver/stealth spoofing). Applied
/// only against the real LinkedIn origin; collapsed to zero when the test-only base override points
/// `base` at a local fixture server (see [`ChromeBrowser::paced`]) so the `#[ignore]` fixture test
/// stays fast. A short randomized pause before Connect, between Connect and Add-a-note, and before
/// typing the note; a slightly longer one after the note is filled and before Send.
const PACE_STEP_MIN_MS: u64 = 600;
const PACE_STEP_MAX_MS: u64 = 1600;
const PACE_PRESEND_MIN_MS: u64 = 900;
const PACE_PRESEND_MAX_MS: u64 = 2200;
/// Note typing: when paced, insert the note in small char-chunks with short randomized gaps so it
/// reads as typed rather than pasted (unpaced/fixture: a single insert, kept fast). See `fill_note`.
const NOTE_CHUNK_CHARS: usize = 4;
const NOTE_CHUNK_MIN_MS: u64 = 40;
const NOTE_CHUNK_MAX_MS: u64 = 160;

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

    /// Human-like pacing (and human-like chunked note typing) run ONLY against the real LinkedIn
    /// origin. When the test-only `COLDTRAIL_LINKEDIN_BASE` override points `base` at a local
    /// fixture server, this is false, so pacing collapses to zero and the `#[ignore]` fixture test
    /// completes fast. Production always targets `LINKEDIN_ORIGIN`, so production is always paced.
    fn paced(&self) -> bool {
        self.base.starts_with(LINKEDIN_ORIGIN)
    }

    /// Sleep a randomized human-like pause in `[min_ms, max_ms]` between drive steps — but only when
    /// [`Self::paced`] is true (a no-op against a fixture base, keeping the fixture test fast).
    async fn pace(&self, min_ms: u64, max_ms: u64) {
        if self.paced() {
            tokio::time::sleep(Duration::from_millis(jitter_ms(min_ms, max_ms))).await;
        }
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
        let paced = self.paced();
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

        // This person's slugs: the one we were given and the one LinkedIn landed on (it redirects
        // an old /in/<id> to the member's current vanity URL, and its Pending marker carries THAT
        // slug). Read now, before any click, so it can only be this target's own profile.
        let slugs = target_slugs(url, &landed_url(&page).await);

        // Human-like pause before the first click, so the drive doesn't fire the instant the page
        // settles (no-op against a fixture base).
        self.pace(PACE_STEP_MIN_MS, PACE_STEP_MAX_MS).await;

        // Connect: a top-level button (main bar or sticky header), else the "…" overflow -> the
        // in-menu Connect item. Each target is located by TEXT/ROLE in JS, tagged, and clicked with
        // a REAL (trusted CDP) gesture — LinkedIn may ignore an untrusted synthetic `.click()`.
        if !locate_connect(&page).await {
            // No Connect because this person was ALREADY invited: their own Pending marker shows
            // instead. Recognize it (slug-tied only) so the draft isn't retried forever.
            if pending_for(&page, &slugs, false, WAIT_TRIES / 4).await {
                return Ok(InviteOutcome::AlreadyInvited);
            }
            return Ok(failed(
                &page,
                "could not find Connect (no top-level button and none in the More \"…\" overflow menu)",
            )
            .await);
        }

        // Defensive guard: if the Connect/More click navigated us AWAY from the member profile, we
        // must have clicked a mis-scoped control (a nav/sidebar/messaging look-alike) — which is the
        // exact live failure this scoping fix targets. Turn the resulting "crash" (teardown force-
        // closing the wrong page) into a diagnostic Failed + screenshot rather than driving on.
        let after_connect = page.url().await.ok().flatten().unwrap_or_default();
        if after_connect.contains("/notifications")
            || after_connect.contains("/feed")
            || after_connect.contains("/mynetwork")
            || !after_connect.contains("/in/")
        {
            return Ok(failed(
                &page,
                "clicked a control that navigated away from the profile: the profile action bar wasn't found where expected",
            )
            .await);
        }

        // Human-like pause between opening Connect and reaching for "Add a note".
        self.pace(PACE_STEP_MIN_MS, PACE_STEP_MAX_MS).await;

        // Add a note (scoped to the open invite dialog).
        match locate_and_click_retry(
            &page,
            "addnote",
            candidates::ACTION,
            match_::ADD_NOTE,
            scopes::DIALOG,
            EXCLUDE,
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

        // Human-like pause before typing the note.
        self.pace(PACE_STEP_MIN_MS, PACE_STEP_MAX_MS).await;

        // Fill the note: focus the textarea, insert via CDP `Input.insertText`, and VERIFY the value
        // stuck (so a silent fill-failure becomes Failed, not a blank note). When paced (real
        // LinkedIn) the insert is chunked with short gaps so it reads as typed, not pasted.
        if let Err(reason) = fill_note(&page, note, paced).await {
            return Ok(failed(&page, &reason).await);
        }

        // Assist stops here with the modal open for the human to click Send.
        if mode == SendMode::Assist {
            return Ok(InviteOutcome::Staged);
        }

        // The email gate: LinkedIn wants the member's email before it enables Send. We don't type
        // one, so this can never send — say so now instead of clicking a disabled Send and waiting
        // out the Pending timeout.
        if eval_bool(&page, email_gate_js()).await {
            return Ok(InviteOutcome::NeedsEmail);
        }

        // Human-like pause after the note is filled and before clicking Send (a beat longer — a
        // person re-reads the note before sending).
        self.pace(PACE_PRESEND_MIN_MS, PACE_PRESEND_MAX_MS).await;

        // Auto: click Send (scoped to the open invite dialog), then VERIFY. Never return Sent without
        // observing the confirmation.
        match locate_and_click_retry(
            &page,
            "send",
            candidates::ACTION,
            match_::SEND,
            scopes::DIALOG,
            EXCLUDE,
            WAIT_TRIES,
        )
        .await
        {
            Located::Clicked => {}
            Located::ClickFailed => {
                return Ok(failed(&page, "found the Send button but could not click it").await)
            }
            Located::NotFound => return Ok(failed(&page, "could not find the Send button").await),
        }

        // Confirmation: the shadow-piercing Pending marker appeared. Its presence is AUTHORITATIVE —
        // LinkedIn recorded the invite — so it is the SOLE signal we gate `Sent` on (never-false-
        // Sent preserved: no Pending => Failed). The old secondary "note textarea gone" check is
        // DROPPED on purpose: a lingering modal must never turn a real, recorded send into a false
        // negative — which, together with the marker being an `<a>` (not a `<button>`), was exactly
        // the shape of the live FALSE-NEGATIVE bug (invite sent on screen, driver reported Failed).
        // Confirmation is tied to THIS invite's target: the Pending marker's href must carry the
        // profile's `/in/<slug>` (so a sidebar "Pending" for a DIFFERENT person cannot confirm).
        if !pending_for(&page, &slugs, true, CONFIRM_TRIES).await {
            return Ok(failed(
                &page,
                &format!(
                    "Pending confirmation not found (predicate: {})",
                    selectors::PENDING_MARKER
                ),
            )
            .await);
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
            Ok(InviteOutcome::AlreadyInvited) => {
                session.close().await;
                Err(AssistError::AlreadyInvited)
            }
            // Assist never clicks Send, so a real driver should never report these.
            Ok(InviteOutcome::NeedsEmail) => {
                session.close().await;
                Err(AssistError::Failed(
                    "unexpected: an Assist drive reported NeedsEmail".to_string(),
                ))
            }
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

/// Outcome of a single locate-then-click attempt.
enum Located {
    /// Matched a visible element and completed a trusted CDP click on it.
    Clicked,
    /// Matched, but the trusted click failed (not clickable / detached mid-click).
    ClickFailed,
    /// No visible element matched the text/role predicate.
    NotFound,
}

/// Render a list of CSS selectors as a JS array literal (`["a","b"]`). The selectors are our own
/// constants and never contain a double quote, so double-quoting each is a safe, allocation-light
/// serialization.
fn js_array(items: &[&str]) -> String {
    let inner = items
        .iter()
        .map(|s| format!("\"{s}\""))
        .collect::<Vec<_>>()
        .join(",");
    format!("[{inner}]")
}

/// Build the locate-and-tag matcher expression for `candidates`/`predicate`/`tag`, confined to the
/// first present of `scopes` and excluding anything inside `exclude`. Simple `replace` (not
/// `format!`) so the JS braces don't need escaping and the inputs stay readable.
fn locate_js(
    tag: &str,
    candidates: &str,
    predicate: &str,
    scopes: &[&str],
    exclude: &str,
) -> String {
    LOCATE_TEMPLATE
        .replace("__HELPERS__", PIERCE_HELPERS)
        .replace("__CAND__", candidates)
        .replace("__PRED__", predicate)
        .replace("__TAG__", tag)
        .replace("__SCOPES__", &js_array(scopes))
        .replace("__EXCLUDE__", exclude)
}

/// Build a shadow-piercing snippet from `template` by injecting [`PIERCE_HELPERS`] at `__HELPERS__`.
fn with_helpers(template: &str) -> String {
    template.replace("__HELPERS__", PIERCE_HELPERS)
}

/// JS: click the `data-ct='<tag>'` node across the shadow boundary (the `.click()` fallback).
fn click_tagged_js(tag: &str) -> String {
    with_helpers(CLICK_TAGGED_TEMPLATE).replace("__TAG__", tag)
}

/// JS: focus the `data-ct='<tag>'` node across the shadow boundary.
fn focus_tagged_js(tag: &str) -> String {
    with_helpers(FOCUS_TAGGED_TEMPLATE).replace("__TAG__", tag)
}

/// JS: read the `data-ct='<tag>'` node's `.value` across the shadow boundary.
fn read_tagged_js(tag: &str) -> String {
    with_helpers(READ_TAGGED_TEMPLATE).replace("__TAG__", tag)
}

/// Cheap time-seeded jitter in `[min_ms, max_ms]` (inclusive). NOT cryptographic — it exists only to
/// make the pause BETWEEN drive steps read as human rather than instant. `rand` is not a dependency,
/// so entropy is derived from the current time's seconds+nanoseconds mixed through a small
/// splitmix64-style avalanche, which spreads even nanosecond-close consecutive calls across the span.
fn jitter_ms(min_ms: u64, max_ms: u64) -> u64 {
    if max_ms <= min_ms {
        return min_ms;
    }
    let span = max_ms - min_ms + 1;
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() ^ ((d.subsec_nanos() as u64) << 20))
        .unwrap_or(0);
    let mut x = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^= x >> 31;
    min_ms + (x % span)
}

/// Run a boolean matcher expression, mapping any error/non-bool result to `false`.
async fn eval_bool(page: &Page, js: impl Into<String>) -> bool {
    page.evaluate_expression(js.into())
        .await
        .ok()
        .and_then(|r| r.into_value::<bool>().ok())
        .unwrap_or(false)
}

/// Drop a `data-ct` tag (best-effort, shadow-piercing) so it can't be re-matched in a later pass.
async fn untag(page: &Page, tag: &str) {
    let _ = page
        .evaluate_expression(with_helpers(UNTAG_TEMPLATE).replace("__TAG__", tag))
        .await;
}

/// Run a locate expression that returns a viewport-center `[x, y]` (found) or `null` (not found).
async fn locate_coords(page: &Page, js: String) -> Option<(f64, f64)> {
    page.evaluate_expression(js)
        .await
        .ok()
        .and_then(|r| r.into_value::<(f64, f64)>().ok())
}

/// Dispatch a TRUSTED CDP left click at viewport coordinates `(x, y)` — a real `Input.dispatchMouse`
/// press+release, which resolves a shadow-nested target that `find_element` (a light-DOM
/// `DOM.querySelector`) cannot. A leading `mouseMoved` arms any hover-gated handler. Returns whether
/// both CDP commands were accepted.
async fn cdp_click(page: &Page, x: f64, y: f64) -> bool {
    let build = |t: DispatchMouseEventType| {
        DispatchMouseEventParams::builder()
            .r#type(t)
            .x(x)
            .y(y)
            .button(MouseButton::Left)
            .click_count(1)
            .build()
    };
    let (press, release) = match (
        build(DispatchMouseEventType::MousePressed),
        build(DispatchMouseEventType::MouseReleased),
    ) {
        (Ok(p), Ok(r)) => (p, r),
        _ => return false,
    };
    if let Ok(moved) = DispatchMouseEventParams::builder()
        .r#type(DispatchMouseEventType::MouseMoved)
        .x(x)
        .y(y)
        .build()
    {
        let _ = page.execute(moved).await;
    }
    page.execute(press).await.is_ok() && page.execute(release).await.is_ok()
}

/// Extract the LinkedIn profile slug from a profile URL: the path segment after the first `/in/`,
/// with any trailing slash / query / fragment stripped and lowercased. Returns None when the URL
/// carries no `/in/<slug>` segment (defensive — production always drives a canonical `/in/<slug>`
/// URL). This is what ties the post-invite Pending confirmation to THIS target (see
/// `PENDING_EXISTS_JS`), and mirrors the JS `slugOf` there so the Rust and JS sides agree.
fn profile_slug(profile_url: &str) -> Option<String> {
    let after = profile_url.split("/in/").nth(1)?;
    let slug = after.split(['/', '?', '#']).next().unwrap_or("").trim();
    if slug.is_empty() {
        None
    } else {
        Some(slug.to_lowercase())
    }
}

/// The target's slugs: from the URL we were given and from the URL the page landed on (deduped,
/// empties dropped). Both name the same person — LinkedIn redirects an old `/in/<id>` URL to the
/// member's current vanity URL, and the Pending marker carries the landed one.
fn target_slugs(given_url: &str, landed_url: &str) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    for s in [profile_slug(given_url), profile_slug(landed_url)]
        .into_iter()
        .flatten()
    {
        if !v.contains(&s) {
            v.push(s);
        }
    }
    v
}

/// The page's current `location.href` (reflects server redirects and SPA URL rewrites); "" if it
/// can't be read, which simply leaves only the given URL's slug.
async fn landed_url(page: &Page) -> String {
    page.evaluate_expression("location.href")
        .await
        .ok()
        .and_then(|r| r.into_value::<String>().ok())
        .unwrap_or_default()
}

/// Build the Pending IIFE for `slugs` (this target's `/in/<slug>`s), injecting the shadow-piercing
/// helpers and the EXCLUDE regions. `allow_nohref` enables the no-href `<main>` fallback pass (see
/// `PENDING_EXISTS_JS`). No slugs disables the slug pass — fail-safe, so a stray/mismatched marker
/// still can't match.
fn pending_exists_js(slugs: &[String], allow_nohref: bool) -> String {
    // JSON-encode: slugs come from stored/landed URLs, so quote them safely into the JS.
    let arr = serde_json::to_string(slugs).unwrap_or_else(|_| "[]".into());
    with_helpers(PENDING_EXISTS_JS)
        .replace("__SLUGS__", &arr)
        .replace(
            "__ALLOW_NOHREF__",
            if allow_nohref { "true" } else { "false" },
        )
        .replace("__EXCLUDE__", EXCLUDE)
}

/// JS: is LinkedIn's email-required invite gate showing? See `EMAIL_GATE_JS`.
fn email_gate_js() -> String {
    with_helpers(EMAIL_GATE_JS).replace("__EXCLUDE__", EXCLUDE)
}

/// Poll up to `tries` (~`tries * WAIT_INTERVAL`) for the shadow-piercing Pending marker (see
/// `PENDING_EXISTS_JS`) that belongs to THIS target's `slugs`. After Send (with `CONFIRM_TRIES`) it
/// is the AUTHORITATIVE "invite sent" signal and the sole never-false-Sent gate: the caller returns
/// `Sent` only when this is true, and only for a marker tied to the target (a stray sidebar
/// "Pending" for a different person cannot satisfy it). Before Connect it detects an invite that
/// already went out.
async fn pending_for(page: &Page, slugs: &[String], allow_nohref: bool, tries: u32) -> bool {
    let js = pending_exists_js(slugs, allow_nohref);
    for _ in 0..tries {
        if eval_bool(page, js.clone()).await {
            return true;
        }
        tokio::time::sleep(WAIT_INTERVAL).await;
    }
    false
}

/// Locate a target by TEXT/ROLE across the shadow boundary: the locate JS scrolls the match into
/// view, tags it `data-ct=<tag>`, and returns its viewport-center coordinates. We then click it with
/// a REAL (trusted CDP) mouse gesture at those coordinates — which resolves a shadow-nested node
/// (`find_element` cannot) and reads as a genuine user action (an untrusted JS `.click()` can be
/// ignored/flagged by LinkedIn). If coordinates are unusable or the CDP click is refused, fall back
/// to a shadow-piercing JS `.click()` on the tagged node. The tag is always removed afterward.
async fn locate_and_click(
    page: &Page,
    tag: &str,
    candidates: &str,
    predicate: &str,
    scopes: &[&str],
    exclude: &str,
) -> Located {
    let Some((x, y)) =
        locate_coords(page, locate_js(tag, candidates, predicate, scopes, exclude)).await
    else {
        return Located::NotFound;
    };
    let mut clicked = false;
    if x.is_finite() && y.is_finite() && x > 0.0 && y > 0.0 {
        clicked = cdp_click(page, x, y).await;
    }
    if !clicked {
        clicked = eval_bool(page, click_tagged_js(tag)).await;
    }
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
    scopes: &[&str],
    exclude: &str,
    tries: u32,
) -> Located {
    let mut last = Located::NotFound;
    for _ in 0..tries {
        match locate_and_click(page, tag, candidates, predicate, scopes, exclude).await {
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
    // (a) A top-level Connect in the profile action bar (short poll — absent on Follow/Message/"…"
    // profiles, by design). Scoped to `<main>` so a sidebar/nav "Connect" can't be mistaken for it.
    if let Located::Clicked = locate_and_click_retry(
        page,
        "connect",
        candidates::TOP,
        match_::CONNECT,
        scopes::MAIN,
        EXCLUDE,
        CONNECT_TRIES,
    )
    .await
    {
        return true;
    }
    // (b) The "…" overflow (also scoped to `<main>`, excluding the global-nav/messaging "…"), then
    // the Connect item inside the dropdown it opens (scoped to that open menu, not the whole page).
    if let Located::Clicked = locate_and_click_retry(
        page,
        "more",
        candidates::ACTION,
        match_::MORE,
        scopes::MAIN,
        EXCLUDE,
        CONNECT_TRIES,
    )
    .await
    {
        if let Located::Clicked = locate_and_click_retry(
            page,
            "connect",
            candidates::DROPDOWN,
            match_::CONNECT,
            scopes::DROPDOWN,
            EXCLUDE,
            WAIT_TRIES,
        )
        .await
        {
            return true;
        }
    }
    false
}

/// Insert `note` via CDP `Input.insertText` in small char-chunks (see `NOTE_CHUNK_CHARS`) with short
/// randomized gaps so it reads as typed, not pasted. Chunks are split on CHAR boundaries — an em-dash
/// / smart quote / emoji and the "\n"s are never split — and concatenate to EXACTLY `note`, so
/// `fill_note`'s read-back verify still asserts the full exact value. Returns false if any chunk
/// insert is rejected. Only called on the paced (real-LinkedIn) path.
async fn insert_note_chunked(page: &Page, note: &str) -> bool {
    let chars: Vec<char> = note.chars().collect();
    for chunk in chars.chunks(NOTE_CHUNK_CHARS) {
        let piece: String = chunk.iter().collect();
        if page.execute(InsertTextParams::new(piece)).await.is_err() {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(jitter_ms(
            NOTE_CHUNK_MIN_MS,
            NOTE_CHUNK_MAX_MS,
        )))
        .await;
    }
    true
}

/// Focus the note textarea and insert `note` via CDP `Input.insertText`, then VERIFY the field holds
/// exactly `note`. Insert (not per-key typing) handles arbitrary Unicode — em-dashes, smart quotes,
/// accents, emoji, all common in real notes/names — and fires the input events a React textarea
/// needs; `type_str` errors on any character outside its US-keyboard keymap. Returns a step reason on
/// failure so a blank/short fill becomes a diagnostic `Failed`, never a silently empty note.
async fn fill_note(page: &Page, note: &str, paced: bool) -> std::result::Result<(), String> {
    // Locate + tag the textarea (poll for the modal to render). The locate is shadow-piercing and
    // returns the textarea's viewport-center coordinates.
    let mut coords = None;
    for _ in 0..WAIT_TRIES {
        coords = locate_coords(page, with_helpers(LOCATE_TEXTAREA_JS)).await;
        if coords.is_some() {
            break;
        }
        tokio::time::sleep(WAIT_INTERVAL).await;
    }
    let Some((x, y)) = coords else {
        return Err("could not find the note textarea".to_string());
    };

    // Focus it: a trusted CDP click at its coordinates (works across the shadow boundary), then a
    // shadow-piercing JS `focus()` as a belt-and-suspenders — plain `focus()` works in an OPEN
    // shadow root and guarantees the field is the active element before we insert.
    if x.is_finite() && y.is_finite() && x > 0.0 && y > 0.0 {
        let _ = cdp_click(page, x, y).await;
    }
    let focused = eval_bool(page, focus_tagged_js("note")).await;
    if !focused {
        untag(page, "note").await;
        return Err("could not focus the note textarea".to_string());
    }

    // Insert the text. When paced (real LinkedIn) type it in small char-chunks with short randomized
    // gaps so it reads as typed, not pasted; unpaced (fixture) a single insert keeps the test fast.
    // Either way the inserted characters concatenate to EXACTLY `note` (chunks are split on CHAR
    // boundaries, so a multi-byte em-dash / smart quote / emoji and the "\n"s are never broken) and
    // the verify loop below still asserts the full exact value — so the newline end-to-end guard and
    // exact-value check are preserved regardless of chunking.
    let inserted = if paced {
        insert_note_chunked(page, note).await
    } else {
        page.execute(InsertTextParams::new(note)).await.is_ok()
    };
    if !inserted {
        untag(page, "note").await;
        return Err("failed to insert the note text".to_string());
    }

    // Verify the value actually landed (React can swallow an insert). Poll a few ticks, reading the
    // tagged textarea's value across the shadow boundary.
    let mut ok = false;
    for _ in 0..WAIT_TRIES {
        let value = page
            .evaluate_expression(read_tagged_js("note"))
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

/// Dump the current page's full HTML into `linkedin-debug/<ts>.html` for post-mortem when a step can't
/// be located — lets us see the REAL DOM (container class/role, exact button text) instead of guessing
/// against LinkedIn's shifting markup. Best-effort — never panics.
async fn debug_html(page: &Page) -> Option<PathBuf> {
    let dir = profile_dir().ok()?.parent()?.join("linkedin-debug");
    std::fs::create_dir_all(&dir).ok()?;
    crate::linkedin::set_private(&dir);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    let path = dir.join(format!("{ts}.html"));
    let html = page
        .evaluate_expression(DUMP_HTML_JS)
        .await
        .ok()?
        .into_value::<String>()
        .ok()?;
    std::fs::write(&path, html).ok()?;
    Some(path)
}

/// Serialize the page SHADOW-AWARE: the top document's `outerHTML` (the light-DOM shell), then for
/// every OPEN shadow host a marker + its `shadowRoot.innerHTML`, recursively, plus same-origin
/// iframe documents. Without this a "step not found" dump on live LinkedIn shows only an empty
/// light-DOM shell — the real invite modal lives inside an open shadow root and would be invisible.
const DUMP_HTML_JS: &str = r#"(() => {
  const out = ['<!-- === TOP DOCUMENT (light DOM) === -->'];
  try { out.push(document.documentElement.outerHTML); } catch (e) {}
  const walkHosts = (root) => {
    let els; try { els = root.querySelectorAll('*'); } catch (e) { return; }
    for (const el of els) {
      if (el.shadowRoot) {
        out.push('<!-- === OPEN SHADOW ROOT on <' + el.tagName.toLowerCase() + (el.id ? ' id="' + el.id + '"' : '') + '> === -->');
        try { out.push(el.shadowRoot.innerHTML); } catch (e) {}
        walkHosts(el.shadowRoot);
      }
      if (el.tagName === 'IFRAME') {
        try {
          if (el.contentDocument) {
            out.push('<!-- === SAME-ORIGIN IFRAME ' + (el.id ? 'id="' + el.id + '"' : '') + ' === -->');
            out.push(el.contentDocument.documentElement.outerHTML);
            walkHosts(el.contentDocument);
          }
        } catch (e) {}
      }
    }
  };
  walkHosts(document);
  return out.join('\n');
})()"#;

/// Build a `Failed` outcome, embedding the debug screenshot + HTML-dump paths when they could be
/// captured (the HTML is the definitive post-mortem for a "step not found" against live LinkedIn).
async fn failed(page: &Page, reason: &str) -> InviteOutcome {
    let shot = debug_screenshot(page).await;
    let html = debug_html(page).await;
    let mut msg = reason.to_string();
    if let Some(p) = shot {
        msg.push_str(&format!(" — screenshot: {}", p.display()));
    }
    if let Some(p) = html {
        msg.push_str(&format!(" — html: {}", p.display()));
    }
    InviteOutcome::Failed(msg)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_slug_extracts_and_normalizes() {
        // The canonical production form, plus trailing slash / query / fragment / mixed case, and the
        // local fixture form — all yield the bare, lowercased slug the Pending confirmation matches on.
        for (url, want) in [
            (
                "https://www.linkedin.com/in/ilyanovohatskyi",
                "ilyanovohatskyi",
            ),
            (
                "https://www.linkedin.com/in/ilyanovohatskyi/",
                "ilyanovohatskyi",
            ),
            ("https://www.linkedin.com/in/janedoe?trk=abc", "janedoe"),
            ("https://www.linkedin.com/in/janedoe#section", "janedoe"),
            ("https://www.linkedin.com/in/JaneDoe", "janedoe"),
            ("http://127.0.0.1:8080/in/janedoe", "janedoe"),
        ] {
            assert_eq!(profile_slug(url).as_deref(), Some(want), "url: {url}");
        }
    }

    #[test]
    fn target_slugs_include_the_landed_vanity_slug_once() {
        assert_eq!(
            target_slugs(
                "https://www.linkedin.com/in/toni-grunwald-b50615176",
                "https://www.linkedin.com/in/tonigrunwald/"
            ),
            vec!["toni-grunwald-b50615176", "tonigrunwald"]
        );
        // no redirect -> one slug; unreadable landed URL -> just the given one
        assert_eq!(
            target_slugs(
                "https://www.linkedin.com/in/JaneDoe",
                "https://www.linkedin.com/in/janedoe/?x=1"
            ),
            vec!["janedoe"]
        );
        assert_eq!(
            target_slugs("https://www.linkedin.com/in/janedoe", ""),
            vec!["janedoe"]
        );
    }

    #[test]
    fn profile_slug_none_without_in_segment() {
        // No `/in/<slug>` => None, which disables the slug pass (fail-safe: only the no-href fallback
        // remains, so a stray/mismatched Pending marker still can't confirm).
        for bad in [
            "https://www.linkedin.com/company/acme",
            "https://www.linkedin.com/feed/",
            "https://www.linkedin.com/in/",
            "",
        ] {
            assert_eq!(profile_slug(bad), None, "should have no slug: {bad}");
        }
    }
}
