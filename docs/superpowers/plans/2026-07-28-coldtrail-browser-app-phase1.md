# coldtrail browser app — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `coldtrail` boots a local web server + opens the browser; onboarding, a streaming agent chat (headless Claude Code), a pipeline dashboard, and drafts-with-Send all run in the browser.

**Architecture:** axum on tokio; embedded SPA (`rust-embed`); loopback + session-token guard; a `Provider` trait whose Phase-1 impl spawns headless `claude -p --output-format stream-json` and maps its JSONL events to SSE. Reuses `agents/mcp/db/enrich` + subcommands.

**Tech Stack:** axum, tower-http, rust-embed, open, uuid, futures; tokio (+process, io-util, sync).

## Global Constraints

- Bind `127.0.0.1` only. Every `/api/*` + SSE request must carry the boot session token (cookie or `?t=`); else 401.
- No auto-send: the agent only creates drafts; `/api/drafts/:domain/send` is the only send path and is triggered by an explicit UI click.
- UI is self-contained (CSP `default-src 'self'`); no external CDN/network.
- Reuse existing modules; do not duplicate pipeline logic.
- stream-json event mapping (verified): `assistant.message.content[]` → `text`⇒Text, `tool_use`⇒ToolStart; `user.message.content[]` `tool_result`⇒ToolEnd; `result`⇒Done; `system`/`rate_limit_event`⇒ignore (capture `init.session_id`).

## File Structure

```
src/serve.rs          # bind, token, open browser, run axum, graceful shutdown
src/web/mod.rs        # router + AppState (token, home) + auth middleware + static embed
src/web/api.rs        # serde types shared with the UI
src/web/onboarding.rs # GET /api/status, POST /api/onboarding/{provider,message,contacted}
src/web/pipeline.rs   # GET /api/companies|contacts|drafts
src/web/chat.rs       # POST /api/chat, GET /api/chat/stream (SSE), run registry
src/web/send.rs       # POST /api/drafts/:domain/send
src/provider/mod.rs   # Provider trait, AgentEvent
src/provider/cli.rs   # headless claude/codex spawn + stream-json parser (pure parse fn)
ui/index.html         # SPA shell (embedded)
ui/app.js  ui/app.css # SPA logic + styles (embedded, no CDN)
```

---

### Task 1: deps + serve skeleton + session guard

- [ ] Add deps; `tokio` features `process,io-util,sync,rt-multi-thread,macros,time`.
- [ ] `serve.rs`: pick port (arg or 8787; if taken, OS-assigned), make a `uuid` token, build router, spawn browser via `open` to `http://127.0.0.1:<port>/?t=<token>` (unless `--no-open`), print URL, serve with graceful ctrl-c shutdown.
- [ ] `web/mod.rs`: `AppState { token: String, home: PathBuf }`; tower middleware that allows `GET /` + `/assets/*` (to hand out the app + set cookie from `?t=`) but requires the cookie/token on `/api/*`; return 401 otherwise.
- [ ] cli.rs: add `Serve { #[arg(long)] port: Option<u16>, #[arg(long)] no_open: bool }`; bare `coldtrail` (None) now calls serve. Keep the old agent-launch under `coldtrail agent` (rename of prior `run`).
- [ ] **Test:** middleware unit test — request without token → 401; with token → passes (use `tower::ServiceExt::oneshot`).
- [ ] Build + commit.

### Task 2: static embed + UI shell

- [ ] `rust-embed` an `ui/` dir; fallback route serves `index.html`; `/assets/*` from embed with content-types.
- [ ] Minimal `ui/index.html`+`app.js`+`app.css` shell: reads `?t=` into a cookie, then renders a tabbed layout (Onboarding / Chat / Pipeline / Drafts). Real content in later tasks.
- [ ] **Manual:** `coldtrail serve --no-open`, curl `/` returns HTML; open in browser shows shell.
- [ ] Commit.

### Task 3: api.rs types + pipeline endpoints

- [ ] `api.rs`: `CompanyDto, ContactDto, DraftDto, StatusDto` (serde) mirroring DB columns + `pending_drafts` shape.
- [ ] `pipeline.rs`: `GET /api/companies` (domain,name,status,first_seen), `/api/contacts`, `/api/drafts` (join outreach+contacts for rows needing review/send). Query via `db::open()`.
- [ ] **Test:** boot state over a temp `COLDTRAIL_HOME` seeded with a company+contact+draft; assert JSON shape/counts.
- [ ] Commit.

### Task 4: onboarding endpoints

