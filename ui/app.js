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
// A 401 means the loopback token didn't match — usually a browser tab left open from an older
// run. Give an actionable message instead of the raw "unauthorized".
const SESSION_EXPIRED = "This tab's session is stale — reopen coldtrail from the URL your terminal printed.";
async function getJSON(path) {
  const r = await fetch(path, { credentials: "same-origin" });
  if (r.status === 401) throw new Error(SESSION_EXPIRED);
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
  if (r.status === 401) throw new Error(SESSION_EXPIRED);
  // Read the body once; error responses are plain text (not JSON), so parsing the same
  // string is what lets the real error surface instead of a generic "Internal Server Error".
  const raw = await r.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
  if (!r.ok) throw new Error(data.message || raw || r.statusText);
  return data;
}
// PATCH/DELETE have no existing helper (only GET/POST did) — mirror the same 401 + error-body
// handling as postJSON so callers get the same "stale session" / real-error surfacing.
async function patchJSON(path, body) {
  const r = await fetch(path, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (r.status === 401) throw new Error(SESSION_EXPIRED);
  const raw = await r.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
  if (!r.ok) throw new Error(data.message || raw || r.statusText);
  return data;
}
async function deleteJSON(path) {
  const r = await fetch(path, { method: "DELETE", credentials: "same-origin" });
  if (r.status === 401) throw new Error(SESSION_EXPIRED);
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
  // The page scrolls, and views share it — so a switch should land at a sensible spot, not wherever
  // the last view was scrolled to. Pages start at the top; chat follows its latest message.
  if (view === "chat") scrollChatToBottom();
  else window.scrollTo(0, 0);
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
  liStatus = s;
  renderLinkedinCard();

  // wizard (first run) vs settings (once onboarded)
  renderSetup(s);

  // checklist
  const items = [
    ["Provider", !!s.provider],
    ["Discovery", s.discovery_connected],
    ["Destination", s.destination_connected],
    ["Company", s.product_set],
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

  // Sign-in / re-auth helper for the selected CLI provider. The auth check is a heuristic and
  // can be stale, and there was no in-app way to re-authenticate — so always show the login
  // command + a Re-check button (a stronger warning when it looks signed-out).
  const LOGIN = { claude: "claude   (sign in when it opens; or type /login)", codex: "codex login" };
  const sel = s.agents.find((a) => a.kind === s.provider);
  const authEl = $("#agent-auth");
  if (authEl && sel && sel.present && LOGIN[sel.kind]) {
    authEl.hidden = false;
    // Re-auth for a CLI provider happens in the *terminal* (coldtrail can't log you in).
    // "Test connection" runs a tiny real turn so you can confirm it actually works now.
    authEl.innerHTML =
      `<span class="hint">Sign-in for <strong>${esc(sel.label)}</strong> happens in your terminal — run <code>${esc(LOGIN[sel.kind])}</code> to (re)authenticate. Then confirm it here:</span>` +
      ` <button class="btn mini" id="agent-recheck">Test connection</button>` +
      ` <span class="form-msg" id="agent-probe-msg"></span>`;
    const rc = $("#agent-recheck");
    if (rc) rc.addEventListener("click", async () => {
      rc.disabled = true; rc.textContent = "testing…";
      msg("#agent-probe-msg", "running a quick check…", true);
      try {
        const r = await postJSON("/api/provider/probe", {});
        msg("#agent-probe-msg", (r.ok ? "✓ " : "⚠ ") + (r.message || ""), r.ok);
      } catch (e) { msg("#agent-probe-msg", e.message, false); }
      rc.disabled = false; rc.textContent = "Test connection";
    });
  } else if (authEl) {
    authEl.hidden = true;
  }

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
  { step: "brief", label: "Company", done: (s) => s.product_set },
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
    // Company has its own tab — no need to repeat the profile editor in flat Settings.
    $("#panel-message").style.display = "none";
    wizardInit = false; // so a later reset re-enters the wizard cleanly
    return;
  }

  $("#panel-message").style.display = ""; // shown in the first-run wizard
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
  if (cur.step === "brief") renderCompany($("#company-mount-wizard"));

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

// Destination (Gmail). Primary = keyless IMAP app password (no Google Cloud); advanced =
// bring-your-own OAuth client. Google gates gmail.compose behind a verified/own client, so
// there is no zero-input path — an app password is the least setup.
const AP_FORM = `
  <label>Gmail address <input id="ap-email" placeholder="you@gmail.com" autocomplete="off" /></label>
  <label>App password <input id="ap-pw" type="password" placeholder="paste the app password Google gave you" autocomplete="off" /></label>
  <div class="row"><button class="btn primary" id="ap-connect">Connect Gmail</button></div>
  <details class="advanced"><summary>How to get an app password (~2 min)</summary>
    <ol class="steps">
      <li>Turn on <a href="https://myaccount.google.com/security" target="_blank" rel="noreferrer">2-Step Verification</a> (required before you can create an app password).</li>
      <li>Open <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">App passwords</a>, type a name like "coldtrail", and click <strong>Create</strong>.</li>
      <li>Google pops up a <strong>16-character password in a yellow box</strong> — <strong>copy it from there</strong> and paste it into the App password field above. (The spaces don't matter.)</li>
      <li>Enable IMAP: Gmail → <strong>Settings</strong> → <strong>Forwarding and POP/IMAP</strong> → <strong>Enable IMAP</strong> → Save.</li>
    </ol>
  </details>`;
const BYO_DETAILS = `
  <details class="advanced"><summary>Prefer your own OAuth client instead?</summary>
    <ol class="steps">
      <li><a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud Console</a> → create/pick a project; enable the <strong>Gmail API</strong>.</li>
      <li>OAuth consent screen → <strong>External</strong>, <strong>Testing</strong>; add yourself as a <strong>Test user</strong>; add scope <code>.../auth/gmail.compose</code>.</li>
      <li>Credentials → <strong>OAuth client ID</strong> → <strong>Desktop app</strong>; copy id + secret.</li>
    </ol>
    <label>Client ID <input id="byo-id" placeholder="…apps.googleusercontent.com" autocomplete="off" /></label>
    <label>Client secret <input id="byo-secret" type="password" placeholder="GOCSPX-…" autocomplete="off" /></label>
    <div class="row"><button class="btn" id="byo-connect">Save &amp; Connect (OAuth)</button></div>
  </details>`;

function wireDestinationForms() {
  const ap = $("#ap-connect");
  if (ap) ap.addEventListener("click", async () => {
    const email = $("#ap-email").value.trim(), pw = $("#ap-pw").value.trim();
    if (!email || !pw) { msg("#dest-msg", "enter your Gmail address and app password", false); return; }
    msg("#dest-msg", "checking the app password…", true);
    try {
      const r = await postJSON("/api/destination/gmail/app-password", { email, app_password: pw });
      if (r.ok === false) { msg("#dest-msg", r.message || "could not connect", false); return; }
      msg("#dest-msg", "connected", true);
      await loadStatus();
    } catch (e) { msg("#dest-msg", e.message, false); }
  });
  const bc = $("#byo-connect");
  if (bc) bc.addEventListener("click", async () => {
    const id = $("#byo-id").value.trim(), secret = $("#byo-secret").value.trim();
    if (!id) { msg("#dest-msg", "paste your client id first", false); return; }
    msg("#dest-msg", "saving client…", true);
    try {
      await postJSON("/api/destination/gmail/client", { client_id: id, client_secret: secret });
      msg("#dest-msg", "opening Google consent in your browser…", true);
      const r = await postJSON("/api/destination/gmail/connect", { callback_port: 8765 });
      if (r.ok === false) { msg("#dest-msg", r.message || "could not connect", false); return; }
      msg("#dest-msg", "connected", true);
      await loadStatus();
    } catch (e) { msg("#dest-msg", e.message, false); }
  });
}

function renderDestination(s) {
  const hint = $("#dest-hint"), gc = $("#dest-gcloud"), btn = $("#connect-gmail");
  if (!hint || !gc || !btn) return;
  btn.style.display = "none"; // forms carry their own buttons
  if (s.destination_connected) {
    hint.innerHTML = s.auto_send
      ? `<strong>Gmail</strong> connected — <strong>auto-send is ON</strong>. Hitting Send on the Drafts screen sends the email immediately (capped at ${s.daily_send_cap}/day).`
      : `<strong>Gmail</strong> connected. coldtrail creates each draft in your Gmail; you review and hit Send (never auto-sends).`;
    gc.innerHTML = `<p class="hint">✓ connected.</p>${autoSendBlock(s)}<details class="advanced"><summary>Reconnect with different credentials</summary>${AP_FORM}${BYO_DETAILS}</details>`;
  } else {
    hint.innerHTML = `Where outreach goes. <strong>Gmail</strong> — coldtrail drafts, you review &amp; hit Send (never auto-sends). Easiest is a <strong>Gmail app password</strong>: keyless, no Google Cloud, ~2 min.`;
    gc.innerHTML = AP_FORM + BYO_DETAILS;
  }
  wireDestinationForms();
  wireAutoSend();
}

// Opt-in auto-send control (only meaningful once a destination is connected). Deliberately
// relaxes the draft-only default, so it's an explicit toggle with a plain-language warning.
function autoSendBlock(s) {
  return `<div class="autosend">
    <label class="switch"><input type="checkbox" id="as-toggle"${s.auto_send ? " checked" : ""} /> <span>Auto-send (skip the manual Gmail step)</span></label>
    <p class="hint">When on, <strong>Send</strong> on the Drafts screen sends the email for real instead of saving a draft. Turn this on only once you trust the drafts. There's no undo on a sent email — also lets scheduled runs send unattended.</p>
    <label class="cap-row">Daily send cap <input type="number" id="as-cap" min="1" max="500" value="${s.daily_send_cap}" /></label>
    <span class="form-msg" id="as-msg"></span>
  </div>`;
}

function wireAutoSend() {
  const t = $("#as-toggle");
  if (!t || t._wired) return;
  t._wired = true;
  const save = async () => {
    const enabled = t.checked;
    const cap = Math.max(1, parseInt($("#as-cap").value, 10) || 20);
    if (enabled && !confirm(`Turn ON auto-send? Hitting Send will email people for real (up to ${cap}/day). There's no undo.`)) { t.checked = false; return; }
    try { await postJSON("/api/destination/auto-send", { enabled, daily_cap: cap }); msg("#as-msg", enabled ? `auto-send on · ${cap}/day` : "auto-send off — back to draft-only", true); await loadStatus(); }
    catch (e) { msg("#as-msg", e.message, false); }
  };
  t.addEventListener("change", save);
  const cap = $("#as-cap");
  if (cap) cap.addEventListener("change", () => { if (t.checked) save(); });
}

// --- LinkedIn destination (Destination panel, second half) ------------------
// `waiting` is client-side (this tab just clicked Connect and is polling); the poll is guarded
// by `liPollSeq` — the same generation-token pattern as chat's `openSeq` — so a second Connect
// click can't leave two pollers both racing to render the card.
let liWaiting = false;
let liPollSeq = 0;
// The LinkedIn-relevant slice of the last-loaded /api/status, kept in sync by loadStatus().
// Connect/auto-send/disconnect patch this locally from their own response and re-render from
// it directly rather than round-tripping through a full /api/status reload — so the card updates
// the instant its own action resolves, without depending on any other endpoint being in sync.
let liStatus = {};

function linkedinAutoSendBlock(s) {
  return `<div class="autosend">
    <label class="switch"><input type="checkbox" id="li-as-toggle"${s.linkedin_auto_send ? " checked" : ""} /> <span>LinkedIn auto-send (coldtrail clicks Send on invites)</span></label>
    <p class="hint li-warn">coldtrail will click Send on invites — keep caps low; LinkedIn can restrict accounts.</p>
    <label class="cap-row">Weekly cap <input type="number" id="li-as-weekly" min="1" max="500" value="${s.linkedin_weekly_cap}" /></label>
    <label class="cap-row">Daily cap <input type="number" id="li-as-daily" min="1" max="500" value="${s.linkedin_daily_cap}" /></label>
    <span class="form-msg" id="li-as-msg"></span>
  </div>`;
}

function renderLinkedinCard() {
  const s = liStatus;
  const body = $("#li-body");
  const badge = $("#li-conn-badge");
  if (!body || !badge) return; // Destination panel not on screen (e.g. before first load)
  badge.classList.remove("li-warn-badge");
  if (liWaiting) {
    badge.textContent = "· connecting…";
    body.innerHTML = `<p class="hint">waiting for login… finish signing in in the Chrome window that opened — this updates automatically.</p>`;
    return;
  }
  if (s.linkedin_reconnect_needed) {
    badge.textContent = "· reconnect needed";
    badge.classList.add("li-warn-badge");
    body.innerHTML = `<p class="hint li-warn">⚠ LinkedIn session expired — reconnect to keep sending invites.</p>
      <div class="row"><button class="btn primary" id="li-connect">Reconnect LinkedIn</button><span class="form-msg" id="li-msg"></span></div>`;
  } else if (s.linkedin_connected) {
    badge.textContent = "· connected";
    body.innerHTML = `<p class="hint">✓ connected.</p>
      <div class="row"><button class="btn" id="li-disconnect">Disconnect</button><span class="form-msg" id="li-msg"></span></div>
      ${linkedinAutoSendBlock(s)}`;
  } else {
    badge.textContent = "";
    body.innerHTML = `<div class="row"><button class="btn primary" id="li-connect">Connect LinkedIn</button><span class="form-msg" id="li-msg"></span></div>`;
  }
  wireLinkedinCard();
}

function wireLinkedinCard() {
  const connectBtn = $("#li-connect");
  if (connectBtn) connectBtn.addEventListener("click", liConnect);
  const disconnectBtn = $("#li-disconnect");
  if (disconnectBtn) disconnectBtn.addEventListener("click", liDisconnect);
  const toggle = $("#li-as-toggle");
  if (toggle) {
    toggle.addEventListener("change", liSaveAutoSend);
    $$("#li-as-weekly, #li-as-daily").forEach((inp) => inp.addEventListener("change", liSaveAutoSend));
  }
}

async function liConnect() {
  const btn = $("#li-connect");
  if (btn) btn.disabled = true;
  msg("#li-msg", "connecting…", true);
  try {
    const r = await postJSON("/api/destination/linkedin/connect", {});
    if (r.status === "busy") {
      msg("#li-msg", "browser busy — try again in a moment", false);
      if (btn) btn.disabled = false;
      return;
    }
    liWaiting = true;
    renderLinkedinCard(); // "waiting for login…" — no network round trip needed for this state
    liPollStatus();
  } catch (e) {
    msg("#li-msg", e.message, false);
    if (btn) btn.disabled = false;
  }
}

function liPollStatus() {
  // Bump the generation token before starting: a superseded poller (from an earlier Connect
  // click) sees its captured value no longer match and stops instead of racing this one.
  const myGen = ++liPollSeq;
  const handle = setInterval(async () => {
    if (myGen !== liPollSeq) { clearInterval(handle); return; }
    let s;
    try { s = await getJSON("/api/destination/linkedin/status"); }
    catch (_) { return; } // transient hiccup — try again next tick
    if (myGen !== liPollSeq) { clearInterval(handle); return; }
    if (s.connected) {
      clearInterval(handle);
      liWaiting = false;
      liStatus = { ...liStatus, linkedin_connected: true, linkedin_reconnect_needed: !!s.reconnect_needed };
      renderLinkedinCard();
    }
  }, 2000);
}

async function liDisconnect() {
  if (!confirm("Disconnect LinkedIn? You'll need to log in again to send invites.")) return;
  try {
    await postJSON("/api/destination/linkedin/disconnect", {});
    liStatus = { ...liStatus, linkedin_connected: false, linkedin_reconnect_needed: false };
    renderLinkedinCard();
  } catch (e) { toast(e.message, "err"); }
}

async function liSaveAutoSend() {
  const enabled = $("#li-as-toggle").checked;
  const weekly = Math.max(1, parseInt($("#li-as-weekly").value, 10) || 1);
  const daily = Math.max(1, parseInt($("#li-as-daily").value, 10) || 1);
  if (enabled && !confirm(`Turn ON LinkedIn auto-send? coldtrail will click Send on invites (up to ${daily}/day, ${weekly}/week). LinkedIn can restrict accounts that send too many invites.`)) {
    $("#li-as-toggle").checked = false;
    return;
  }
  try {
    await postJSON("/api/destination/linkedin/auto-send", { enabled, weekly_cap: weekly, daily_cap: daily });
    liStatus = { ...liStatus, linkedin_auto_send: enabled, linkedin_weekly_cap: weekly, linkedin_daily_cap: daily };
    renderLinkedinCard();
    msg("#li-as-msg", enabled ? `auto-send on · ${daily}/day · ${weekly}/week` : "auto-send off", true);
  } catch (e) { msg("#li-as-msg", e.message, false); }
}

// --- cron (multi-schedule) ---------------------------------------------------
// #cron-list / #cron-runs are re-rendered via innerHTML on every loadCron(), so their action
// listeners are (re)wired after each render — same pattern as loaders.pipeline / loaders.drafts.
loaders.cron = loadCron;
let cronStatus = {}; // last /api/status snapshot — feeds the auto_send "Run now" guard
let cronSchedules = []; // last-loaded schedules — feeds Edit (populate the form) and Delete (name in the confirm)

async function loadCron() {
  let data, runs, status;
  try { [data, runs, status] = await Promise.all([
    getJSON("/api/schedules"), getJSON("/api/runs"), getJSON("/api/status").catch(()=>({})) ]); }
  catch (_) { return; }
  cronStatus = status || {};
  // The live API returns a plain array; tolerate a {schedules:[...]} wrapper too.
  cronSchedules = data.schedules || data || [];
  renderScheduleCards(cronSchedules, cronStatus);
  renderRunHistory(runs.runs || runs || []);
}

// next-run computed client-side from cadence
function nextRun(freq, time, weekday) {
  const [h, m] = (time||"09:00").split(":").map(Number);
  const now = new Date(); const d = new Date(now); d.setHours(h, m, 0, 0);
  if (freq === "weekly") {
    const target = (weekday==null?1:weekday); // 0=Sun..6=Sat
    let add = (target - d.getDay() + 7) % 7;
    if (add === 0 && d <= now) add = 7;
    d.setDate(d.getDate() + add);
  } else if (d <= now) { d.setDate(d.getDate() + 1); }
  return d;
}

const CRON_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function cadenceLabel(sc) {
  return sc.freq === "weekly"
    ? `Weekly · ${CRON_DAYS[sc.weekday == null ? 1 : sc.weekday]} ${sc.time}`
    : `Daily · ${sc.time}`;
}
function taskBadge(sc) {
  if (sc.task_mode === "custom") {
    const p = sc.prompt || "";
    return `Custom: "${esc(p.slice(0, 40))}${p.length > 40 ? "…" : ""}"`;
  }
  return "Agent decides";
}
function lastRunLine(lr) {
  if (!lr) return `<span class="cron-lastrun muted">No runs yet.</span>`;
  const view = lr.chat_id ? ` <a href="#" class="cron-view-run" data-chat="${escAttr(lr.chat_id)}">view</a>` : "";
  if (lr.status === "auth_failed") return `<span class="cron-lastrun warn">⚠ last run couldn't authenticate — sign in again</span>${view}`;
  return `<span class="cron-lastrun">last: ${esc((lr.started_at || "").replace("T", " ").slice(0, 16))} · ${esc(lr.status)} · sourced ${lr.sourced}, enriched ${lr.enriched}, drafted ${lr.drafted}, sent ${lr.sent}</span>${view}`;
}

function renderScheduleCards(schedules, status) {
  const host = $("#cron-list");
  if (!host) return;
  if (!schedules.length) {
    host.innerHTML = `<div class="empty">No schedules yet — add one to run coldtrail while you're away.</div>`;
    return;
  }
  host.innerHTML = schedules
    .map(
      (sc) => `<div class="cron-card" data-id="${escAttr(sc.id)}">
        <div class="cron-card-head">
          <label class="switch"><input type="checkbox" class="cron-enabled" ${sc.enabled ? "checked" : ""}> <strong>${esc(sc.name) || "(untitled)"}</strong></label>
          <span class="cron-badge">${esc(cadenceLabel(sc))}</span>
          <span class="cron-badge task">${taskBadge(sc)}</span>
        </div>
        <div class="cron-meta">
          <span class="cron-next">next: ${esc(nextRun(sc.freq, sc.time, sc.weekday).toLocaleString())}</span>
          ${lastRunLine(sc.last_run)}
        </div>
        <div class="cron-actions">
          <button class="btn mini cron-dry" type="button">Dry run</button>
          <button class="btn mini primary cron-run" type="button">Run now</button>
          <button class="btn mini cron-edit" type="button">Edit</button>
          <button class="btn mini cron-delete" type="button">Delete</button>
        </div>
      </div>`
    )
    .join("");

  $$("#cron-list .cron-enabled").forEach((cb) =>
    cb.addEventListener("change", async () => {
      const id = cb.closest(".cron-card").dataset.id;
      const enabled = cb.checked;
      try { await patchJSON(`/api/schedules/${encodeURIComponent(id)}`, { enabled }); toast(enabled ? "Schedule enabled." : "Schedule paused.", "ok"); }
      catch (e) { cb.checked = !enabled; toast(e.message, "err"); }
    })
  );
  $$("#cron-list .cron-view-run").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); openChat(a.dataset.chat); show("chat"); })
  );
  $$("#cron-list .cron-dry").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.closest(".cron-card").dataset.id;
      b.disabled = true; b.textContent = "running…";
      try {
        const res = await postJSON(`/api/schedules/${encodeURIComponent(id)}/run`, { draft_only: true });
        openChat(res.chat_id);
        show("chat");
      } catch (e) { toast(e.message, "err"); }
      finally { b.disabled = false; b.textContent = "Dry run"; setTimeout(loadCron, 1500); }
    })
  );
  $$("#cron-list .cron-run").forEach((b) =>
    b.addEventListener("click", async () => {
      if (status.auto_send) {
        const cap = status.daily_send_cap || 20;
        if (!confirm("Auto-send is ON — this may send up to " + cap + " real emails. Run live?")) return;
      }
      const id = b.closest(".cron-card").dataset.id;
      b.disabled = true; b.textContent = "running…";
      try {
        const res = await postJSON(`/api/schedules/${encodeURIComponent(id)}/run`, { draft_only: false });
        openChat(res.chat_id);
        show("chat");
      } catch (e) { toast(e.message, "err"); }
      finally { b.disabled = false; b.textContent = "Run now"; setTimeout(loadCron, 1500); }
    })
  );
  $$("#cron-list .cron-edit").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.closest(".cron-card").dataset.id;
      const sc = schedules.find((s) => s.id === id);
      if (sc) openCronForm(sc);
    })
  );
  $$("#cron-list .cron-delete").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.closest(".cron-card").dataset.id;
      const sc = schedules.find((s) => s.id === id);
      if (!confirm(`Delete schedule "${sc ? sc.name : id}"? This can't be undone.`)) return;
      try { await deleteJSON(`/api/schedules/${encodeURIComponent(id)}`); toast("Schedule deleted.", "ok"); await loadCron(); }
      catch (e) { toast(e.message, "err"); }
    })
  );
}

