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

// --- theme (set ASAP to avoid a flash) --------------------------------------
(function initTheme() {
  let t = null;
  try { t = localStorage.getItem("ct-theme"); } catch (_) {}
  if (!t) t = (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
  document.documentElement.dataset.theme = t;
})();

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
  // Read the body once; error responses are plain text (not JSON), so parsing the same
  // string is what lets the real error surface instead of a generic "Internal Server Error".
  const raw = await r.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
  if (!r.ok) throw new Error(data.message || raw || r.statusText);
  return data;
}
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Non-blocking toast — replaces alert() so actions confirm without stealing focus.
function toast(text, kind) {
  let host = $("#toasts");
  if (!host) { host = document.createElement("div"); host.id = "toasts"; document.body.appendChild(host); }
  const t = document.createElement("div");
  t.className = "toast " + (kind || "");
  t.textContent = text;
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  const ttl = Math.min(8000, 3000 + text.length * 30); // longer messages linger longer
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, ttl);
}
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
  renderDestination(s);

  // enrichment (OSINT)
  renderOsint(s.osint || {});

  // wizard (first run) vs settings (once onboarded)
  renderSetup(s);

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
      catch (e) { toast(e.message, "err"); }
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

// --- setup: stepper wizard (first run) / flat settings (once onboarded) -----
const WIZARD_STEPS = [
  { step: "provider", label: "Provider", done: (s) => !!s.provider },
  { step: "discovery", label: "Discovery", done: (s) => s.discovery_connected },
  { step: "destination", label: "Destination", done: (s) => s.destination_connected },
  { step: "brief", label: "Brief", done: (s) => s.message_customized },
];
let wizardIdx = 0;
let wizardInit = false;

function renderSetup(s) {
  const wizard = !s.onboarded;
  const panels = $("#panels"), bar = $("#wizard-bar"), checklist = $("#checklist");
  $("#nav-setup-label").textContent = wizard ? "Setup" : "Settings";
  $("#setup-title").textContent = wizard ? "Get set up" : "Settings";
  $("#setup-sub").textContent = wizard
    ? "A few steps to get coldtrail running. coldtrail owns sourcing (Canonical) and drafting (Gmail); drafts are never auto-sent — you send by hand."
    : "Change your provider, connections, brief, and enrichment anytime. coldtrail owns Canonical + Gmail directly.";

  if (!wizard) {
    panels.classList.remove("wizard");
    bar.hidden = true;
    checklist.hidden = true;
    $$("#panels .panel").forEach((p) => p.classList.remove("wizard-active"));
    wizardInit = false; // so a later reset re-enters the wizard cleanly
    return;
  }

  checklist.hidden = true;
  panels.classList.add("wizard");
  bar.hidden = false;
  if (!wizardInit) {
    const firstIncomplete = WIZARD_STEPS.findIndex((w) => !w.done(s));
    wizardIdx = firstIncomplete === -1 ? 0 : firstIncomplete;
    wizardInit = true;
  }
  wizardIdx = Math.max(0, Math.min(WIZARD_STEPS.length - 1, wizardIdx));
  const cur = WIZARD_STEPS[wizardIdx];
  $$("#panels .panel").forEach((p) => p.classList.toggle("wizard-active", p.dataset.step === cur.step));

  const steps = WIZARD_STEPS
    .map((w, i) => {
      const cls = i === wizardIdx ? "active" : w.done(s) ? "done" : "";
      return `<span class="ws ${cls}"><span class="wn">${w.done(s) ? "✓" : i + 1}</span>${w.label}</span>`;
    })
    .join(`<span class="wsep"></span>`);
  const atLast = wizardIdx === WIZARD_STEPS.length - 1;
  bar.innerHTML = `<div class="wizard-steps">${steps}</div>
    <div class="wizard-actions">
      ${wizardIdx > 0 ? `<button class="btn" id="wiz-back">Back</button>` : ""}
      <button class="btn primary" id="wiz-next">${atLast ? "Finish" : "Next →"}</button>
    </div>`;
  const back = $("#wiz-back");
  if (back) back.addEventListener("click", () => { wizardIdx -= 1; renderSetup(s); });
  $("#wiz-next").addEventListener("click", () => {
    if (atLast) { wizardInit = false; loadStatus(); return; }
    wizardIdx += 1;
    renderSetup(s);
  });
}

