# coldtrail Rust CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python outreach scripts with a single installable Rust binary that is both the Claude Code launcher and the workflow commands the agent calls, distributed via `curl … | bash`.

**Architecture:** One `clap`-derive binary, `coldtrail`, with subcommands. Tool-owned assets (`CLAUDE.md`, `schema.sql`, default templates) are embedded via `include_str!`. State + user config live in `~/.coldtrail/` (overridable by `COLDTRAIL_HOME`), which doubles as the agent's working directory. Faithful ports of the existing Python logic; SQLite via bundled `rusqlite`.

**Tech Stack:** Rust 2021, `clap`, `rusqlite` (bundled), `serde`/`serde_json`, `toml`, `reqwest` (rustls-tls), `scraper`, `hickory-resolver`, `regex`, `anyhow`, `dirs`, `tokio`.

## Global Constraints

- Binary name: `coldtrail`. Edition 2021. MSRV: whatever `cargo` ships here (1.88).
- Workspace dir: `~/.coldtrail/`, overridable via `COLDTRAIL_HOME`. Resolve once, in `home.rs`.
- Dedupe key is always the company **domain**, lowercased + trimmed.
- **Drafts are never sent.** No subcommand may send email. `draft-prep` only writes rows + `pending_drafts.json`.
- Asset ownership: `CLAUDE.md` is tool-owned (rewritten from embed on `run`/`update`/`setup`). `message.toml`, `contacted.toml`, `config.toml` are user-owned (written from embed only if absent, never overwritten).
- Status vocab — company: `sourced → named → emailed → drafted → sent → replied / bounced / skip`; outreach: `draft_pending → drafted → sent → replied → bounced`.
- Only supported agent for now: `claude`. `config.toml` reserves the seam; nothing else wired.
- Public-safe: no private outreach strategy in any committed file.
- CTA link default points at Canonical with `{slug}` utm_content. Message placeholders: `{company}`, `{fn}`, `{slug}`, `{link}`; paragraph sentinel `"__CTA__"`.

---

## File Structure

```
Cargo.toml
src/
  main.rs        # clap parse + dispatch, tokio runtime
  cli.rs         # clap arg structs (Cli, Commands)
  home.rs        # COLDTRAIL_HOME resolution, ensure_workspace, asset writing
  db.rs          # rusqlite connect/init/upsert_company/set_status + row helpers
  message.rs     # Message struct, load from toml, render(company, founder, domain)
  import.rs      # parse_results (3 shapes) + run(import)
  enrich.rs      # score(), domain_emails(), first_name(), slug()  (pure, shared)
  contact.rs     # add-contact command
  find.rs        # find-emails command (ddg, fetch, resolve_founder, hunt, mx_ok)
  draft.rs       # draft-prep command
  mark.rs        # mark command
  seed.rs        # seed command (contacted.toml)
  setup.rs       # setup command
  run.rs         # run command (launch claude)
templates/
  CLAUDE.md
  schema.sql
  message.toml
  contacted.toml
install.sh
.github/workflows/release.yml
README.md
.gitignore
```

Removed: all `*.py`, `requirements.txt`, `outreach.db` from repo (state moves to `~/.coldtrail/`).

---

### Task 1: Cargo scaffold, CLI skeleton, home/workspace module

**Files:**
- Create: `Cargo.toml`, `src/main.rs`, `src/cli.rs`, `src/home.rs`
- Create: `templates/schema.sql` (copied verbatim from existing `schema.sql`)
- Test: unit tests inside `src/home.rs`

**Interfaces:**
- Produces: `home::workspace() -> anyhow::Result<PathBuf>` (resolves `COLDTRAIL_HOME` or `~/.coldtrail`, creates it), `home::path(name: &str) -> PathBuf`, `home::write_asset(name, contents, overwrite: bool)`.
- Produces: `cli::Cli` (clap) with `Commands` enum: `Run`, `Setup`, `Import{json,label}`, `AddContact{domain,name,email,source}`, `FindEmails{max}`, `DraftPrep{max}`, `Mark{domain,value}`, `Seed`, `Update`.

- [ ] **Step 1: Write `Cargo.toml`**

```toml
[package]
name = "coldtrail"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "coldtrail"
path = "src/main.rs"

[dependencies]
clap = { version = "4", features = ["derive"] }
rusqlite = { version = "0.31", features = ["bundled"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
toml = "0.8"
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }
scraper = "0.19"
hickory-resolver = "0.24"
regex = "1"
anyhow = "1"
dirs = "5"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "time"] }
```

