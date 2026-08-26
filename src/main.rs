mod agents;
mod chat_store;
mod cli;
mod config;
mod contact;
mod db;
mod deliver;
mod draft;
mod enrich;
mod find;
mod gcloud;
mod gmail;
mod home;
mod imap_draft;
mod import;
mod linkedin;
mod logf;
mod mark;
mod mcp;
mod mcp_client;
mod message;
mod oauth;
mod osint;
mod probe;
mod prompt;
mod provider;
mod run;
mod schedule;
mod scheduled;
mod secrets;
mod seed;
mod serve;
mod setup;
mod smtp;
mod source;
mod update;
mod web;

use clap::Parser;
use cli::{Cli, Commands};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        None => {
            update::auto_update().await; // best-effort; may relaunch, never blocks a launch
            serve::serve(None, false).await
        }
        Some(Commands::Serve { port, no_open }) => serve::serve(port, no_open).await,
        Some(Commands::Agent) => run::run().await,
        Some(Commands::Setup {
            provider,
            gmail_callback_port,
            skip_gmail,
            force,
        }) => setup::run(setup::SetupOpts {
            provider,
            gmail_callback_port,
            skip_gmail,
            force,
        }),
        Some(Commands::Source { queries, limit }) => source::run(&queries, limit).await,
        Some(Commands::Import { json, label }) => import::run(&json, &label),
        Some(Commands::AddContact {
            domain,
            name,
            email,
            linkedin,
            source,
        }) => {
            contact::run(
                &domain,
                &name,
                email.as_deref(),
                linkedin.as_deref(),
                source.as_deref(),
            )
            .await
        }
        Some(Commands::FindEmails { max }) => find::run(max.unwrap_or(20)).await,
        Some(Commands::DraftPrep { max }) => draft::run(max.unwrap_or(20)),
        Some(Commands::Draft {
            domain,
            subject,
            body,
        }) => draft::add(&domain, &subject, &body),
        Some(Commands::Followup {
            domain,
            subject,
            body,
        }) => draft::followup_add(&domain, &subject, &body),
        Some(Commands::Mark { domain, value }) => mark::run(&domain, &value),
        Some(Commands::LinkedinNote { domain, note }) => linkedin::note::add(&domain, &note),
        Some(Commands::Send { domain }) => deliver::run(&domain).await,
        Some(Commands::Seed) => seed::run(),
        Some(Commands::Update) => update::run().await,
        Some(Commands::Run {
            schedule,
            draft_only,
            trigger,
            chat,
        }) => {
            let derived = if draft_only {
                "dry"
            } else if schedule.is_some() {
                "scheduled"
            } else {
                "manual"
            };
            let effective_trigger = trigger.as_deref().unwrap_or(derived);
            scheduled::run(schedule.as_deref(), effective_trigger, chat.as_deref()).await
        }
        Some(Commands::Schedule { cmd }) => match cmd {
            cli::ScheduleCmd::Sync => schedule::sync(),
        },
        Some(Commands::Linkedin { cmd }) => match cmd {
            cli::LinkedinCmd::Connect => linkedin_connect().await,
            cli::LinkedinCmd::Status => {
                let s = linkedin::LinkedinState::load();
                println!(
                    "connected={} reconnect_needed={}",
                    s.connected, s.reconnect_needed
                );
                Ok(())
            }
        },
    }
}

/// Thin CLI mirror of the web connect flow (`src/web/linkedin.rs::connect`): launch a real,
/// human-visible Chrome window at the LinkedIn login page and wait (up to 3 minutes) for the
/// human to finish logging in. Unlike the web path — which spawns off the request and can't
/// surface a launch error to the caller — this awaits inline, so a `ChromeBrowser::new()` or
/// launch failure (e.g. no Chrome installed) prints directly instead of being swallowed.
async fn linkedin_connect() -> anyhow::Result<()> {
    use linkedin::browser::{ChromeBrowser, LinkedInBrowser, LoginOutcome};

    let browser = ChromeBrowser::new()?;
    match browser.connect_and_wait_for_login(180).await? {
        LoginOutcome::LoggedIn => {
            linkedin::LinkedinState {
                connected: true,
                reconnect_needed: false,
            }
            .save()?;
            println!("LinkedIn connected.");
        }
        LoginOutcome::TimedOut => {
            println!("Not logged in (timed out after 3 minutes) — run `coldtrail linkedin connect` again.");
        }
        LoginOutcome::WindowClosed => {
            println!("Not logged in (the Chrome window was closed) — run `coldtrail linkedin connect` again.");
        }
    }
    Ok(())
}

/// Test-only helpers. `COLDTRAIL_HOME` is process-global, so any test that sets it
/// must hold this lock to stay deterministic under the parallel test runner.
#[cfg(test)]
pub(crate) mod testutil {
    use std::path::PathBuf;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Serialize any test that mutates the process-global `COLDTRAIL_HOME`.
    pub fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn with_home<T>(sub: &str, f: impl FnOnce(&PathBuf) -> T) -> T {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(sub);
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("COLDTRAIL_HOME", &dir);
        let out = f(&dir);
        std::env::remove_var("COLDTRAIL_HOME");
        out
    }
}