- [ ] `GET /api/status` → derive from workspace: provider (`read_agent`), agents detected (`agents::detect_all`), whether `.mcp.json`/codex config has canonical+gmail, whether message/contacted edited (differ from embedded defaults). Return `StatusDto`.
- [ ] `POST /api/onboarding/provider {provider}` → validate present, `write_agent`.
- [ ] `POST /api/onboarding/mcp {gmail_client_id?, gmail_secret?, callback_port?, skip_gmail}` → reuse the wiring in `setup.rs` (extract a `wire(provider, opts)` fn callable from both CLI and HTTP).
- [ ] `POST /api/onboarding/message {toml}` / `/contacted {toml}` → validate parse, write file.
- [ ] **Test:** status derivation over temp home (fresh vs configured); message save round-trip + rejects invalid TOML.
- [ ] Commit.

### Task 5: provider trait + headless claude driver + parser

- [ ] `provider/mod.rs`: `AgentEvent` enum; `Provider` trait `run_turn(session,msg,tx)`.
- [ ] `provider/cli.rs`: **pure** `parse_stream_line(&str) -> Option<AgentEvent>` per the verified schema. Spawn helper: `claude -p <msg> --output-format stream-json --verbose --session-id <uuid> [--resume on turn>1] --allowedTools <list> --permission-mode acceptEdits`, cwd `~/.coldtrail`; read stdout lines async, map, send to channel; also handle Codex via `codex exec` (best-effort; behind kind match).
- [ ] **Test:** feed each fixture line (captured schema) to `parse_stream_line`; assert Text/ToolStart/ToolEnd/Done mapping; junk line → None.
- [ ] Commit.

### Task 6: chat SSE endpoint

- [ ] `chat.rs`: `POST /api/chat {message}` → allocate run id + a broadcast/mpsc channel, store in a `RunRegistry` (in `AppState`), spawn the provider turn; return `{run}`. `GET /api/chat/stream?run=<id>` → axum SSE reading the channel, emitting `AgentEvent` as SSE `data:` JSON until `Done`.
- [ ] Session continuity: map browser session→claude session uuid in the registry; first turn creates it, later turns `--resume`.
- [ ] **Test:** with a fake `claude` stub on PATH emitting canned stream-json, POST chat then read the SSE stream to completion; assert events include Text + Done. (integration test gated on constructing PATH.)
- [ ] Commit.

### Task 7: send endpoint

- [ ] `send.rs`: `POST /api/drafts/:domain/send` → verify the domain has a `drafted`/`draft_pending` outreach row; issue a constrained provider turn ("send the Gmail draft for <domain> and nothing else"); on success run `mark <domain> sent`. If the Gmail MCP lacks a send tool, return a `{fallback:"open-in-gmail", url}` so the UI can link out.
- [ ] **Test:** send-eligibility unit (only eligible statuses); the agent call path covered by the stub.
- [ ] Commit.

### Task 8: the real UI (frontend-design skill)

- [ ] Invoke `frontend-design`. Build the four views against the API/SSE contract: Onboarding (status + provider pick + MCP form + message/contacted editors), Chat (input + streamed text + tool chips), Pipeline (companies table + status filter), Drafts (list + body view + Send button + warmup counter). Self-contained, themed light/dark, accessible.
- [ ] **Manual:** full walk-through in the browser against a seeded temp home.
- [ ] Commit.

### Task 9: end-to-end verification + README

- [ ] Real run: `coldtrail` → browser → onboarding status shows wired MCP → one chat turn drives headless claude (seed a tiny prompt) → pipeline/drafts populate → Send path (or fallback) works.
- [ ] `cargo test` + `clippy` + `fmt` + `shellcheck` clean.
- [ ] README: new "Run the app" section (bare `coldtrail` opens the browser); note `coldtrail agent` for the raw terminal agent and subcommands for power use.
- [ ] Commit.

## Self-Review

**Spec coverage:** topology+security (T1), embed/UI shell (T2), pipeline API (T3), onboarding (T4), provider+parser (T5), chat SSE (T6), send (T7), full UI (T8), e2e+docs (T9). Phases 2/3 (BYOK/Ollama, analytics) explicitly out of this plan.

**Type consistency:** `AgentEvent` (T5) consumed by chat (T6) + send (T7); `api.rs` DTOs (T3) shared by pipeline/onboarding + UI; `wire()` extracted from setup reused by onboarding (T4). Consistent.

**Placeholders:** stream-json mapping is concrete (verified schema). Known-unknowns carried: exact allowed-tools/permission flags for unattended headless runs (T5 — verify live) and Gmail send-tool availability (T7 — fallback designed).
