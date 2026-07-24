# coldtrail

> The deduped, discovery-first outreach workflow I actually use — built on [Canonical](https://trycanonical.ai).
> Build-in-public: this is my real pipeline, not a polished product.

Most outreach tools start from a list you already have and optimize the *sending*. This
starts from the opposite end: **discovery**. Canonical turns a plain-English ICP into
verified, long-tail companies standard databases miss; everything downstream is
state-tracking and drafts you review by hand. It never sends anything on its own.

`coldtrail` is a single binary that is both the **launcher** (it spins up Claude Code in a
pre-wired workspace) and the **commands the agent runs** to drive the loop.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/dilpreet92/coldtrail/main/install.sh | bash
```

The only runtime dependency is the [Claude Code CLI](https://claude.com/claude-code)
(`claude`) — the installer checks for it and tells you how to get it if it's missing.
Then:

```bash
coldtrail setup     # writes ~/.coldtrail/, initializes the database
# edit ~/.coldtrail/message.toml   (your name, pitch, link)
# edit ~/.coldtrail/contacted.toml (domains you've already contacted)
coldtrail seed      # load the dedupe guard
coldtrail           # launch the agent in the workspace
```

Everything lives in `~/.coldtrail/` — the SQLite state, your private message template, and
the agent brief (`CLAUDE.md`). Nothing leaves your machine except the drafts you choose to
send.

## How it's wired

```
Canonical (sourcing, fixed)      ← describe an ICP, get verified companies
        │
        ▼
local SQLite state               ← dedupe by domain, status per company (never double-contact)
        │
        ▼
enrichment (BYOK, your choice)   ← your Apollo/Hunter key · an OSINT tool · the built-in
        │                          finder · or add contacts by hand
        ▼
drafts (never auto-sent)         ← personalized bodies + your link; YOU review and hit send
        │
        ▼
status tracking                  ← drafted → sent → replied / bounced
```

**Sourcing is fixed to Canonical** (that's the good part). **Everything else is yours** —
your enrichment provider, your message, your sending, your data.

## The loop

The launched agent (Claude Code) drives this via the Canonical + Gmail MCPs and the
`coldtrail` subcommands. You can also run any step by hand:

| Command | What it does |
|---|---|
| `coldtrail import <results.json> "<label>"` | dedupe-import a Canonical `search_companies` result |
| `coldtrail add-contact <domain> "<Name>" <email> [source]` | add a founder contact by hand (MX-verified) |
| `coldtrail find-emails [max]` | best-effort OSINT founder-email finder (MX-verified) |
| `coldtrail draft-prep [max]` | build personalized drafts → `~/.coldtrail/pending_drafts.json` |
| `coldtrail mark <domain> <draft_id\|sent\|bounced>` | advance status |
| `coldtrail seed` | load already-contacted domains from `contacted.toml` |

1. **Source** — the agent runs Canonical `search_companies`, saves the JSON, and
   `coldtrail import`s it. Already-known domains are skipped automatically.
2. **Enrich** — a founder email per company, via your own key, an OSINT tool,
   `coldtrail find-emails`, or `coldtrail add-contact`.
3. **Draft** — `coldtrail draft-prep` builds bodies from your `message.toml` and writes
   `pending_drafts.json`. It writes DB rows only; it sends nothing.
4. **Create Gmail drafts** — the agent creates each as a *draft* via the Gmail MCP; record
   the id with `coldtrail mark <domain> <draft_id>`.
5. **After you send by hand** — `coldtrail mark <domain> sent` (or `bounced`).

## Guardrails baked in

- **Dedupe by domain** — you can't double-contact a company.
- **MX-verified before drafting** — kills the bounce problem from guessed addresses.
- **Founder-addressed only** — generic (`info@`/`sales@`) and placeholder/example
  addresses are rejected.
- **Drafts, never auto-send** — a human reviews and sends every message. Pace warmup
  yourself (~5/day on a new mailbox).

## Migrating from the Python version

State moved out of the repo into `~/.coldtrail/`. If you ran the old Python scripts:

- copy your old `outreach.db` → `~/.coldtrail/outreach.db`
- translate `message.py` → `~/.coldtrail/message.toml` and `seed_contacted.py` →
  `~/.coldtrail/contacted.toml` (small files, by hand)

## Build from source

```bash
git clone https://github.com/dilpreet92/coldtrail && cd coldtrail
cargo build --release          # -> target/release/coldtrail
cargo test                     # unit tests
```

## Powered by Canonical

The sourcing engine is [Canonical](https://trycanonical.ai) — verified, long-tail company
search, available as an [MCP server + Claude Code plugin](https://github.com/vy-labs/canonical-mcp)
and a ChatGPT app. Free tier: 250 credits, no card.

## Note

This is a **personal, build-in-public workflow**, not a supported product — no roadmap, no
promises. Shared under MIT in case the bones are useful to another founder doing their own
outreach.
