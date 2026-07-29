"use strict";

// --- session token: from ?t= (first load) then cookie ----------------------
(function initToken() {
  const u = new URL(location.href);
  const t = u.searchParams.get("t");
  if (t) {
    document.cookie = "ct_token=" + t + ";path=/;samesite=strict";
    u.searchParams.delete("t");
    history.replaceState({}, "", u.pathname + u.search);
  }
})();
function token() {
  const m = document.cookie.match(/(?:^|;\s*)ct_token=([^;]+)/);
  return m ? m[1] : "";
}

// --- api --------------------------------------------------------------------
async function getJSON(path) {
  const r = await fetch(path, { credentials: "same-origin" });
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}
async function postJSON(path, body) {
  const r = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || (await r.text().catch(() => "")) || r.statusText);
  return data;
}
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
// Safe inline markdown: escape first, then add controlled tags for `code`, **bold**, *italic*.
const mdInline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

// --- navigation -------------------------------------------------------------
const loaders = {};
function show(view) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
  $$(".nav-item").forEach((n) => n.setAttribute("aria-current", n.dataset.nav === view));
  document.documentElement.dataset.view = view;
  if (loaders[view]) loaders[view]();
}
$$(".nav-item").forEach((n) => n.addEventListener("click", () => show(n.dataset.nav)));

// --- status / onboarding ----------------------------------------------------
async function loadStatus() {
  let s;
  try { s = await getJSON("/api/status"); } catch (e) { return; }

  const led = (id, on) => {
    const el = $("#" + id);
    el.className = "led " + (on === true ? "on" : on === false ? "off" : "warn");
  };
  $("#provider-label").textContent = s.provider || "—";
  led("led-provider", !!s.provider);
  led("led-canonical", s.discovery_connected);
  led("led-gmail", s.destination_connected ? true : "warn");
  const st = $("#disc-state");
  if (st) st.textContent = s.discovery_connected ? "· connected" : "";
  const dt = $("#dest-state");
  if (dt) dt.textContent = s.destination_connected ? "· connected" : "";
  // Destination is provider-aware: CLI uses the account connector (no keys); BYOK/Ollama connects keyless via coldtrail's Google client.
  const cliProvider = s.provider === "claude" || s.provider === "codex";
  const ga = $("#gmail-account"), gb = $("#gmail-byo");
  if (ga) ga.hidden = !cliProvider;
  if (gb) gb.hidden = cliProvider;

  // checklist
  const items = [
    ["Provider", !!s.provider],
    ["Discovery", s.discovery_connected],
    ["Destination", s.destination_connected],
    ["Pitch", s.message_customized],
  ];
  $("#checklist").innerHTML = items
    .map(([n, done]) => `<li class="${done ? "done" : ""}"><span class="tick">${done ? "✓" : ""}</span>${n}</li>`)
    .join("");

  // agents (claude/codex cards + a BYOK/Local card)
  let cards = s.agents
    .map((a) => {
      const cur = a.kind === s.provider;
      const state = !a.present ? "not installed" : a.authed ? "ready" : "sign in needed";
      return `<button class="agent" data-kind="${a.kind}" aria-pressed="${cur}" ${a.present ? "" : "disabled"}>
        <div class="an">${esc(a.label)}</div><div class="as">${state}</div></button>`;
    })
    .join("");
  cards += `<button class="agent" data-kind="openai" aria-pressed="${s.provider === "openai"}">
      <div class="an">BYOK / Local</div><div class="as">OpenAI-compatible · Ollama</div></button>`;
  $("#agent-row").innerHTML = cards;

  // prefill + reveal the BYOK form
  $("#byok-base").value = s.base_url || "";
  $("#byok-model").value = s.model || "";
  $("#byok-key").placeholder = s.key_set ? "•••••• (saved — leave blank to keep)" : "blank for local Ollama";
  $("#byok").hidden = s.provider !== "openai";

  $$("#agent-row .agent").forEach((b) =>
    b.addEventListener("click", async () => {
      if (b.dataset.kind === "openai") {
        $("#byok").hidden = false;
        $$("#agent-row .agent").forEach((x) => x.setAttribute("aria-pressed", x.dataset.kind === "openai"));
        return;
      }
      try { await postJSON("/api/onboarding/provider", { provider: b.dataset.kind }); await loadStatus(); }
      catch (e) { alert(e.message); }
    })
  );

  // prefill editors once
  if (!loadStatus._filled) {
    try {
      const f = await getJSON("/api/onboarding/files");
      $("#message-toml").value = f.message || "";
      $("#contacted-toml").value = f.contacted || "";
      loadStatus._filled = true;
    } catch (_) {}
  }
}