- [ ] **Step 2: Write `src/home.rs` with a failing test**

```rust
use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

pub fn workspace() -> Result<PathBuf> {
    let dir = match std::env::var_os("COLDTRAIL_HOME") {
        Some(v) => PathBuf::from(v),
        None => dirs::home_dir().context("no home dir")?.join(".coldtrail"),
    };
    fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    Ok(dir)
}

pub fn path(name: &str) -> Result<PathBuf> {
    Ok(workspace()?.join(name))
}

/// Write an embedded asset. If overwrite is false, leaves an existing file untouched.
pub fn write_asset(name: &str, contents: &str, overwrite: bool) -> Result<bool> {
    let p = path(name)?;
    if p.exists() && !overwrite {
        return Ok(false);
    }
    fs::write(&p, contents).with_context(|| format!("write {}", p.display()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_respects_env_override() {
        let tmp = std::env::temp_dir().join("coldtrail-test-ws");
        std::env::set_var("COLDTRAIL_HOME", &tmp);
        let ws = workspace().unwrap();
        assert_eq!(ws, tmp);
        assert!(tmp.exists());
        std::env::remove_var("COLDTRAIL_HOME");
    }

    #[test]
    fn write_asset_no_overwrite_preserves() {
        let tmp = std::env::temp_dir().join("coldtrail-test-ow");
        std::env::set_var("COLDTRAIL_HOME", &tmp);
        write_asset("f.txt", "first", true).unwrap();
        let wrote = write_asset("f.txt", "second", false).unwrap();
        assert!(!wrote);
        assert_eq!(std::fs::read_to_string(tmp.join("f.txt")).unwrap(), "first");
        std::env::remove_var("COLDTRAIL_HOME");
    }
}
```

Note: tests that mutate the `COLDTRAIL_HOME` env var must run single-threaded or use distinct dirs; run finder/env tests with `cargo test -- --test-threads=1` if flakiness appears. Prefer distinct temp dirs per test (as above) to avoid cross-talk.

- [ ] **Step 3: Write `src/cli.rs`**

```rust
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "coldtrail", version, about = "Discovery-first, deduped outreach — drafts you send by hand.")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Launch the agent (Claude Code) in the coldtrail workspace
    Run,
    /// Write config + templates, initialize the database
    Setup,
    /// Import Canonical search results (JSON), deduped by domain
    Import { json: String, label: String },
    /// Add an MX-verified founder contact by hand
    AddContact { domain: String, name: String, email: String, source: Option<String> },
    /// Best-effort founder-email finder (OSINT)
    FindEmails { max: Option<usize> },
    /// Build personalized drafts -> pending_drafts.json (never sends)
    DraftPrep { max: Option<usize> },
    /// Record a Gmail draft id, or mark sent/bounced
    Mark { domain: String, value: String },
    /// Load already-contacted domains from contacted.toml (dedupe guard)
    Seed,
    /// Re-download the latest release binary in place
    Update,
}
```

- [ ] **Step 4: Write `src/main.rs` dispatching (stubs returning Ok for now)**

```rust
mod cli; mod home; mod db; mod message; mod import; mod enrich;
mod contact; mod find; mod draft; mod mark; mod seed; mod setup; mod run;

use clap::Parser;
use cli::{Cli, Commands};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        None | Some(Commands::Run) => run::run().await,
        Some(Commands::Setup) => setup::run(),
        Some(Commands::Import { json, label }) => import::run(&json, &label),
        Some(Commands::AddContact { domain, name, email, source }) =>
            contact::run(&domain, &name, &email, source.as_deref()).await,
        Some(Commands::FindEmails { max }) => find::run(max.unwrap_or(20)).await,
        Some(Commands::DraftPrep { max }) => draft::run(max.unwrap_or(20)),
        Some(Commands::Mark { domain, value }) => mark::run(&domain, &value),
        Some(Commands::Seed) => seed::run(),
        Some(Commands::Update) => run::update(),
    }
}
```

- [ ] **Step 5: Copy `schema.sql` to `templates/schema.sql`** (verbatim from existing repo file).

- [ ] **Step 6: `cargo test` — home tests pass; `cargo build` fails only on not-yet-written modules.** Create the remaining module files as empty stubs with the exact signatures below so the crate compiles. Commit.

