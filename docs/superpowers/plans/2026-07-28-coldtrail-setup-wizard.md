# coldtrail setup wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `coldtrail setup` an interactive, idempotent wizard that detects the agent CLIs, picks a default provider, and wires the Canonical + Gmail MCP servers into coldtrail's own scope.

**Architecture:** Pure cores (`agents` detection, `mcp` config generation) with a thin tty `prompt` layer and a `setup` orchestrator. Claude MCP wiring shells out to `claude mcp add --scope project` (cwd = `~/.coldtrail`); Codex writes `~/.codex/config.toml`. `run` learns to launch the configured provider.

**Tech Stack:** Rust 2021, existing deps + `rpassword` (hidden input); `std::io::IsTerminal`; `std::process::Command`; `toml`.

## Global Constraints

- Wiring is scoped to coldtrail only; never touch global agent MCP config.
- Chosen provider only; re-run to switch. Default provider stored in `config.toml` `agent`.
- Canonical URL: `https://trycanonical.ai/mcp/`. Gmail URL: `https://gmailmcp.googleapis.com/mcp/v1`.
- Gmail scopes to document: `gmail.readonly`, `gmail.compose`. Default callback port: `8765`.
- Secrets never in argv and never in the repo; pass the Gmail secret via `MCP_CLIENT_SECRET` env to `claude mcp add`.
- Non-interactive (non-tty) runs must never block on stdin.
- Everything idempotent and re-runnable.

---

## File Structure

```
src/agents.rs   # AgentKind, AgentStatus, detect(which, home) — pure + detect_all()
src/mcp.rs      # McpServer, OAuthClient, claude_add_args(), codex_config_merge()
src/prompt.rs   # tty-aware select/line/secret helpers
src/setup.rs    # orchestrator (extends existing ensure()/run())
src/run.rs      # launch configured provider (claude|codex)
src/cli.rs      # Setup flags: --provider, --gmail-callback-port, --skip-gmail, --force
Cargo.toml      # + rpassword
```

---

### Task 1: `agents.rs` — provider detection (pure)

**Files:** Create `src/agents.rs`; add `mod agents;` to `src/main.rs`. Tests in-module.

**Interfaces:**
- Produces: `AgentKind { Claude, Codex }` (with `fn bin(&self)->&str`, `fn label(&self)->&str`, `fn install_hint(&self)->&str`); `AgentStatus { kind, present: bool, authed: bool }`; `fn detect(which: impl Fn(&str)->bool, home: &Path) -> Vec<AgentStatus>`; `fn detect_all() -> Vec<AgentStatus>`.

- [ ] **Step 1: Failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    #[test]
    fn detects_present_and_authed() {
        let home = std::env::temp_dir().join("ct-agents-test");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join(".claude.json"), "{\"x\":1}").unwrap(); // claude authed
        // no ~/.codex/auth.json -> codex present but not authed
        let which = |b: &str| b == "claude" || b == "codex";
        let v = detect(which, &home);
        let claude = v.iter().find(|s| s.kind == AgentKind::Claude).unwrap();
        let codex = v.iter().find(|s| s.kind == AgentKind::Codex).unwrap();
        assert!(claude.present && claude.authed);
        assert!(codex.present && !codex.authed);
    }
    #[test]
    fn absent_when_not_on_path() {
        let home = std::env::temp_dir().join("ct-agents-test2");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let v = detect(|_| false, &home);
        assert!(v.iter().all(|s| !s.present));
    }
}
```

- [ ] **Step 2: Implement.** `detect` builds a status per kind: `present = which(kind.bin())`; `authed` = Claude → `home.join(".claude.json").exists()`; Codex → `home.join(".codex/auth.json").exists()`. `detect_all()` uses a real `which` (scan `PATH` for the binary, as in `run::claude_present`) and `dirs::home_dir()`.
- [ ] **Step 3: `cargo test agents::` passes. Commit.**

---

### Task 2: `mcp.rs` — MCP config generation (pure)

**Files:** Create `src/mcp.rs`; `mod mcp;`. Tests in-module.

**Interfaces:**
- Produces: `OAuthClient { client_id: String, callback_port: u16 }`; `McpServer { name: String, url: String, oauth: Option<OAuthClient> }`; `fn claude_add_args(s: &McpServer) -> Vec<String>` (argv AFTER `mcp add`, EXCLUDING the secret); `fn codex_config_merge(existing: &str, servers: &[McpServer]) -> anyhow::Result<String>`.

- [ ] **Step 1: Failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn claude_args_canonical_plain() {
        let s = McpServer { name: "canonical".into(), url: "https://trycanonical.ai/mcp/".into(), oauth: None };
        assert_eq!(claude_add_args(&s), vec![
            "--transport","http","--scope","project","canonical","https://trycanonical.ai/mcp/",
        ]);
    }
    #[test]
    fn claude_args_gmail_oauth_no_secret_in_argv() {
        let s = McpServer { name: "gmail".into(), url: "https://gmailmcp.googleapis.com/mcp/v1".into(),
            oauth: Some(OAuthClient { client_id: "abc.apps".into(), callback_port: 8765 }) };
        let a = claude_add_args(&s);
        assert!(a.contains(&"--client-id".to_string()) && a.contains(&"abc.apps".to_string()));
        assert!(a.contains(&"--client-secret".to_string()));           // flag present (prompts / env)
        assert!(a.contains(&"--callback-port".to_string()) && a.contains(&"8765".to_string()));
        assert!(!a.iter().any(|x| x.contains("SECRET") || x.contains("secret=")));  // never the value
    }
    #[test]
    fn codex_merge_adds_and_is_idempotent() {
        let servers = vec![McpServer{name:"canonical".into(),url:"https://trycanonical.ai/mcp/".into(),oauth:None}];
        let once = codex_config_merge("", &servers).unwrap();
        assert!(once.contains("[mcp_servers.canonical]") && once.contains("https://trycanonical.ai/mcp/"));
        let twice = codex_config_merge(&once, &servers).unwrap();
        // merging again does not duplicate the table
        assert_eq!(twice.matches("[mcp_servers.canonical]").count(), 1);
        // pre-existing unrelated content is preserved
        let with_other = codex_config_merge("model = \"gpt\"\n", &servers).unwrap();
        assert!(with_other.contains("model = \"gpt\""));
    }
}
```