function msg(el, text, ok) {
  const m = $(el);
  m.textContent = text;
  m.className = "form-msg " + (ok ? "ok" : "err");
}

$("#connect-canonical").addEventListener("click", async () => {
  msg("#disc-msg", "connecting… authorize in the browser tab if one opens", true);
  try {
    await postJSON("/api/discovery/canonical/connect", {});
    msg("#disc-msg", "connected", true);
    await loadStatus();
  } catch (e) { msg("#disc-msg", e.message, false); }
});
$("#connect-gmail").addEventListener("click", async () => {
  msg("#dest-msg", "connecting… authorize in the browser tab that opens", true);
  try {
    await postJSON("/api/destination/gmail/connect", { callback_port: 8765 });
    msg("#dest-msg", "connected", true);
    await loadStatus();
  } catch (e) { msg("#dest-msg", e.message, false); }
});
$("#save-message").addEventListener("click", async () => {
  try { await postJSON("/api/onboarding/message", { toml: $("#message-toml").value }); msg("#message-msg", "saved", true); await loadStatus(); }
  catch (e) { msg("#message-msg", e.message, false); }
});
$("#save-contacted").addEventListener("click", async () => {
  try { await postJSON("/api/onboarding/contacted", { toml: $("#contacted-toml").value }); msg("#contacted-msg", "saved", true); }
  catch (e) { msg("#contacted-msg", e.message, false); }
});
$("#ollama-preset").addEventListener("click", () => {
  $("#byok-base").value = "http://localhost:11434/v1";
  if (!$("#byok-model").value) $("#byok-model").value = "llama3.1";
});
$("#save-byok").addEventListener("click", async () => {
  const body = {
    provider: "openai",
    base_url: $("#byok-base").value.trim(),
    model: $("#byok-model").value.trim(),
    api_key: $("#byok-key").value.trim() || null,
  };
  msg("#byok-msg", "saving…", true);
  try {
    await postJSON("/api/onboarding/provider", body);
    $("#byok-key").value = "";
    msg("#byok-msg", "saved", true);
    await loadStatus();
  } catch (e) { msg("#byok-msg", e.message, false); }
});