```bash
git add Cargo.toml src templates/schema.sql
git commit -m "feat: cargo scaffold, CLI skeleton, workspace module"
```

---

### Task 2: db module

**Files:**
- Modify: `src/db.rs`
- Test: unit tests in `src/db.rs`

**Interfaces:**
- Consumes: `home::path`, embedded `templates/schema.sql`.
- Produces: `db::open() -> Result<Connection>` (opens `outreach.db`, `PRAGMA foreign_keys=ON`), `db::init() -> Result<()>` (executescript schema), `db::upsert_company(&Connection, domain, name, hq, employees, founding_year, source_query) -> Result<bool>` (true if newly inserted), `db::set_status(&Connection, domain, status) -> Result<()>`.

- [ ] **Step 1: Failing test for upsert dedupe**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn fresh() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c
    }
    #[test]
    fn upsert_is_deduped_by_domain() {
        let c = fresh();
        let a = upsert_company(&c, "acme.com", Some("Acme"), None, None, None, "q").unwrap();
        let b = upsert_company(&c, "acme.com", Some("Acme"), None, None, None, "q").unwrap();
        assert!(a); assert!(!b);
        let n: i64 = c.query_row("SELECT count(*) FROM companies", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }
    #[test]
    fn set_status_updates() {
        let c = fresh();
        upsert_company(&c, "acme.com", None, None, None, None, "q").unwrap();
        set_status(&c, "acme.com", "emailed").unwrap();
        let s: String = c.query_row("SELECT status FROM companies WHERE domain='acme.com'", [], |r| r.get(0)).unwrap();
        assert_eq!(s, "emailed");
    }
}
```

- [ ] **Step 2: Implement `src/db.rs`**

```rust
use anyhow::Result;
use rusqlite::{params, Connection};

pub const SCHEMA: &str = include_str!("../templates/schema.sql");

pub fn open() -> Result<Connection> {
    let c = Connection::open(crate::home::path("outreach.db")?)?;
    c.execute_batch("PRAGMA foreign_keys = ON;")?;
    Ok(c)
}

pub fn init() -> Result<()> {
    let c = open()?;
    c.execute_batch(SCHEMA)?;
    Ok(())
}

pub fn upsert_company(
    c: &Connection, domain: &str, name: Option<&str>, hq: Option<&str>,
    employees: Option<i64>, founding_year: Option<i64>, source_query: &str,
) -> Result<bool> {
    let exists: bool = c.query_row("SELECT 1 FROM companies WHERE domain=?1", [domain], |_| Ok(true)).optional_bool()?;
    if exists { return Ok(false); }
    c.execute(
        "INSERT INTO companies (domain,name,hq,employees,founding_year,source_query) VALUES (?1,?2,?3,?4,?5,?6)",
        params![domain, name, hq, employees, founding_year, source_query],
    )?;
    Ok(true)
}

pub fn set_status(c: &Connection, domain: &str, status: &str) -> Result<()> {
    c.execute("UPDATE companies SET status=?1 WHERE domain=?2", params![status, domain])?;
    Ok(())
}

// helper extension for optional existence
trait OptionalBool { fn optional_bool(self) -> Result<bool>; }
impl OptionalBool for rusqlite::Result<bool> {
    fn optional_bool(self) -> Result<bool> {
        match self { Ok(b) => Ok(b), Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false), Err(e) => Err(e.into()) }
    }
}
```

- [ ] **Step 3: `cargo test db::` passes. Commit.**

```bash
git add src/db.rs && git commit -m "feat: db module with deduped company upsert"
```

---

### Task 3: enrich module (pure helpers) — score, domain_emails, first_name, slug

**Files:**
- Modify: `src/enrich.rs`
- Test: unit tests in `src/enrich.rs`

**Interfaces:**
- Produces: `enrich::score(email, founder: Option<&str>) -> Option<&'static str>` returning `Some("direct")`, `Some("inferred")`, or `None` (reject). `enrich::domain_emails(text, domain) -> BTreeSet<String>`. `enrich::first_name(full: Option<&str>) -> String`. `enrich::slug(domain) -> String`.

