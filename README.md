# coldtrail

> The deduped, discovery-first outreach workflow I actually use — built on [Canonical](https://trycanonical.ai).
> Build-in-public: this is my real pipeline, not a polished product.

Most outreach tools start from a list you already have and optimize the *sending*. This
starts from the opposite end: **discovery**. Canonical turns a plain-English ICP into
verified, long-tail companies standard databases miss; everything downstream is
state-tracking and drafts you review by hand. It never sends anything on its own.

`coldtrail` is a single binary. Run it and it opens a **local app in your browser** — a
chat that drives an embedded agent (headless Claude Code / Codex) to source, enrich, and
draft, plus a pipeline dashboard and a drafts view where you review and send by hand.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/dilpreet92/coldtrail/main/install.sh | bash
```

The only runtime dependency is an agent CLI — [Claude Code](https://claude.com/claude-code)
(`claude`) or [Codex](https://github.com/openai/codex) (`codex`). The installer checks for
one and tells you how to get it if it's missing. Then:

```bash
coldtrail           # opens the app at http://127.0.0.1:8787
```

On first run it opens your browser to the **Setup** screen: pick your agent, wire the
Canonical + Gmail connectors, and paste your pitch. Then use **Chat** to run the loop,
**Pipeline** to watch companies flow through statuses, and **Drafts** to review and hit
**Send** (the only thing that ever sends — a human click).

**Backends.** The agent runs on headless **Claude Code** / **Codex** (reuses your
subscription + MCP), or on **your own model** — any OpenAI-compatible endpoint or a local
**Ollama** — via a built-in tool-calling loop. (For BYOK/Ollama today, source by importing a
Canonical results JSON and send from the Claude backend; native Canonical/Gmail for those
models arrives with the MCP-client milestone.)

Everything lives in `~/.coldtrail/` — the SQLite state, your private message template, the
agent brief (`CLAUDE.md`), and the MCP config. The app binds `127.0.0.1` only, guarded by a
one-time token in the URL. Nothing leaves your machine except the drafts you choose to send.

### Command-line surface

Bare `coldtrail` serves the app. The workflow also runs headless for power users / CI:

```bash
coldtrail serve --port 9000 --no-open   # serve without opening a browser
coldtrail setup                         # the terminal setup wizard (see below)
coldtrail agent                         # launch the raw terminal agent in the workspace
coldtrail import / add-contact / find-emails / draft-prep / mark / seed
```

### `coldtrail setup` — the wizard

`setup` is idempotent and re-runnable. It:

1. **Detects** which agent CLIs you have (`claude`, `codex`) and whether they're signed in.
2. **Picks a default provider** — if both are present it asks; otherwise it uses the one it
   finds. Saved to `~/.coldtrail/config.toml` (`agent = "claude"` | `"codex"`). `coldtrail`
   launches whichever you chose.
3. **Wires Canonical** (sourcing) into coldtrail's own scope — for Claude that's
   `~/.coldtrail/.mcp.json`; for Codex, `~/.codex/config.toml`. OAuth completes in-browser on
   first use.
4. **Wires Gmail** (drafts) — Google's Gmail MCP (`https://gmailmcp.googleapis.com/mcp/v1`).
   This needs a one-time Google Cloud OAuth client: enable the Gmail API + Gmail MCP API,
   create an OAuth 2.0 Web client, add scopes `gmail.readonly` + `gmail.compose`, and register
   the redirect URI `http://localhost:8765/callback`. setup prints these steps and takes your
   client id/secret (the secret is never written to the repo).

Flags / env for non-interactive use:

```bash
coldtrail setup --provider claude              # skip the provider prompt
coldtrail setup --skip-gmail                   # Canonical only
coldtrail setup --gmail-callback-port 9000     # change the OAuth redirect port
coldtrail setup --force                        # re-wire servers already configured
# Gmail creds without a prompt:
COLDTRAIL_GMAIL_CLIENT_ID=…  COLDTRAIL_GMAIL_CLIENT_SECRET=…  coldtrail setup
```

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
