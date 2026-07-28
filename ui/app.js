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
  led("led-canonical", s.canonical_wired);
  led("led-gmail", s.gmail_wired ? true : "warn");

  // checklist
  const items = [
    ["Agent", !!s.provider],
    ["Canonical", s.canonical_wired],
    ["Gmail", s.gmail_wired],
    ["Pitch", s.message_customized],
  ];
  $("#checklist").innerHTML = items
    .map(([n, done]) => `<li class="${done ? "done" : ""}"><span class="tick">${done ? "✓" : ""}</span>${n}</li>`)
    .join("");

  // agents
  $("#agent-row").innerHTML = s.agents
    .map((a) => {
      const cur = a.kind === s.provider;
      const state = !a.present ? "not installed" : a.authed ? "ready" : "sign in needed";
      return `<button class="agent" data-kind="${a.kind}" aria-pressed="${cur}" ${a.present ? "" : "disabled"}>
        <div class="an">${esc(a.label)}</div><div class="as">${state}</div></button>`;
    })
    .join("");
  $$("#agent-row .agent").forEach((b) =>
    b.addEventListener("click", async () => {
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

$("#mcp-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    gmail_client_id: fd.get("gmail_client_id") || null,
    gmail_secret: fd.get("gmail_secret") || null,
    skip_gmail: fd.get("skip_gmail") === "on",
    callback_port: 8765,
  };
  msg("#mcp-msg", "wiring…", true);
  try {
    const r = await postJSON("/api/onboarding/mcp", body);
    msg("#mcp-msg", "wired: " + (r.wired || []).join(", "), true);
    await loadStatus();
  } catch (err) { msg("#mcp-msg", err.message, false); }
});
$("#save-message").addEventListener("click", async () => {
  try { await postJSON("/api/onboarding/message", { toml: $("#message-toml").value }); msg("#message-msg", "saved", true); await loadStatus(); }
  catch (e) { msg("#message-msg", e.message, false); }
});
$("#save-contacted").addEventListener("click", async () => {
  try { await postJSON("/api/onboarding/contacted", { toml: $("#contacted-toml").value }); msg("#contacted-msg", "saved", true); }
  catch (e) { msg("#contacted-msg", e.message, false); }
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

  let run;
  try { run = (await postJSON("/api/chat", { message: text })).run; }
  catch (e) { bubble("agent", "⚠ " + e.message); busy = false; $("#chat-send").disabled = false; return; }

  let agentBubble = null;
  let pendingTool = null;
  const es = new EventSource(`/api/chat/stream?run=${encodeURIComponent(run)}&t=${encodeURIComponent(token())}`);
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch (_) { return; }
    if (e.type === "text") {
      if (!agentBubble) { agentBubble = bubble("agent live", ""); }
      agentBubble.textContent += e.text;
      log.scrollTop = log.scrollHeight;
    } else if (e.type === "tool_start") {
      pendingTool = toolChip(e.name);
      agentBubble = null;
    } else if (e.type === "tool_end") {
      if (pendingTool) { pendingTool.classList.add("done"); if (!e.ok) pendingTool.classList.add("fail"); pendingTool = null; }
    } else if (e.type === "error") {
      bubble("agent", "⚠ " + e.message);
    } else if (e.type === "done") {
      if (agentBubble) agentBubble.classList.remove("live");
      es.close();
      busy = false; $("#chat-send").disabled = false;
      loaders.pipeline && document.getElementById("view-pipeline") && loaders.pipeline();
      loaders.drafts();
    }
  };
  es.onerror = () => {
    if (agentBubble) agentBubble.classList.remove("live");
    es.close(); busy = false; $("#chat-send").disabled = false;
  };
}

// --- boot -------------------------------------------------------------------
loadStatus();
show("onboarding");
