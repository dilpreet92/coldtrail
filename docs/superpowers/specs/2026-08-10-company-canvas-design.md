# Company canvas — design

**Date:** 2026-08-10
**Status:** built v0.8.0, then simplified in v0.8.1 — see amendment below.

## Amendment (v0.8.1): drop the chat, keep the editable profile

The chat pane added ceremony without enough payoff; the editable profile alone is sufficient.
The Company tab is now **just the editable markdown doc** (`product.md`), full-width, auto-saved
as you type, with a starter skeleton (section headings) shown when empty (guidance only — it
saves once you actually edit). Removed: the `company-doc` turn contract, `POST /api/company/turn`,
`company::turn`/`build_prompt`/`PREAMBLE`, `api::CompanyTurnReq`, and all chat JS
(`ccTurn`/`ccSplit`/`ccBubble`). Kept: `GET/POST /api/company`, `product.md` as source of truth,
`product_set` gating. The rest of the original design below stands (minus the chat turn).

## Idea

Replace Setup step 4's interview→review-form flow with a **canvas**: a dedicated **Company**
tab, chat on the left, a live company/product profile on the right that the agent edits as you
talk. The doc is the durable artifact; you can also hand-edit it.

## Decisions (locked)

1. **Format:** Markdown prose, stored as `product.md` (unchanged file — already the agent's
   drafting source of truth). Tab labelled "Company".
2. **Right pane:** editable + auto-save. Each turn the agent rewrites the whole doc from the
   current doc + your latest message; hand-edits are honoured (they're what the agent sees next
   turn).
3. **Migration:** the Company tab replaces the interview + review form. `set_pitch` /
   `build_brief` / `build_product_md` / `PitchReq` and `src/web/interview.rs` are removed.
4. **Chat transcript:** ephemeral (client-side). The doc is the saved memory; the agent works
   from the current doc each turn, so an empty chat on return is fine.

## Architecture

### Turn contract (`src/web/company.rs`, replaces `interview.rs`)

- `POST /api/company/turn { doc: String, message: String }` → `{ run }`, streamed over the
  existing `/api/chat/stream`. Stateless, ephemeral session, tools disabled (never touches
  Gmail/DB) — same guardrails as the interview it replaces.
- Server prompt = a fixed **canvas preamble** + the current doc + the latest message. On the
  first turn (`message` empty, `doc` empty) the agent greets and asks the first question.
- The agent returns: a 1–2 sentence chat reply, then the ENTIRE updated doc inside a fenced
  ` ```company-doc ` block and nothing after. Rules: only facts the founder gave (no invented
  claims); preserve existing content unless corrected; keep `utm_content={slug}` on the CTA
  link; well-structured markdown.
- `build_prompt(doc, message) -> String` is pure and unit-tested.

### Doc load/save

- `GET /api/company` → `{ doc: <product.md or ""> }`.
- `POST /api/company { doc }` → writes `product.md` (used by both auto-save after a turn and
  debounced auto-save on hand-edit). Trims; empty is allowed (clears).

### Frontend (`ui/app.js`, `ui/index.html`, `ui/app.css`)

- New nav item **Company** → a two-pane view: `#company-chat` + `#company-composer` (left),
  `#company-doc` editable `<textarea>` (right). Responsive: panes stack on narrow widths.
- Reusable `renderCompany(root)` mounted by BOTH the Company view and the wizard step-4 panel.
- Turn flow: push user msg → `POST /api/company/turn {doc: currentDocValue, message}` → open
  SSE → accumulate text → chat bubble shows text minus any partial ` ```company-doc ` block →
  on `done`, replace the textarea with the block's content and `POST /api/company` to save.
- Hand-edit: `input` on the textarea → debounced (~800ms) `POST /api/company`.
- On mount: `GET /api/company` to load the current doc; if empty, auto-start the first turn
  (greeting) when a provider is connected.

### Status / wizard

- `product_set` already exists (`product.md` non-empty). Change `onboarded` and the checklist
  item from `message_customized` → `product_set`. Wizard step-4 `done(s)` = `s.product_set`.

## Removed

- `src/web/interview.rs` + its route; the `coldtrail-brief` extraction + review form in the UI;
  `onboarding::set_pitch`, `build_brief`, `build_product_md`, `ensure_slug` (if unused after),
  `api::PitchReq`; the `/api/onboarding/pitch` route. Their tests are replaced by canvas tests.

## Kept / caveats

- `product.md` wiring (CLAUDE.md step 3, `provider/openai.rs`) is unchanged.
- `message.toml` is **not** regenerated from the prose doc (can't cleanly derive structured
  TOML from free markdown). It remains as the setup default, consumed only by the legacy CLI
  batch `coldtrail draft` (`draft::run`) — unused by the browser app, where the agent drafts via
  `coldtrail draft <domain> --subject --body` from `product.md`. Noted as a known limitation;
  a future `message.toml`-from-`product.md` derivation is possible if the batch path matters.

## Testing

- Unit: `company::build_prompt` (empty → greeting instruction; non-empty → includes doc +
  message + the `company-doc` contract).
- Live (real Claude backend, temp home): first turn greets + emits a `company-doc` block; a
  second turn with a doc + a fact returns an updated doc containing that fact; `GET/POST
  /api/company` round-trips `product.md`; `product_set` flips.