- [ ] **Step 2: Implement.**
  - `claude_add_args`: start `["--transport","http","--scope","project"]`; if `oauth`, push `"--client-id", id, "--client-secret", "--callback-port", port.to_string()`; then `name, url`. (Secret comes via `MCP_CLIENT_SECRET` env at call time, not here.)
  - `codex_config_merge`: parse `existing` as `toml::Value` (empty → empty table); ensure `mcp_servers` table; for each server insert/replace a sub-table with `url` (+ oauth fields if present); serialize back with `toml::to_string_pretty`. Idempotent because insert replaces the same key.
- [ ] **Step 3: `cargo test mcp::` passes. Commit.**

---

### Task 3: `prompt.rs` — tty-aware input

**Files:** Create `src/prompt.rs`; `mod prompt;`. Add `rpassword` to Cargo.toml.

**Interfaces:**
- Produces: `fn interactive() -> bool` (`std::io::stdin().is_terminal()`); `fn line(label: &str, default: Option<&str>) -> Option<String>`; `fn select(label: &str, options: &[&str], default: &str) -> Option<String>`; `fn secret(label: &str) -> Option<String>`. All return `None` when not interactive (caller falls back to env/flags).

- [ ] **Step 1: Implement** (thin; logic is just tty-gated stdin reads; `secret` uses `rpassword::prompt_password`). No unit test for the interactive reads themselves; a test asserts `interactive()` is callable and `line`/`select`/`secret` return `None` under a forced non-tty is not reliable to simulate — instead keep these functions trivial and cover the branching logic in `setup` via injected values (Task 4).
- [ ] **Step 2: `cargo build` clean. Commit.**

---

### Task 4: `setup.rs` — orchestrate the wizard

**Files:** Modify `src/setup.rs`, `src/cli.rs`, `src/main.rs`.

**Interfaces:**
- Consumes: `agents`, `mcp`, `prompt`, `home`, `db`.
- Produces: `setup::run(opts: SetupOpts) -> Result<()>`; `SetupOpts { provider: Option<String>, gmail_callback_port: u16, skip_gmail: bool, force: bool }`. Keeps `setup::ensure()`.
- Produces (config): `fn write_agent(kind: AgentKind) -> Result<()>` (writes `config.toml` `agent = "<kind>"`), `fn read_agent() -> Result<AgentKind>` (defaults Claude).

- [ ] **Step 1: cli.rs** — extend `Commands::Setup` to a struct variant:
```rust
Setup {
    #[arg(long)] provider: Option<String>,
    #[arg(long, default_value_t = 8765)] gmail_callback_port: u16,
    #[arg(long)] skip_gmail: bool,
    #[arg(long)] force: bool,
},
```
Update `main.rs` dispatch to build `SetupOpts` and call `setup::run(opts)`.

