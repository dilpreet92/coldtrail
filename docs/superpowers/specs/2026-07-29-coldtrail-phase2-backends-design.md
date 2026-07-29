# coldtrail Phase 2 — pluggable backends (BYOK API + Ollama)

**Date:** 2026-07-29
**Status:** Approved direction (full parity), decomposed. This spec = foundation (part 1).
**Builds on:** the browser-app spec (2026-07-28).

## Goal (full parity — the target)

Let the embedded agent run on any of: headless Claude Code / Codex (Phase 1), a **BYOK
API** (OpenAI-compatible gateway or hosted model), or a **local LLM via Ollama** — with the
same chat/pipeline/drafts UX, and eventually the same tool reach (Canonical sourcing + Gmail
send).

## Decomposition

- **Part 1 (this spec/build):** provider config + secret storage + an in-Rust
  OpenAI-compatible tool-calling agent loop whose tools are coldtrail's **local**
  operations. Sourcing for these backends = importing a Canonical results JSON.
- **Part 2 (next milestone, separate spec):** an in-Rust MCP client + OAuth (Canonical +
  Gmail) so BYOK/Ollama get native sourcing and send. Out of scope here.

## Part 1 design

### Provider model

`config.toml` gains a provider selector plus an optional `[provider]` table:

```toml
agent = "openai"          # claude | codex | openai   (openai == any OpenAI-compatible endpoint)

[provider]                # only when agent = "openai"
base_url = "http://localhost:11434/v1"   # Ollama; or a BYOK gateway base url
model    = "llama3.1"
# api key is NOT stored here — see secrets
```

- `claude`/`codex` → the Phase-1 headless CLI backend (unchanged).
- `openai` → the new in-Rust loop. Covers **Ollama** (`base_url=http://localhost:11434/v1`,
  no key) and **BYOK** (any OpenAI-compatible base url + key: OpenAI, OpenRouter, Together,
  Groq, or an Anthropic-compatible gateway).

`provider::resolve() -> Backend` reads config + secret and returns the runtime backend.

### Secret storage

API key lives in `~/.coldtrail/secrets.toml` (created `0600`), never in `config.toml` or the
repo, or via `COLDTRAIL_API_KEY` env. Onboarding writes it; it is never returned by any GET.

### The agent loop (`src/provider/openai.rs`)

Non-streaming LLM calls, streamed *step* events to the browser (text blocks + tool chips) —
simpler and far less error-prone than proxying the model's own token stream, and the UX is
still live per message/tool.

Loop:
1. Build messages: a system prompt (identity + the run-loop rules + the user's
   `message.toml` brief injected) then the conversation + this user turn.
2. POST `{base_url}/chat/completions` with `tools` = the local toolset (JSON-schema
   function defs) and `tool_choice: auto`.
3. On `tool_calls`: for each, emit `ToolStart`, execute the Rust tool, emit `ToolEnd`,
   append a `role:tool` result message; loop back to step 2.
4. On assistant `content` with `finish_reason: stop`: emit `Text`, then `Done`.
5. Bounded to N iterations (e.g. 12) to avoid runaway; always emits a terminal `Done`.

Errors (HTTP, connection refused for Ollama, auth) → `Error` + `Done{ok:false}`.

### Local tools exposed

Pure wrappers over existing logic, each a function tool:

| tool | maps to |
|---|---|
| `import_json(results_json, label)` | `import::parse_results` + upsert (dedupe) |
| `add_contact(domain, name, email, source?)` | `contact` logic (MX-verify, reject generic) |
| `find_emails(max?)` | `find::run` (OSINT finder) |
| `draft(domain, subject, body)` | `draft::add` (agent-composed) |
| `mark(domain, value)` | `mark::run` |
| `list_companies()` / `list_drafts()` | read DB |

**No Gmail tool in the chat loop** — same invariant as Phase 1 (send is the separate
human-clicked step). Sending for the `openai` backend also routes through a constrained
send; if no MCP/Gmail path exists for it yet (Part 2), the Drafts Send button reports a
"connect Gmail (coming for this backend)" fallback. The chat loop never sends.

### Runtime dispatch

`web::chat` and `web::send` call `provider::run_turn(backend, …)` which dispatches:
- `claude`/`codex` → `provider::cli` (Phase 1).
- `openai` → `provider::openai` (this build). Same `AgentEvent` stream + terminal-Done
  guarantee, so the SSE UI is unchanged.

### Onboarding UI

The Agent panel gains, when "BYOK / Local (OpenAI-compatible)" is chosen: base_url, model,
and API key (password) inputs → `POST /api/onboarding/provider` (extended). Quick presets:
"Ollama (localhost)" fills the local base url. `/api/status` reports the configured backend
(key presence only, never the key).

## Reuse & guardrails

Reuses `import`/`contact`/`find`/`draft`/`mark`/`db`. All Phase-1 guardrails hold: dedupe,
MX-verify, founder-only, **no auto-send** (no Gmail tool in the chat loop), human-clicked
Send. The OpenAI loop is bounded (max iterations) and always emits a terminal event.

## Testing

- `provider::openai` loop against a **mock** OpenAI-compatible server (axum in-test):
  a response with a `tool_call` → assert the tool ran + `ToolStart`/`ToolEnd`/`Done` emitted;
  a plain content response → `Text` + `Done`; an HTTP 500 → `Error` + `Done{ok:false}`.
- tool JSON-schema serialization; `import_json` dedupe; secret read/write round-trip
  (0600), never surfaced by status.
- provider resolution from config (claude/codex/openai).

## Known limits (Part 1)

- BYOK/Ollama can't source from Canonical or send via Gmail yet (Part 2 / MCP client).
  Sourcing = import a Canonical JSON; sending needs the Claude backend or Part 2.
- Non-streaming LLM calls (step-level UI streaming, not token-level).
