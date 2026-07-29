//! Boot the local web app: bind loopback, mint a session token, open the browser.

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::web::{self, AppState};

pub async fn serve(port: Option<u16>, no_open: bool) -> Result<()> {
    crate::setup::ensure()?;
    let token = uuid::Uuid::new_v4().to_string();

    // Prefer the requested/default port; fall back to an OS-assigned one if taken.
    let wanted = SocketAddr::from(([127, 0, 0, 1], port.unwrap_or(8787)));
    let listener = match tokio::net::TcpListener::bind(wanted).await {
        Ok(l) => l,
        Err(_) => tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .context("could not bind a local port")?,
    };
    let addr = listener.local_addr()?;

    let state = Arc::new(AppState {
        token: token.clone(),
        port: addr.port(),
        runs: Mutex::new(HashMap::new()),
        chat: Mutex::new(web::ChatSession::default()),
        turn_lock: Mutex::new(()),
    });
    let app = web::router(state);

    let url = format!("http://{addr}/?t={token}");

    println!("\n  coldtrail is running:\n    {url}\n");
    if no_open {
        println!("  (open that URL in your browser)");
    } else if open::that(&url).is_err() {
        println!("  (couldn't auto-open a browser — open the URL above)");
    }
    println!("  press Ctrl-C to stop.\n");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server error")?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    println!("\n  coldtrail stopped.");
}
