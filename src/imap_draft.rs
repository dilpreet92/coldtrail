//! Keyless Gmail drafts via IMAP `APPEND` with an app password — no OAuth client, no Google
//! Cloud project, no verification. Requires 2-Step Verification on the account (to mint an
//! app password) and IMAP enabled. Pure-rustls TLS so the static binary stays OpenSSL-free.

use anyhow::{anyhow, Context, Result};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

const HOST: &str = "imap.gmail.com";
const PORT: u16 = 993;
const DRAFTS: &str = "[Gmail]/Drafts";

/// Quote a string for an IMAP command (backslash-escape `\` and `"`).
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

type Tls = BufReader<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>;

/// Open a TLS connection to Gmail IMAP and read the server greeting.
async fn connect() -> Result<Tls> {
    // Install a process-default crypto provider once (idempotent); ring keeps us OpenSSL-free.
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
    let roots = RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(config));
    let tcp = tokio::net::TcpStream::connect((HOST, PORT))
        .await
        .context("connecting to imap.gmail.com:993")?;
    let name = ServerName::try_from(HOST)
        .map_err(|_| anyhow!("bad server name"))?
        .to_owned();
    let tls = connector
        .connect(name, tcp)
        .await
        .context("TLS handshake with imap.gmail.com")?;
    let mut stream = BufReader::new(tls);
    let mut greeting = String::new();
    stream.read_line(&mut greeting).await?; // "* OK Gimap ready..."
    Ok(stream)
}

/// Read response lines until the one tagged `tag`; error on NO/BAD (with the mailbox's message).
async fn read_tagged(stream: &mut Tls, tag: &str) -> Result<()> {
    let mut line = String::new();
    loop {
        line.clear();
        let n = stream.read_line(&mut line).await?;
        if n == 0 {
            return Err(anyhow!("IMAP connection closed unexpectedly"));
        }
        let t = line.trim_end();
        if let Some(rest) = t.strip_prefix(tag).and_then(|r| r.strip_prefix(' ')) {
            if rest.starts_with("OK") {
                return Ok(());
            }
            // Gmail's NO/BAD text is the useful part (e.g. bad app password, IMAP disabled).
            return Err(anyhow!("Gmail IMAP: {rest}"));
        }
        // otherwise an untagged `* …` line — keep reading
    }
}

/// Read until the server's `+` continuation prompt (for the APPEND literal).
async fn read_continuation(stream: &mut Tls, tag: &str) -> Result<()> {
    let mut line = String::new();
    loop {
        line.clear();
        let n = stream.read_line(&mut line).await?;
        if n == 0 {
            return Err(anyhow!("IMAP connection closed before APPEND continuation"));
        }
        let t = line.trim_end();
        if t.starts_with('+') {
            return Ok(());
        }
        if let Some(rest) = t.strip_prefix(tag).and_then(|r| r.strip_prefix(' ')) {
            // a tagged reply here means the command was rejected before the literal
            return Err(anyhow!("Gmail IMAP: {rest}"));
        }
    }
}

/// LOGIN then LOGOUT — used to check credentials at connect time.
pub async fn verify(email: &str, app_password: &str) -> Result<()> {
    let mut s = connect().await?;
    let pw = app_password.replace(' ', ""); // Google shows app passwords with spaces; strip them
    s.write_all(format!("a1 LOGIN {} {}\r\n", quote(email), quote(&pw)).as_bytes())
        .await?;
    read_tagged(&mut s, "a1")
        .await
        .context("IMAP login failed — check the email + app password, and that IMAP is enabled")?;
    let _ = s.write_all(b"a2 LOGOUT\r\n").await;
    Ok(())
}

/// Append `rfc822` to the Gmail Drafts folder as a draft. `rfc822` uses CRLF line endings.
pub async fn append_draft(email: &str, app_password: &str, rfc822: &str) -> Result<()> {
    let mut s = connect().await?;
    let pw = app_password.replace(' ', "");
    s.write_all(format!("a1 LOGIN {} {}\r\n", quote(email), quote(&pw)).as_bytes())
        .await?;
    read_tagged(&mut s, "a1")
        .await
        .context("IMAP login failed — check the email + app password, and that IMAP is enabled")?;

    // APPEND with a literal: {N} octets follow the continuation, then a terminating CRLF.
    let msg = rfc822.replace("\r\n", "\n").replace('\n', "\r\n"); // normalize to CRLF
    let cmd = format!(
        "a2 APPEND {} (\\Draft) {{{}}}\r\n",
        quote(DRAFTS),
        msg.len()
    );
    s.write_all(cmd.as_bytes()).await?;
    read_continuation(&mut s, "a2").await?;
    s.write_all(msg.as_bytes()).await?;
    s.write_all(b"\r\n").await?;
    read_tagged(&mut s, "a2")
        .await
        .context("saving the Gmail draft failed")?;

    let _ = s.write_all(b"a3 LOGOUT\r\n").await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_escape_specials() {
        assert_eq!(quote("a@b.com"), "\"a@b.com\"");
        assert_eq!(quote(r#"x"y\z"#), "\"x\\\"y\\\\z\"");
    }
}