- [ ] **Step 1: Failing tests (mirror Python semantics exactly)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_generic_and_placeholder() {
        assert!(score("info@acme.com", Some("Jane Roe")).is_none());
        assert!(score("john.doe@acme.com", None).is_none());
        assert!(score("jsmith@acme.com", None).is_none());
    }
    #[test]
    fn direct_when_founder_name_in_local() {
        assert_eq!(score("dilpreet@acme.com", Some("Dilpreet Singh")), Some("direct"));
    }
    #[test]
    fn inferred_when_no_name_match() {
        assert_eq!(score("hello2@acme.com", Some("Dilpreet Singh")), Some("inferred"));
    }
    #[test]
    fn domain_emails_only_on_domain() {
        let t = "reach me at sam@acme.com or noise@other.com";
        let got = domain_emails(t, "acme.com");
        assert!(got.contains("sam@acme.com"));
        assert!(!got.iter().any(|e| e.ends_with("other.com")));
    }
    #[test]
    fn first_name_and_slug() {
        assert_eq!(first_name(Some("Dilpreet Singh")), "Dilpreet");
        assert_eq!(first_name(None), "there");
        assert_eq!(slug("acme.co.uk"), "acme");
        assert_eq!(slug("sub.acme.com"), "sub-acme");
    }
}
```

- [ ] **Step 2: Implement `src/enrich.rs`** — port the Python `GENERIC`, `PLACEHOLDER`, `TITLE_WORDS`, `EMAIL_RE`, `score`, `domain_emails`, `first_name`, `slug`. `slug`: strip trailing `\.[a-z.]+$` then replace remaining `.` with `-` (matches `draft_prep.slug`).

```rust
use once_cell::sync::Lazy; // OR: use std::sync::LazyLock (std, 1.80+). Prefer std LazyLock to avoid a dep.
use regex::Regex;
use std::collections::BTreeSet;

// GENERIC and PLACEHOLDER: copy the exact string sets from find_emails.py.
// TITLE_WORDS regex: (Executive|Partner|Officer|Chief|Manager|Director|Founder|CEO|President|Head|Sales|Marketing|Team|Owner), case-insensitive.
// EMAIL_RE: [a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}
// score(): local = before '@', lowercased.
//   if local in GENERIC or PLACEHOLDER -> None
//   if local contains "doe" or "smith" -> None
//   if founder present and !TITLE_WORDS.is_match(founder):
//       parts = founder split whitespace, len>1, lowercased; if any part substring of local -> Some("direct")
//   Some("inferred")
// domain_emails(): EMAIL_RE.find_iter, trim, strip trailing '.', lowercase, keep those ending "@{domain}".
// first_name(): full.map(split_whitespace first).unwrap_or("there"); empty -> "there".
// slug(): Regex::new(r"\.[a-z.]+$") replace with "" then replace '.' -> '-'.
```

Use `std::sync::LazyLock` for the compiled regexes (no extra dep).

- [ ] **Step 3: `cargo test enrich::` passes. Commit.**

```bash
git add src/enrich.rs && git commit -m "feat: enrich pure helpers (score, extraction, slug)"
```

---

### Task 4: import command (3-shape JSON parser + dedupe)

**Files:**
- Modify: `src/import.rs`
- Test: unit tests in `src/import.rs`

**Interfaces:**
- Consumes: `db`, `serde_json`.
- Produces: `import::parse_results(raw: &str) -> Result<Vec<Company>>` where `Company{domain, name, hq, employees, founding_year}` via serde. `import::run(json_path, label) -> Result<()>`.

- [ ] **Step 1: Failing tests for all three shapes**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_bare_list() {
        let v = parse_results(r#"[{"domain":"acme.com","name":"Acme"}]"#).unwrap();
        assert_eq!(v[0].domain, "acme.com");
    }
    #[test]
    fn parses_results_wrapper() {
        let v = parse_results(r#"{"results":[{"domain":"acme.com"}]}"#).unwrap();
        assert_eq!(v.len(), 1);
    }
    #[test]
    fn parses_mcp_text_wrapper() {
        let inner = r#"{\"results\":[{\"domain\":\"acme.com\"}]}"#;
        let raw = format!(r#"[{{"type":"text","text":"{}"}}]"#, inner);
        let v = parse_results(&raw).unwrap();
        assert_eq!(v[0].domain, "acme.com");
    }
}
```

- [ ] **Step 2: Implement `parse_results`** — deserialize to `serde_json::Value`; if array whose first elem is an object containing `"text"`, parse that string recursively; if object, take `results`; if array, take as-is. Map each to `Company` reading fields `domain`,`name`,`headquarters`→hq,`employee_count`→employees,`founding_year`. Then `run`: read file, parse, `db::init()`, for each lowercase+trim domain (skip empty), `upsert_company`, count added/skipped, print `imported: N new, M already-known (deduped) from T results`.

