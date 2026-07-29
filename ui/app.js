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

// --- overview ---------------------------------------------------------------
loaders.overview = async () => {
  let d;
  try { d = await getJSON("/api/overview"); } catch (e) { return; }
  $("#ov-tiles").innerHTML = [
    ["Companies", d.companies],
    ["Verified contacts", d.contacts],
    ["Drafts", d.drafts],
    ["Sent", d.sent],
  ].map(([k, v]) => `<div class="tile"><div class="tv">${v}</div><div class="tk">${k}</div></div>`).join("");

  const bars = (rows, labelHtml) => {
    if (!rows.length) return `<div class="empty">Nothing yet.</div>`;
    const max = Math.max(1, ...rows.map((r) => r[1]));
    return rows
      .map(([label, n]) =>
        `<div class="ov-row"><span class="ov-label">${labelHtml(label)}</span>
         <span class="ov-bar"><i style="width:${Math.round((n / max) * 100)}%"></i></span>
         <span class="ov-n">${n}</span></div>`
      )
      .join("");
  };
  $("#ov-queries").innerHTML = bars(d.queries, (l) => esc(l));
  $("#ov-funnel").innerHTML = bars(d.funnel, (l) => `<span class="status s-${esc(l)}">${esc(l)}</span>`);
};

// --- drafts -----------------------------------------------------------------
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");
loaders.drafts = async () => {
  let rows;
  try { rows = await getJSON("/api/drafts"); } catch (e) { return; }
  const sent = rows.filter((r) => r.status === "sent").length;
  $("#warmup").textContent = `${sent} sent · pace new mailboxes to ~5/day`;
  const list = $("#drafts-list");
  if (!rows.length) { list.innerHTML = `<div class="empty">No drafts yet — ask the agent to draft outreach in Chat.</div>`; return; }
  list.innerHTML = rows
    .map((r) => {
      const draftable = r.status === "draft_pending" || r.status === "drafted"; // reviewable
      const head = `<div class="draft-head">
          <span class="to">${esc(r.to) || esc(r.domain)}</span>
          <span class="spacer"></span>
          <span class="status s-${esc(r.status)}">${esc(r.status)}</span>
          ${draftable ? `<button class="btn save">Save</button><button class="btn primary send">Send</button>` : ""}
        </div>`;
      const bodyBlock = draftable
        ? `<input class="draft-subj" value="${escAttr(r.subject || "")}" placeholder="subject" />
           <textarea class="draft-body-edit" rows="9" spellcheck="false">${esc(r.body || "")}</textarea>`
        : `<div class="draft-subj-ro">${esc(r.subject || "")}</div><div class="draft-body">${esc(r.body || "")}</div>`;
      return `<div class="draft" data-domain="${escAttr(r.domain)}">${head}${bodyBlock}</div>`;
    })
    .join("");

  const edits = (card) => ({
    subject: card.querySelector(".draft-subj")?.value,
    body: card.querySelector(".draft-body-edit")?.value,
  });

  $$("#drafts-list .save").forEach((b) =>
    b.addEventListener("click", async () => {
      const card = b.closest(".draft");
      b.disabled = true; b.textContent = "saving…";
      try {
        await postJSON(`/api/drafts/${encodeURIComponent(card.dataset.domain)}`, edits(card));
        b.textContent = "saved";
        setTimeout(() => { b.textContent = "Save"; b.disabled = false; }, 1200);
      } catch (e) { b.textContent = "Save"; b.disabled = false; alert(e.message); }
    })
  );
  $$("#drafts-list .send").forEach((b) =>
    b.addEventListener("click", async () => {
      const card = b.closest(".draft");
      const dom = card.dataset.domain;
      if (!confirm(`Send this email to ${dom}? coldtrail will send it via Gmail now.`)) return;
      b.disabled = true; b.textContent = "sending…";
      try {
        await postJSON(`/api/drafts/${encodeURIComponent(dom)}`, edits(card)); // persist edits first
        const r = await postJSON(`/api/drafts/${encodeURIComponent(dom)}/send`, {});
        if (r.ok) { await loaders.drafts(); }
        else { b.disabled = false; b.textContent = "Send"; alert(r.message || "send did not complete"); }
      } catch (e) { b.disabled = false; b.textContent = "Send"; alert(e.message); }
    })
  );
};

// --- follow-ups -------------------------------------------------------------
const FU_LABEL = { awaiting: "awaiting reply", due: "due for follow-up", replied: "replied", bounced: "bounced" };
const FU_CLASS = { awaiting: "emailed", due: "drafted", replied: "sent", bounced: "bounced" };
loaders.followups = async () => {
  let rows;
  try { rows = await getJSON("/api/followups"); } catch (e) { return; }
  const list = $("#followups-list");
  if (!rows.length) { list.innerHTML = `<div class="empty">No sent contacts yet — send a draft first.</div>`; return; }
  list.innerHTML = rows
    .map((r) => {
      const open = r.state === "due" || r.state === "awaiting";
      return `<div class="fu-row" data-domain="${escAttr(r.domain)}">
        <div class="fu-main"><span class="to">${esc(r.to) || esc(r.domain)}</span>
          <span class="fu-meta">${r.touches} sent · ${r.days}d ago</span></div>
        <span class="status s-${FU_CLASS[r.state] || "sourced"}">${FU_LABEL[r.state] || esc(r.state)}</span>
        <div class="fu-actions">
          ${r.state === "due" ? `<button class="btn primary fu-draft">Draft follow-up</button>` : ""}
          ${open ? `<button class="btn fu-mark" data-v="replied">Replied</button><button class="btn fu-mark" data-v="bounced">Bounced</button>` : ""}
        </div></div>`;
    })
    .join("");
  $$("#followups-list .fu-draft").forEach((b) =>
    b.addEventListener("click", async () => {
      const dom = b.closest(".fu-row").dataset.domain;
      b.disabled = true; b.textContent = "drafting…";
      try {
        const r = await postJSON(`/api/followups/${encodeURIComponent(dom)}/draft`, {});
        alert(r.message || "follow-up drafted");
        await loaders.followups();
      } catch (e) { b.disabled = false; b.textContent = "Draft follow-up"; alert(e.message); }
    })
  );
  $$("#followups-list .fu-mark").forEach((b) =>
    b.addEventListener("click", async () => {
      const dom = b.closest(".fu-row").dataset.domain;
      try { await postJSON(`/api/followups/${encodeURIComponent(dom)}/mark`, { value: b.dataset.v }); await loaders.followups(); }
      catch (e) { alert(e.message); }
    })
  );
};
$("#check-replies").addEventListener("click", async () => {
  const btn = $("#check-replies");
  msg("#fu-msg", "checking Gmail for replies…", true);
  btn.disabled = true;
  try {
    const r = await postJSON("/api/followups/check", {});
    msg("#fu-msg", r.message || "done", r.ok);
    await loaders.followups();
  } catch (e) { msg("#fu-msg", e.message, false); }
  finally { btn.disabled = false; }
});

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