// Destination (Gmail) — coldtrail's own client if configured, else the keyless gcloud path.
const GCLOUD_CMD = "gcloud auth application-default login --scopes=https://www.googleapis.com/auth/gmail.compose,https://www.googleapis.com/auth/cloud-platform";
function renderDestination(s) {
  const hint = $("#dest-hint"), gc = $("#dest-gcloud"), btn = $("#connect-gmail");
  if (!hint || !gc || !btn) return;
  if (s.gmail_client_configured) {
    hint.innerHTML = `Where outreach goes. <strong>Gmail</strong>, via <strong>coldtrail's own Google client</strong> — one browser consent, no keys to paste. coldtrail creates the draft in your Gmail; you review and hit Send (never auto-sends). You'll pass Google's "unverified app" screen (Advanced → continue).`;
    gc.innerHTML = "";
    btn.textContent = "Connect Gmail";
    return;
  }
  // keyless gcloud (ADC) path
  hint.innerHTML = `Where outreach goes. <strong>Gmail</strong>, keyless via <strong>gcloud</strong> — no client id/secret. coldtrail mints a token from your Application Default Credentials; you review each draft and hit Send (never auto-sends).`;
  gc.innerHTML = `<p class="hint" style="margin-bottom:6px">One-time, in your terminal:</p>
    <pre class="cmd">${esc(GCLOUD_CMD)}</pre>
    <p class="hint">${s.gcloud_available
      ? "✓ gcloud credentials detected — click <strong>Use gcloud</strong> to connect. Also set a quota project with the Gmail API enabled: <code>gcloud auth application-default set-quota-project &lt;PROJECT&gt;</code>."
      : "gcloud credentials not detected yet — run the command above (and install the Google Cloud SDK if needed), then click <strong>Use gcloud</strong>."}</p>`;
  btn.textContent = "Use gcloud";
}

// Enrichment (OSINT) setup panel: one row per tool — detected, one-click install, or why not.
function renderOsint(o) {
  const state = $("#osint-state");
  if (state) state.textContent = (o.the_harvester || o.spiderfoot) ? "· ready" : "";
  const body = $("#osint-body");
  if (!body) return;

  const row = (tool, label, installed, canInstall, why) => {
    if (installed) return `<div class="osint-tool"><span class="ok">✓ ${label}</span><span class="osint-note">installed</span></div>`;
    if (canInstall) return `<div class="osint-tool"><span>${label}</span><button class="btn mini primary osint-install" data-tool="${tool}" data-label="${label}">Install</button></div>`;
    return `<div class="osint-tool"><span class="muted">${label}</span><span class="osint-note">${why}</span></div>`;
  };

  body.innerHTML =
    row("the_harvester", "theHarvester", o.the_harvester, o.the_harvester_can_install, o.pipx ? "unavailable" : "needs pipx") +
    row("spiderfoot", "SpiderFoot", o.spiderfoot, o.spiderfoot_can_install, "needs git + Python 3.10–3.12") +
    `<span class="form-msg" id="osint-msg"></span>`;

  $$("#osint-body .osint-install").forEach((b) =>
    b.addEventListener("click", async () => {
      const label = b.dataset.label;
      b.disabled = true; b.textContent = "installing…";
      msg("#osint-msg", `installing ${label}… this can take a few minutes`, true);
      try {
        const r = await postJSON("/api/onboarding/osint/install", { tool: b.dataset.tool });
        toast(r.message || (r.ok ? "installed" : "install failed"), r.ok ? "ok" : "err");
        await loadStatus();
      } catch (e) { b.disabled = false; b.textContent = "Install"; msg("#osint-msg", e.message, false); }
    })
  );
}

