# coldtrail — Rust CLI rewrite + installer

**Date:** 2026-07-24
**Status:** Approved design, pre-implementation

## Goal

Turn `coldtrail` from a Python-scripts-in-a-repo workflow into a single installable
Rust binary distributed via `curl … | bash`. The binary is both the **launcher**
(spins up Claude Code, the only supported agent for now) and the **workflow commands
the agent calls**. This is step one of the Hermes-style vision: `install` → `setup`
(models/providers/BYOK later) → run.

The only runtime dependency becomes the `claude` CLI. No Python, no venv, no pip.

## Non-goals (for now)

- Any agent other than Claude Code. `config.toml` reserves the seam; nothing else wired.
- Provider/model selection and BYOK key management in `setup` (future; stubbed).
- A `.mcp.json` shipped in the workspace (the author's account already has Canonical +
  Gmail connectors; revisit for fresh-clone users later).
- Rewriting outreach *strategy*; the private learnings stay out of the public repo.

## Architecture

One `clap`-based binary, `coldtrail`, with subcommands. The same binary that launches
the agent is on PATH, so the launched agent calls `coldtrail import`, `coldtrail
draft-prep`, etc. — not `python foo.py`.

| Command | Replaces | Behavior |
|---|---|---|
| `coldtrail` (no args) / `coldtrail run` | shell alias | ensure `~/.coldtrail/CLAUDE.md` current, then `cd ~/.coldtrail && exec claude` |
| `coldtrail setup` | manual venv/copy | write config + templates if absent, init DB, print next steps |
| `coldtrail import <results.json> "<label>"` | `import_companies.py` | dedupe-import Canonical results |
| `coldtrail add-contact <domain> "<name>" <email> [source]` | `add_contact.py` | MX-verified manual contact add |
| `coldtrail find-emails [max]` | `find_emails.py` | OSINT founder-email finder |
| `coldtrail draft-prep [max]` | `draft_prep.py` | build drafts → `pending_drafts.json` |
| `coldtrail mark <domain> <id\|sent\|bounced>` | `mark_drafted.py` | advance outreach + company status |
| `coldtrail seed` | `seed_contacted.py` | load already-contacted dedupe guard from `contacted.toml` |
| `coldtrail update` | — | re-download the latest release binary in place |

### No repo at runtime — the embedded workspace

A compiled binary has no repo directory to live in. The binary **embeds** its
tool-owned assets via `include_str!`: `CLAUDE.md`, `schema.sql`, and the default
`message` / `contacted` templates. `~/.coldtrail/` is the agent's self-contained
working directory:

```
~/.coldtrail/
  CLAUDE.md          # tool-owned — refreshed from the binary on run/update
  config.toml        # { agent = "claude" }  ← seam for providers/BYOK later
  message.toml       # user-owned — created if absent, NEVER clobbered  (was message.py)
  contacted.toml     # user-owned — dedupe seed list                    (was seed_contacted.py)
  outreach.db        # SQLite state (rusqlite, bundled sqlite)
  pending_drafts.json
```

- **Location override:** `COLDTRAIL_HOME` env var (used for testing; defaults to
  `~/.coldtrail`).
- **Ownership rule:** `CLAUDE.md` is tool-owned and re-written from the embedded copy
  on every `run`/`update` so it always matches the binary. `message.toml`,
  `contacted.toml`, `config.toml` are user-owned: created from embedded defaults only
  if absent, never overwritten.

### Data model (unchanged)

Port `schema.sql` verbatim (SQLite `datetime('now')` defaults work under bundled
rusqlite — no `chrono` needed). Three tables: `companies` (PK = domain, the dedupe
key), `contacts` (UNIQUE(domain,email)), `outreach`. Status vocabularies unchanged:
- company: `sourced → named → emailed → drafted → sent → replied / bounced / skip`
- outreach: `draft_pending → drafted → sent → replied → bounced`

### Message template: `message.py` → `message.toml`

Same placeholders (`{company}`, `{fn}`, `{slug}`, `{link}`) and the `"__CTA__"`
paragraph sentinel. Rendered by plain string replacement — no template engine.

```toml
link       = "https://trycanonical.ai/?utm_source=outreach&utm_medium=email&utm_campaign=design_partner&utm_content={slug}"
subject    = "found {company} while testing Canonical"
paragraphs = ["Hi {fn},", "…", "__CTA__", "— Your Name"]
cta_plain  = "Feel free to explore on your own at trycanonical.ai — no need to book a demo."
cta_html   = "Feel free to explore on your own at <a href=\"{link}\">trycanonical.ai</a> — no need to book a demo."
```

`contacted.toml` (was `seed_contacted.py`):
```toml
# domain = { name = "…", status = "sent" | "skip" }
"example-agency.com" = { name = "Example Agency", status = "sent" }
"another-co.io"      = { name = "Another Co",      status = "skip" }
```

## Subcommand semantics (faithful to the Python)

- **import** — accept three JSON shapes: bare `[…]`, `{"results":[…]}`, and the MCP
  tool-result wrapper `[{"type":"text","text":"<json string>"}]` (parse the inner
  string). Lowercase+trim `domain`, skip empty. Upsert (insert only if domain new).
  Report `N new, M already-known (deduped) from T results`.
- **add-contact** — `score(email, founder)`; reject generic/placeholder locals (exit
  non-zero). `mx_ok(domain)`. Ensure company row exists (`source_query='manual'`).
  `INSERT OR IGNORE` contact. Status → `emailed` if MX ok else `named`.
- **draft-prep** — select contacts where `mx_ok=1 AND email NOT NULL AND
  company.status='emailed' AND no outreach row exists`, ordered by `found_at`, limited
  (default 20). Build subject/body/html, insert `outreach` (`draft_pending`), write
  `pending_drafts.json` (`[{domain,to,subject,body,html}]`). Never sends.