function renderRunHistory(runs) {
  const host = $("#cron-runs");
  if (!host) return;
  if (!runs.length) { host.innerHTML = `<div class="empty">No runs yet.</div>`; return; }
  host.innerHTML = runs
    .map((r) => {
      const view = r.chat_id ? `<a href="#" class="cron-view-run" data-chat="${escAttr(r.chat_id)}">view</a>` : "";
      const cls = r.status === "auth_failed" || r.status === "error" ? "bad" : r.status === "ok" ? "ok" : "warn";
      return `<div class="cron-run-row">
          <span class="cr-when">${esc((r.started_at || "").replace("T", " ").slice(0, 16))}</span>
          <span class="cr-name">${esc(r.schedule_name || "manual")}</span>
          <span class="cr-status ${cls}">${esc(r.status)}</span>
          <span class="cr-trigger">${esc(r.trigger || "")}</span>
          <span class="cr-counts">sourced ${r.sourced} · enriched ${r.enriched} · drafted ${r.drafted} · sent ${r.sent}</span>
          ${view}
        </div>`;
    })
    .join("");
  $$("#cron-runs .cron-view-run").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); openChat(a.dataset.chat); show("chat"); })
  );
}

// New/Edit form. `sc` is the schedule to edit, or null/undefined for a new one.
function openCronForm(sc) {
  const form = $("#cron-form");
  $("#cf-id").value = sc ? sc.id : "";
  $("#cf-name").value = sc ? sc.name : "";
  $("#cf-freq").value = sc ? sc.freq : "daily";
  $("#cf-time").value = sc ? sc.time : "09:00";
  $("#cf-weekday").value = sc && sc.weekday != null ? String(sc.weekday) : "1";
  $("#cf-weekday").hidden = $("#cf-freq").value !== "weekly";
  const mode = sc ? sc.task_mode : "agent";
  $$('input[name="cf-task-mode"]').forEach((r) => { r.checked = r.value === mode; });
  $("#cf-prompt").value = sc ? sc.prompt || "" : "";
  $("#cf-prompt").hidden = mode !== "custom";
  $("#cron-form-title").textContent = sc ? "Edit schedule" : "New schedule";
  msg("#cf-msg", "", true);
  form.hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}