- [ ] **Step 3: `cargo test import::` passes. Commit.**

```bash
git add src/import.rs && git commit -m "feat: import command with 3-shape JSON parser + dedupe"
```

---

### Task 5: message module + draft-prep command

**Files:**
- Modify: `src/message.rs`, `src/draft.rs`
- Create: `templates/message.toml` (translated from `message.example.py`)
- Test: unit tests in `src/message.rs`

**Interfaces:**
- Produces: `message::Message` (serde from toml: `link, subject, paragraphs: Vec<String>, cta_plain, cta_html`), `message::Message::load() -> Result<Message>` (reads `message.toml`), `Message::render(company: Option<&str>, founder: Option<&str>, domain) -> Rendered{subject, body, html, link}`.
- Consumes (draft): `db`, `message`, `enrich::{first_name,slug}`.
- Produces (draft): `draft::run(max) -> Result<()>`.

- [ ] **Step 1: `templates/message.toml`** — translate `message.example.py` fields verbatim (LINK→link, SUBJECT→subject, PARAGRAPHS→paragraphs, CTA_PLAIN→cta_plain, CTA_HTML→cta_html; keep `__CTA__` sentinel and `— Your Name`).

- [ ] **Step 2: Failing render test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Message {
        Message {
            link: "https://x/?utm_content={slug}".into(),
            subject: "found {company}".into(),
            paragraphs: vec!["Hi {fn},".into(), "__CTA__".into(), "— Me".into()],
            cta_plain: "see {link}".into(),
            cta_html: "see <a href=\"{link}\">x</a>".into(),
        }
    }
    #[test]
    fn render_fills_placeholders_and_cta() {
        let r = sample().render(Some("Acme"), Some("Dilpreet Singh"), "acme.com");
        assert_eq!(r.subject, "found Acme");
        assert!(r.body.starts_with("Hi Dilpreet,"));
        assert!(r.body.contains("see https://x/?utm_content=acme"));
        assert!(r.html.contains("<p>Hi Dilpreet,</p>"));
        assert!(r.html.contains("<a href=\"https://x/?utm_content=acme\">x</a>"));
        assert!(!r.body.contains("__CTA__"));
    }
}
```

- [ ] **Step 3: Implement `render`** — `fn = first_name(founder)`, `link = self.link.replace("{slug}", &slug(domain))`. Substitute `{company}`/`{fn}` in subject and each paragraph. Body: join paragraphs with `\n\n`, replacing `__CTA__` para with `cta_plain` (after `{link}` substitution). Html: wrap each in `<p>…</p>`, `__CTA__` → `cta_html` with `{link}`. Use a small `fill(s, company, fn)` helper (plain `.replace`).

- [ ] **Step 4: Implement `draft::run`** — port `draft_prep.py`: `db::init()`, select `contacts JOIN companies WHERE mx_ok=1 AND email NOT NULL AND company.status='emailed' AND NOT EXISTS(outreach for domain) ORDER BY found_at LIMIT ?`. For each: `Message::load()?.render(name, founder_name, domain)`, insert outreach `draft_pending`, push `{domain,to,subject,body,html}`. Write `pending_drafts.json` (pretty). Print count + `domain -> email` lines. If `message.toml` missing, error with the copy: "No message.toml — run `coldtrail setup`, then edit ~/.coldtrail/message.toml".

- [ ] **Step 5: `cargo test message::` passes. Commit.**

```bash
git add src/message.rs src/draft.rs templates/message.toml
git commit -m "feat: message rendering + draft-prep command"
```

---

### Task 6: add-contact + mark + seed commands

**Files:**
- Modify: `src/contact.rs`, `src/mark.rs`, `src/seed.rs`
- Create: `templates/contacted.toml`
- Test: unit test for contacted.toml parsing in `src/seed.rs`

**Interfaces:**
- Consumes: `db`, `enrich::score`, `find::mx_ok`.
- Produces: `contact::run(domain,name,email,source) -> Result<()>` (async — calls mx_ok), `mark::run(domain,value) -> Result<()>`, `seed::run() -> Result<()>`, `seed::parse(raw: &str) -> Result<Vec<(String,String,String)>>` returning `(domain,name,status)`.

- [ ] **Step 1: `templates/contacted.toml`** — translate `seed_contacted.example.py` CONTACTED dict to the toml shape in the spec.

- [ ] **Step 2: Failing test for seed parse**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_contacted_toml() {
        let raw = r#"
"a.com" = { name = "A", status = "sent" }
"b.io" = { name = "B", status = "skip" }
"#;
        let mut v = parse(raw).unwrap();
        v.sort();
        assert_eq!(v[0], ("a.com".into(), "A".into(), "sent".into()));
        assert_eq!(v[1], ("b.io".into(), "B".into(), "skip".into()));
    }
}
```