- **mark** — `sent` → outreach+company `sent` (+`sent_at`); `bounced` → both `bounced`;
  else treat arg as `gmail_draft_id`, set outreach `drafted` + company `drafted`.
- **seed** — read `contacted.toml`, upsert each with its status. Idempotent.
- **find-emails** — see below.
- **run** — refresh `CLAUDE.md`, `cd ~/.coldtrail`, `exec claude` (via
  `std::process::Command`/`exec` on Unix). If `claude` missing, guide + exit.

### find-emails port

Async on `tokio`. Same algorithm as `find_emails.py`:
1. Select companies with status in (`sourced`,`named`) lacking a verified email, limit.
2. Founder from `contacts.founder_name` if seeded, else `resolve_founder` via search.
3. Query patterns (founder-aware + fallbacks) against DuckDuckGo's HTML endpoint
   (`https://html.duckduckgo.com/html/?q=…`) parsed with `scraper` — the `ddgs`
   replacement. Extract on-domain emails from result snippets; collect on-domain URLs.
4. Fetch candidate on-domain pages (`""`,`/about`,`/about-us`,`/team`,`/our-team`,
   `/contact`,`/contact-us`) + on-domain result URLs (cap 8) via `reqwest`; extract.
5. `score`: reject `GENERIC`/`PLACEHOLDER` locals and `doe`/`smith` junk; `direct` if a
   founder-name part appears in the local, else `inferred`.
6. Accept `direct` from anywhere; accept `inferred` **only from an on-domain page**.
7. `mx_ok`: MX record → else A record (hickory-resolver, ~8s/6s lifetimes). Store
   contact; status `emailed` if MX ok else `named`.

Politeness sleeps between queries preserved.

## Crates

`clap` (derive), `rusqlite` (bundled), `serde`/`serde_json`, `toml`, `reqwest`
(rustls-tls), `scraper`, `hickory-resolver`, `regex`, `anyhow`, `dirs`, `tokio`.

## Repo layout

```
coldtrail/
  Cargo.toml
  src/
    main.rs      # clap dispatch
    home.rs      # COLDTRAIL_HOME resolution, workspace ensure, asset write
    db.rs        # connect/init/upsert_company/set_status
    import.rs  contact.rs  find.rs  draft.rs  mark.rs  setup.rs  seed.rs  run.rs
    message.rs   # load message.toml + render
  templates/
    CLAUDE.md  schema.sql  message.toml  contacted.toml   # embedded via include_str!
  install.sh
  .github/workflows/release.yml
  README.md   LICENSE
```

The Python files (`*.py`, `requirements.txt`) are removed. `.gitignore` updated:
runtime state now lives under `~/.coldtrail/`, not the repo, so the repo only needs to
ignore `/target` and Rust artifacts.

## CLAUDE.md (embedded agent brief, public-safe)

Encodes: identity (this is coldtrail); the run loop (source via Canonical MCP → enrich
BYOK/`find-emails`/`add-contact` → `draft-prep` → create Gmail drafts via Gmail MCP →
`mark`); the `coldtrail` subcommands and how to call them; and the guardrails verbatim
— **drafts never auto-send**, dedupe by domain, MX-verify before drafting,
founder-addressed only (no generic/placeholder), warmup pacing (~5/day new mailbox). No
private strategy learnings.

## Install & distribution

**`install.sh`** (`curl -fsSL https://raw.githubusercontent.com/dilpreet92/coldtrail/main/install.sh | bash`):
1. Detect OS/arch → target triple (macOS arm64/x86_64, Linux x86_64).
2. Check `claude`; if missing, print `npm i -g @anthropic-ai/claude-code` and exit
   non-zero. (git/python3 no longer required at runtime.)
3. Download `coldtrail-<target>.tar.gz` from the latest GitHub Release, extract, install
   to `~/.local/bin/coldtrail`, `chmod +x`.
   - **Fallback:** if no release asset exists yet (or `--from-source`), `cargo install
     --git …` when a Rust toolchain is present; else instruct.
   - **Test override:** `COLDTRAIL_BIN=/path/to/local/binary` skips download and installs
     that binary — lets install.sh run end-to-end before any release exists.
4. PATH: if `~/.local/bin` not on PATH, **print** the `export PATH=…` line for the
   detected shell rc. No silent edits.
5. Print next steps: `coldtrail setup` → edit `~/.coldtrail/message.toml` &
   `contacted.toml` → `coldtrail seed` → `coldtrail`.

**`.github/workflows/release.yml`** — on tag push, cross-compile the three targets,
`tar.gz` each, attach to the GitHub Release.

## Testing

- **`cargo test`** — deterministic logic: `score()` (generic/placeholder/doe-smith
  rejection, direct vs inferred), email extraction/`domain_emails`, `slug`,
  `first_name`, message render (placeholders + `__CTA__`), the 3-shape JSON import
  parser, `contacted.toml` parse.
- **`cargo clippy` + `cargo fmt`** clean.
- **`shellcheck install.sh`** clean; run install.sh end-to-end with `COLDTRAIL_BIN`
  (local `cargo build` output) into a temp `COLDTRAIL_HOME`; assert workspace + PATH
  guidance.
- Network paths (DuckDuckGo, MX, page fetch) — manual smoke, not unit tests.

## Migration for the author

Existing `~/projects/coldtrail/outreach.db`, `message.py`, `seed_contacted.py` carry
over: copy `outreach.db` → `~/.coldtrail/outreach.db`; translate `message.py` →
`message.toml` and `seed_contacted.py` → `contacted.toml` (one-time, by hand — small
files). Documented in the README, not automated.
