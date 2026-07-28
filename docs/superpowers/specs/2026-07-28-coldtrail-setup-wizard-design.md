# coldtrail `setup` wizard — provider detection + MCP wiring

**Date:** 2026-07-28
**Status:** Approved design, pre-implementation
**Builds on:** 2026-07-24-coldtrail-rust-cli-design.md

## Goal

Turn `coldtrail setup` from a one-shot file-writer into a Hermes-style interactive wizard
that (1) detects the installed agent CLIs and their auth, (2) lets the user pick a default
provider, and (3) wires the Canonical and Gmail MCP servers into coldtrail's own scope for
that provider. Idempotent and re-runnable.

## Non-goals

- Authenticating the agent itself (`claude`/`codex` login) — that stays each CLI's job;
  setup only detects and reports auth state.
- Creating the user's Google Cloud OAuth client / enabling APIs — setup prints the exact
  prerequisites and collects the resulting client id/secret; it does not automate Cloud.
- Configuring MCP globally — writes are scoped to coldtrail only.
- Wiring both providers at once — the chosen provider only; re-run to switch.

## Flow

`coldtrail setup` runs these steps in order; each is idempotent:

1. **Ensure workspace** — CLAUDE.md (refresh), config.toml / message.toml / contacted.toml
   (create if absent), init db. (Existing behavior.)
2. **Detect agents** — for `claude` and `codex`: on PATH? authenticated? Report a line each:
   - `claude`: present iff on PATH; authed iff `~/.claude.json` exists and is non-trivial.
   - `codex`: present iff on PATH; authed iff `~/.codex/auth.json` exists.
   - Print e.g. `Claude Code   ✓ found, authenticated` / `Codex          ✓ found` /
     `… not found — install: <hint>`.
3. **Pick default provider** — write `agent` in `config.toml`:
   - both found → prompt `Default agent? [claude/codex] (claude): `
   - exactly one found → use it, print the choice
   - none found → print install hints and stop before MCP steps (nothing to wire into)
4. **Wire Canonical** into the chosen provider's coldtrail scope (URL
   `https://trycanonical.ai/mcp/`). OAuth completes on first agent launch.
5. **Wire Gmail** — print Google Cloud prerequisites (below), collect OAuth **client id** +
   **client secret**, wire the Gmail HTTP MCP (`https://gmailmcp.googleapis.com/mcp/v1`) into
   coldtrail scope with a fixed OAuth callback port.
6. **Summary** — what was wired, and: "run `coldtrail`; OAuth for Canonical/Gmail completes
   in-browser on first use."

## MCP wiring mechanism (scoped to coldtrail)

### Claude — shell out to `claude mcp add --scope project`, run with cwd = `~/.coldtrail`

`--scope project` writes/updates `~/.coldtrail/.mcp.json`; Claude Code owns the exact schema
and secret storage (so we never hand-encode OAuth fields).

- Canonical:
  `claude mcp add --transport http --scope project canonical https://trycanonical.ai/mcp/`
- Gmail:
  `claude mcp add --transport http --scope project --client-id <ID> --client-secret \
     --callback-port <PORT> gmail https://gmailmcp.googleapis.com/mcp/v1`
  with the secret passed via `MCP_CLIENT_SECRET` env on that invocation (not argv).

Idempotency: before adding, check `claude mcp get <name>` (cwd = workspace). If already
present, skip unless `--force`, in which case `claude mcp remove <name> --scope project`
first. All invocations run with `current_dir(~/.coldtrail)`.

### Codex — write `~/.codex/config.toml`

Add/replace `[mcp_servers.canonical]` and `[mcp_servers.gmail]` tables:
```toml
[mcp_servers.canonical]
url = "https://trycanonical.ai/mcp/"

[mcp_servers.gmail]
url = "https://gmailmcp.googleapis.com/mcp/v1"
```
Preserve existing content (parse → merge tables → write). Gmail OAuth client id/secret and
Codex's exact remote-MCP schema are Codex-version-dependent; if the installed Codex lacks
HTTP-MCP support, print a warning and the manual steps rather than writing an unusable entry.
(Claude is the primary path; Codex is best-effort.)

