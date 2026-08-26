//! The browser boundary. Real driving (Task 5) implements `LinkedInBrowser` with chromiumoxide;
//! tests use `FakeBrowser`. The send-path gate logic (linkedin::send) is written against the
//! trait so it is fully testable without a browser.

use anyhow::Result;
use async_trait::async_trait;

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

/// Real chromiumoxide-backed browser. STUB until Task 5 fills in the driving; returns Failed so
/// no invite can be claimed sent before the real impl exists.
#[allow(dead_code)]
pub struct ChromeBrowser;

#[allow(dead_code)]
impl ChromeBrowser {
    pub fn new() -> Result<Self> {
        Ok(ChromeBrowser)
    }
}

#[async_trait]
impl LinkedInBrowser for ChromeBrowser {
    async fn connect_and_wait_for_login(&self, _t: u64) -> Result<LoginOutcome> {
        Ok(LoginOutcome::TimedOut)
    }
    async fn send_connection_request(
        &self,
        _u: &str,
        _n: &str,
        _m: SendMode,
    ) -> Result<InviteOutcome> {
        Ok(InviteOutcome::Failed(
            "LinkedIn browser not yet implemented".into(),
        ))
    }
    async fn is_session_valid(&self) -> Result<bool> {
        Ok(false)
    }
}
