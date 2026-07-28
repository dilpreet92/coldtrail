# coldtrail as a local browser app

**Date:** 2026-07-28
**Status:** Approved design, pre-implementation
**Builds on:** the Rust CLI + setup wizard specs (same date / 2026-07-24)

## Goal

`coldtrail` (no args) boots a local web server and opens the browser; onboarding and the
whole outreach workflow happen in the browser, driven by an embedded AI agent. The agent
runtime is pluggable: headless Claude Code / Codex first, then BYOK API keys and local LLMs
(Ollama). Sending is an explicit human click in the UI. The terminal subcommands remain as
the backend engine and a power-user surface.

## Topology

- `coldtrail` → bind `127.0.0.1:<port>` (default 8787, `--port` to override), print the URL,
  auto-open the browser (`--no-open` to skip). Single self-contained binary; UI embedded.
- **Local security:** on boot generate a random session token; the opened URL carries it
  (`?t=<token>`), the server sets it as an httpOnly cookie, and every API/SSE request must
  present it. Bind loopback only. No external exposure, no remote auth needed.
- `coldtrail serve` is the explicit form; bare `coldtrail` is an alias for it.

## Server (Rust, axum on the existing tokio runtime)

Routes:
- `GET /` and `/assets/*` — embedded SPA (`rust-embed`).
- `GET /api/status` — onboarding state (provider chosen, MCP wired, message/contacted set).
- `POST /api/onboarding/*` — provider detect/select, MCP wiring, message/contacted save
  (thin HTTP wrappers over `agents.rs` / `mcp.rs` / file writes we already have).
- `GET /api/companies`, `/api/contacts`, `/api/drafts` — pipeline data from SQLite (`db.rs`).
- `POST /api/chat` — start/continue an agent turn; returns a run id.
- `GET /api/chat/stream?run=<id>` — **SSE** stream of agent events.
- `POST /api/drafts/:domain/send` — explicit human send (see Sending).
- `open` crate launches the browser; `rust-embed` bakes `ui/dist` into the binary.

## Provider abstraction (the engine)

A trait with one streaming method:

```
trait Provider {
    async fn run_turn(&self, session: &str, user_msg: &str, sink: EventSink) -> Result<()>;
}
enum AgentEvent { Text(String), ToolStart{name,input}, ToolEnd{name,ok}, Error(String), Done }
```

Backends:

