# coldtrail — agent brief

You are running inside **coldtrail**, a discovery-first, deduped cold-outreach
workflow. This directory (`~/.coldtrail`) is your workspace: it holds the SQLite
state (`outreach.db`), the user's private message template (`message.toml`), their
already-contacted seed list (`contacted.toml`), and the draft handoff file
(`pending_drafts.json`).

`coldtrail` is a single binary on the PATH. You drive the workflow by calling its
subcommands — never re-implement their logic, never touch `outreach.db` directly.

## The run loop

1. **Source (Canonical, fixed).** Use the Canonical MCP `search_companies` to turn a
   plain-English ICP into a verified, domain-keyed shortlist. Save the tool result to a
   JSON file, then import it (deduped by domain):
   `coldtrail import <results.json> "<short ICP label>"`
   Already-known domains are skipped automatically.
2. **Enrich (BYOK / your choice).** Get a founder contact per company:
   - manual / from your own WebSearch: `coldtrail add-contact <domain> "<Full Name>" <email> [source]`
   - the built-in best-effort finder: `coldtrail find-emails [max]`
   Both MX-verify before storing and reject generic/placeholder addresses.
3. **Draft (never auto-sent).** `coldtrail draft-prep [max]` builds personalized bodies
   (using `message.toml`) and writes `pending_drafts.json`. It writes DB rows only — it
   sends nothing.
4. **Create the Gmail drafts.** For each entry in `pending_drafts.json`, create a
   **draft** (not a send) via the Gmail MCP. Record the draft id:
   `coldtrail mark <domain> <gmail_draft_id>`
5. **After the human sends by hand:** `coldtrail mark <domain> sent` (or `bounced`).

## Guardrails — non-negotiable

- **Drafts are never auto-sent.** You create Gmail *drafts* only. A human reviews and
  hits send. Do not send email under any circumstance.
- **Dedupe by domain.** Never contact a company twice. Import and seeding enforce this;
  trust the "already-known (deduped)" counts.
- **MX-verified before drafting.** Only MX-verified founder emails reach `draft-prep`.
- **Founder-addressed only.** Generic (`info@`, `sales@`, …) and placeholder/example
  addresses are rejected by `add-contact`/`find-emails`. Don't work around this.
- **Pace warmup yourself.** On a new mailbox, ~5 sends/day. Don't bulk-draft beyond what
  the human will actually review and send.

## Commands

| Command | Purpose |
|---|---|
| `coldtrail setup` | write config/templates, init the DB |
| `coldtrail import <json> "<label>"` | dedupe-import Canonical results |
| `coldtrail add-contact <domain> "<name>" <email> [src]` | MX-verified manual contact |
| `coldtrail find-emails [max]` | best-effort OSINT founder-email finder |
| `coldtrail draft-prep [max]` | build drafts → `pending_drafts.json` (never sends) |
| `coldtrail mark <domain> <id\|sent\|bounced>` | advance status |
| `coldtrail seed` | load already-contacted domains (dedupe guard) |

Sourcing is fixed to Canonical (the good part). Everything else — enrichment provider,
message, sending, data — is the user's, and stays on their machine.
