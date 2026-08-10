# Interactive "Your product" Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Setup step 4's static product form with an agent-led interview that captures rich product context, stored as `product.md` (the agent's source of truth) plus a `message.toml` fallback.

**Architecture:** A stateless, transcript-carrying interview: the frontend holds the running conversation and re-sends it each turn; the server prepends a fixed preamble and runs one ephemeral agent turn (no session/persistence), streamed over the existing `/api/chat/stream`. The agent ends with a fenced `coldtrail-brief` JSON block; the frontend pre-fills an editable review form; "Build my brief" writes `product.md` + `message.toml`.

**Tech Stack:** Rust (axum 0.7, tokio, serde/serde_json, toml), embedded SPA (vanilla JS in `ui/`).

## Global Constraints

- Rust 2021, single binary; keep OpenSSL-free (rustls only).
- No fabrication: `build_brief` uses only the user's words; the review gate lets the user edit before saving.
- Draft-only: interview turns disable Bash + MCP tools and never touch Gmail.
- Backend-agnostic: interview must behave identically on Claude / Codex / OpenAI / Ollama (⇒ stateless, transcript-carrying — the OpenAI backend's `run_turn` ignores `session_id`/`first_turn`).
- `message.toml` schema is unchanged; `src/message.rs` and `src/draft.rs` are not modified.
- `templates/AGENTS.md` is generated from `CLAUDE_MD` in `setup.rs` — edit only `templates/CLAUDE.md`.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Backend storage — rich fields, `product.md`, `product_set`

**Files:**
- Modify: `src/web/api.rs` (extend `PitchReq`; add `product_set` to `StatusDto`; add `InterviewReq`)
- Modify: `src/web/onboarding.rs` (`build_brief` folds new fields; add `build_product_md`; `set_pitch` writes both files; `status()` sets `product_set`)
- Test: inline `#[cfg(test)]` in `src/web/onboarding.rs`

**Interfaces:**
- Produces: `PitchReq { product, value, offer, pain_value, proof, voice, link, sender }` (all `String`; `offer`/`pain_value`/`proof`/`voice` are `#[serde(default)]`).
- Produces: `build_product_md(&PitchReq) -> String`.
- Produces: `StatusDto.product_set: bool`.
- Produces: `InterviewReq { transcript: Vec<TranscriptTurn> }`, `TranscriptTurn { role: String, text: String }` (consumed by Task 2).

- [ ] **Step 1: Extend `PitchReq` and add `InterviewReq` in `src/web/api.rs`**

Replace the existing `PitchReq` struct with:

```rust
/// The product interview/form → coldtrail assembles the outreach brief from these.
#[derive(Deserialize)]
pub struct PitchReq {
    pub product: String,
    /// What it does + who it helps.
    pub value: String,
    #[serde(default)]
    pub pain_value: String,
    #[serde(default)]
    pub proof: String,
    #[serde(default)]
    pub offer: String,
    #[serde(default)]
    pub voice: String,
    pub link: String,
    pub sender: String,
}

/// One turn of the product interview, held by the browser and re-sent each turn.
#[derive(Deserialize)]
pub struct TranscriptTurn {
    pub role: String,
    pub text: String,
}

/// The running product-interview transcript (stateless — carries full context each turn).
#[derive(Deserialize)]
pub struct InterviewReq {
    #[serde(default)]
    pub transcript: Vec<TranscriptTurn>,
}
```

Add `product_set` to `StatusDto` (after `message_customized`):

```rust
    pub message_customized: bool,
    /// The user has captured a product brief (product.md exists and is non-empty).
    pub product_set: bool,
```

- [ ] **Step 2: Write failing tests in `src/web/onboarding.rs`**

Add to the `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn build_brief_folds_pain_value() {
        let req = super::super::api::PitchReq {
            product: "Canonical".into(),
            value: "Plain-English company search.".into(),
            pain_value: "Standard databases miss the long tail.".into(),
            proof: "Used by 100 outbound teams.".into(),
            offer: "free credits".into(),
            voice: "warm, direct".into(),
            link: "https://trycanonical.ai".into(),
            sender: "Dilpreet".into(),
        };
        let toml = build_brief(&req);
        let m: crate::message::Message = toml::from_str(&toml).expect("brief must parse");
        assert!(m.paragraphs.iter().any(|p| p.contains("long tail")));
    }

    #[test]
    fn product_md_has_link_and_context_note() {
        let req = super::super::api::PitchReq {
            product: "Canonical".into(),
            value: "Plain-English company search.".into(),
            pain_value: String::new(),
            proof: String::new(),
            offer: String::new(),
            voice: String::new(),
            link: "https://trycanonical.ai".into(),
            sender: "Dilpreet".into(),
        };
        let md = build_product_md(&req);
        assert!(md.contains("trycanonical.ai"), "keeps CTA link");
        assert!(md.to_lowercase().contains("never send"), "carries the compose-fresh instruction");
        assert!(md.contains("Canonical"));
    }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test --lib web::onboarding`
Expected: FAIL — `build_product_md` not defined; `build_brief_folds_pain_value` asserts on missing content.

- [ ] **Step 4: Implement in `src/web/onboarding.rs`**

In `build_brief`, insert the `pain_value` paragraph right after the `value` paragraph and before `offer`:

```rust
    let value = req.value.trim();
    if !value.is_empty() {
        paragraphs.push(value.to_string());
    }
    let pain = req.pain_value.trim();
    if !pain.is_empty() {
        paragraphs.push(pain.to_string());
    }
    let offer = req.offer.trim();
```

Add the `product.md` renderer (place near `build_brief`):

```rust
/// Render the rich product brief the agent composes from. Prose, not a template — every
/// email is written fresh per company from this context. Only the user's words; no invented
/// claims (the interview + review gate enforce that upstream).
fn build_product_md(req: &super::api::PitchReq) -> String {
    let line = |label: &str, val: &str| {
        let v = val.trim();
        if v.is_empty() {
            String::new()
        } else {
            format!("**{label}:** {v}\n\n")
        }
    };
    let product = if req.product.trim().is_empty() {
        "your product".to_string()
    } else {
        req.product.trim().to_string()
    };
    let mut s = format!("# {product} — outreach brief\n\n");
    s.push_str(&line("What it does / who it helps", &req.value));
    s.push_str(&line("The pain / value", &req.pain_value));
    s.push_str(&line("Proof / differentiator", &req.proof));
    s.push_str(&line("Offer", &req.offer));
    s.push_str(&line("Voice / tone", &req.voice));
    s.push_str(&line("Call to action", &ensure_slug(&req.link)));
    s.push_str(&line("From", &req.sender));
    s.push_str(
        "---\n\nUse this as context. Write each email fresh for the specific company — \
         reference what they actually do and why it's a fit, in the sender's voice. \
         **Never send this verbatim. Don't invent claims beyond what's here.**\n",
    );
    s
}
```

Update `set_pitch` to write both files:

```rust
pub async fn set_pitch(Json(req): Json<super::api::PitchReq>) -> Result<Json<MsgResp>, ApiErr> {
    let toml = build_brief(&req);
    toml::from_str::<crate::message::Message>(&toml)
        .map_err(|e| anyhow::anyhow!("generated brief didn't parse: {e}"))?;
    std::fs::write(crate::home::path("message.toml")?, &toml)?;
    std::fs::write(crate::home::path("product.md")?, build_product_md(&req))?;
    Ok(Json(MsgResp::ok()))
}
```

In `status()`, compute `product_set` and add it to the returned `StatusDto`:

```rust
    let product_set = crate::home::path("product.md")
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
```

Add `product_set,` to the `StatusDto { ... }` literal (right after `message_customized`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --lib web::onboarding`
Expected: PASS (including the existing `build_brief_parses_and_keeps_placeholders`).

- [ ] **Step 6: Commit**

```bash
git add src/web/api.rs src/web/onboarding.rs
git commit -m "feat(onboarding): rich product brief — product.md + extended fields

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Interview turn endpoint

**Files:**
- Create: `src/web/interview.rs`
- Modify: `src/web/mod.rs` (add `mod interview;` + route `/api/onboarding/interview`)
- Test: inline `#[cfg(test)]` in `src/web/interview.rs`

**Interfaces:**
- Consumes: `InterviewReq`, `TranscriptTurn` (Task 1); `AppState { runs, turn_lock }`; `provider::{resolve, run_turn, AgentEvent}`; `provider::cli::Tools`.
- Produces: `interview::start(State<Arc<AppState>>, Json<InterviewReq>) -> Json<ChatResp>` (reuses `ChatResp { run }`); `build_prompt(&[TranscriptTurn]) -> String` (pure, tested).

- [ ] **Step 1: Write the failing test in `src/web/interview.rs`**

Create `src/web/interview.rs` with the prompt builder + its test first:

```rust
//! The product interview: a stateless, transcript-carrying agent turn. The browser holds the
//! running conversation and re-sends it each turn; we prepend a fixed preamble and run one
//! ephemeral turn (no session, no history), streamed over the shared /api/chat/stream.
//! Tools are disabled — it's a pure conversation that never touches Gmail or the DB.

use axum::extract::State;
use axum::Json;
use std::sync::Arc;
use tokio::sync::mpsc;

use super::api::{ChatResp, InterviewReq, TranscriptTurn};
use super::{ApiErr, AppState};
use crate::provider::cli::Tools;
use crate::provider::{resolve, run_turn, AgentEvent};

const PREAMBLE: &str = "You are helping a founder describe their product so coldtrail can write \
cold outreach. Interview them warmly and briefly — ask ONE short question at a time. Capture \
only what they tell you; never invent claims. Cover: what the product is and who it helps, the \
concrete pain/value, any proof or differentiator, the offer (optional), the call-to-action link, \
their name/sign-off, and voice/tone. After enough (usually 4-6 exchanges), stop asking, write one \
short line like \"Here's what I've got — review and tweak below.\", then output EXACTLY one fenced \
block and nothing after it:\n\
```coldtrail-brief\n\
{\"product\":\"\",\"value\":\"\",\"pain_value\":\"\",\"proof\":\"\",\"offer\":\"\",\"voice\":\"\",\"link\":\"\",\"sender\":\"\"}\n\
```\n\
Fill each field from the conversation; use \"\" for anything not provided. `value` = what it does \
and who it helps. Do NOT run any commands or tools — this is a conversation only.";

/// Assemble the single-turn prompt: preamble + the running transcript. Pure, for testing.
fn build_prompt(transcript: &[TranscriptTurn]) -> String {
    let mut s = String::from(PREAMBLE);
    if transcript.is_empty() {
        s.push_str("\n\n--- The conversation has not started. Greet the founder in one line and ask your first question. ---");
        return s;
    }
    s.push_str("\n\n--- conversation so far ---\n");
    for t in transcript {
        let who = if t.role == "assistant" { "you" } else { "founder" };
        s.push_str(&format!("{who}: {}\n", t.text.trim()));
    }
    s.push_str("\nContinue: ask the next short question, or if you have enough, output the coldtrail-brief block now.");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_transcript_prompts_a_greeting() {
        let p = build_prompt(&[]);
        assert!(p.contains("coldtrail-brief"));
        assert!(p.contains("has not started"));
    }

    #[test]
    fn transcript_is_rendered_with_roles() {
        let t = vec![
            TranscriptTurn { role: "assistant".into(), text: "What do you sell?".into() },
            TranscriptTurn { role: "user".into(), text: "A company search tool.".into() },
        ];
        let p = build_prompt(&t);
        assert!(p.contains("you: What do you sell?"));
        assert!(p.contains("founder: A company search tool."));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail (module not wired)**

Run: `cargo test --lib web::interview`
Expected: FAIL to compile until `mod interview;` is added (do Step 3), then PASS for the two unit tests. (If compile blocks the test run, add the `mod` line first, then re-run.)

- [ ] **Step 3: Add the `start` handler in `src/web/interview.rs`**

Append below `build_prompt`:

```rust
/// How long an unclaimed run lingers before eviction (mirrors chat.rs).
const RUN_TTL: std::time::Duration = std::time::Duration::from_secs(45);

pub async fn start(
    State(state): State<Arc<AppState>>,
    Json(req): Json<InterviewReq>,
) -> Result<Json<ChatResp>, ApiErr> {
    let home = crate::home::workspace()?;
    let prompt = build_prompt(&req.transcript);

    let run_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<AgentEvent>(128);
    state.runs.lock().await.insert(run_id.clone(), rx);

    let st = state.clone();
    tokio::spawn(async move {
        let _turn = st.turn_lock.lock().await; // serialize with chat turns on one session
        let backend = resolve();
        // Fresh, ephemeral session every turn — no resume, no persistence. Tools off so the
        // agent can't run coldtrail commands / touch Gmail during the interview.
        let sid = uuid::Uuid::new_v4().to_string();
        let tools = Tools::Disallow(&["Bash", "mcp__gmail", "mcp__canonical"]);
        let _ = run_turn(&backend, &sid, true, &prompt, &home, &tools, tx).await;
    });

    // Reaper: evict if the browser never opens the stream (mirrors chat.rs).
    let st2 = state.clone();
    let rid = run_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(RUN_TTL).await;
        st2.runs.lock().await.remove(&rid);
    });

    Ok(Json(ChatResp { run: run_id }))
}
```

- [ ] **Step 4: Wire the module + route in `src/web/mod.rs`**

Add `mod interview;` alongside the other `mod` declarations, and add the route near the other `/api/onboarding/*` routes:

```rust
        .route("/api/onboarding/interview", post(interview::start))
```

- [ ] **Step 5: Run tests + build**

Run: `cargo test --lib web::interview && cargo build`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add src/web/interview.rs src/web/mod.rs
git commit -m "feat(onboarding): stateless product-interview turn endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire the agent to `product.md`

**Files:**
- Modify: `templates/CLAUDE.md` (step 3 + workspace-contents line)
- Modify: `src/provider/openai.rs` (`system_prompt` prefers `product.md`)
- Test: inline `#[cfg(test)]` in `src/provider/openai.rs`

**Interfaces:**
- Consumes: `product.md` written by Task 1's `set_pitch`.

- [ ] **Step 1: Write a failing test in `src/provider/openai.rs`**

Add to the `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn system_prompt_prefers_product_md() {
        crate::testutil::with_home("openai-brief-test", |tmp| {
            std::fs::write(tmp.join("message.toml"), "subject='x'").unwrap();
            std::fs::write(tmp.join("product.md"), "# Acme — outreach brief\nrich context").unwrap();
            let p = super::system_prompt(tmp);
            assert!(p.contains("rich context"), "uses product.md when present");
        });
    }
```

(Confirm the crate exposes `testutil::with_home`; it is used in `src/setup.rs` tests. If `system_prompt` is private, this same-module test can still call it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib provider::openai`
Expected: FAIL — `system_prompt` still reads `message.toml`, so "rich context" is absent.

- [ ] **Step 3: Update `system_prompt` in `src/provider/openai.rs`**

Replace the first line of `system_prompt`:

```rust
fn system_prompt(home: &Path) -> String {
    let brief = std::fs::read_to_string(home.join("product.md"))
        .or_else(|_| std::fs::read_to_string(home.join("message.toml")))
        .unwrap_or_default();
```

And change the closing label in the `format!` from `--- brief (message.toml) ---` to `--- product brief ---`.

- [ ] **Step 4: Update `templates/CLAUDE.md`**

In the intro line listing workspace contents, change:
`the user's outreach **brief** (\`message.toml\`)` → `the user's product **brief** (\`product.md\`)`.

Replace step 3 ("Compose a personalized pitch — per company") body so it reads `product.md`:

```
3. **Compose a personalized pitch — per company.** Read `product.md` as your **product brief**:
   it carries what the product is + who it helps, the pain/value, proof, the offer, the
   call-to-action link, the sender's voice, and any constraints. (`message.toml` is a
   structural fallback for the CLI batch path — you don't need it.) **Do not send anything
   verbatim.** For each company, write a genuinely tailored subject + body — reference what the
   company actually does and why it's a fit — in the user's voice, honest, short. Then store it:
   `coldtrail draft <domain> --subject "<subject>" --body "<body>"`
   This writes a DB row only. It does not create a Gmail draft and does not send.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --lib provider::openai`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add templates/CLAUDE.md src/provider/openai.rs
git commit -m "feat(agent): read product.md as the primary brief (message.toml = fallback)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Frontend — step 4 interview + review form + manual fallback

**Files:**
- Modify: `ui/index.html` (replace the step-4 panel body)
- Modify: `ui/app.js` (interview chat, brief-block detection, review form, wizard `product_set`)

**Interfaces:**
- Consumes: `POST /api/onboarding/interview` → `{run}` streamed via `GET /api/chat/stream?run=<id>`; `POST /api/onboarding/pitch` (extended fields); `status.product_set`.

- [ ] **Step 1: Replace the step-4 panel in `ui/index.html`**

Replace the contents of `<div class="panel" data-step="brief" id="panel-message">` (keep the wrapper + `data-step="brief"`) with:

```html
        <h2>4 · Your product</h2>
        <p class="hint" id="pi-hint">Tell coldtrail what you sell — it asks a few questions, then builds your brief from <em>your</em> words (it won't invent claims). The agent writes a fresh, personalized email per company from that brief; nothing is sent verbatim, and it stays local.</p>
        <div id="pi-chat" class="pi-chat" hidden></div>
        <div class="row" id="pi-composer" hidden>
          <input id="pi-input" placeholder="Type your answer…" autocomplete="off" />
          <button class="btn primary" id="pi-send">Send</button>
        </div>
        <div id="pi-review" hidden>
          <p class="hint">Here's what coldtrail captured — edit anything, then build your brief.</p>
          <label>Product name <input id="pi-product" autocomplete="off" /></label>
          <label>What it does &amp; who it helps <textarea id="pi-value" rows="3"></textarea></label>
          <label>The pain / value <span style="text-transform:none">(optional)</span> <textarea id="pi-pain" rows="2"></textarea></label>
          <label>Proof / differentiator <span style="text-transform:none">(optional)</span> <input id="pi-proof" autocomplete="off" /></label>
          <label>Your offer <span style="text-transform:none">(optional)</span> <input id="pi-offer" autocomplete="off" /></label>
          <label>Voice / tone <span style="text-transform:none">(optional)</span> <input id="pi-voice" autocomplete="off" /></label>
          <label>Call-to-action link <input id="pi-link" placeholder="https://yourproduct.com" autocomplete="off" /></label>
          <label>Your name <input id="pi-sender" autocomplete="off" /></label>
          <div class="row"><button class="btn primary" id="build-pitch">Build my brief</button><span class="form-msg" id="pitch-msg"></span></div>
        </div>
        <p class="hint" style="margin-top:10px"><a href="#" id="pi-manual">Prefer to fill it in yourself?</a></p>
        <details class="advanced">
          <summary>Advanced — edit the raw brief (message.toml)</summary>
          <textarea id="message-toml" spellcheck="false" rows="12"></textarea>
          <div class="row"><button class="btn" id="save-message">Save raw</button><span class="form-msg" id="message-msg"></span></div>
        </details>
```

- [ ] **Step 2: Add interview logic in `ui/app.js`**

Add these helpers (near the other Setup functions). `postJSON`, `$`, and `msg` already exist.

```js
// --- Product interview (Setup step 4) ---
let piTranscript = [];
let piStarted = false;

function piRenderChat() {
  const box = $("#pi-chat");
  box.hidden = false;
  $("#pi-composer").hidden = false;
  box.innerHTML = piTranscript
    .map((t) => `<div class="pi-turn ${t.role}">${escapeHtml(t.text)}</div>`)
    .join("");
  box.scrollTop = box.scrollHeight;
}

// Pull a ```coldtrail-brief {json}``` block out of assistant text. Returns {fields, clean}.
function piExtractBrief(text) {
  const m = text.match(/```coldtrail-brief\s*([\s\S]*?)```/);
  if (!m) return { fields: null, clean: text };
  let fields = null;
  try { fields = JSON.parse(m[1].trim()); } catch (_) { fields = null; }
  return { fields, clean: text.replace(m[0], "").trim() };
}

async function piRunTurn() {
  const box = $("#pi-chat");
  const holder = document.createElement("div");
  holder.className = "pi-turn assistant";
  holder.textContent = "…";
  box.appendChild(holder);
  const { run } = await postJSON("/api/onboarding/interview", { transcript: piTranscript });
  const es = new EventSource(`/api/chat/stream?run=${encodeURIComponent(run)}`);
  let acc = "";
  es.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch (_) { return; }
    if (ev.type === "text") { acc += ev.text; holder.textContent = piExtractBrief(acc).clean || "…"; box.scrollTop = box.scrollHeight; }
    if (ev.type === "done") {
      es.close();
      const { fields, clean } = piExtractBrief(acc);
      holder.textContent = clean || "…";
      piTranscript.push({ role: "assistant", text: clean });
      if (fields) piShowReview(fields);
    }
  };
  es.onerror = () => { es.close(); if (holder.textContent === "…") holder.textContent = "(the agent didn't respond — check your provider in step 1)"; };
}

function piShowReview(f) {
  $("#pi-product").value = f.product || "";
  $("#pi-value").value = f.value || "";
  $("#pi-pain").value = f.pain_value || "";
  $("#pi-proof").value = f.proof || "";
  $("#pi-offer").value = f.offer || "";
  $("#pi-voice").value = f.voice || "";
  $("#pi-link").value = f.link || "";
  $("#pi-sender").value = f.sender || "";
  $("#pi-review").hidden = false;
  $("#pi-review").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function wireProductStep() {
  const send = $("#pi-send"), input = $("#pi-input");
  const doSend = async () => {
    const v = input.value.trim();
    if (!v) return;
    piTranscript.push({ role: "user", text: v });
    input.value = "";
    piRenderChat();
    await piRunTurn();
  };
  if (send && !send._wired) { send._wired = true; send.addEventListener("click", doSend); }
  if (input && !input._wired) { input._wired = true; input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSend(); }); }
  const manual = $("#pi-manual");
  if (manual && !manual._wired) { manual._wired = true; manual.addEventListener("click", (e) => { e.preventDefault(); $("#pi-review").hidden = false; $("#pi-chat").hidden = true; $("#pi-composer").hidden = true; }); }
}

// Kick the interview once, when step 4 becomes visible.
function maybeStartInterview() {
  if (piStarted) return;
  piStarted = true;
  piRenderChat();
  piRunTurn();
}
```

- [ ] **Step 3: Update `#build-pitch` handler to send the new fields**

Replace the existing `$("#build-pitch").addEventListener(...)` body's `body` object and validation with:

```js
$("#build-pitch").addEventListener("click", async () => {
  const body = {
    product: $("#pi-product").value.trim(),
    value: $("#pi-value").value.trim(),
    pain_value: $("#pi-pain").value.trim(),
    proof: $("#pi-proof").value.trim(),
    offer: $("#pi-offer").value.trim(),
    voice: $("#pi-voice").value.trim(),
    link: $("#pi-link").value.trim(),
    sender: $("#pi-sender").value.trim(),
  };
  if (!body.value) { msg("#pitch-msg", "tell coldtrail what your product does first", false); return; }
  msg("#pitch-msg", "building your brief…", true);
  try {
    await postJSON("/api/onboarding/pitch", body);
    await loadStatus();
    msg("#pitch-msg", "brief ready — the agent will personalize it per company", true);
  } catch (e) { msg("#pitch-msg", e.message, false); }
});
```

- [ ] **Step 4: Start the interview when step 4 shows, and wire the step**

In `renderSetup`, after the line that toggles `wizard-active` on panels (`$$("#panels .panel").forEach(... p.dataset.step === cur.step)`), add:

```js
  if (cur.step === "brief") { wireProductStep(); maybeStartInterview(); }
```

Also call `wireProductStep()` once for the non-wizard (Settings) path — add it near the top of `renderSetup` after `const wizard = ...` is known, guarded so Settings users can still interview:

```js
  // Settings (already onboarded): make the interview available too.
  if (s.onboarded) wireProductStep();
```

Ensure `WIZARD_STEPS` brief step's `done(s)` uses `product_set`. Find the brief entry in `WIZARD_STEPS` and set its `done` to:

```js
    done: (s) => s.product_set || s.message_customized,
```

- [ ] **Step 5: Add minimal styles in `ui/index.html` (or the embedded CSS)**

Add to the stylesheet:

```css
.pi-chat { display:flex; flex-direction:column; gap:8px; max-height:320px; overflow-y:auto; padding:8px 0; }
.pi-turn { padding:8px 12px; border-radius:10px; max-width:85%; white-space:pre-wrap; }
.pi-turn.assistant { align-self:flex-start; background:var(--panel-2,#1c2230); }
.pi-turn.user { align-self:flex-end; background:var(--accent,#3b82f6); color:#fff; }
#pi-composer { gap:8px; } #pi-input { flex:1; }
```

(Match existing CSS var names in the file; fall back to literals as shown.)

- [ ] **Step 6: Build the release binary and verify manually**

Run: `cargo build --release && codesign --force -s - target/release/coldtrail 2>/dev/null; cp target/release/coldtrail ~/.local/bin/coldtrail && codesign --force -s - ~/.local/bin/coldtrail`
Then launch, open the browser, go to Setup step 4, and confirm: the agent greets + asks a question; answering advances; a completion emits the review form pre-filled; "Build my brief" saves; `~/.coldtrail/product.md` exists and reads as a brief.

- [ ] **Step 7: Commit**

```bash
git add ui/index.html ui/app.js
git commit -m "feat(ui): step 4 is an agent interview → editable review → build brief

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Ship

**Files:**
- Modify: `Cargo.toml` (version bump)
- Modify: `~/.claude/.../memory/coldtrail-status.md` (status note)

- [ ] **Step 1: Full check**

Run: `cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test`
Expected: clean; all tests pass.

- [ ] **Step 2: Bump version**

Edit `Cargo.toml` `version = "0.5.9"` → `version = "0.6.0"` (a user-facing feature).

- [ ] **Step 3: Build + install (re-sign for macOS)**

```bash
cargo build --release
cp target/release/coldtrail ~/.local/bin/coldtrail
codesign --force -s - ~/.local/bin/coldtrail
coldtrail --version   # expect: coldtrail 0.6.0
```

- [ ] **Step 4: Commit, tag, push**

```bash
git add Cargo.toml Cargo.lock docs/superpowers/plans/
git commit -m "feat: interactive product onboarding (v0.6.0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git tag v0.6.0
git push origin main --tags
```

- [ ] **Step 5: Update memory** `coldtrail-status.md` with a v0.6.0 entry summarizing the interactive product step (interview → product.md context doc + message.toml fallback; agent reads product.md).

---

## Self-Review

**Spec coverage:** Interview loop (Task 2) ✓; completion→review→build (Task 4) ✓; product.md + message.toml storage (Task 1) ✓; agent wiring to product.md (Task 3) ✓; status/wizard `product_set` (Tasks 1, 4) ✓; no `message.rs`/`draft.rs` changes ✓; guardrails (tools off, review gate, no-fabrication) ✓.

**Placeholder scan:** none — every step has concrete code or exact commands.

**Type consistency:** `PitchReq` fields (`product,value,pain_value,proof,offer,voice,link,sender`) are identical across api.rs, tests, `build_product_md`, the pitch handler, and the frontend body. `InterviewReq { transcript: Vec<TranscriptTurn{role,text}> }` matches `build_prompt` and the frontend payload. `ChatResp { run }` reused for the interview. `build_prompt`/`build_product_md`/`system_prompt` names are consistent.
