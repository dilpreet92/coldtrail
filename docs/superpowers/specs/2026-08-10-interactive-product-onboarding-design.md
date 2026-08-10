# Interactive "Your product" onboarding — design

**Date:** 2026-08-10
**Status:** approved, ready for implementation plan

## Problem

Setup step 4 ("Your product") is a static 5-field form (`product / value / offer / link /
sender`) that POSTs to `/api/onboarding/pitch`, where `build_brief` assembles a `message.toml`.
This captures thin context and *looks* like a fill-in template (`subject = "{product} for
{company}"`, a fixed "book a demo" CTA), which undercuts how the agent actually drafts.

The agent already composes each email **fresh, per company** (`templates/CLAUDE.md` step 3:
read `message.toml` as a *brief*, "do not send verbatim", write a tailored subject+body, store
via `coldtrail draft`). The mechanical `message.render()` fill-in (`{company}`/`{fn}`/`{slug}`)
is used only by the secondary CLI batch path `draft::run`, not by the chat agent.

**Goal:** replace the static form with an agent-led interview that captures **rich product
context**, stores it as the brief the agent composes from, and keeps everything downstream
working.

## Decisions (locked)

1. **Agent interviews, deterministic build.** The connected provider chats the user through it;
   a review step then saves via `build_brief` (preserving the no-fabrication guardrail). Not
   agent-authored `message.toml` (would risk schema breakage + needs a filesystem path the
   OpenAI/Ollama backend lacks).
2. **Rich context doc.** The interview produces a prose product brief (`product.md`) that the
   agent reads as its source of truth. `message.toml`'s structured fields stay working
   underneath as the deterministic fallback (schema unchanged).
3. **Review-and-edit gate** before building — extracted fields pre-fill an editable form; the
   user tweaks wording and clicks Build. Keeps control of the exact words that ship.

## Key constraint

The OpenAI/Ollama backend's `provider::openai::run_turn` is **stateless per call** — it rebuilds
`[system, user]` every time and ignores `session_id`/`first_turn`. A resume-based multi-turn
interview would silently lose context there. So the interview is designed **stateless and
transcript-carrying**: the frontend holds the running transcript and re-sends it each turn.
Identical behavior on Claude / Codex / OpenAI / Ollama.

## Architecture

### 1. Interview loop (`src/web/interview.rs`, new)

- `POST /api/onboarding/interview { transcript: [{role, text}] }` → `{ run }`.
- Each call is one **stateless** agent turn: fresh session id, `first_turn = true`, no resume,
  no SQLite persistence, tools disabled.
- Server prepends a fixed **interview preamble**, then renders the transcript, then runs
  `provider::run_turn`, forwarding events into `state.runs` under the returned run id.
- Streamed over the **existing** `/api/chat/stream` (already generic by run id) — no new stream
  endpoint.
- Empty transcript ⇒ the agent greets and asks the first question.

**Interview preamble (server constant):**
> You are helping a founder describe their product so coldtrail can write cold outreach.
> Interview them warmly and briefly — ask ONE short question at a time. Capture only what they
> tell you; never invent claims. Cover: what the product is + who it helps, the concrete
> pain/value, any proof or differentiator, the offer (optional), the call-to-action link, their
> name/sign-off, and voice/tone. After enough (usually 4–6 exchanges), stop asking and write one
> short line like "Here's what I've got — review and tweak below." then output EXACTLY one fenced
> block:
> ```coldtrail-brief
> {"product":"","what_it_does":"","pain_value":"","proof":"","offer":"","link":"","sender":"","voice":""}
> ```
> Use "" for anything not provided. Do not run any commands or tools.

**Tools:** disabled for interview turns (pure conversation). Exact flags handled in
implementation; the preamble also instructs no tool/command use as a belt-and-suspenders.

### 2. Completion → review → build (frontend)

- Step 4 renders a chat log + composer.
- On entering step 4 with a provider connected, auto-start the interview (empty transcript).
- Each assistant message is scanned for a ` ```coldtrail-brief ` fenced block. When found:
  - strip the block from the visible text,
  - parse the JSON, pre-fill an **editable review form** (product, what-it-does, pain-value,
    proof, offer, link, name, voice),
  - reveal a "Build my brief" button.
- A "fill it in manually instead" link reveals the plain form as a fallback (no provider, or
  user preference).

### 3. Storage — `set_pitch` writes two files

Extend `PitchReq` with the richer fields. `set_pitch` writes both, from the same captured input:

- **`product.md`** — readable prose brief; the agent's source of truth. Ends with a standing
  instruction: "Use as context. Write each email fresh for the specific company — reference what
  they actually do and why it's a fit. Never send this verbatim. Don't invent claims beyond
  what's here."
- **`message.toml`** — via the existing `build_brief` (folding `pain_value` into the value
  paragraph). Schema unchanged ⇒ `message.rs`, `draft.rs`, and existing tests untouched.

### 4. Wire the agent to `product.md`

- `templates/CLAUDE.md` + `templates/AGENTS.md` step 3: read **`product.md`** as the product
  brief; note `message.toml` is a structural fallback.
- `provider/openai.rs` `system_prompt`: `brief = read(product.md).or_else(read(message.toml))`.

### 5. Status / wizard

- Add `product_set: bool` to `StatusDto` = `product.md` exists and is non-empty.
- Step-4-done = `product_set || message_customized` (back-compat for users who already
  customized `message.toml`).

## Files touched

- **new** `src/web/interview.rs` — interview turn handler.
- `src/web/mod.rs` — one route (`/api/onboarding/interview`).
- `src/web/api.rs` — extend `PitchReq`; add `InterviewReq`; add `product_set` to `StatusDto`.
- `src/web/onboarding.rs` — `set_pitch` writes `product.md` + `message.toml`; `build_brief`
  folds `pain_value`; `status()` sets `product_set`.
- `src/provider/openai.rs` — `system_prompt` prefers `product.md`.
- `templates/CLAUDE.md`, `templates/AGENTS.md` — step 3 points at `product.md`.
- `ui/index.html`, `ui/app.js` — step 4 chat + review form + manual fallback.

**No changes** to `message.rs`, `draft.rs`, or the `message.toml` schema.

## Guardrails preserved

- No fabrication: `build_brief` uses only the user's words; the review gate lets the user fix any
  paraphrase before it ships; the interview preamble forbids invented claims.
- Draft-only: interview turns have tools disabled and never touch Gmail.
- Backend-agnostic: stateless transcript-carrying interview works on every backend.

## Testing

- Unit: `build_brief` still parses with the new fields; `product.md` renderer produces non-empty
  output and contains the CTA link; `product_set` detection.
- Manual (live): run the interview on the Claude backend end-to-end in the browser; confirm the
  brief block is emitted, the review form pre-fills, Build writes both files, and a subsequent
  draft reads `product.md`.
