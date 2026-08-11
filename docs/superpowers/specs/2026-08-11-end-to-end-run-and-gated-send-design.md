# End-to-end run + gated agent send — design

**Date:** 2026-08-11
**Status:** implemented (v0.9.0)

## Problem

The chat agent sourced companies and **stopped** at a summary ("no contacts were enriched and no
drafts were created yet"), instead of carrying the run through. The user wants: after sourcing,
automatically **enrich contacts → draft**, show the contacts found, and at the end **offer to
send**, actually sending when the user has configured auto-send.

## Decisions (from brainstorm)

1. **Agent sends itself** when auto-send is on (not just hand off) — via a gated path, after an
   explicit in-chat yes.
2. **Warmup-sized batch**: enrich + draft ~5 per run (or up to the daily cap), rest stay sourced.

## Design

### Delivery core (`src/deliver.rs`)

One shared module for turning a reviewable draft into a Gmail draft or a real send, so the
auto-send gate + daily cap are enforced identically everywhere:
- `reviewable(domain) -> Draft{to,subject,body}` — latest `draft_pending|drafted` + recipient.
- `draft(domain, &Draft)` — create a Gmail DRAFT (IMAP app-password APPEND or Gmail API), mark
  `drafted`.
- `send(domain, &Draft) -> String` — **refuses unless `config.auto_send`**; enforces
  `daily_send_cap` (counts today's `sent`); sends via SMTP (app-password) or Gmail API; marks
  `sent`.
- `run(domain)` — CLI entry (`coldtrail send <domain>`); inits DB, `reviewable` + `send`.

`web::send::send` is refactored to call `deliver` (draft when auto-send off, send when on). The
OpenAI `send_outreach` tool calls `deliver::reviewable` + `deliver::send`.

### The gate (safety)

The agent can *trigger* a send but cannot send unless the human turned on auto-send — a real
opt-in in Settings. `deliver::send` is the only send path and self-gates, so a prompt-injected
"send everything" from sourced (untrusted) content can't fire while auto-send is off. The agent
still never reads stored credentials or calls mail APIs directly; `coldtrail send` does delivery.
Two gates for a real send: (a) `auto_send = true` in config, (b) an explicit in-chat yes.

### Run loop (`templates/CLAUDE.md` + `provider/openai.rs`)

Reframed to run end-to-end by default: **source → enrich a warmup batch (~5) → draft → report
contacts + drafts → offer to send**. The agent reads `config.toml`:
- `auto_send = true` → offer "send these N now?"; on yes, `coldtrail send <domain>` per draft
  (stops when the cap is hit).
- otherwise → hand off to the Drafts tab.

Guardrail edits: "you never send" → "send only via `coldtrail send`, only with auto-send on + an
in-chat yes"; "don't pause mid-run" now carves out the one exception — always confirm before
sending.

### New surface

- CLI: `coldtrail send <domain>` (`src/cli.rs`, `src/main.rs`).
- OpenAI tool: `send_outreach {domain}` (`src/provider/tools.rs`).

## Testing

- `deliver::send_refuses_when_auto_send_off` (unit) — the gate holds with a fresh (off) config.
- CLI wired: `coldtrail send --help`; clean errors ("no reviewable draft") on an empty workspace.
- Real send is user-verified (needs live creds; must not fire test email). Web draft/send refactor
  covered by compile + existing behavior.