// --- pipeline ---------------------------------------------------------------
let pipeFilter = "all";
loaders.pipeline = async () => {
  let rows;
  try { rows = await getJSON("/api/companies"); } catch (e) { return; }
  const statuses = [...new Set(rows.map((r) => r.status))];
  $("#pipe-filters").innerHTML =
    [`all`, ...statuses]
      .map((s) => `<button class="chip" data-f="${s}" aria-pressed="${s === pipeFilter}">${s}</button>`)
      .join("");
  $$("#pipe-filters .chip").forEach((c) =>
    c.addEventListener("click", () => { pipeFilter = c.dataset.f; loaders.pipeline(); })
  );
  const tb = $("#companies-table tbody");
  const shown = rows.filter((r) => pipeFilter === "all" || r.status === pipeFilter);
  tb.innerHTML = shown.length
    ? shown
        .map(
          (r) => `<tr><td>${esc(r.name) || "<span class='dom'>—</span>"}</td>
        <td class="dom">${esc(r.domain)}</td>
        <td><span class="status s-${esc(r.status)}">${esc(r.status)}</span></td>
        <td class="dom">${esc((r.first_seen || "").slice(0, 10))}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="4"><div class="empty">No companies yet — start a run in Chat.</div></td></tr>`;
};

// --- drafts -----------------------------------------------------------------
loaders.drafts = async () => {
  let rows;
  try { rows = await getJSON("/api/drafts"); } catch (e) { return; }
  const sent = rows.filter((r) => r.status === "sent").length;
  $("#warmup").textContent = `${sent} sent · pace new mailboxes to ~5/day`;
  const list = $("#drafts-list");
  const pending = rows.filter((r) => r.status === "draft_pending" || r.status === "drafted");
  if (!rows.length) { list.innerHTML = `<div class="empty">No drafts yet — ask the agent to draft outreach in Chat.</div>`; return; }
  list.innerHTML = rows
    .map((r, i) => {
      const canSend = r.status === "draft_pending" || r.status === "drafted";
      return `<div class="draft" data-domain="${esc(r.domain)}">
        <div class="draft-head">
          <span class="to">${esc(r.to) || esc(r.domain)}</span>
          <span class="subj">${esc(r.subject) || "(no subject)"}</span>
          <span class="spacer"></span>
          <span class="status s-${esc(r.status)}">${esc(r.status)}</span>
          ${canSend ? `<button class="btn primary send" data-i="${i}">Send</button>` : ""}
        </div>
        <div class="draft-body">${esc(r.body) || ""}</div>
      </div>`;
    })
    .join("");
  $$("#drafts-list .send").forEach((b) =>
    b.addEventListener("click", async () => {
      const dom = b.closest(".draft").dataset.domain;
      if (!confirm(`Send the drafted email to ${dom}? This actually sends it.`)) return;
      b.disabled = true; b.textContent = "sending…";
      try {
        const r = await postJSON(`/api/drafts/${encodeURIComponent(dom)}/send`, {});
        if (r.ok) { await loaders.drafts(); }
        else { b.disabled = false; b.textContent = "Send"; alert(r.message || "send did not complete"); }
      } catch (e) { b.disabled = false; b.textContent = "Send"; alert(e.message); }
    })
  );
  void pending;
};

// --- chat -------------------------------------------------------------------
const log = $("#chat-log");
function bubble(cls, text) {
  const d = document.createElement("div");
  d.className = "msg " + cls;
  d.textContent = text || "";
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}
function toolChip(name) {
  const d = document.createElement("div");
  d.className = "tool";
  d.innerHTML = `<span class="st"></span><span class="tn">${esc(name)}</span>`;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}
// Animated "working" indicator — kept at the bottom while the agent is busy between
// visible text, so a long tool call never looks frozen.
let workingEl = null;
function showWorking() {
  if (!workingEl) { workingEl = document.createElement("div"); workingEl.className = "working"; workingEl.innerHTML = "<i></i><i></i><i></i>"; }
  log.appendChild(workingEl); // moves it to the end
  log.scrollTop = log.scrollHeight;
}
function hideWorking() { if (workingEl) workingEl.remove(); }

const input = $("#chat-input");
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; });
$("#chat-form").addEventListener("submit", (e) => { e.preventDefault(); sendChat(); });
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });

let busy = false;
async function sendChat() {
  const text = input.value.trim();
  if (!text || busy) return;
  busy = true; $("#chat-send").disabled = true;
  bubble("user", text);
  input.value = ""; input.style.height = "auto";
  showWorking();

  let run;
  try { run = (await postJSON("/api/chat", { message: text })).run; }
  catch (e) { hideWorking(); bubble("agent", "⚠ " + e.message); busy = false; $("#chat-send").disabled = false; return; }

  let agentBubble = null;
  let agentRaw = "";
  let pendingTool = null;
  // Only ever one live (blinking) bubble: clear it on every transition.
  const finishLive = () => { if (agentBubble) { agentBubble.classList.remove("live"); agentBubble = null; agentRaw = ""; } };
  const done = () => { finishLive(); hideWorking(); es.close(); busy = false; $("#chat-send").disabled = false; };

  const es = new EventSource(`/api/chat/stream?run=${encodeURIComponent(run)}&t=${encodeURIComponent(token())}`);
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch (_) { return; }
    if (e.type === "text") {
      hideWorking(); // the streaming cursor is the activity now
      if (!agentBubble) { agentBubble = bubble("agent live", ""); agentRaw = ""; }
      agentRaw += e.text;
      agentBubble.innerHTML = mdInline(agentRaw);
      log.scrollTop = log.scrollHeight;
    } else if (e.type === "tool_start") {
      finishLive();
      pendingTool = toolChip(e.name);
      showWorking(); // keep motion below the running tool
    } else if (e.type === "tool_end") {
      if (pendingTool) { pendingTool.classList.add("done"); if (!e.ok) pendingTool.classList.add("fail"); pendingTool = null; }
      showWorking(); // still thinking about the next step
    } else if (e.type === "error") {
      finishLive();
      bubble("agent", "⚠ " + e.message);
    } else if (e.type === "done") {
      done();
      loaders.pipeline();
      loaders.drafts();
    }
  };
  es.onerror = () => done();
}

// --- boot -------------------------------------------------------------------
loadStatus();
show("onboarding");