- [ ] **Step 3: Implement `seed`** — `parse` via `toml::from_str` into `BTreeMap<String, Entry{name,status}>`; `run` does `db::init()`, upsert each + `set_status`, count, print `seeded N …`.

- [ ] **Step 4: Implement `contact::run`** — port `add_contact.py`: `conf = score(email, Some(name))`; if None → eprintln "REJECTED (generic/placeholder): {email}" and `std::process::exit(2)`. `ok = find::mx_ok(domain_of(email)).await`. Ensure company row (`INSERT` with `source_query='manual'` if absent). `INSERT OR IGNORE` contact. status = emailed if ok else named. Print line.

- [ ] **Step 5: Implement `mark::run`** — port `mark_drafted.py`: `sent` → outreach `sent`+`sent_at=datetime('now')`, company `sent`; `bounced` → both bounced; else set `gmail_draft_id=value,status='drafted'` + company drafted. Print `{domain}: {value}`.

- [ ] **Step 6: `cargo test seed::` passes. Commit.**

```bash
git add src/contact.rs src/mark.rs src/seed.rs templates/contacted.toml
git commit -m "feat: add-contact, mark, seed commands"
```

---

### Task 7: find-emails command (the finder)

**Files:**
- Modify: `src/find.rs`
- Test: unit tests for the pure `hunt`-selection logic where feasible; network paths are manual smoke.

**Interfaces:**
- Consumes: `db`, `enrich::{score,domain_emails}`, `reqwest`, `scraper`, `hickory-resolver`, `regex`.
- Produces: `find::mx_ok(domain: &str) -> bool` (async), `find::run(max) -> Result<()>`, internal `ddg(query, max) -> Vec<SearchHit{title,body,href}>`, `fetch(url) -> String`, `resolve_founder(company, domain) -> Option<String>`, `hunt(domain, company, founder) -> Option<Found{email,confidence,source}>`.

- [ ] **Step 1: Implement `mx_ok`** — hickory `TokioAsyncResolver::tokio_from_system_conf()` (fallback `::tokio(default,default)`); `resolver.mx_lookup(domain).await` non-empty → true; else `resolver.ipv4_lookup(domain).await` ok → true; else false. Match Python's MX-then-A fallback.

- [ ] **Step 2: Implement `ddg`** — POST/GET `https://html.duckduckgo.com/html/?q={urlencoded}` with a browser UA; parse with `scraper`: each `.result` → `.result__title` text, `.result__snippet` text, `.result__a` href (DuckDuckGo wraps hrefs as `//duckduckgo.com/l/?uddg=<urlencoded target>` — decode the `uddg` param to recover the real URL). Return up to `max` hits. On any error return empty vec (Python swallows errors).

- [ ] **Step 3: Implement `fetch`** — `reqwest::Client` GET, 12s timeout, browser UA; return body on 200 else "".

- [ ] **Step 4: Implement `resolve_founder`** — two queries `"{company} {domain} founder CEO"`, `"\"{company}\" founder"`; for each ddg hit build blob `title + " " + body`; two regexes (capitalized pair near founder/CEO, and after founder/CEO); return first match not matching TITLE_WORDS. `sleep(1s)` between queries (`tokio::time::sleep`).

- [ ] **Step 5: Implement `hunt`** — build query list (founder-aware + fallbacks) exactly as Python; for each ddg hit: extract `domain_emails` from blob, `score`, record with source `ddg-snippet`; if `href` contains domain, add `href.split('?')[0]` to `domain_urls`. `sleep(1.2s)` between queries. Then add `https://{domain}{path}` for each CANDIDATE_PATH; fetch first 8 urls, extract + score with source `site-page`. `usable = candidates where conf=="direct" OR source=="site-page"`; if empty None; pick direct first else inferred. Return best.

- [ ] **Step 6: Implement `run`** — port loop: select companies `status IN ('sourced','named') AND NOT EXISTS verified contact ORDER BY first_seen LIMIT ?`; per row get seeded founder else `resolve_founder`; print line; `hunt`; if None set status named/sourced + continue; else `mx_ok(domain)`, `INSERT OR IGNORE` contact, status emailed/named, print result line.