## Gmail Google Cloud prerequisites (printed by setup)

1. Enable **Gmail API** and **Gmail MCP API** in a Google Cloud project.
2. Create an **OAuth 2.0 Client** (type: Web application). Note the client id + secret.
3. Configure the consent screen; add scopes `gmail.readonly` and `gmail.compose`.
4. Add redirect URI `http://localhost:<PORT>/callback` matching the fixed callback port
   setup uses (default **8765**; overridable). The exact callback path Claude Code expects
   is verified at implementation time and printed verbatim.

## config.toml

```toml
agent = "claude"   # or "codex" — the chosen default provider
```
The `run` command already launches the configured agent; today it hardcodes `claude`. As
part of this work, `run` reads `config.toml.agent` and launches that CLI (claude | codex),
still in cwd = `~/.coldtrail`.

## Secrets & interactivity

- The Gmail client **secret** is never written to the repo. Under Claude it goes wherever
  `claude mcp add` stores it (project `.mcp.json`/`~/.claude.json`); either way inside
  `~/.coldtrail` or the user's Claude config, never coldtrail's git repo.
- Interactive prompts read stdin only when `stdin.is_terminal()`. Non-interactive/piped runs
  DO NOT hang: they take env/flags and print what still needs manual input.
- Automation inputs: `--provider claude|codex`, env `COLDTRAIL_GMAIL_CLIENT_ID` /
  `COLDTRAIL_GMAIL_CLIENT_SECRET`, `--gmail-callback-port <n>`, `--skip-gmail`, `--force`.

## Rust structure

- `src/agents.rs` — pure detection: `detect(which_fn, home_probe) -> Vec<AgentStatus{kind,
  present,authed}>`; plus a thin real `detect_all()`. `AgentKind { Claude, Codex }`.
- `src/mcp.rs` — pure config generation:
  - `claude_add_args(server: &McpServer) -> Vec<String>` (the argv after `mcp add`).
  - `codex_config_merge(existing_toml: &str, servers: &[McpServer]) -> String`.
  - `McpServer { name, url, oauth: Option<OAuthClient{client_id, callback_port}> }`.
- `src/prompt.rs` — thin tty helpers: `select(label, options, default)`, `line(label,
  default)`, `secret(label)` (hidden). Interactive only when `IsTerminal`.
- `src/setup.rs` — orchestrates the flow using the above; still exposes `ensure()`.
- `src/cli.rs` — extend `Setup` with `--provider`, `--gmail-callback-port`, `--skip-gmail`,
  `--force`.
- `src/run.rs` — read `config.toml.agent`; launch claude or codex accordingly.

New deps: `is-terminal` is unnecessary (`std::io::IsTerminal`, stable). Hidden password input
needs `rpassword` (small, well-used) — added to Cargo.toml.

## Testing

- `agents::detect` — inject a fake `which` closure + a fake home dir with/without
  `.claude.json` / `auth.json`; assert present/authed matrix.
- `mcp::claude_add_args` — Canonical (no oauth) and Gmail (with client-id + callback-port)
  produce the exact expected argv; secret is NOT in argv.
- `mcp::codex_config_merge` — merging into empty, into existing unrelated tables, and
  re-merging (idempotent) yields expected TOML that still round-trips through `toml`.
- provider-selection logic — both/one/none found → correct chosen provider or stop.
- `run` agent dispatch — config `agent="codex"` selects the codex launch path (unit-test the
  resolver, not the exec).
- Manual: a real `coldtrail setup` on this machine (claude present) writing
  `~/.coldtrail/.mcp.json` with canonical, verified via `claude mcp get canonical`.

## Known unknowns (verify at implementation)

- The exact OAuth callback path/port Claude Code expects for `--callback-port` (to print the
  correct redirect URI). Verify with a real `claude mcp add … --callback-port` and inspect.
- Whether the installed Codex (0.144) accepts an HTTP `url` MCP entry in config.toml. If not,
  warn + document instead of writing.