- [ ] **Step 2: provider selection** — gather `agents::detect_all()`, print status lines. Resolve provider: `opts.provider` if given (validate it's present) → else if exactly one present use it → else if both present and interactive `prompt::select("Default agent", ["claude","codex"], "claude")` → else default claude with a note. If none present, print install hints and return early. `write_agent(kind)`.

- [ ] **Step 3: unit-test provider resolution** — extract `resolve_provider(statuses, flag, interactive_choice: Option<&str>) -> Option<AgentKind>` (pure) and test: both+flag=codex→Codex; one present→that one; none→None; both+no flag+choice→choice.

```rust
#[test]
fn resolve_provider_rules() {
    use AgentKind::*;
    let both = vec![st(Claude,true), st(Codex,true)];
    assert_eq!(resolve_provider(&both, Some("codex"), None), Some(Codex));
    assert_eq!(resolve_provider(&both, None, Some("codex")), Some(Codex));
    let only_codex = vec![st(Claude,false), st(Codex,true)];
    assert_eq!(resolve_provider(&only_codex, None, None), Some(Codex));
    let none = vec![st(Claude,false), st(Codex,false)];
    assert_eq!(resolve_provider(&none, None, None), None);
}
// where st(kind,present)=AgentStatus{kind,present,authed:present}
```

- [ ] **Step 4: Canonical wiring** — build `McpServer{name:"canonical",url:CANONICAL_URL,oauth:None}`; call `wire(provider, &server, None)`:
  - Claude: if not `force` and `claude mcp get canonical` (cwd=ws) succeeds → skip; else (force) `claude mcp remove canonical --scope project` then `claude mcp add <claude_add_args> ` with cwd=ws.
  - Codex: read `~/.codex/config.toml`, `codex_config_merge`, write back.
- [ ] **Step 5: Gmail wiring** (unless `--skip-gmail`) — print the Cloud prerequisites + redirect URI `http://localhost:<port>/callback`. Resolve client id (`--`? no; env `COLDTRAIL_GMAIL_CLIENT_ID` or `prompt::line`) and secret (env `COLDTRAIL_GMAIL_CLIENT_SECRET` or `prompt::secret`). If either missing and non-interactive → print "set COLDTRAIL_GMAIL_CLIENT_ID/SECRET or run setup in a terminal" and skip Gmail (don't fail the whole wizard). Else build `McpServer` with `OAuthClient{client_id, callback_port}`; for Claude, set `MCP_CLIENT_SECRET` env on the `claude mcp add` Command; for Codex, merge url (+ note that secret must be added manually if unsupported).
- [ ] **Step 6: summary + next steps.** Print wired servers and the "run `coldtrail`; OAuth completes on first use" note.
- [ ] **Step 7: `cargo test setup::` passes; `cargo build` clean. Commit.**

---

### Task 5: `run.rs` — launch the configured provider

**Files:** Modify `src/run.rs`.

- [ ] **Step 1: dispatch on config** — `let kind = setup::read_agent()?;` choose `bin = kind.bin()` (claude|codex). Replace hardcoded `"claude"` in `claude_present`/`launch` with the resolved bin. Keep the "not found → guidance + exit 127" path, using `kind.install_hint()`.
- [ ] **Step 2: unit-test the resolver** (not the exec): `read_agent()` returns Codex when config has `agent="codex"`, Claude by default/missing. Use `testutil::with_home`.
- [ ] **Step 3: `cargo test` full green. Commit.**

---

### Task 6: live verification + docs

**Files:** README.md (setup section), maybe install.sh message.

- [ ] **Step 1: real run** — `COLDTRAIL_HOME=$(mktemp -d) coldtrail setup --skip-gmail` on this machine (claude present); assert it writes `~/.coldtrail/.mcp.json` with canonical, verify `claude mcp get canonical` (cwd=ws) shows it.
- [ ] **Step 2: gmail dry path** — run with `COLDTRAIL_GMAIL_CLIENT_ID=test COLDTRAIL_GMAIL_CLIENT_SECRET=test --gmail-callback-port 8765` in a temp home; assert the gmail server is registered (client id present, secret not echoed).
- [ ] **Step 3: README** — document the wizard: what it detects, provider choice, the Gmail Google Cloud prerequisites + redirect URI, and the env/flags for automation.
- [ ] **Step 4: `cargo fmt` + `cargo clippy` + full `cargo test` + `shellcheck` all clean. Commit.**

---

## Self-Review

**Spec coverage:** detection (T1), MCP generation (T2), tty input (T3), provider pick + Canonical + Gmail wiring + config write (T4), provider-aware launch (T5), verification + docs (T6). All spec sections mapped.

**Type consistency:** `AgentKind`/`AgentStatus` (T1) consumed by T4/T5; `McpServer`/`OAuthClient` + `claude_add_args`/`codex_config_merge` (T2) consumed by T4; `resolve_provider`/`read_agent`/`write_agent` shared T4↔T5. Consistent.

**Placeholder scan:** concrete commands, argv, and TOML throughout. Two acknowledged verify-at-impl unknowns carried from the spec: the exact Claude `--callback-port` redirect path (T5 prints what Claude reports), and Codex HTTP-MCP support (T4 warns + documents if absent). Neither blocks the Claude primary path.