$("#cron-new").addEventListener("click", () => openCronForm(null));
$("#cf-cancel").addEventListener("click", () => { $("#cron-form").hidden = true; });
$("#cf-freq").addEventListener("change", (e) => { $("#cf-weekday").hidden = e.target.value !== "weekly"; });
$$('input[name="cf-task-mode"]').forEach((r) =>
  r.addEventListener("change", (e) => { $("#cf-prompt").hidden = e.target.value !== "custom"; })
);
$("#cron-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#cf-id").value;
  const name = $("#cf-name").value.trim();
  const freq = $("#cf-freq").value;
  const time = $("#cf-time").value;
  const weekday = freq === "weekly" ? Number($("#cf-weekday").value) : null;
  const taskModeEl = $$('input[name="cf-task-mode"]').find((r) => r.checked);
  const task_mode = taskModeEl ? taskModeEl.value : "agent";
  const prompt = $("#cf-prompt").value.trim();
  if (!name) { msg("#cf-msg", "give it a name", false); return; }
  if (task_mode === "custom" && !prompt) { msg("#cf-msg", "a custom task needs an instruction", false); return; }
  const body = { name, freq, time, weekday, task_mode, prompt: task_mode === "custom" ? prompt : null };
  const btn = $("#cf-save");
  btn.disabled = true;
  try {
    if (id) await patchJSON(`/api/schedules/${encodeURIComponent(id)}`, body);
    else await postJSON("/api/schedules", { ...body, enabled: true });
    $("#cron-form").hidden = true;
    toast(id ? "Schedule updated." : "Schedule created.", "ok");
    await loadCron();
  } catch (err) { msg("#cf-msg", err.message, false); }
  btn.disabled = false;
});

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
// Build the outreach brief (message.toml) from the product form.
// --- Company profile (editable product.md) ----------------------------------
const COMPANY_DOC_HTML = `
  <div class="company-doc-only">
    <div class="cc-doc-head">Company profile <span class="cc-doc-status"></span></div>
    <textarea class="cc-doc" spellcheck="false" placeholder="Describe your company here (markdown). This is what the agent writes each cold email from."></textarea>
  </div>`;

