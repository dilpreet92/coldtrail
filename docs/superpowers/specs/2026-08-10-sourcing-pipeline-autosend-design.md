# Multi-angle sourcing · Pipeline filter scaling · Opt-in auto-send — design

**Date:** 2026-08-10
**Status:** implemented (v0.7.0)

Three independent improvements shipped together. Each section is self-contained.

---

## 1. Parallel multi-angle sourcing (`coldtrail source`)

**Motivation.** Studied the canonical-server "agent mode" (commit `c402676`): every recall bug
is an expansion failure of one-shot interpretation. Its fix = an LLM planner emits 3–5 diverse
structured search requests whose **union** covers what a single guess misses; deterministic code
fans them out (bounded concurrency), dedupes by company id, and stops on budget/target/all-dry.

**Adaptation for coldtrail.** coldtrail's agent *is already the LLM*, so we don't nest an LLM
call inside the CLI. Instead:
- The **agent plans the angles** (guided by `CLAUDE.md` step 1 + the OpenAI `discover` tool
  description / system prompt), reusing canonical's planner rules: expand acronyms/regions into
  distinct positive phrasings, keep angles genuinely different, never negate.
- `coldtrail source "<a1>" "<a2>" …` accepts **multiple angles**, fans out the Canonical
  `search_companies` calls **in parallel** (`futures::join_all`, each its own MCP connection),
  and imports the results **sequentially** so domain-dedupe carries across angles (a company is
  added by the first angle that finds it; later angles see it as already-known).
- Single-angle usage is unchanged (back-compat): `coldtrail source "<icp>"`.

**Files:** `src/source.rs` (`fetch_and_import_many`), `src/cli.rs` (`queries: Vec<String>`,
`num_args = 1..`), `src/main.rs`, `src/provider/tools.rs` (`discover` accepts `queries[]`),
`src/provider/openai.rs` (system prompt), `templates/CLAUDE.md`.

**Not ported (YAGNI for v1):** the multi-round loop, budget tiers, the deterministic
lookup/ask/discovery intent fork, structured `filters`/`intent`. A single round of parallel
angles captures ~90% of the recall benefit. These are noted as future work.

**Test:** `import::cross_angle_import_dedupes_by_domain` proves union dedupe + first-angle
ownership of `source_query`. Live fan-out against Canonical is user-verified (needs their token).

---

## 2. Pipeline "Sourced by" filter scaling

**Motivation.** The filter rendered one chip per distinct `source_query`; as searches pile up the
row becomes unmanageable.

**Change (frontend only).** Replace the chip row with a compact `<select>` dropdown:
`all queries (N)` + one option per query showing its company count, sorted by count desc, each
label clipped to 60 chars. Scales to any number of queries. `ui/app.js` (`loaders.pipeline`),
`ui/app.css` (`.pipe-select`).

---

## 3. Opt-in auto-send

**Motivation.** The user asked to optionally let coldtrail *send* (not just draft) once they trust
the output — a deliberate, explicit relaxation of the standing draft-only guardrail.

**Design.**
- **Off by default.** `Config { auto_send: bool, daily_send_cap: Option<u32> }`
  (`DEFAULT_DAILY_SEND_CAP = 20`). Toggled via `POST /api/destination/auto-send {enabled,
  daily_cap}`; surfaced in `StatusDto { auto_send, daily_send_cap }`.
- **Send paths.** New `src/smtp.rs` — minimal SMTP submission over implicit TLS
  (smtp.gmail.com:465, pure-rustls/ring, AUTH LOGIN, dot-stuffed DATA) for the keyless
  app-password path (which could previously only draft). The OAuth path uses
  `gmail::send_message` (Gmail API `messages.send`; `gmail.compose` covers sending).
- **Guardrails kept.** `send::send` enforces a per-calendar-day cap before sending (counts
  `outreach` rows with `status='sent'` and `date(sent_at)=date('now')`); over the cap → a clear
  refusal, no send. Success marks `status='sent'`. Default path is unchanged (draft + human
  sends). The **chat agent still never sends** — only the human's click on the Drafts screen
  does; `CLAUDE.md` notes the toggle is the human's action, not the agent's.
- **UI.** Settings → Destination gains a toggle + daily-cap input with a plain-language warning
  and a confirm dialog on enable. The Drafts screen adapts its copy when auto-send is on
  ("Send now" / "Send all (N)", stronger confirms, warmup line shows the cap).

**Files:** `src/config.rs`, `src/smtp.rs` (new), `src/gmail.rs` (`send_message`), `src/main.rs`,
`src/web/send.rs`, `src/web/api.rs`, `src/web/onboarding.rs` (`set_auto_send` + status),
`src/web/mod.rs`, `ui/app.js`, `ui/app.css`, `templates/CLAUDE.md`.

**Test:** `config::auto_send_roundtrips`; `smtp::dot_stuffs_leading_dots_and_crlf`. The real send
(SMTP / Gmail API) is user-verified — it needs live credentials and must not fire test email.
Toggle + cap plumbing verified live via the status endpoint.
