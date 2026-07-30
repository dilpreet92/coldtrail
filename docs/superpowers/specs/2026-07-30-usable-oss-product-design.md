# coldtrail → usable OSS product — design

Date: 2026-07-30. Five changes to make coldtrail feel like a real, self-owned product.

## 1 · Onboarding wizard + persistent Settings

- First run (`status.onboarded == false`): the Setup view renders as a **stepper** —
  ① Provider → ② Discovery (Canonical) → ③ Destination (Gmail) → ④ Brief. One panel at a
  time, Next/Back, a progress rail, "step N of 4".
- Once onboarded: same nav entry renders as **Settings** — all slots on one page, each
  editable anytime (swap provider, reconnect Canonical/Gmail, edit message/contacted).
- Frontend-only; reuses the existing panels. A `wizardStep` state + a `renderSetup()` that
  branches on `onboarded`. Provider/discovery/destination/message endpoints already exist.

## 2 · Chat history (view + resume)

- Schema (new tables in `templates/schema.sql`):
  - `chat_sessions(id TEXT PK, agent_session_id TEXT, title TEXT, created_at, updated_at)`
  - `chat_messages(id INTEGER PK, session_id TEXT, role TEXT, content TEXT, created_at)`
- `AppState.chat` becomes the *active* chat: `{ chat_id, agent_session_id, created }`.
- Persist: on `start`, ensure an active `chat_sessions` row (create with title = trimmed
  first message if none), insert the user `chat_messages` row. The spawned turn accumulates
  agent text; on terminal `Done`, insert the assistant `chat_messages` row and bump
  `updated_at`. DB writes use short-lived connections (never held across `.await`).
- Endpoints: `GET /api/chats` (list, newest first), `GET /api/chats/:id` (messages),
  `POST /api/chats/new` (clear active → next message starts a fresh session),
  `POST /api/chats/:id/activate` (set active + load `agent_session_id`; next turn resumes).
- Resume: CLI backends pass the stored `agent_session_id` to `--resume`. BYOK/Ollama has no
  native session, so its turn is seeded with the stored transcript as prior context.
- UI: Chat view gains a history sidebar (title + relative time) + "New chat". Selecting a
  chat loads its transcript and activates it.

## 3 · coldtrail owns Canonical + Gmail (provider-agnostic)

### Canonical → `coldtrail source`
- New `src/source.rs` + `coldtrail source "<query>" [--limit N]`: resolve
  `oauth::valid_access("canonical")`, connect `mcp_client`, call `search_companies`
  (`{query, limit}`), parse the domain-keyed results, write a temp JSON and run the existing
  `import::run` (dedupe) with `source_query = query`. Prints an import summary.
- OpenAI/Ollama loop: add a `source` tool mirroring the command.
- Brief (`CLAUDE.md`): step 1 becomes "run `coldtrail source \"<query>\"`", not the MCP tool.
- Onboarding: Discovery connect = `oauth::connect_canonical` for **all** providers;
  `discovery_connected = secrets::has_token("canonical")` regardless of provider.

### Gmail → coldtrail's own Google client
- Re-introduce `src/gmail.rs`: `create_draft(token, to, subject, body)` → POST
  `users/me/drafts` with `{message:{raw}}` (RFC822, base64url, RFC2047 subject) using the
  `gmail.compose` OAuth token. Returns the Gmail draft id.
- `src/web/send.rs`: drop the connector-agent path entirely; for every backend, look up the
  reviewable draft, get `oauth::valid_access("gmail")` (else "connect Gmail in Settings"),
  call `gmail::create_draft`, then `mark::run(domain, <draft_id>)` → status `drafted`.
- Onboarding: Destination connect = `oauth::connect_gmail` for all providers;
  `destination_connected = secrets::has_token("gmail")`.
- **Guardrail unchanged: draft-only. coldtrail never sends; the human sends from Gmail.**
- Requires `COLDTRAIL_GOOGLE_CLIENT_ID/SECRET` (maintainer sets once).

## 4 · Source query visible per company

- `CompanyDto` += `source_query`. `companies()` selects it.
- Pipeline: a "Sourced by" column (truncated query) + a query filter (distinct queries)
  alongside the status filter.

## 5 · Light / dark theme

- `app.css`: a light palette under `:root[data-theme="light"]` mirroring every variable.
- Sidebar toggle; JS sets `document.documentElement.dataset.theme`, persists to
  `localStorage`, and defaults to `prefers-color-scheme` when unset.

## Guardrails preserved

Dedupe by domain; MX-verify; founder-addressed only; **drafts never auto-sent (human sends)**;
chat agent never touches Gmail; warmup pacing.

## Not verifiable by me (user verifies live)

Canonical `search_companies` schema over coldtrail's own OAuth; Gmail `drafts.create` with
the maintainer's Google client. Both are unit/mock-tested.

## Build order

Backend first (source-query, chat persistence, `source`, gmail), then one coherent UI pass
(theme, pipeline column, chat sidebar, wizard/settings + discovery/destination reframe), then
a parallel adversarial review, fixes, Playwright verification, ship.