// A starter template shown when the profile is empty — guidance only, not saved until edited.
const COMPANY_SKELETON = `# <Your company / product> — profile

## What we do / who we help
`+`

## The pain / value
`+`

## Proof / differentiator
`+`

## Offer
`+`

## Call to action
https://yourproduct.com/?utm_content={slug}

## Voice & sign-off
`;

async function ccSaveDoc(root, doc) {
  const status = root.querySelector(".cc-doc-status");
  try {
    await postJSON("/api/company", { doc });
    if (status) { status.textContent = "saved"; setTimeout(() => { if (status.textContent === "saved") status.textContent = ""; }, 1500); }
  } catch (e) { if (status) status.textContent = "save failed"; }
}

// Build the editor into `root` once; on later calls refresh the doc unless it's being edited.
async function renderCompany(root) {
  if (!root) return;
  if (root._ccInit) {
    const d = root.querySelector(".cc-doc");
    if (d && document.activeElement !== d) {
      try { const { doc } = await getJSON("/api/company"); d.value = doc && doc.trim() ? doc : COMPANY_SKELETON; } catch (_) {}
    }
    return;
  }
  root._ccInit = true;
  root.innerHTML = COMPANY_DOC_HTML;
  const docEl = root.querySelector(".cc-doc");
  let t;
  docEl.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => ccSaveDoc(root, docEl.value), 800); });
  try { const { doc } = await getJSON("/api/company"); docEl.value = doc || ""; } catch (_) {}
  if (!docEl.value.trim()) docEl.value = COMPANY_SKELETON; // guidance; saves once they edit
}
loaders.company = () => renderCompany($("#company-mount"));
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

  // Query filter (which ICP search sourced each company). A compact dropdown with per-query
  // counts so it scales as searches pile up (a chip row got unmanageable). Only shown when
  // there's ≥1 query.
  const counts = {};
  rows.forEach((r) => { if (r.source_query) counts[r.source_query] = (counts[r.source_query] || 0) + 1; });
  const queries = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const qrow = $("#pipe-query-row");
  if (queries.length && !queries.includes(pipeQuery) && pipeQuery !== "all") pipeQuery = "all";
  const clip = (q) => (q.length > 60 ? q.slice(0, 57) + "…" : q);
  qrow.innerHTML = queries.length
    ? `<label class="filter-label" for="pipe-query-select">sourced by</label>
       <select id="pipe-query-select" class="pipe-select">
         <option value="all"${pipeQuery === "all" ? " selected" : ""}>all queries (${rows.length})</option>
         ${queries.map((q) => `<option value="${escAttr(q)}"${q === pipeQuery ? " selected" : ""}>${esc(clip(q))} (${counts[q]})</option>`).join("")}
       </select>`
    : "";
  const qsel = $("#pipe-query-select");
  if (qsel) qsel.addEventListener("change", () => { pipeQuery = qsel.value; loaders.pipeline(); });

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
// Domains whose LinkedIn assist drive just staged an invite (Chrome left the modal open for the
// human to click Send) — ephemeral client-side state; it drives the "Did it send?" ✓/✗ prompt
// until the human resolves it via confirm. Not persisted: a reload just shows "Open in LinkedIn" again.
const liStagedDomains = new Set();
// Generation token for the LinkedIn auto-"Send" poll (see the .li-send wiring below) — the same
// supersede-guard pattern as chat's `openSeq`, so a second Send (or a tab switch) can't leave an
// orphaned interval polling the drafts list forever.
let liSendSeq = 0;