- [ ] **Step 7: Add a unit test for the `uddg` href decoder** (pure) and for candidate-usability selection given a synthetic candidate map.

```rust
#[test]
fn decodes_uddg_href() {
    let h = "//duckduckgo.com/l/?uddg=https%3A%2F%2Facme.com%2Fteam&rut=x";
    assert_eq!(decode_ddg_href(h), "https://acme.com/team");
}
```

- [ ] **Step 8: `cargo build` clean, `cargo test find::` passes. Commit.**

```bash
git add src/find.rs && git commit -m "feat: find-emails OSINT finder (ddg html + mx verify)"
```

---

### Task 8: setup + run + update commands, embedded assets, CLAUDE.md + templates

**Files:**
- Modify: `src/setup.rs`, `src/run.rs`
- Create: `templates/CLAUDE.md`
- Test: manual (workspace population), plus a unit test asserting `setup` writes the expected files under a temp `COLDTRAIL_HOME`.

**Interfaces:**
- Consumes: `home`, `db`.
- Produces: `setup::run() -> Result<()>`, `run::run() -> Result<()>` (async), `run::update() -> Result<()>`.
- Embedded consts: `CLAUDE_MD = include_str!("../templates/CLAUDE.md")`, `MESSAGE_TOML`, `CONTACTED_TOML`, `CONFIG_TOML` (a literal `agent = "claude"\n`).

- [ ] **Step 1: Write `templates/CLAUDE.md`** — the public-safe agent brief (identity, run loop referencing `coldtrail <subcommand>` + Canonical/Gmail MCPs, guardrails verbatim). No private strategy.

- [ ] **Step 2: Implement `setup::run`** — `home::workspace()`; `write_asset("CLAUDE.md", CLAUDE_MD, true)`; `write_asset("config.toml", "agent = \"claude\"\n", false)`; `write_asset("message.toml", MESSAGE_TOML, false)`; `write_asset("contacted.toml", CONTACTED_TOML, false)`; `db::init()`. Print what was created vs already present, then next-steps (edit message.toml/contacted.toml, `coldtrail seed`, `coldtrail`).

- [ ] **Step 3: Failing test for setup population**

```rust
#[test]
fn setup_populates_workspace() {
    let tmp = std::env::temp_dir().join("coldtrail-setup-test");
    let _ = std::fs::remove_dir_all(&tmp);
    std::env::set_var("COLDTRAIL_HOME", &tmp);
    crate::setup::run().unwrap();
    for f in ["CLAUDE.md","config.toml","message.toml","contacted.toml","outreach.db"] {
        assert!(tmp.join(f).exists(), "missing {f}");
    }
    std::env::remove_var("COLDTRAIL_HOME");
}
```

- [ ] **Step 4: Implement `run::run`** — ensure workspace, refresh `CLAUDE.md` (`write_asset(..., true)`), ensure config/message/contacted exist (call setup logic or a shared `ensure()`), then check `claude` on PATH (`which`); if missing, eprintln guidance (`npm i -g @anthropic-ai/claude-code`) + exit. Else `std::process::Command::new("claude").current_dir(workspace)` and on Unix `.exec()` (via `std::os::unix::process::CommandExt`) replacing the process; fallback `.status()`.

- [ ] **Step 5: Implement `run::update`** — for now: print the one-line curl reinstall command and (if release exists) attempt re-download; acceptable minimal: shell out to the install.sh URL via curl. Keep simple; document that full self-update lands with releases.

- [ ] **Step 6: `cargo test` full suite green. Commit.**

```bash
git add src/setup.rs src/run.rs templates/CLAUDE.md
git commit -m "feat: setup/run/update commands + embedded CLAUDE.md"
```

---

### Task 9: install.sh + release workflow

**Files:**
- Create: `install.sh`, `.github/workflows/release.yml`
- Test: `bash -n install.sh`; `shellcheck` if available; end-to-end run with `COLDTRAIL_BIN` into a temp dir.

