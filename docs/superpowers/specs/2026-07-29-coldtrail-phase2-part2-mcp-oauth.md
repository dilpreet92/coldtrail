# coldtrail Phase 2 part 2 — Discovery/Destination reframe + in-Rust MCP client & OAuth

**Date:** 2026-07-29
**Status:** Approved (build all; live OAuth verified by the user).
**Builds on:** Phase 2 part 1 (backends).

## Goal

1. Reframe onboarding into three pluggable categories: **Provider** (the brain),
   **Discovery** (where companies come from), **Destination** (where outreach goes).
2. Give the BYOK/Ollama backends the same reach as Claude Code via an **in-Rust MCP
   client** + **OAuth**, so they can natively use Canonical (discovery) and Gmail
   (destination) — no more import-JSON-only / send-only-on-Claude.

## Categories (extensible)

- **Provider:** claude · codex · openai(BYOK) · ollama. *(part 1)*
- **Discovery:** `canonical` today. Future: other company sources.
- **Destination:** `gmail` today. Future: `linkedin`, etc.

Config (`config.toml`):
```toml
agent = "openai"
[provider] base_url = "…"  model = "…"
[discovery.canonical]  connected = true
[destination.gmail]    connected = true
```
"Connect" semantics per provider:
- **claude/codex** → wire the MCP into their config (`wire_mcp`, existing). OAuth handled
  by the CLI in-browser on first use.
- **openai/ollama** → the in-Rust MCP client authenticates via OAuth and stores a token;
  the agent loop / send path call the connector through that client.

## MCP client (`src/mcp_client.rs`)

JSON-RPC 2.0 over MCP **Streamable HTTP**:
- `initialize` (capture `Mcp-Session-Id` response header + protocol version), then
  `notifications/initialized`, `tools/list`, `tools/call`.
- POST with `Accept: application/json, text/event-stream`; parse either a JSON body or an
  SSE `event: message\ndata: {json}` frame.
- `Authorization: Bearer <token>` from the connector's stored token.
- Public API: `McpClient::connect(url, token) -> Result<McpClient>`;
  `client.call_tool(name, args_json) -> Result<Value>`; `client.list_tools()`.
- Unit-tested against a mock MCP server (axum) covering initialize→tools/call.

## OAuth (`src/oauth.rs`)

Authorization-code + **PKCE (S256)** with a one-shot local redirect server.
- `pkce()` → (verifier, challenge); `authorize_url(...)`; `exchange_code(...)`;
  `refresh(...)`. Pure parts unit-tested (PKCE S256 vector, URL building, token-JSON parse).
- `run_flow(cfg) -> Tokens`: build URL, open browser, run a one-shot callback server on a
  fixed loopback port to capture `?code=`, exchange for tokens. (Live step — user clicks
  "authorize".)
- **Gmail** (concrete Google flow): endpoints `accounts.google.com/o/oauth2/v2/auth` +
  `oauth2.googleapis.com/token`; user-supplied client id/secret; scopes `gmail.compose`,
  `gmail.readonly`; redirect `http://localhost:<port>/callback`.
- **Canonical** (MCP-standard flow): on a 401 from the MCP URL, discover
  protected-resource metadata (RFC 9728) → auth-server metadata (RFC 8414) → dynamic client
  registration (RFC 7591) if needed → auth code + PKCE.
- **Token store:** `secrets.toml` gains `[tokens.<connector>]`
  `{access, refresh, expires_at}`; `0600`; refresh-on-expiry; never surfaced by HTTP.

## Wiring into the loop (guardrail-preserving)

- **Discovery = a chat-loop tool.** For openai/ollama, `tools::defs()` gains
  `discover_companies(query, label)` when Canonical is connected: calls Canonical
  `search_companies` via the MCP client, upserts results (dedupe), returns a summary. So
  BYOK/Ollama source natively.
- **Destination = SEND path only, never the chat loop.** `send.rs` for openai/ollama uses
  the MCP client to call Gmail's send tool with the stored token; marks sent only on a
  successful tool result. The chat loop still has **no** Gmail tool — the no-auto-send
  invariant holds for every backend.
- CLI backends unchanged (Claude/Codex own their MCP + OAuth).

## Onboarding UI

Three sections: **Provider** (part 1), **Discovery** (Canonical: Connect → OAuth for
BYOK/Ollama, or wire for CLI; shows connected state), **Destination** (Gmail: Google Cloud
prereqs + client id/secret + Connect; a disabled "LinkedIn — coming" chip). `/api/status`
reports each category's connected state (never tokens/keys).

## Testing

- `mcp_client`: mock MCP server (axum) → initialize + tools/call happy path; error mapping;
  SSE-framed vs JSON response parsing.
- `oauth`: PKCE S256 known-answer; authorize-URL params; token-response parse; refresh
  request shape (vs a mock token endpoint). The interactive browser leg is **not**
  unit-tested — verified live by the user.
- config reframe round-trip (discovery/destination tables); status derivation.

## Live-verification boundary (explicit)

The interactive OAuth consent for Canonical and Gmail requires the user's real credentials
and a browser, which cannot run in this environment. Everything else is unit/mock-tested;
the user runs the "Connect → authorize" step to confirm the live handshakes.

## Known unknowns

- Canonical's exact OAuth/DCR support and the MCP `search_companies` result schema over the
  raw protocol (Claude Code abstracts both) — verified at implementation against the live
  server / adjusted; discovery tool falls back to import-JSON if the live flow differs.
- Gmail MCP send tool's exact name/params under `gmail.compose` (Destination) — verified live.