// One LinkedIn draft row: the note (300-char LinkedIn invite limit) + a live char count, an
// "Open in LinkedIn" assist button, and — once staged — the "Did it send?" ✓/✗ pair. Reuses the
// same `.draft-body-edit`/`.save` wiring as the email rows below (see `edits()`), since the
// backend's PATCH-style save endpoint is channel-agnostic. When LinkedIn auto-send is ON
// (`liAuto`), a "Send" button (drives Connect→note→Send itself, like the email "Send now") sits
// alongside the assist button; with auto-send off, only "Open in LinkedIn" (assist) shows.
function linkedinDraftRow(r, liAuto) {
  const staged = liStagedDomains.has(r.domain);
  const note = r.body || "";
  const len = note.length;
  const actions = staged
    ? `<span class="li-confirm"><span class="li-confirm-q">Did it send?</span><button class="btn mini primary li-yes">✓</button><button class="btn mini li-no">✗</button></span>`
    : `<button class="btn save">Save</button>${liAuto ? `<button class="btn primary li-send">Send</button>` : ""}<button class="btn${liAuto ? "" : " primary"} li-assist">Open in LinkedIn</button>`;
  const head = `<div class="draft-head">
      <span class="to">${esc(r.to) || esc(r.domain)}</span>
      <span class="status s-linkedin">LinkedIn</span>
      <span class="spacer"></span>
      <span class="status s-${esc(r.status)}">${esc(DRAFT_LABEL[r.status] || r.status)}</span>
      ${actions}
    </div>`;
  const bodyBlock = `<textarea class="draft-body-edit li-note" rows="6" spellcheck="false">${esc(note)}</textarea>
      <div class="li-charcount${len > 300 ? " over" : ""}">${len}/300</div>`;
  return `<div class="draft" data-domain="${escAttr(r.domain)}" data-channel="linkedin">${head}${bodyBlock}</div>`;
}