1. **CLI agents — Phase 1 (default).**
   - Claude Code: spawn `claude -p <msg> --output-format stream-json --verbose --session-id
     <uuid>` (first turn) / `--resume <uuid>` (subsequent), `current_dir(~/.coldtrail)`, with
     an allowed-tools set (coldtrail subcommands + Canonical read + Gmail *create draft* — NOT
     send). Parse the JSONL event stream (system/assistant/user tool_result/result) into
     `AgentEvent`s and forward over SSE.
   - Codex: `codex exec --json` equivalent; same event mapping (best-effort; flag if the
     installed Codex's stream schema differs).
   - Reuses subscription auth + the MCP wiring already set up. No API key.
2. **BYOK API — Phase 2.** Anthropic Messages API (+ OpenAI-compatible) with an in-Rust
   tool-use loop; MCP tools via the Anthropic MCP-connector param or a small Rust MCP client.
   Keys stored in the OS keychain (fallback `~/.coldtrail/secrets` at `0600`).
3. **Local LLM / Ollama — Phase 2.** Ollama OpenAI-compatible endpoint + the same in-Rust
   loop exposing coldtrail tools (local models don't call remote MCP themselves).

Selected backend + config live in `config.toml` (`agent`, plus a `[provider]` table in P2).

## The agent loop (unchanged intent)

Source (Canonical) → import → enrich → draft-prep → create Gmail draft → mark. For CLI agents
these are the coldtrail subcommands + Canonical/Gmail MCP, exactly as `CLAUDE.md` already
encodes. The chat is the human steering that loop ("find 20 like X, draft outreach").

## Sending (human-in-the-loop, no auto-send)

The agent only ever **creates** Gmail drafts. The UI lists pending drafts; each has a
**Send** button. Clicking it issues a **constrained agent action** — a scoped turn instructed
to send exactly that one Gmail draft and nothing else — then `coldtrail mark <domain> sent`.
Routing send through the agent reuses the single Gmail (MCP) integration rather than adding a
second Gmail client in Rust. The button is the explicit human action; nothing sends without
it. A warmup indicator shows today's send count and the ~5/day new-mailbox guidance.
(Requires the Gmail MCP to expose a send/send-draft capability under the `gmail.compose`
scope; if unavailable, the UI falls back to "open in Gmail to send" — verified at impl time.)

## Browser UI (self-contained SPA, no external CDN — CSP-safe, offline)

- **Onboarding** — the wizard as web screens: detect providers → pick/configure backend →
  wire Canonical + Gmail (OAuth; show the Google Cloud prereqs + redirect URI) → fill
  `message` + `contacted` via forms. Mirrors `coldtrail setup` over HTTP.
- **Chat** — streamed agent text + tool-call chips; an input box to steer the loop.
- **Pipeline** — companies/contacts table with status filters (from the DB).
- **Drafts** — pending drafts with subject/body view + inline edit + per-draft **Send**;
  warmup pacing indicator.
- Built with a light toolchain into `ui/dist`, embedded; no runtime network to third parties
  (CSP `default-src 'self'`). Quality via the frontend-design skill.

## Guardrails preserved

Dedupe by domain, MX-verify before drafting, founder-addressed only, and **no auto-send** —
the agent creates drafts; a human clicks Send. Warmup pacing surfaced.

## Reuse & reconcile

`agents.rs`, `mcp.rs`, `db.rs`, `enrich.rs`, `import/draft/mark/seed/contact` become the
server backend (and P2 tool implementations). `coldtrail setup` and all subcommands remain
for headless/CI/power use. Bare `coldtrail` now serves the app instead of exec'ing the agent;
launching a raw terminal agent is still available via an explicit subcommand if wanted.

## Phasing

- **Phase 1 (this build):** server + session security + embedded UI shell; browser
  onboarding over the existing wizard logic; CLI-agent chat with live SSE streaming;
  pipeline dashboard; drafts list + send-via-agent. Full experience on Claude Code/Codex.
- **Phase 2:** BYOK API + Ollama backends (in-Rust agent loop + MCP client); secret storage.
- **Phase 3:** run history, analytics, warmup scheduler.

## Rust structure (Phase 1)

```
src/web/mod.rs        # router assembly, session token, state
src/web/api.rs        # shared request/response types (serde)
src/web/onboarding.rs # /api/status + /api/onboarding/* handlers (reuse agents/mcp)
src/web/pipeline.rs   # /api/companies|contacts|drafts (reuse db)
src/web/chat.rs       # /api/chat + SSE; owns run registry
src/web/send.rs       # /api/drafts/:domain/send (constrained agent action + mark)
src/provider/mod.rs   # Provider trait, AgentEvent
src/provider/cli.rs   # headless claude/codex driver + stream-json parser
src/serve.rs          # bind, open browser, graceful shutdown
ui/                   # SPA source -> ui/dist (embedded)
```
New deps: `axum`, `tower`, `tower-http` (already transitively present), `rust-embed`, `open`,
`uuid`, `futures`. `tokio` gains `process`, `io-util`, `sync` features.

## Testing

- Pure/unit: stream-json event parser (fixture JSONL → `AgentEvent`s), session-token
  middleware (reject without token), API serde round-trips, onboarding-status derivation,
  send-eligibility (only `drafted`/`draft_pending` domains).
- Integration: boot server on an ephemeral port, hit `/api/status`, `/api/companies` against
  a temp `COLDTRAIL_HOME` DB; assert JSON. A fake `claude` stub on PATH emitting canned
  stream-json to drive one chat turn end-to-end through SSE.
- Manual: real `coldtrail` on this machine → browser onboarding → one chat turn via headless
  Claude Code → see a draft → send.

## Known unknowns (verify at implementation)

- Exact `claude -p --output-format stream-json` event schema + the multi-turn resume flags,
  and the allowed-tools/permission flags needed for unattended MCP + subcommand calls.
- Whether the Gmail MCP exposes a send-draft tool under `gmail.compose` (else UI falls back to
  "open in Gmail").
- Codex `exec` JSON stream schema (Codex path is best-effort in P1; Claude is primary).