- [ ] **Step 1: Write `install.sh`** — `set -euo pipefail`; detect `uname -sm` → target (`aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`); check `claude` (guide `npm i -g @anthropic-ai/claude-code` + exit non-zero if missing); resolve binary:
  - if `COLDTRAIL_BIN` set → copy it to `~/.local/bin/coldtrail` (test path).
  - else try download `https://github.com/dilpreet92/coldtrail/releases/latest/download/coldtrail-<target>.tar.gz` → extract → install.
  - else if `cargo` present → `cargo install --git https://github.com/dilpreet92/coldtrail --root ~/.local` (from-source fallback).
  - else print instructions + exit.
  `chmod +x`; PATH check on `~/.local/bin` → print `export PATH="$HOME/.local/bin:$PATH"` guidance (no rc edit). Print next steps.

- [ ] **Step 2: Write `.github/workflows/release.yml`** — on `push: tags: ['v*']`, matrix over the three targets on `macos-latest`/`ubuntu-latest`, `cargo build --release --target`, tar.gz the binary as `coldtrail-<target>.tar.gz`, `softprops/action-gh-release` upload.

- [ ] **Step 3: Test install.sh locally**

```bash
cargo build --release
bash -n install.sh
COLDTRAIL_BIN="$PWD/target/release/coldtrail" HOME="$(mktemp -d)" bash install.sh
# assert ~/.local/bin/coldtrail exists in the temp HOME and `coldtrail --version` runs
```

- [ ] **Step 4: Commit.**

```bash
git add install.sh .github/workflows/release.yml
git commit -m "feat: curl|bash installer + release workflow"
```

---

### Task 10: README rewrite, remove Python, .gitignore, end-to-end smoke

**Files:**
- Rewrite: `README.md`
- Delete: `*.py`, `requirements.txt`, repo `outreach.db` if tracked
- Modify: `.gitignore`

- [ ] **Step 1: `git rm` the Python files + requirements.txt.** Keep `schema.sql`? No — it now lives in `templates/schema.sql`; remove the root copy.

- [ ] **Step 2: Rewrite README** — new install (`curl … | bash`), the `coldtrail` command table, the each-run loop in terms of subcommands, guardrails, migration note (copy old `outreach.db` → `~/.coldtrail/`, translate message/seed to toml), Canonical credit, MIT/build-in-public note.

- [ ] **Step 3: Update `.gitignore`** — replace Python-era ignores with `/target`, keep editor/OS noise. Runtime state lives in `~/.coldtrail/`, not the repo.

- [ ] **Step 4: End-to-end smoke into a temp workspace**

```bash
export COLDTRAIL_HOME="$(mktemp -d)"
./target/release/coldtrail setup
echo '[{"domain":"ACME.com ","name":"Acme","employee_count":10}]' > /tmp/r.json
./target/release/coldtrail import /tmp/r.json "smoke test"      # 1 new
./target/release/coldtrail import /tmp/r.json "smoke test"      # 0 new, 1 deduped
./target/release/coldtrail add-contact acme.com "Dilpreet Singh" dilpreet@acme.com manual
./target/release/coldtrail draft-prep 5                          # writes pending_drafts.json
cat "$COLDTRAIL_HOME/pending_drafts.json"
./target/release/coldtrail mark acme.com draft_abc123
./target/release/coldtrail mark acme.com sent
unset COLDTRAIL_HOME
```
Expected: dedupe message on second import; a draft row + json entry for acme.com; status transitions succeed. (add-contact will hit real DNS for MX — acme.com resolves, so mx_ok=true.)

- [ ] **Step 5: `cargo fmt`, `cargo clippy --all-targets` clean; full `cargo test` green. Commit.**

```bash
git add -A && git commit -m "feat: rewrite README, remove Python, e2e smoke green"
```

---

## Self-Review

**Spec coverage:** command table (Tasks 4-8), embedded workspace (Tasks 1,8), message.toml (Task 5), finder port (Task 7), install+releases (Task 9), CLAUDE.md (Task 8), README+migration (Task 10), testing (each task + Task 10 smoke). All spec sections mapped.

**Type consistency:** `db::upsert_company` signature reused by import/seed/contact; `enrich::score` returns `Option<&'static str>` consumed by contact/find; `find::mx_ok` async bool consumed by contact/find; `message::Message::render` shape consumed by draft. Consistent across tasks.

**Placeholder scan:** finder network functions specify exact endpoints, parse selectors, and the `uddg` decode; no "handle errors appropriately" left abstract (Python's swallow-and-continue is stated). One acknowledged soft spot: `scraper` selector class names for DuckDuckGo HTML may need adjustment at implementation time if the markup differs — implementer verifies against a live fetch during Task 7.