loaders.drafts = async () => {
  let rows, ov, st;
  try { [rows, ov, st] = await Promise.all([getJSON("/api/drafts"), getJSON("/api/overview").catch(() => ({ sent: 0 })), getJSON("/api/status").catch(() => ({}))]); }
  catch (e) { return; }
  const auto = !!st.auto_send;
  const cap = st.daily_send_cap || 20;
  const sent = ov.sent || 0;
  $("#warmup").textContent = auto
    ? `${sent} sent · auto-send ON · cap ${cap}/day`
    : (sent ? `${sent} sent · pace new mailboxes to ~5/day` : "pace new mailboxes to ~5/day");
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
      if (r.channel === "linkedin") return linkedinDraftRow(r, !!st.linkedin_auto_send);
      const draftable = r.status === "draft_pending"; // still editable, not yet in Gmail
      const inGmail = r.status === "drafted"; // pushed to Gmail, awaiting your send
      const head = `<div class="draft-head">
          <span class="to">${esc(r.to) || esc(r.domain)}</span>
          <span class="spacer"></span>
          <span class="status s-${esc(r.status)}">${esc(DRAFT_LABEL[r.status] || r.status)}</span>
          ${draftable ? `<button class="btn save">Save</button><button class="btn primary push">${auto ? "Send now" : "Create Gmail draft"}</button>` : ""}
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
  // LinkedIn drafts go through the assist/confirm flow (a real, human-visible browser window),
  // never the bulk "Create all Gmail drafts" button — so bulk only ever touches email drafts.
  const pending = rows.filter((r) => r.status === "draft_pending" && r.channel !== "linkedin");
  const bulk = $("#drafts-bulk");
  if (bulk) {
    bulk.innerHTML = pending.length >= 2
      ? `<button class="btn primary" id="bulk-draft">${auto ? `Send all (${pending.length})` : `Create all Gmail drafts (${pending.length})`}</button><span class="form-msg" id="bulk-msg"></span>`
      : "";
  }
  const bulkBtn = $("#bulk-draft");
  if (bulkBtn)
    bulkBtn.addEventListener("click", async () => {
      const confirmMsg = auto
        ? `Send all ${pending.length} pending emails FOR REAL now (cap ${cap}/day)? There's no undo.`
        : `Create Gmail drafts for all ${pending.length} pending? Each is created as a draft — nothing is sent.`;
      if (!confirm(confirmMsg)) return;
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
      let summary = auto
        ? `Sent ${ok} email${ok === 1 ? "" : "s"}.`
        : `Created ${ok} Gmail draft${ok === 1 ? "" : "s"}.`;
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
      const label = auto ? "Send now" : "Create Gmail draft";
      b.disabled = true; b.textContent = auto ? "sending…" : "creating…";
      try {
        await postJSON(`/api/drafts/${encodeURIComponent(dom)}`, edits(card)); // persist edits first
        const r = await postJSON(`/api/drafts/${encodeURIComponent(dom)}/send`, {}); // send or draft, per auto_send
        if (r.ok) { toast(r.message || (auto ? "Sent." : "Created in your Gmail Drafts."), "ok"); await loaders.drafts(); }
        else { b.disabled = false; b.textContent = label; toast(r.message || "could not complete", "err"); }
      } catch (e) { b.disabled = false; b.textContent = label; toast(e.message, "err"); }
    })
  );
  $$("#drafts-list .marksent").forEach((b) =>
    b.addEventListener("click", async () => {
      const dom = b.closest(".draft").dataset.domain;
      try { await postJSON(`/api/followups/${encodeURIComponent(dom)}/mark`, { value: "sent" }); toast(`Marked ${dom} as sent.`, "ok"); await loaders.drafts(); }
      catch (e) { toast(e.message, "err"); }
    })
  );

  // LinkedIn: live char count against the 300-char invite-note limit.
  $$("#drafts-list .li-note").forEach((ta) => {
    const counter = ta.closest(".draft").querySelector(".li-charcount");
    ta.addEventListener("input", () => {
      const len = ta.value.length;
      if (counter) { counter.textContent = `${len}/300`; counter.classList.toggle("over", len > 300); }
    });
  });
  // "Open in LinkedIn" — drives a real, human-visible Chrome window to Connect -> Add note ->
  // fill the note, then leaves the Send click to the human (see web/linkedin.rs::assist).
  $$("#drafts-list .li-assist").forEach((b) =>
    b.addEventListener("click", async () => {
      const card = b.closest(".draft");
      const dom = card.dataset.domain;
      b.disabled = true; b.textContent = "opening…";
      try {
        await postJSON(`/api/drafts/${encodeURIComponent(dom)}`, edits(card)); // persist the edited note first
        const r = await postJSON(`/api/drafts/${encodeURIComponent(dom)}/linkedin/assist`, {});
        if (r.staged) { liStagedDomains.add(dom); toast("Opened in LinkedIn — review and click Send there.", "ok"); await loaders.drafts(); }
        else { b.disabled = false; b.textContent = "Open in LinkedIn"; toast("could not open LinkedIn", "err"); }
      } catch (e) { b.disabled = false; b.textContent = "Open in LinkedIn"; toast(e.message, "err"); }
    })
  );
  // "Send" (auto) — only rendered when LinkedIn auto-send is ON. POSTs .../linkedin/send, which
  // spawns a detached `coldtrail send <domain>` that drives Connect→note→Send itself and marks the
  // row sent on success. The row leaves the drafts list once it's sent (drafts only lists
  // draft_pending/drafted), so we poll `/api/drafts` every ~2s and, when this domain's LinkedIn row
  // is gone, refetch to reflect it. After a generous timeout (pacing can add up to ~2 min before
  // Chrome even launches) we stop and leave a gentle nudge — the button stays disabled so a re-click
  // can't spawn a second send; the user can refresh to re-check.
  $$("#drafts-list .li-send").forEach((b) =>
    b.addEventListener("click", async () => {
      const card = b.closest(".draft");
      const dom = card.dataset.domain;
      b.disabled = true; b.textContent = "Sending on LinkedIn…";
      const gen = ++liSendSeq;
      try {
        await postJSON(`/api/drafts/${encodeURIComponent(dom)}`, edits(card)); // persist the edited note first
        const r = await postJSON(`/api/drafts/${encodeURIComponent(dom)}/linkedin/send`, {});
        if (!r.sending) { b.disabled = false; b.textContent = "Send"; toast("could not start the LinkedIn send", "err"); return; }
        toast("Sending on LinkedIn — driving the browser…", "ok");
        const started = Date.now();
        const TIMEOUT_MS = 240000; // 4 min: covers up to ~2 min inter-invite pacing + the drive
        const tick = async () => {
          if (gen !== liSendSeq) return; // superseded by a newer send or a tab switch
          let rows = null;
          try { rows = await getJSON("/api/drafts"); } catch (_) { /* transient — try again next tick */ }
          if (gen !== liSendSeq) return;
          const stillPending = rows && rows.some((x) => x.domain === dom && x.channel === "linkedin");
          if (rows && !stillPending) { // the LinkedIn row left the drafts list => marked sent
            toast("Invite sent on LinkedIn.", "ok");
            await loaders.drafts();
            return;
          }
          if (Date.now() - started > TIMEOUT_MS) {
            toast("Still working — watch the LinkedIn browser window, or check again in a moment.", "");
            return; // leave the button disabled so a re-click can't double-send
          }
          setTimeout(tick, 2000);
        };
        setTimeout(tick, 2000);
      } catch (e) { b.disabled = false; b.textContent = "Send"; toast(e.message, "err"); }
    })
  );
  $$("#drafts-list .li-yes").forEach((b) =>
    b.addEventListener("click", async () => {
      const dom = b.closest(".draft").dataset.domain;
      try {
        await postJSON(`/api/drafts/${encodeURIComponent(dom)}/linkedin/confirm`, { sent: true });
        liStagedDomains.delete(dom);
        toast("Marked sent.", "ok");
        await loaders.drafts();
      } catch (e) { toast(e.message, "err"); }
    })
  );
  $$("#drafts-list .li-no").forEach((b) =>
    b.addEventListener("click", async () => {
      const dom = b.closest(".draft").dataset.domain;
      try {
        await postJSON(`/api/drafts/${encodeURIComponent(dom)}/linkedin/confirm`, { sent: false });
        liStagedDomains.delete(dom);
        toast("Not sent — you can try again.", "ok");
        await loaders.drafts();
      } catch (e) { toast(e.message, "err"); }
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
// UI teardown for an in-flight chat stream (set while streaming; see sendChat). Switching
// chats calls this so a running turn's tool chips / dots don't bleed into the chat on screen.
let teardownStream = null;
// Live-poll handle for a scheduled run's chat opened via openChat() — cleared whenever the
// user switches chats or starts a new one, mirroring teardownStream's cancel-on-switch discipline.
let cronPoll = null;
// Generation counter for openChat(): each call captures the value at its start (`myGen`) and
// re-checks it after every await. A newer openChat() bumps this, so a superseded call (and its
// poll, which re-checks per tick) bails instead of racing to overwrite `cronPoll` with an
// orphaned interval that would poll the wrong chat forever.
let openSeq = 0;
// The page (window) is the scroll container — #chat-log has no height of its own — so follow
// new chat output by scrolling the window, not the log element (log.scrollTop was a no-op).
// Guarded to the chat view so a stray event can't yank another screen.
function scrollChatToBottom() {
  if (!$("#view-chat").classList.contains("active")) return;
  requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
}
function bubble(cls, text) {
  const d = document.createElement("div");
  d.className = "msg " + cls;
  d.textContent = text || "";
  log.appendChild(d);
  scrollChatToBottom();
  return d;
}
function toolChip(name, parent = log) {
  const d = document.createElement("div");
  d.className = "tool";
  d.innerHTML = `<span class="st"></span><span class="tn">${esc(name)}</span>`;
  parent.appendChild(d);
  scrollChatToBottom();
  return d;
}

// Consecutive tool calls in one "step" collapse into a single expandable row, so a burst of
// dozens of WebSearch/WebFetch/Bash calls stays one compact line you can scroll past (and expand
// on demand) instead of hundreds of stacked chips burying the conversation.
function newToolGroup() {
  const wrap = document.createElement("div");
  wrap.className = "tool-group running";
  wrap.innerHTML =
    `<button class="tool-group-head"><span class="tg-caret">▸</span><span class="tg-dot"></span>` +
    `<span class="tg-summary"></span></button><div class="tool-group-body"></div>`;
  wrap.querySelector(".tool-group-head").addEventListener("click", () => wrap.classList.toggle("open"));
  log.appendChild(wrap);
  scrollChatToBottom();
  return { wrap, body: wrap.querySelector(".tool-group-body"), summary: wrap.querySelector(".tg-summary"), counts: {}, total: 0 };
}
function toolGroupAdd(g, name) {
  g.total++;
  g.counts[name] = (g.counts[name] || 0) + 1;
  const chip = toolChip(name, g.body);
  renderToolSummary(g, true);
  return chip;
}
function renderToolSummary(g, running) {
  const label = g.total === 1 ? "1 tool call" : `${g.total} tool calls`;
  const parts = Object.entries(g.counts).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");
  g.summary.textContent = running ? `working… ${label}` : `${label} · ${parts}`;
  g.wrap.classList.toggle("running", !!running);
}
// Animated "working" indicator — kept at the bottom while the agent is busy between
// visible text, so a long tool call never looks frozen.
let workingEl = null;
function showWorking() {
  if (!workingEl) { workingEl = document.createElement("div"); workingEl.className = "working"; workingEl.innerHTML = "<i></i><i></i><i></i>"; }
  log.appendChild(workingEl); // moves it to the end
  scrollChatToBottom();
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

// Render a chat's persisted message list into #chat-log. Shared by the initial openChat render
// and each live-poll re-render, so both stay in lockstep with the same role handling.
// `running` (true while a scheduled run is still in flight) leaves the very last tool row
// pulsing instead of marked done, since the backend persists a tool row at start (not completion)
// and has no separate "finished" signal for it.
function renderMessages(list, running) {
  log.innerHTML = "";
  list.forEach((m, i) => {
    if (m.role === "user") bubble("user", m.content);
    else if (m.role === "tool") {
      const chip = toolChip(m.content);
      if (!(running && i === list.length - 1)) chip.classList.add("done");
    } else { const el = bubble("agent", ""); el.innerHTML = mdInline(m.content); }
  });
}

async function openChat(id) {
  // Captured synchronously before any await, so a later openChat() call (e.g. the user clicking
  // a different chat before this one's fetches resolve) can be detected below and this call can
  // bail instead of racing to render/poll the wrong chat.
  const myGen = ++openSeq;
  if (teardownStream) teardownStream(); // stop the previous chat's live stream leaking in here
  if (cronPoll) { clearInterval(cronPoll); cronPoll = null; } // cancel any prior run's live poll
  try {
    const d = await getJSON(`/api/chats/${encodeURIComponent(id)}`);
    if (myGen !== openSeq) return; // superseded while awaiting — a newer openChat() owns the screen now
    await postJSON(`/api/chats/${encodeURIComponent(id)}/activate`, {});
    if (myGen !== openSeq) return;
    renderMessages(d.messages, d.running);
    scrollChatToBottom();
    await loadChatList();
    if (d.running) {
      const handle = setInterval(async () => {
        if (myGen !== openSeq) { clearInterval(handle); return; } // this chat is no longer the one on screen
        try {
          const d2 = await getJSON(`/api/chats/${encodeURIComponent(id)}`);
          if (myGen !== openSeq) { clearInterval(handle); return; }
          renderMessages(d2.messages, d2.running);
          scrollChatToBottom();
          if (!d2.running) { clearInterval(handle); if (cronPoll === handle) cronPoll = null; }
        } catch (_) { clearInterval(handle); if (cronPoll === handle) cronPoll = null; }
      }, 2000);
      cronPoll = handle;
    }
  } catch (e) { toast(e.message, "err"); }
}

$("#chat-new").addEventListener("click", async () => {
  if (teardownStream) teardownStream(); // don't let a running turn stream into the fresh chat
  if (cronPoll) { clearInterval(cronPoll); cronPoll = null; } // don't let a scheduled run's poll paint into the fresh chat
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
  let toolGroup = null; // current collapsed run of tool calls (until text/end resumes)
  let currentChip = null; // the tool_start awaiting its tool_end
  // Only ever one live (blinking) bubble: clear it on every transition.
  const finishLive = () => { if (agentBubble) { agentBubble.classList.remove("live"); agentBubble = null; agentRaw = ""; } };
  // Freeze the current tool group into its collapsed summary and start a fresh one next burst.
  const closeToolGroup = () => { if (toolGroup) { renderToolSummary(toolGroup, false); toolGroup = null; currentChip = null; } };

  const es = new EventSource(`/api/chat/stream?run=${encodeURIComponent(run)}&t=${encodeURIComponent(token())}`);
  // Stop this stream's UI: on done/error, and when the user switches to another chat (the server
  // run keeps going in the background and persists its reply, so nothing is lost — we just stop
  // painting its chips/dots into whatever chat is now on screen).
  teardownStream = () => {
    teardownStream = null;
    finishLive(); closeToolGroup(); hideWorking();
    try { es.close(); } catch (_) {}
    busy = false; $("#chat-send").disabled = false;
  };
  es.onmessage = (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch (_) { return; }
    if (e.type === "text") {
      hideWorking(); closeToolGroup(); // the streaming cursor is the activity now
      if (!agentBubble) { agentBubble = bubble("agent live", ""); agentRaw = ""; }
      agentRaw += e.text;
      agentBubble.innerHTML = mdInline(agentRaw);
      scrollChatToBottom();
    } else if (e.type === "tool_start") {
      finishLive();
      hideWorking(); // the group's own running dot is the activity now
      if (!toolGroup) toolGroup = newToolGroup();
      currentChip = toolGroupAdd(toolGroup, e.name);
    } else if (e.type === "tool_end") {
      if (currentChip) { currentChip.classList.add("done"); if (!e.ok) currentChip.classList.add("fail"); currentChip = null; }
    } else if (e.type === "error") {
      finishLive(); closeToolGroup();
      bubble("agent", "⚠ " + e.message);
    } else if (e.type === "done") {
      if (teardownStream) teardownStream();
      loaders.pipeline();
      loaders.drafts();
      loadChatList();
    }
  };
  es.onerror = () => { if (teardownStream) teardownStream(); };
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
