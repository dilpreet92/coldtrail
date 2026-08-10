//! Keyless Gmail SEND via SMTP submission with an app password — the send counterpart to
//! `imap_draft` (which only drafts). Implicit TLS to smtp.gmail.com:465, pure-rustls so the
//! static binary stays OpenSSL-free. Used only when the human has opted into auto-send.

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

const HOST: &str = "smtp.gmail.com";
const PORT: u16 = 465; // implicit TLS (SMTPS) — simpler than STARTTLS on 587

type Tls = BufReader<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>;

/// Dot-stuff a message body for SMTP DATA: lines beginning with `.` get an extra `.`, and the
/// whole thing is normalized to CRLF. (The terminating `\r\n.\r\n` is added by the caller.)
fn dot_stuff(rfc822: &str) -> String {
    let crlf = rfc822.replace("\r\n", "\n").replace('\n', "\r\n");
    crlf.split("\r\n")
        .map(|l| if l.starts_with('.') { format!(".{l}") } else { l.to_string() })
        .collect::<Vec<_>>()
        .join("\r\n")
}

async fn connect() -> Result<Tls> {
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
        .context("connecting to smtp.gmail.com:465")?;
    let name = ServerName::try_from(HOST)
        .map_err(|_| anyhow!("bad server name"))?
        .to_owned();
    let tls = connector
        .connect(name, tcp)
        .await
        .context("TLS handshake with smtp.gmail.com")?;
    let mut stream = BufReader::new(tls);
    read_code(&mut stream).await?; // server greeting "220 ..."
    Ok(stream)
}

/// Read one SMTP reply (handling multi-line `250-…` continuations) and return its 3-digit code.
/// A 4xx/5xx code is an error carrying the server's text (the useful part on rejection).
async fn read_code(stream: &mut Tls) -> Result<u16> {
    let last;
    loop {
        let mut line = String::new();
        let n = stream.read_line(&mut line).await?;
        if n == 0 {
            return Err(anyhow!("SMTP connection closed unexpectedly"));
        }
        let t = line.trim_end().to_string();
        // A continuation line has a '-' as the 4th char; a space means it's the final line.
        let more = t.as_bytes().get(3) == Some(&b'-');
        if !more {
            last = t;
            break;
        }
    }
    let code: u16 = last.get(0..3).and_then(|c| c.parse().ok()).unwrap_or(0);
    if (200..400).contains(&code) {
        Ok(code)
    } else {
        Err(anyhow!("Gmail SMTP: {last}"))
    }
}

async fn cmd(stream: &mut Tls, line: &str) -> Result<u16> {
    stream.write_all(line.as_bytes()).await?;
    stream.write_all(b"\r\n").await?;
    read_code(stream).await
}

/// Send `rfc822` (built by `gmail::mime_message`) to `to`, authenticating as `email` with an
/// app password. Envelope sender is the authenticated address.
pub async fn send(email: &str, app_password: &str, to: &str, rfc822: &str) -> Result<()> {
    let pw = app_password.replace(' ', "");
    let to = to.replace(['\r', '\n'], " ");
    let mut s = connect().await?;
    cmd(&mut s, "EHLO coldtrail").await.context("SMTP EHLO")?;
    // AUTH LOGIN: username then password, each base64, each after a 334 prompt.
    cmd(&mut s, "AUTH LOGIN").await.context("SMTP AUTH LOGIN")?;
    cmd(&mut s, &STANDARD.encode(email.as_bytes()))
        .await
        .context("SMTP username")?;
    cmd(&mut s, &STANDARD.encode(pw.as_bytes()))
        .await
        .context("SMTP login failed — check the email + app password")?;
    cmd(&mut s, &format!("MAIL FROM:<{email}>")).await?;
    cmd(&mut s, &format!("RCPT TO:<{to}>"))
        .await
        .context("recipient rejected")?;
    cmd(&mut s, "DATA").await?; // expects 354
    let body = dot_stuff(rfc822);
    s.write_all(body.as_bytes()).await?;
    s.write_all(b"\r\n.\r\n").await?;
    read_code(&mut s).await.context("message rejected on send")?;
    let _ = cmd(&mut s, "QUIT").await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_stuffs_leading_dots_and_crlf() {
        let out = dot_stuff("line one\n. hidden\n.. two");
        assert!(out.contains("\r\n"));
        assert!(out.contains(".. hidden"), "a leading dot is doubled");
        assert!(out.contains("... two"), "two leading dots become three");
        assert!(out.starts_with("line one"));
    }
}