$("#connect-canonical").addEventListener("click", async () => {
  msg("#disc-msg", "connecting… authorize in the browser tab if one opens", true);
  try {
    const r = await postJSON("/api/discovery/canonical/connect", {});
    if (r.ok === false) { msg("#disc-msg", r.message || "could not connect", false); return; }
    msg("#disc-msg", "connected", true);
    await loadStatus();
  } catch (e) { msg("#disc-msg", e.message, false); }
});
$("#connect-gmail").addEventListener("click", async () => {
  msg("#dest-msg", "connecting… authorize in the browser tab that opens", true);
  try {
    const r = await postJSON("/api/destination/gmail/connect", { callback_port: 8765 });
    if (r.ok === false) { msg("#dest-msg", r.message || "could not connect", false); return; }
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
// Friendly funnel labels — the raw statuses are confusing ('emailed' means "a verified
// contact was found", NOT "we emailed them"), so relabel everywhere they surface.
const STAGE_LABEL = {
  sourced: "sourced", named: "name only", emailed: "contact found",
  drafted: "in Gmail", sent: "sent", replied: "replied", bounced: "bounced", skip: "skipped",
};
const stageLabel = (s) => STAGE_LABEL[s] || s;

// Prefill the chat box with a next-step instruction and jump to Chat.
function askAgent(text) {
  const input = $("#chat-input");
  input.value = text;
  show("chat");
  input.focus();
  input.dispatchEvent(new Event("input")); // trigger auto-resize
}

let pipeFilter = "all";
let pipeQuery = "all";
loaders.pipeline = async () => {
  let rows;
  try { rows = await getJSON("/api/companies"); } catch (e) { return; }
  const statuses = [...new Set(rows.map((r) => r.status))];
  $("#pipe-filters").innerHTML =
    ["all", ...statuses]
      .map((s) => `<button class="chip" data-f="${esc(s)}" aria-pressed="${s === pipeFilter}">${s === "all" ? "all" : esc(stageLabel(s))}</button>`)
      .join("");
  $$("#pipe-filters .chip").forEach((c) =>
    c.addEventListener("click", () => { pipeFilter = c.dataset.f; loaders.pipeline(); })
  );

  // Query filter (which ICP search sourced the company) — only when there's ≥1 query.
  const queries = [...new Set(rows.map((r) => r.source_query).filter(Boolean))];
  const qrow = $("#pipe-query-row");
  if (queries.length && !queries.includes(pipeQuery) && pipeQuery !== "all") pipeQuery = "all";
  qrow.innerHTML = queries.length
    ? [`<span class="filter-label">sourced by</span>`, "all", ...queries]
        .map((q, i) => i === 0 ? q : `<button class="chip" data-q="${escAttr(q)}" aria-pressed="${q === pipeQuery}">${q === "all" ? "all queries" : esc(q)}</button>`)
        .join("")
    : "";
  $$("#pipe-query-row .chip").forEach((c) =>
    c.addEventListener("click", () => { pipeQuery = c.dataset.q; loaders.pipeline(); })
  );

  const contactLine = (r) => {
    if (r.email) return `<div class="sub-contact">${esc(r.founder ? r.founder + " · " : "")}${esc(r.email)}</div>`;
    if (r.status === "skip") return "";
    return `<div class="sub-contact none">no contact yet</div>`;
  };
  const actionsFor = (r) => {
    if (r.status === "skip") return `<button class="btn mini restore">Restore</button>`;
    if (r.status === "sourced" || r.status === "named") return `<button class="btn mini primary work" data-mode="enrich">Enrich</button><button class="btn mini skip">Skip</button>`;
    if (r.status === "emailed") return `<button class="btn mini primary work" data-mode="draft">Draft</button><button class="btn mini skip">Skip</button>`;
    if (r.status === "drafted") return `<button class="btn mini goto" data-nav="drafts">Drafts →</button>`;
    return `<button class="btn mini goto" data-nav="followups">Follow-ups →</button>`; // sent/replied/bounced
  };

  const tb = $("#companies-table tbody");
  const shown = rows.filter(
    (r) => (pipeFilter === "all" || r.status === pipeFilter) && (pipeQuery === "all" || r.source_query === pipeQuery)
  );
  const byDom = {};
  shown.forEach((r) => { byDom[r.domain] = r; });
  tb.innerHTML = shown.length
    ? shown
        .map((r) => `<tr data-domain="${escAttr(r.domain)}">
          <td><div class="co">${esc(r.name) || "<span class='dom'>—</span>"}</div>${contactLine(r)}</td>
          <td class="dom">${esc(r.domain)}</td>
          <td><span class="status s-${esc(r.status)}">${esc(stageLabel(r.status))}</span></td>
          <td class="src-q" title="${escAttr(r.source_query || "")}">${esc(r.source_query || "—")}</td>
          <td class="dom">${esc((r.first_seen || "").slice(0, 10))}</td>
          <td class="pipe-actions">${actionsFor(r)}</td></tr>`)
        .join("")
    : `<tr><td colspan="6"><div class="empty">No companies yet — start a run in Chat.</div></td></tr>`;

  const setStatus = async (dom, value, okMsg) => {
    try { await postJSON(`/api/companies/${encodeURIComponent(dom)}/status`, { value }); toast(okMsg, "ok"); loaders.pipeline(); }
    catch (e) { toast(e.message, "err"); }
  };
  $$("#companies-table .skip").forEach((b) => b.addEventListener("click", () => setStatus(b.closest("tr").dataset.domain, "skip", "Skipped — won't be contacted.")));
  $$("#companies-table .restore").forEach((b) => b.addEventListener("click", () => setStatus(b.closest("tr").dataset.domain, "restore", "Restored to the pipeline.")));
  $$("#companies-table .goto").forEach((b) => b.addEventListener("click", () => show(b.dataset.nav)));
  $$("#companies-table .work").forEach((b) =>
    b.addEventListener("click", () => {
      const r = byDom[b.closest("tr").dataset.domain];
      const label = r.name ? `${r.name} (${r.domain})` : r.domain;
      askAgent(b.dataset.mode === "draft"
        ? `Draft personalized outreach for ${label}.`
        : `Find a founder contact for ${label}, then draft personalized outreach.`);
    })
  );
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
  $("#ov-funnel").innerHTML = bars(d.funnel, (l) => `<span class="status s-${esc(l)}">${esc(stageLabel(l))}</span>`);
};

// --- drafts -----------------------------------------------------------------
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");
const DRAFT_LABEL = { draft_pending: "draft", drafted: "in Gmail" };
loaders.drafts = async () => {
  let rows, ov;
  try { [rows, ov] = await Promise.all([getJSON("/api/drafts"), getJSON("/api/overview").catch(() => ({ sent: 0 }))]); }
  catch (e) { return; }
  const sent = ov.sent || 0;
  $("#warmup").textContent = sent ? `${sent} sent · pace new mailboxes to ~5/day` : "pace new mailboxes to ~5/day";
  const list = $("#drafts-list");
  const bulkHost = $("#drafts-bulk");
  if (!rows.length) {
    if (bulkHost) bulkHost.innerHTML = "";
    list.innerHTML = sent
      ? `<div class="empty">All caught up — nothing waiting to draft. ${sent} sent; track replies in <strong>Follow-ups</strong>.</div>`
      : `<div class="empty">No drafts yet — ask the agent to draft outreach in Chat.</div>`;
    return;
  }
  list.innerHTML = rows
    .map((r) => {
      const draftable = r.status === "draft_pending"; // still editable, not yet in Gmail
      const inGmail = r.status === "drafted"; // pushed to Gmail, awaiting your send
      const head = `<div class="draft-head">
          <span class="to">${esc(r.to) || esc(r.domain)}</span>
          <span class="spacer"></span>
          <span class="status s-${esc(r.status)}">${esc(DRAFT_LABEL[r.status] || r.status)}</span>
          ${draftable ? `<button class="btn save">Save</button><button class="btn primary push">Create Gmail draft</button>` : ""}
          ${inGmail ? `<a class="btn" href="https://mail.google.com/mail/u/0/#drafts" target="_blank" rel="noreferrer">Open Gmail</a><button class="btn marksent">Mark sent</button>` : ""}
        </div>`;
      const gmailNote = inGmail
        ? `<div class="gmail-note">↳ In your Gmail Drafts — review &amp; send it there, then Mark sent.</div>`
        : "";
      const bodyBlock = draftable
        ? `<input class="draft-subj" value="${escAttr(r.subject || "")}" placeholder="subject" />
           <textarea class="draft-body-edit" rows="9" spellcheck="false">${esc(r.body || "")}</textarea>`
        : `<div class="draft-subj-ro">${esc(r.subject || "")}</div>${gmailNote}<div class="draft-body">${esc(r.body || "")}</div>`;
      return `<div class="draft" data-domain="${escAttr(r.domain)}">${head}${bodyBlock}</div>`;
    })
    .join("");

  const edits = (card) => ({
    subject: card.querySelector(".draft-subj")?.value,
    body: card.querySelector(".draft-body-edit")?.value,
  });

  // Bulk: create a Gmail draft for every pending draft, one at a time (each is an agent turn).
  const pending = rows.filter((r) => r.status === "draft_pending");
  const bulk = $("#drafts-bulk");
  if (bulk) {
    bulk.innerHTML = pending.length >= 2
      ? `<button class="btn primary" id="bulk-draft">Create all Gmail drafts (${pending.length})</button><span class="form-msg" id="bulk-msg"></span>`
      : "";
  }
  const bulkBtn = $("#bulk-draft");
  if (bulkBtn)
    bulkBtn.addEventListener("click", async () => {
      if (!confirm(`Create Gmail drafts for all ${pending.length} pending? Each is created as a draft — nothing is sent.`)) return;
      const msg = $("#bulk-msg");
      $$("#drafts-list .push, #drafts-list .save").forEach((b) => (b.disabled = true));
      bulkBtn.disabled = true;
      const cardByDom = {};
      $$("#drafts-list .draft").forEach((c) => { cardByDom[c.dataset.domain] = c; });
      const doms = pending.map((r) => r.domain);
      let ok = 0;
      const fails = [];
      for (let i = 0; i < doms.length; i++) {
        const dom = doms[i];
        if (msg) msg.textContent = `creating ${i + 1}/${doms.length}…`;
        try {
          const card = cardByDom[dom];
          if (card) await postJSON(`/api/drafts/${encodeURIComponent(dom)}`, edits(card)); // persist edits first
          const r = await postJSON(`/api/drafts/${encodeURIComponent(dom)}/send`, {}); // creates a Gmail draft
          if (r.ok) ok++; else fails.push(`${dom}: ${r.message || "failed"}`);
        } catch (e) { fails.push(`${dom}: ${e.message}`); }
      }
      let summary = `Created ${ok} Gmail draft${ok === 1 ? "" : "s"}.`;
      if (fails.length) summary += ` ${fails.length} failed — see below.`;
      toast(summary, fails.length ? "err" : "ok");
      if (fails.length) toast(`Not created:\n${fails.join("\n")}`, "err");
      await loaders.drafts();
    });

  $$("#drafts-list .save").forEach((b) =>
    b.addEventListener("click", async () => {
      const card = b.closest(".draft");
      b.disabled = true; b.textContent = "saving…";
      try {
        await postJSON(`/api/drafts/${encodeURIComponent(card.dataset.domain)}`, edits(card));
        b.textContent = "saved";
        setTimeout(() => { b.textContent = "Save"; b.disabled = false; }, 1200);
      } catch (e) { b.textContent = "Save"; b.disabled = false; toast(e.message, "err"); }
    })
  );
  $$("#drafts-list .push").forEach((b) =>
    b.addEventListener("click", async () => {
      const card = b.closest(".draft");
      const dom = card.dataset.domain;
      b.disabled = true; b.textContent = "creating…";
      try {
        await postJSON(`/api/drafts/${encodeURIComponent(dom)}`, edits(card)); // persist edits first
        const r = await postJSON(`/api/drafts/${encodeURIComponent(dom)}/send`, {}); // creates a Gmail draft
        if (r.ok) { toast(r.message || "Created in your Gmail Drafts.", "ok"); await loaders.drafts(); }
        else { b.disabled = false; b.textContent = "Create Gmail draft"; toast(r.message || "could not create the Gmail draft", "err"); }
      } catch (e) { b.disabled = false; b.textContent = "Create Gmail draft"; toast(e.message, "err"); }
    })
  );
  $$("#drafts-list .marksent").forEach((b) =>
    b.addEventListener("click", async () => {
      const dom = b.closest(".draft").dataset.domain;
      try { await postJSON(`/api/followups/${encodeURIComponent(dom)}/mark`, { value: "sent" }); toast(`Marked ${dom} as sent.`, "ok"); await loaders.drafts(); }
      catch (e) { toast(e.message, "err"); }
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
        toast(r.message || "Follow-up drafted — see the Drafts tab.", "ok");
        await loaders.followups();
      } catch (e) { b.disabled = false; b.textContent = "Draft follow-up"; toast(e.message, "err"); }
    })
  );
  $$("#followups-list .fu-mark").forEach((b) =>
    b.addEventListener("click", async () => {
      const dom = b.closest(".fu-row").dataset.domain;
      const v = b.dataset.v;
      try { await postJSON(`/api/followups/${encodeURIComponent(dom)}/mark`, { value: v }); toast(`Marked ${dom} as ${v}.`, "ok"); await loaders.followups(); }
      catch (e) { toast(e.message, "err"); }
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

// --- chat history -----------------------------------------------------------
loaders.chat = async () => { await loadChatList(); };

async function loadChatList() {
  let chats;
  try { chats = await getJSON("/api/chats"); } catch (_) { return; }
  const list = $("#chat-list");
  if (!chats.length) { list.innerHTML = `<div class="empty">No chats yet.</div>`; return; }
  list.innerHTML = chats
    .map((c) => `<button class="chat-item" data-id="${escAttr(c.id)}" aria-current="${c.active ? "true" : "false"}">
        <span class="ct">${esc(c.title) || "(untitled)"}</span>
        <span class="cm">${esc((c.updated_at || "").slice(0, 16).replace("T", " "))}</span>
      </button>`)
    .join("");
  $$("#chat-list .chat-item").forEach((b) => b.addEventListener("click", () => openChat(b.dataset.id)));
}

async function openChat(id) {
  try {
    const d = await getJSON(`/api/chats/${encodeURIComponent(id)}`);
    await postJSON(`/api/chats/${encodeURIComponent(id)}/activate`, {});
    log.innerHTML = "";
    d.messages.forEach((m) => {
      if (m.role === "user") bubble("user", m.content);
      else { const el = bubble("agent", ""); el.innerHTML = mdInline(m.content); }
    });
    await loadChatList();
  } catch (e) { toast(e.message, "err"); }
}

$("#chat-new").addEventListener("click", async () => {
  try {
    await postJSON("/api/chats/new", {});
    log.innerHTML = "";
    await loadChatList();
    $("#chat-input").focus();
  } catch (e) { toast(e.message, "err"); }
});

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
      loadChatList();
    }
  };
  es.onerror = () => done();
}

// --- theme toggle -----------------------------------------------------------
function setThemeIcon() {
  const t = document.documentElement.dataset.theme;
  const icon = $("#theme-icon"), label = $("#theme-label");
  if (icon) icon.textContent = t === "light" ? "☀" : "☾";
  if (label) label.textContent = t;
}
$("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("ct-theme", next); } catch (_) {}
  setThemeIcon();
});

// --- boot -------------------------------------------------------------------
setThemeIcon();
loadStatus();
show("onboarding");
