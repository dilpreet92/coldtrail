//! Thin, tty-aware prompt helpers. All return `None` when stdin is not a terminal,
//! so non-interactive (piped/CI) runs never block — callers fall back to env/flags.

use std::io::{self, IsTerminal, Write};

pub fn interactive() -> bool {
    io::stdin().is_terminal()
}

fn read_line() -> Option<String> {
    let mut s = String::new();
    match io::stdin().read_line(&mut s) {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(s.trim().to_string()),
    }
}

/// Free-text prompt with an optional default (returned when the user hits enter).
pub fn line(label: &str, default: Option<&str>) -> Option<String> {
    if !interactive() {
        return None;
    }
    match default {
        Some(d) => print!("{label} ({d}): "),
        None => print!("{label}: "),
    }
    io::stdout().flush().ok();
    let input = read_line()?;
    if input.is_empty() {
        default.map(|d| d.to_string())
    } else {
        Some(input)
    }
}

/// Choose one of `options`; enter accepts `default`. Re-prompts on an invalid choice.
pub fn select(label: &str, options: &[&str], default: &str) -> Option<String> {
    if !interactive() {
        return None;
    }
    loop {
        print!("{label} [{}] ({default}): ", options.join("/"));
        io::stdout().flush().ok();
        let input = read_line()?;
        if input.is_empty() {
            return Some(default.to_string());
        }
        if options.iter().any(|o| o.eq_ignore_ascii_case(&input)) {
            return Some(input.to_lowercase());
        }
        println!("  please choose one of: {}", options.join(", "));
    }
}

/// Hidden (no-echo) secret prompt.
pub fn secret(label: &str) -> Option<String> {
    if !interactive() {
        return None;
    }
    match rpassword::prompt_password(format!("{label}: ")) {
        Ok(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    }
}
