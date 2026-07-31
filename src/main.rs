mod agents;
mod cli;
mod config;
mod contact;
mod db;
mod draft;
mod enrich;
mod find;
mod gcloud;
mod gmail;
mod home;
mod import;
mod mark;
mod mcp;
mod mcp_client;
mod message;
mod oauth;
mod osint;
mod prompt;
mod provider;
mod run;
mod secrets;
mod seed;
mod serve;
mod setup;
mod source;
mod web;

use clap::Parser;
use cli::{Cli, Commands};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        None => serve::serve(None, false).await,
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
        Some(Commands::Source { query, limit }) => source::run(&query, limit).await,
        Some(Commands::Import { json, label }) => import::run(&json, &label),
        Some(Commands::AddContact {
            domain,
            name,
            email,
            source,
        }) => contact::run(&domain, &name, &email, source.as_deref()).await,
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
        Some(Commands::Seed) => seed::run(),
        Some(Commands::Update) => run::update(),
    }
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
