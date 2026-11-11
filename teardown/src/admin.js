// The back office for Ned and Brian.
//
//   GET  /teardown/admin               dashboard: numbers, filters, every lead
//   GET  /teardown/admin/leads.csv     download (same filters as the page)
//   POST /teardown/admin/api/lead      { id, stage?, owner?, notes? }
//   POST /teardown/admin/api/delete    { id }
//   POST /teardown/admin/api/settings  { paused?, dailyLimit? }
//   GET  /teardown/admin/lead/<id>     one teardown in full: screenshot, the whole note, contacts, pipeline
//   POST /teardown/admin/api/delete-many  { ids }
//   POST /teardown/admin/api/test-run     { url }   a full teardown that skips the daily limit and is filed under Tests
//   GET  /teardown/admin/prompt        edit the auditor prompt, try it on a site, see past versions
//   POST /teardown/admin/api/prompt       { prompt }   ("" goes back to the built-in prompt)
//   POST /teardown/admin/api/prompt-test  { url, prompt }   runs a draft without saving anything
//
// Sign-in is HTTP Basic auth. Set the ADMIN_USERS secret to "ned:password,brian:password"
// so each person has their own login and changes are stamped with who made them.
// (ADMIN_PASSWORD alone still works: one shared password, any username.)

import {
  STAGES, listLeads, leadStats, updateLead, deleteLead, deleteLeads, getLead, insertLead, getSettings, saveSettings, parseList, toCsv,
  listEvents, logEvent,
  getActivePrompt, savePrompt, listPromptVersions, PROMPT_MAX,
} from "./leads.js";
import { AUDITOR_PROMPT, runFreeAudit } from "./audit.js";
import { TeardownError, normalizeUrl, safeFetchPage } from "./safe-fetch.js";
import { extractPage, extractContacts, hasTooLittleContent } from "./extract.js";
import { takeScreenshot, saveScreenshot } from "./shot.js";
import { parseAnalysis, scoreRow, scoreAndAlert } from "./followup.js";
import { buildAlert, sendAlert, parseRecipients } from "./notify.js";
import { scoreLabel } from "./analysis.js";

const PRIVATE_HEADERS = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" };
const STAGE_LABELS = {
  new: "New", contacted: "Contacted", replied: "Replied", won: "Won", not_a_fit: "Not a fit", do_not_contact: "Do not contact",
};
const SITE = "https://ihatemybrand.com";

function text(body, status, extra = {}) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...PRIVATE_HEADERS, ...extra } });
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...PRIVATE_HEADERS } });
}

// ---------- sign-in ----------

function adminUsers(env) {
  const users = [];
  for (const pair of String(env.ADMIN_USERS || "").split(",")) {
    const colon = pair.indexOf(":");
    if (colon < 1) continue;
    const name = pair.slice(0, colon).trim().toLowerCase();
    const password = pair.slice(colon + 1).trim();
    if (name && password) users.push({ name, password });
  }
  return users;
}

async function sameSecret(a, b) {
  // Compare hashes so the time taken says nothing about how close a guess was.
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const xs = new Uint8Array(x);
  const ys = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xs.length; i++) diff |= xs[i] ^ ys[i];
  return diff === 0;
}

/** Returns the signed-in person's name, or null. */
async function whoIs(request, env) {
  const header = request.headers.get("authorization") || "";
  if (!header.toLowerCase().startsWith("basic ")) return null;
  let decoded;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  const name = decoded.slice(0, colon).trim().toLowerCase();
  const password = decoded.slice(colon + 1);

  const users = adminUsers(env);
  if (users.length) {
    let match = null;
    for (const user of users) {
      const passwordOk = await sameSecret(password, user.password); // checked for every user, no early exit
      if (passwordOk && user.name === name) match = user.name;
    }
    return match;
  }
  if (env.ADMIN_PASSWORD && (await sameSecret(password, env.ADMIN_PASSWORD))) {
    return name.replace(/[^a-z0-9 ._-]/g, "").slice(0, 40) || "admin";
  }
  return null;
}

function ownerChoices(env) {
  const names = adminUsers(env).map((u) => u.name);
  return names.length ? names : ["ned", "brian"];
}

// ---------- rendering ----------

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cap = (name) => String(name || "").replace(/^./, (c) => c.toUpperCase());
const clip = (value, max) => {
  const s = String(value || "").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
};

function safeLink(url, label) {
  if (!/^https?:\/\//i.test(String(url || ""))) return esc(label ?? url);
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(label ?? url)}</a>`;
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "link";
  }
}

/** A ready-to-send email in the person's own mail app. Nothing is sent from here. */
export function outreachDraft(row, sender, analysis = parseAnalysis(row)) {
  const to = row.visitor_email || parseList(row.site_emails)[0] || "";
  if (!row.note_problem) return null;
  if (analysis?.outreachBody) {
    return { to, subject: analysis.outreachSubject || `The biggest problem with ${row.domain}`, body: analysis.outreachBody.replace(/\[Your name\]/gi, cap(sender)), ai: true };
  }
  const opener = row.visitor_email
    ? `You ran ${row.domain} through our free Brand Teardown. Here's the note again, in case it got lost:`
    : `Someone ran ${row.domain} through our free Brand Teardown at ihatemybrand.com. This is the biggest thing it flagged:`;
  const body = [
    "Hi,", "", opener, "", clip(row.note_problem, 240), "", clip(row.note_why, 420), "", "The fix: " + clip(row.note_fix, 520), "",
    `If you'd rather have us handle it, our flat prices are at ${SITE}. No calls, done in days.`, "",
    "Not interested? Reply and say so, and we won't email again.", "", cap(sender), "I Hate My Brand",
  ].join("\n");
  return { to, subject: `The biggest problem with ${row.domain}`, body, ai: false };
}

/** A ready-to-send email in the person's own mail app. Nothing is sent from here. */
export function outreachMailto(row, sender) {
  const draft = outreachDraft(row, sender);
  if (!draft || !draft.to || row.stage === "do_not_contact") return null;
  return `mailto:${encodeURIComponent(draft.to)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(clip(draft.body, 1400))}`;
}

function scoreBadge(row) {
  if (row.lead_score === null || row.lead_score === undefined) return "";
  const label = scoreLabel(row.lead_score);
  return `<span class="score ${label.toLowerCase()}" title="Lead score">${esc(row.lead_score)} ${label}</span>`;
}

function queryString(filters, changes = {}) {
  const merged = { ...filters, ...changes };
  const params = new URLSearchParams();
  if (merged.stage) params.set("stage", merged.stage);
  if (merged.q) params.set("q", merged.q);
  if (merged.reachable) params.set("reachable", "1");
  if (merged.tests) params.set("tests", "1");
  if (merged.due) params.set("due", "1");
  if (merged.sort) params.set("sort", merged.sort);
  const s = params.toString();
  return s ? "?" + s : "";
}

const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b1a33; color: #f4f5f7; font: 15px/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  main { max-width: 1320px; margin: 0 auto; padding: 24px 16px 80px; }
  h1 { font-size: 26px; margin: 0; }
  h2 { font-size: 13px; letter-spacing: .1em; text-transform: uppercase; color: #b4c3de; margin: 0 0 10px; }
  a { color: #e4ec66; }
  .muted { color: #b4c3de; font-size: 13px; }
  .top { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: center; justify-content: space-between; margin-bottom: 22px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 18px; }
  .stat { border: 1px solid #27385b; border-radius: 14px; padding: 14px 16px; }
  .stat b { display: block; font-size: 30px; line-height: 1.1; }
  .panel { border: 1px solid #27385b; border-radius: 14px; padding: 16px; margin-bottom: 18px; display: flex; flex-wrap: wrap; gap: 14px 32px; align-items: center; }
  .panel.paused { border-color: #e4ec66; }
  .panel label { display: flex; align-items: center; gap: 8px; }
  .tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .tab { text-decoration: none; color: #f4f5f7; border: 1px solid #27385b; border-radius: 999px; padding: 7px 14px; }
  .tab span { color: #b4c3de; margin-left: 4px; }
  .tab.on { background: #e4ec66; color: #0b1a33; border-color: #e4ec66; font-weight: 600; }
  .tab.on span { color: #0b1a33; }
  .tools { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; margin-bottom: 14px; }
  input[type="search"], input[type="number"], select, textarea {
    font: inherit; color: #f4f5f7; background: #0f2140; border: 1px solid #3a4c72; border-radius: 8px; padding: 8px 10px;
  }
  input[type="search"] { width: min(320px, 100%); }
  input[type="number"] { width: 76px; }
  input[type="checkbox"] { width: 18px; height: 18px; accent-color: #e4ec66; }
  select, textarea { width: 100%; }
  textarea { resize: vertical; min-height: 44px; }
  :focus-visible { outline: 3px solid #e4ec66; outline-offset: 2px; }
  .btn { display: inline-block; background: #e4ec66; color: #0b1a33; text-decoration: none; font: inherit; font-weight: 600; padding: 10px 18px; border: 0; border-radius: 999px; cursor: pointer; }
  .btn.small { padding: 7px 14px; font-size: 14px; }
  .btn.ghost { background: transparent; color: #f4f5f7; border: 1px solid #5b6c8f; }
  .link { background: none; border: 0; padding: 6px 0; font: inherit; color: #b4c3de; text-decoration: underline; cursor: pointer; }
  .link.danger:hover { color: #ff9d8a; }
  .wrap { overflow-x: auto; border: 1px solid #27385b; border-radius: 14px; }
  table { border-collapse: collapse; width: 100%; min-width: 1100px; }
  th, td { text-align: left; vertical-align: top; padding: 12px; border-bottom: 1px solid #27385b; }
  tr:last-child td { border-bottom: 0; }
  th { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #b4c3de; }
  .nowrap { white-space: nowrap; }
  .wide { min-width: 260px; }
  .work { width: 230px; }
  .work > * + * { margin-top: 8px; }
  .actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .tag { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; background: #e4ec66; color: #0b1a33; border-radius: 999px; padding: 2px 8px; font-weight: 600; }
  summary { cursor: pointer; font-weight: 600; }
  details p { margin: 8px 0 0; }
  td div + div { margin-top: 4px; }
  #toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); background: #f4f5f7; color: #0b1a33; font-weight: 600; padding: 10px 18px; border-radius: 999px; }
  #toast.bad { background: #ffb4a6; }
  #toast[hidden] { display: none; }
  .nav { display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 1px solid #27385b; }
  .nav a { text-decoration: none; color: #b4c3de; padding: 10px 14px; border-bottom: 3px solid transparent; margin-bottom: -1px; font-weight: 600; }
  .nav a.on { color: #f4f5f7; border-bottom-color: #e4ec66; }
  .cols { display: grid; grid-template-columns: minmax(0, 3fr) minmax(280px, 2fr); gap: 20px; align-items: start; }
  @media (max-width: 900px) { .cols { grid-template-columns: minmax(0, 1fr); } }
  .card { border: 1px solid #27385b; border-radius: 14px; padding: 16px; margin-bottom: 18px; }
  .card p { margin: 0 0 12px; }
  #prompt { min-height: 520px; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  input[type="text"] { font: inherit; color: #f4f5f7; background: #0f2140; border: 1px solid #3a4c72; border-radius: 8px; padding: 8px 10px; width: 100%; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 12px; }
  .versions { list-style: none; margin: 0; padding: 0; }
  .versions li { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; justify-content: space-between; padding: 10px 0; border-top: 1px solid #27385b; }
  .versions li:first-child { border-top: 0; }
  .score { display: inline-block; font-size: 12px; font-weight: 700; letter-spacing: .04em; border-radius: 999px; padding: 3px 10px; margin-bottom: 6px; border: 1px solid #5b6c8f; color: #f4f5f7; }
  .score.hot { background: #e4ec66; color: #0b1a33; border-color: #e4ec66; }
  .score.warm { border-color: #e4ec66; color: #e4ec66; }
  .follow { display: block; }
  input[type="date"] { font: inherit; color: #f4f5f7; background: #0f2140; border: 1px solid #3a4c72; border-radius: 8px; padding: 6px 8px; margin-top: 4px; width: 100%; color-scheme: dark; }
  .funnel { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: center; margin-bottom: 18px; }
  .funnel div { border: 1px solid #27385b; border-radius: 10px; padding: 8px 12px; }
  .funnel b { font-size: 18px; margin-right: 6px; }
  .funnel i { font-style: normal; color: #b4c3de; font-size: 13px; }
  .funnel span { color: #5b6c8f; }
  .bignum { font-size: 44px; font-weight: 800; line-height: 1; }
  .meter { display: flex; gap: 14px; flex-wrap: wrap; margin: 10px 0 14px; }
  .meter div { flex: 1 1 120px; border: 1px solid #27385b; border-radius: 10px; padding: 10px 12px; }
  .meter b { display: block; font-size: 26px; line-height: 1.1; }
  .parts { list-style: none; margin: 10px 0 0; padding: 0; }
  .parts li { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-top: 1px solid #27385b; font-size: 14px; }
  #draftbody { min-height: 260px; }
  .trail { list-style: none; margin: 0; padding: 0; }
  .trail li { padding: 9px 0; border-top: 1px solid #27385b; }
  .trail li:first-child { border-top: 0; }
  .trail time { display: block; }
  .addnote { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .addnote input { flex: 1 1 200px; width: auto; }
  .thumb { display: block; width: 120px; height: auto; margin-top: 8px; border-radius: 6px; border: 1px solid #27385b; }
  .headline { display: block; color: #f4f5f7; font-weight: 600; text-decoration: none; margin-bottom: 4px; }
  .headline:hover { text-decoration: underline; }
  .lead h2 { margin-top: 26px; }
  .lead p { margin: 0 0 12px; font-size: 16px; line-height: 1.55; }
  .big { font-size: 26px !important; line-height: 1.2 !important; font-weight: 700; margin: 18px 0 0 !important; }
  .shotbox { margin: 0; }
  .shotbox img { display: block; width: 100%; height: auto; border-radius: 10px; border: 1px solid #27385b; }
  .shotbox figcaption { margin-top: 6px; }
  .q { background: #132849; border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
  .q i { display: block; font-size: 17px; }
  .q span { display: block; margin-top: 4px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #b4c3de; }
  .fixsteps { margin: 0; padding-left: 22px; }
  .fixsteps li { margin-bottom: 10px; font-size: 16px; line-height: 1.5; }
  .rw { margin-top: 14px; padding-top: 14px; border-top: 1px solid #27385b; }
  .rw div { display: grid; grid-template-columns: 48px 1fr; gap: 10px; margin-bottom: 8px; align-items: baseline; }
  .rw span { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #b4c3de; }
  .rw s { color: #b4c3de; }
  .rw b { color: #e4ec66; font-size: 18px; }
  #result { white-space: pre-wrap; }
  #result b { display: block; margin-top: 10px; color: #b4c3de; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
  #result h3 { margin: 0; font-size: 19px; }
`;

function adminNav(active) {
  const link = (key, href, label) => `<a${key === active ? ' class="on" aria-current="page"' : ""} href="${href}">${label}</a>`;
  return `<nav class="nav" aria-label="Back office">${link("leads", "/teardown/admin", "Leads")}${link("prompt", "/teardown/admin/prompt", "Auditor prompt")}</nav>`;
}

const SCRIPT = `
(function () {
  var toast = document.getElementById("toast"), timer;
  function say(msg, bad) {
    toast.textContent = msg; toast.className = bad ? "bad" : ""; toast.hidden = false;
    clearTimeout(timer); timer = setTimeout(function () { toast.hidden = true; }, bad ? 5000 : 1600);
  }
  function send(path, body) {
    return fetch("/teardown/admin/api/" + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || !data.ok) throw new Error(data.error || "That didn't work.");
        return data;
      });
    });
  }
  function picked() {
    return Array.prototype.map.call(document.querySelectorAll(".pick:checked"), function (c) { return c.value; });
  }
  function updateBulk() {
    var button = document.getElementById("bulkdelete");
    if (!button) return;
    var n = picked().length;
    button.hidden = n === 0;
    button.textContent = "Delete " + n + " selected";
  }
  document.addEventListener("change", function (e) {
    if (e.target.id === "checkall") {
      document.querySelectorAll(".pick").forEach(function (c) { c.checked = e.target.checked; });
    }
    if (e.target.id === "checkall" || e.target.classList.contains("pick")) { updateBulk(); return; }
    var field = e.target.getAttribute("data-field"), row = e.target.closest("[data-id]");
    if (field && row) {
      var body = { id: row.getAttribute("data-id") }; body[field] = e.target.value;
      send("lead", body).then(function () { say("Saved"); }).catch(function (err) { say(err.message, true); });
      return;
    }
    if (e.target.id === "alertTo") {
      send("settings", { alertTo: e.target.value }).then(function () { say("Saved"); }).catch(function (err) { say(err.message, true); });
      return;
    }
    if (e.target.id === "paused" || e.target.id === "dailyLimit") {
      var change = e.target.id === "paused" ? { paused: e.target.checked } : { dailyLimit: Number(e.target.value) };
      send("settings", change).then(function () { say("Saved"); setTimeout(function () { location.reload(); }, 500); })
        .catch(function (err) { say(err.message, true); });
    }
  });
  document.addEventListener("click", function (e) {
    if (e.target.id === "bulkdelete") {
      var ids = picked();
      if (!ids.length || !confirm("Delete " + ids.length + " for good? This can't be undone.")) return;
      send("delete-many", { ids: ids }).then(function () { location.reload(); }).catch(function (err) { say(err.message, true); });
      return;
    }
    if (e.target.id === "testrun") {
      var button = e.target, status = document.getElementById("teststatus"), url = document.getElementById("testurl").value.trim();
      if (!url) { say("Give it a website to test.", true); return; }
      var was = status.textContent;
      button.disabled = true; status.textContent = "Auditing. About 30 seconds.";
      send("test-run", { url: url }).then(function (d) { location.href = "/teardown/admin/lead/" + d.id; })
        .catch(function (err) { button.disabled = false; status.textContent = was; say(err.message, true); });
      return;
    }
    if (e.target.id === "testalert") {
      e.target.disabled = true;
      send("test-alert", {}).then(function (d) { say(d.message); }).catch(function (err) { say(err.message, true); })
        .then(function () { e.target.disabled = false; });
      return;
    }
    var holder = e.target.closest("[data-id]");
    if (e.target.id === "addnote" || e.target.id === "logreply") {
      var input = document.getElementById("notetext"), isReply = e.target.id === "logreply";
      if (!isReply && !input.value.trim()) { say("Type something first.", true); return; }
      send("event", { id: holder.getAttribute("data-id"), type: isReply ? "reply" : "note", detail: input.value })
        .then(function () { location.reload(); }).catch(function (err) { say(err.message, true); });
      return;
    }
    if (e.target.id === "copydraft") {
      var text = document.getElementById("draftbody").value;
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { say("Copied"); }, function () { say("Couldn't copy. Select the text and copy it by hand.", true); });
      return;
    }
    if (e.target.id === "openmail") {
      var to = document.getElementById("draftto").value.trim();
      if (!to) { e.preventDefault(); say("Add an email address in the To box first.", true); return; }
      e.target.href = "mailto:" + encodeURIComponent(to) + "?subject=" + encodeURIComponent(document.getElementById("draftsubject").value)
        + "&body=" + encodeURIComponent(document.getElementById("draftbody").value.slice(0, 1800));
    }
    var action = e.target.getAttribute("data-action"), row = holder;
    if (!action || !row) return;
    var id = row.getAttribute("data-id");
    if (action === "delete") {
      if (!confirm("Delete the " + row.getAttribute("data-domain") + " teardown for good? This can't be undone.")) return;
      send("delete", { id: id }).then(function () {
        if (document.body.getAttribute("data-page") === "lead") { location.href = "/teardown/admin"; return; }
        row.remove(); say("Deleted"); updateBulk();
      }).catch(function (err) { say(err.message, true); });
    }
    if (action === "email") {
      // Opening your mail app counts as reaching out: it goes on the trail and a new lead moves to Contacted.
      send("event", { id: id, type: "outreach" }).catch(function () {});
      var stage = document.querySelector('[data-id="' + id + '"] [data-field="stage"]');
      if (stage && stage.value === "new") {
        stage.value = "contacted";
        send("lead", { id: id, stage: "contacted" }).then(function () { say("Marked as contacted"); }).catch(function (err) { say(err.message, true); });
      }
    }
  });
})();
`;

function workControls(row, me, owners) {
  const mailto = outreachMailto(row, me);
  const ownerList = [...new Set([...owners, ...(row.owner ? [row.owner] : [])])];
  const stageSelect = `<select data-field="stage" aria-label="Stage for ${esc(row.domain)}">${STAGES.map(
    (s) => `<option value="${s}"${s === (row.stage || "new") ? " selected" : ""}>${STAGE_LABELS[s]}</option>`,
  ).join("")}</select>`;
  const ownerSelect = `<select data-field="owner" aria-label="Owner for ${esc(row.domain)}"><option value="">Nobody yet</option>${ownerList
    .map((o) => `<option value="${esc(o)}"${o === row.owner ? " selected" : ""}>${esc(cap(o))}</option>`)
    .join("")}</select>`;
  const touched = row.updated_at
    ? `<div class="muted">Changed by ${esc(cap(row.updated_by))}, ${esc(String(row.updated_at).slice(0, 10))}</div>`
    : "";
  return `${stageSelect}
      ${ownerSelect}
      <label class="muted follow">Follow up on <input type="date" data-field="followUp" value="${esc(row.follow_up || "")}"></label>
      <textarea data-field="notes" rows="2" maxlength="4000" placeholder="Notes" aria-label="Notes for ${esc(row.domain)}">${esc(row.admin_notes)}</textarea>
      <div class="actions">
        ${mailto ? `<a class="btn small" data-action="email" href="${esc(mailto)}">Email them</a>` : ""}
        <button class="link danger" type="button" data-action="delete">Delete</button>
      </div>
      ${touched}`;
}

function contactBlock(row) {
  const emails = parseList(row.site_emails);
  const phones = parseList(row.site_phones);
  const socials = parseList(row.social_links);
  return [
    row.visitor_email ? `<div><span class="tag">Gave us</span> ${esc(row.visitor_email)}</div>` : "",
    emails.length ? `<div>${emails.map(esc).join("<br>")}</div>` : "",
    phones.length ? `<div>${phones.map((p) => `<a href="tel:${esc(p)}">${esc(p)}</a>`).join("<br>")}</div>` : "",
    row.contact_page ? `<div>${safeLink(row.contact_page, "Contact page")}</div>` : "",
    socials.length ? `<div>${socials.map((s) => safeLink(s, hostLabel(s))).join(" · ")}</div>` : "",
  ].join("") || '<span class="muted">None found</span>';
}

const validShot = (id) => /^[0-9a-f-]{36}$/.test(String(id || ""));

function renderRow(row, me, owners) {
  const detail = `/teardown/admin/lead/${esc(row.id)}`;
  const note = row.note_problem
    ? `<a class="headline" href="${detail}">${esc(row.note_problem)}</a><div><a href="${detail}">View the full teardown</a></div>`
    : `<span class="muted">No note. Their site failed: ${esc(String(row.status).replace(/_/g, " "))}</span>`;
  const thumb = validShot(row.shot_id)
    ? `<a href="${detail}"><img class="thumb" src="/teardown/shot/${esc(row.shot_id)}" alt="" loading="lazy" width="120" height="75"></a>`
    : "";

  return `<tr data-id="${esc(row.id)}" data-domain="${esc(row.domain)}">
    <td><input type="checkbox" class="pick" value="${esc(row.id)}" aria-label="Select ${esc(row.domain)}"></td>
    <td class="nowrap">${scoreBadge(row)}<div>${esc(String(row.created_at).replace("T", " ").slice(0, 16))}</div>${row.from_cache ? '<div class="muted">repeat site</div>' : ""}${row.follow_up ? `<div class="muted">Follow up ${esc(row.follow_up)}</div>` : ""}</td>
    <td>${safeLink(row.final_url || row.input_url, row.domain)}${row.site_title ? `<div class="muted">${esc(clip(row.site_title, 70))}</div>` : ""}${row.country ? `<div class="muted">Visitor in ${esc(row.country)}</div>` : ""}${thumb}</td>
    <td class="wide">${note}</td>
    <td>${contactBlock(row)}</td>
    <td class="work">
      ${workControls(row, me, owners)}
    </td>
  </tr>`;
}

function structuredNote(row) {
  let extra = {};
  try {
    extra = JSON.parse(row.note_json || "{}") || {};
  } catch {
    extra = {};
  }
  const split = (text) => String(text || "").split(/\n{2,}/).map((t) => t.trim()).filter(Boolean);
  const list = (value, fallback) => (Array.isArray(value) && value.length ? value.map(String) : split(fallback));
  return {
    whyPoints: list(extra.whyPoints, row.note_why),
    fixSteps: list(extra.fixSteps, row.note_fix),
    evidence: Array.isArray(extra.evidence) ? extra.evidence.filter((e) => e && e.quote) : [],
    rewrite: extra.rewrite && extra.rewrite.after ? extra.rewrite : null,
  };
}

function renderLeadPage({ row, me, owners, events = [] }) {
  const note = structuredNote(row);
  const read = parseAnalysis(row);
  const score = scoreRow(row, read);
  const draft = outreachDraft(row, me, read);
  const closed = row.stage === "do_not_contact";

  const scoreCard = `<div class="card"><h2>Lead score</h2>
      <div class="bignum">${score.score}<span class="score ${score.label.toLowerCase()}" style="margin-left:12px;vertical-align:middle">${score.label}</span></div>
      <ul class="parts">${score.parts.map((p) => `<li><span>${esc(p.label)}</span><b>+${p.points}</b></li>`).join("") || '<li><span class="muted">Nothing to score yet.</span></li>'}</ul>
    </div>`;

  const readCard = read
    ? `<div class="card"><h2>The business, as the AI reads it</h2>
        <p><b>${esc(read.businessType)}.</b> ${esc(read.businessSummary)}</p>
        <div class="meter">
          <div><b>${esc(read.businessScore)}/10</b>How real the business looks${read.businessReasons?.length ? `<ul class="parts">${read.businessReasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}</div>
          <div><b>${esc(read.brandScore)}/10</b>How strong the brand is now${read.brandReasons?.length ? `<ul class="parts">${read.brandReasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}</div>
        </div>
        ${read.package ? `<p><b>Pitch: ${esc(read.package)} (${esc(read.packagePrice)}).</b> ${esc(read.packageWhy)}</p>` : ""}
        <p class="muted">An AI's judgement from their public site only. Treat it as a starting point, not a fact.</p>
      </div>`
    : row.note_problem ? '<div class="card"><h2>The business, as the AI reads it</h2><p class="muted">No read on this one. It was made before this feature, or the analysis didn\u2019t finish.</p></div>' : "";

  const draftCard = draft
    ? `<div class="card"><h2>Outreach draft${draft.ai ? "" : " (standard template)"}</h2>
        ${closed ? '<p class="muted">Marked Do not contact, so sending is switched off.</p>' : ""}
        <label class="muted" for="draftto">To</label><input type="text" id="draftto" value="${esc(draft.to)}" placeholder="No address found. Add one." autocapitalize="none" spellcheck="false">
        <label class="muted" for="draftsubject" style="display:block;margin-top:10px">Subject</label><input type="text" id="draftsubject" value="${esc(draft.subject)}">
        <label class="muted" for="draftbody" style="display:block;margin-top:10px">Message</label><textarea id="draftbody">${esc(draft.body)}</textarea>
        <div class="row">
          ${closed ? "" : '<a class="btn small" id="openmail" data-action="email" href="#">Open in my email</a>'}
          <button class="btn small ghost" type="button" id="copydraft">Copy message</button>
          <span class="muted">Edit it first. Nothing is sent from here.</span>
        </div>
      </div>`
    : "";

  const trailCard = `<div class="card"><h2>Activity</h2>
      <div class="addnote"><input type="text" id="notetext" maxlength="400" placeholder="Add to the trail: called, left voicemail, sent proposal..." aria-label="Add a note to the trail">
        <button class="btn small" type="button" id="addnote">Add</button>
        <button class="btn small ghost" type="button" id="logreply">They replied</button></div>
      <ul class="trail">${events.map((e) => `<li><div>${esc(e.detail || e.type)}</div><time class="muted">${esc(String(e.at).replace("T", " ").slice(0, 16))} UTC \u00b7 ${esc(cap(e.by || "system"))}</time></li>`).join("") || '<li class="muted">Nothing yet.</li>'}</ul>
    </div>`;
  const when = String(row.created_at).replace("T", " ").slice(0, 16);
  const facts = [
    row.is_test ? "Test run from the back office" : null,
    row.country ? `Visitor in ${esc(row.country)}` : null,
    row.from_cache ? "Repeat site, shown the saved note" : null,
    row.prompt_version ? `Auditor prompt version ${esc(row.prompt_version)}` : "Built-in auditor prompt",
    row.status !== "ok" && row.status !== "test" ? `Result: ${esc(String(row.status).replace(/_/g, " "))}` : null,
  ].filter(Boolean);

  const body = row.note_problem
    ? `${validShot(row.shot_id) ? `<figure class="shotbox"><img src="/teardown/shot/${esc(row.shot_id)}" alt="The top of ${esc(row.domain)} when it was audited" width="1280" height="800"><figcaption class="muted">What a stranger sees first</figcaption></figure>` : '<p class="muted">No screenshot was taken for this one.</p>'}
      <p class="big">${esc(row.note_problem)}</p>
      ${note.evidence.length ? `<h2>On their site</h2>${note.evidence.map((e) => `<div class="q"><i>\u201c${esc(e.quote)}\u201d</i>${e.where ? `<span>${esc(e.where)}</span>` : ""}</div>`).join("")}` : ""}
      <h2>Why it's costing them</h2>
      ${note.whyPoints.map((p) => `<p>${esc(p)}</p>`).join("")}
      <h2>The fix</h2>
      <ol class="fixsteps">${note.fixSteps.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>
      ${note.rewrite ? `<div class="rw">${note.rewrite.before ? `<div><span>Now</span><s>${esc(note.rewrite.before)}</s></div>` : ""}<div><span>Try</span><b>${esc(note.rewrite.after)}</b></div></div>` : ""}`
    : `<p class="muted">No note. Their site failed: ${esc(String(row.status).replace(/_/g, " "))}.</p>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(row.domain)} teardown</title>
<style>${CSS}</style></head><body data-page="lead"><main>

<div class="top">
  <div><a href="/teardown/admin${row.is_test ? "?tests=1" : ""}">\u2190 All ${row.is_test ? "tests" : "leads"}</a>
    <h1>${esc(row.domain)}</h1>
    <div class="muted">${esc(when)} UTC. ${safeLink(row.final_url || row.input_url, "Open their site")}${row.site_title ? `. ${esc(clip(row.site_title, 90))}` : ""}</div></div>
</div>

<div class="cols">
  <div data-id="${esc(row.id)}" data-domain="${esc(row.domain)}">
    <div class="card lead">${body}</div>
    ${draftCard}
    ${readCard}
  </div>
  <div data-id="${esc(row.id)}" data-domain="${esc(row.domain)}">
    <div class="card work" style="width:auto"><h2>Working it</h2>${workControls(row, me, owners)}</div>
    ${scoreCard}
    ${trailCard}
    <div class="card"><h2>Contact</h2>${contactBlock(row)}</div>
    <div class="card"><h2>Details</h2>${facts.map((f) => `<div class="muted">${f}</div>`).join("")}</div>
  </div>
</div>

<div id="toast" role="status" aria-live="polite" hidden></div>
</main>
<script>${SCRIPT}</script>
</body></html>`;
}

function renderPage({ rows, stats, settings, filters, me, owners, hasCache }) {
  const tab = (stage, label, count) =>
    `<a class="tab${!filters.tests && !filters.due && (filters.stage || "") === stage ? " on" : ""}" href="/teardown/admin${queryString({ ...filters, tests: false, due: false }, { stage })}">${esc(label)} <span>${count}</span></a>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Teardown back office</title>
<style>${CSS}</style></head><body><main>

<div class="top">
  <div><h1>Teardown back office</h1><div class="muted">Signed in as ${esc(cap(me))}. Times are UTC.</div></div>
  <div style="display:flex;flex-wrap:wrap;gap:10px">
    <a class="btn ghost" href="/teardown/" target="_blank" rel="noopener">Open the teardown page</a>
    <a class="btn" href="/teardown/admin/leads.csv${queryString(filters)}">Download CSV</a>
  </div>
</div>

${adminNav("leads")}

<div class="stats">
  <div class="stat"><b>${stats.today}</b>today</div>
  <div class="stat"><b>${stats.week}</b>last 7 days</div>
  <div class="stat"><b>${stats.total}</b>all time</div>
  <div class="stat"><b>${stats.reachable}</b>with a way to reach them</div>
  <div class="stat"><b>${stats.gaveEmail}</b>left their own email</div>
  <div class="stat"><b>${stats.stages.won}</b>won</div>
</div>

<div class="funnel" aria-label="Funnel">
  ${[["Teardowns", stats.funnel.teardowns], ["Reachable", stats.funnel.reachable], ["Contacted", stats.funnel.contacted], ["Replied", stats.funnel.replied], ["Won", stats.funnel.won]]
    .map(([label, n], i) => `${i ? '<span aria-hidden="true">\u2192</span>' : ""}<div><b>${n}</b>${label}${i && stats.funnel.teardowns ? ` <i>${Math.round((n / stats.funnel.teardowns) * 100)}%</i>` : ""}</div>`).join("")}
</div>

<div class="panel${settings.paused ? " paused" : ""}" id="settings">
  <div><h2 style="margin:0">Teardown controls</h2></div>
  <label><input type="checkbox" id="paused"${settings.paused ? " checked" : ""}> Pause new teardowns</label>
  <label>Free teardowns per visitor per day <input type="number" id="dailyLimit" min="1" max="100" value="${settings.dailyLimit}"></label>
  <span class="muted">${settings.paused ? "Paused. Visitors see a “check back soon” message and nothing is spent on audits." : "Live."}${hasCache ? "" : " The daily limit needs the cache turned on (see README)."}${settings.upcoming ? ` The daily limit changes to ${settings.upcoming.dailyLimit} on ${esc(new Date(settings.upcoming.from).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }))}. Changing the number here cancels that.` : ""}</span>
</div>

<div class="panel">
  <div><h2 style="margin:0">Lead alerts</h2></div>
  <label style="flex:1 1 320px">Email <input type="text" id="alertTo" value="${esc(settings.alertTo)}" placeholder="you@example.com, partner@example.com" autocapitalize="none" spellcheck="false" style="width:auto;flex:1"></label>
  <button class="btn small ghost" type="button" id="testalert">Send a test alert</button>
  <span class="muted">An email goes out when a teardown is run and again if the visitor leaves their email. Addresses must be verified in Cloudflare Email Routing.</span>
</div>

<div class="panel">
  <div><h2 style="margin:0">Run a test teardown</h2></div>
  <input type="text" id="testurl" inputmode="url" autocapitalize="none" spellcheck="false" placeholder="yourbrand.com" aria-label="Website to test" style="flex:1 1 220px;width:auto;max-width:360px">
  <button class="btn small" type="button" id="testrun">Run test</button>
  <span class="muted" id="teststatus">Skips the daily limit and stays out of your numbers. Costs one audit. Filed under Tests.</span>
</div>

<nav class="tabs" aria-label="Filter by stage">
  ${tab("", "All", stats.total)}
  ${STAGES.map((s) => tab(s, STAGE_LABELS[s], stats.stages[s])).join("")}
  <a class="tab${filters.due ? " on" : ""}" href="/teardown/admin?due=1">Follow-ups due <span>${stats.due}</span></a>
  <a class="tab${filters.tests ? " on" : ""}" href="/teardown/admin?tests=1">Tests <span>${stats.tests}</span></a>
</nav>

<form class="tools" method="get" action="/teardown/admin">
  ${filters.stage ? `<input type="hidden" name="stage" value="${esc(filters.stage)}">` : ""}
  ${filters.tests ? '<input type="hidden" name="tests" value="1">' : ""}
  ${filters.due ? '<input type="hidden" name="due" value="1">' : ""}
  ${filters.sort ? `<input type="hidden" name="sort" value="${esc(filters.sort)}">` : ""}
  <input type="search" name="q" value="${esc(filters.q)}" placeholder="Search site, email, note" aria-label="Search leads">
  <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" name="reachable" value="1"${filters.reachable ? " checked" : ""}> Only leads we can reach</label>
  <button class="btn small" type="submit">Filter</button>
  ${filters.q || filters.reachable ? `<a href="/teardown/admin${queryString({ stage: filters.stage })}">Clear</a>` : ""}
  <span class="muted">${rows.length} shown</span>
  ${filters.sort === "score" ? `<a href="/teardown/admin${queryString(filters, { sort: "" })}">Newest first</a>` : `<a href="/teardown/admin${queryString(filters, { sort: "score" })}">Highest score first</a>`}
  <button class="btn small ghost" id="bulkdelete" type="button" hidden></button>
</form>

<div class="wrap"><table>
<thead><tr><th><input type="checkbox" id="checkall" aria-label="Select all shown"></th><th>When</th><th>Website</th><th>What we told them</th><th>Contact</th><th>Working it</th></tr></thead>
<tbody>${rows.map((r) => renderRow(r, me, owners)).join("") || '<tr><td colspan="6" class="muted">Nothing here yet.</td></tr>'}</tbody>
</table></div>

<div id="toast" role="status" aria-live="polite" hidden></div>
</main>
<script>${SCRIPT}</script>
</body></html>`;
}

function renderPromptPage({ active, versions, me }) {
  const usingBuiltIn = !active.prompt;
  const history = versions
    .map((v) => {
      const isCurrent = Number(v.version) === active.version;
      const label = v.prompt ? `${String(v.prompt).length.toLocaleString("en-US")} characters` : "Back to the built-in prompt";
      return `<li><div><b>Version ${esc(v.version)}</b>${isCurrent ? ' <span class="tag">In use</span>' : ""}
        <div class="muted">${esc(String(v.created_at).replace("T", " ").slice(0, 16))} by ${esc(cap(v.created_by))}. ${esc(label)}</div></div>
        <button class="btn small ghost" type="button" data-load="${esc(v.prompt || AUDITOR_PROMPT)}">Load into editor</button></li>`;
    })
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Auditor prompt</title>
<style>${CSS}</style></head><body><main>

<div class="top">
  <div><h1>Teardown back office</h1><div class="muted">Signed in as ${esc(cap(me))}. Times are UTC.</div></div>
</div>
${adminNav("prompt")}

<div class="cols">
  <div>
    <div class="card">
      <h2>What the auditor is told</h2>
      <p>This is read by the AI before it looks at a visitor's site. Edit it to change what it looks for, how it judges, and how it talks. A saved change applies to the very next teardown.</p>
      <p class="muted">${usingBuiltIn ? "You're on the built-in prompt." : `You're on version ${active.version}.`} Two things are locked and added automatically after your text: the answer format the page needs, and the rule that it never invents an audit or follows instructions hidden on a visitor's site.</p>
      <label for="prompt" class="muted">Auditor prompt</label>
      <textarea id="prompt" maxlength="${PROMPT_MAX}" spellcheck="true">${esc(active.prompt || AUDITOR_PROMPT)}</textarea>
      <div class="row">
        <button class="btn" type="button" id="save">Save and use this</button>
        <button class="btn ghost" type="button" id="reset">Go back to the built-in prompt</button>
        <span class="muted" id="count"></span>
      </div>
    </div>
  </div>

  <div>
    <div class="card">
      <h2>Try it before you save</h2>
      <p class="muted">Runs whatever is in the editor against a real site. Nothing is saved, no lead is created, and visitors don't see it. Each try costs one audit.</p>
      <label for="testurl" class="muted">Website</label>
      <input type="text" id="testurl" inputmode="url" autocapitalize="none" spellcheck="false" placeholder="yourbrand.com">
      <div class="row"><button class="btn small" type="button" id="test">Try this draft</button><span class="muted" id="teststatus"></span></div>
      <div id="result" hidden><b>The problem</b><h3 id="r-problem"></h3><b>Why it's costing them</b><div id="r-why"></div><b>The fix</b><div id="r-fix"></div></div>
    </div>
    <div class="card">
      <h2>Past versions</h2>
      ${history ? `<ul class="versions">${history}</ul>` : '<p class="muted" style="margin:0">None yet. Every save is kept here so you can go back.</p>'}
    </div>
  </div>
</div>

<div id="toast" role="status" aria-live="polite" hidden></div>
</main>
<script>
(function () {
  var toast = document.getElementById("toast"), timer;
  var editor = document.getElementById("prompt"), count = document.getElementById("count");
  function say(msg, bad) {
    toast.textContent = msg; toast.className = bad ? "bad" : ""; toast.hidden = false;
    clearTimeout(timer); timer = setTimeout(function () { toast.hidden = true; }, bad ? 6000 : 1800);
  }
  function send(path, body) {
    return fetch("/teardown/admin/api/" + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || !data.ok) throw new Error(data.error || "That didn't work.");
        return data;
      });
    });
  }
  function tally() { count.textContent = editor.value.length.toLocaleString() + " characters"; }
  editor.addEventListener("input", tally); tally();

  document.getElementById("save").addEventListener("click", function () {
    send("prompt", { prompt: editor.value }).then(function (d) { say("Saved as version " + d.version); setTimeout(function () { location.reload(); }, 700); })
      .catch(function (err) { say(err.message, true); });
  });
  document.getElementById("reset").addEventListener("click", function () {
    if (!confirm("Stop using your version and go back to the built-in prompt? Your versions stay in the history.")) return;
    send("prompt", { prompt: "" }).then(function () { say("Back on the built-in prompt"); setTimeout(function () { location.reload(); }, 700); })
      .catch(function (err) { say(err.message, true); });
  });
  document.addEventListener("click", function (e) {
    var text = e.target.getAttribute("data-load");
    if (text === null) return;
    editor.value = text; tally(); editor.focus(); say("Loaded. Not saved yet.");
  });
  document.getElementById("test").addEventListener("click", function () {
    var btn = this, status = document.getElementById("teststatus"), box = document.getElementById("result");
    var url = document.getElementById("testurl").value.trim();
    if (!url) { say("Give it a website to try.", true); return; }
    btn.disabled = true; box.hidden = true; status.textContent = "Auditing. About 20 seconds.";
    send("prompt-test", { url: url, prompt: editor.value }).then(function (d) {
      document.getElementById("r-problem").textContent = d.note.problem;
      document.getElementById("r-why").textContent = d.note.why;
      document.getElementById("r-fix").textContent = d.note.fix;
      box.hidden = false; status.textContent = d.domain;
    }).catch(function (err) { status.textContent = ""; say(err.message, true); })
      .then(function () { btn.disabled = false; });
  });
})();
</script>
</body></html>`;
}

// Runs a draft prompt on a real site. Saves nothing and creates no lead.
async function tryPrompt(env, body) {
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: "The Claude API key isn't set yet." }, 503);
  const draft = String(body?.prompt ?? "").trim();
  if (draft.length > PROMPT_MAX) return json({ ok: false, error: "That prompt is too long." }, 400);
  try {
    const fetched = await safeFetchPage(normalizeUrl(body?.url));
    const page = extractPage(fetched.html, fetched.finalUrl);
    if (hasTooLittleContent(page)) return json({ ok: false, error: "That site has almost no text to audit. Try another." }, 422);
    const note = await runFreeAudit(page, env, fetch, draft);
    return json({ ok: true, domain: new URL(fetched.finalUrl).hostname.replace(/^www\./, ""), note });
  } catch (err) {
    if (err instanceof TeardownError) return json({ ok: false, error: err.message }, err.status);
    throw err;
  }
}

// A full teardown run by Ned or Brian: same steps as a visitor's, no daily limit, filed under Tests.
async function testRun(env, body, me) {
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: "The Claude API key isn't set yet." }, 503);
  try {
    const fetched = await safeFetchPage(normalizeUrl(body?.url));
    const page = extractPage(fetched.html, fetched.finalUrl);
    if (hasTooLittleContent(page)) return json({ ok: false, error: "That site has almost no text to audit. Try another." }, 422);
    const active = await getActivePrompt(env.DB);
    const shot = await takeScreenshot(env, fetched.finalUrl);
    const note = await runFreeAudit(page, env, fetch, active.prompt, shot);
    const id = crypto.randomUUID();
    const savedShot = await saveScreenshot(env, id, shot).catch(() => false);
    await insertLead(env.DB, {
      id, createdAt: new Date().toISOString(), inputUrl: fetched.finalUrl, finalUrl: fetched.finalUrl,
      domain: new URL(fetched.finalUrl).hostname.toLowerCase().replace(/^www\./, ""),
      status: "ok", note, contacts: extractContacts(fetched.html, fetched.finalUrl), socialLinks: page.socialLinks,
      siteTitle: page.title, promptVersion: active.version, shotId: savedShot ? id : null, isTest: true,
    });
    await logEvent(env.DB, id, "created", `Test run on ${new URL(fetched.finalUrl).hostname}`, me);
    await scoreAndAlert(env, id, { page, note });
    return json({ ok: true, id });
  } catch (err) {
    if (err instanceof TeardownError) return json({ ok: false, error: err.message }, err.status);
    throw err;
  }
}

// ---------- routes ----------

async function handleAction(request, env, pathname, me) {
  // The browser attaches the login to any request to this site, including ones started by
  // another site. Only accept changes that came from our own page.
  const origin = request.headers.get("origin");
  let sameOrigin = false;
  try {
    sameOrigin = Boolean(origin) && new URL(origin).host === new URL(request.url).host;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin || !(request.headers.get("content-type") || "").includes("application/json")) {
    return json({ ok: false, error: "That request didn't come from the admin page." }, 403);
  }
  let body;
  try {
    body = JSON.parse((await request.text()).slice(0, 60000));
  } catch {
    return json({ ok: false, error: "Bad request." }, 400);
  }
  const id = String(body?.id ?? "");
  const validId = /^[0-9a-f-]{36}$/.test(id);

  try {
    if (pathname === "/teardown/admin/api/lead") {
      if (!validId) return json({ ok: false, error: "Unknown lead." }, 400);
      const found = await updateLead(env.DB, id, { stage: body.stage, owner: body.owner, notes: body.notes, followUp: body.followUp }, me);
      return found ? json({ ok: true }) : json({ ok: false, error: "That lead no longer exists." }, 404);
    }
    if (pathname === "/teardown/admin/api/delete") {
      if (!validId) return json({ ok: false, error: "Unknown lead." }, 400);
      const found = await deleteLead(env.DB, id);
      return found ? json({ ok: true }) : json({ ok: false, error: "That lead no longer exists." }, 404);
    }
    if (pathname === "/teardown/admin/api/event") {
      const lead = validId ? await getLead(env.DB, id) : null;
      if (!lead) return json({ ok: false, error: "That lead no longer exists." }, 404);
      const detail = String(body?.detail || "").trim().slice(0, 400);
      if (body?.type === "note") {
        if (!detail) return json({ ok: false, error: "Type something first." }, 400);
        await logEvent(env.DB, id, "note", detail, me);
      } else if (body?.type === "reply") {
        await logEvent(env.DB, id, "reply", detail ? `They replied: ${detail}` : "They replied", me);
        if (lead.stage === "new" || lead.stage === "contacted") await updateLead(env.DB, id, { stage: "replied" }, me);
      } else if (body?.type === "outreach") {
        await logEvent(env.DB, id, "outreach", "Opened an outreach email in their mail app", me);
      } else {
        return json({ ok: false, error: "Bad request." }, 400);
      }
      return json({ ok: true });
    }
    if (pathname === "/teardown/admin/api/test-alert") {
      const settings = await getSettings(env.DB);
      if (!parseRecipients(settings.alertTo).length) return json({ ok: false, error: "Add an alert email address first." }, 400);
      const result = await sendAlert(env, settings.alertTo, buildAlert({ kind: "test", row: {}, analysis: null, score: null }));
      return result.sent
        ? json({ ok: true, message: `Test sent to ${result.sent}. Check your inbox${result.failed ? `. ${result.failed} failed: ${result.error}` : ""}` })
        : json({ ok: false, error: `Couldn't send: ${result.error}` }, 502);
    }
    if (pathname === "/teardown/admin/api/delete-many") {
      if (!Array.isArray(body?.ids)) return json({ ok: false, error: "Bad request." }, 400);
      return json({ ok: true, deleted: await deleteLeads(env.DB, body.ids) });
    }
    if (pathname === "/teardown/admin/api/test-run") return await testRun(env, body, me);
    if (pathname === "/teardown/admin/api/prompt") {
      if (typeof body?.prompt !== "string") return json({ ok: false, error: "Bad request." }, 400);
      const saved = await savePrompt(env.DB, body.prompt, me);
      return json({ ok: true, version: saved.version, builtIn: !saved.prompt });
    }
    if (pathname === "/teardown/admin/api/prompt-test") return await tryPrompt(env, body);
    if (pathname === "/teardown/admin/api/settings") {
      const changes = {};
      if (typeof body?.paused === "boolean") changes.paused = body.paused;
      if (body?.dailyLimit !== undefined) changes.dailyLimit = body.dailyLimit;
      if (typeof body?.alertTo === "string") changes.alertTo = parseRecipients(body.alertTo).join(", ");
      return json({ ok: true, settings: await saveSettings(env.DB, changes) });
    }
  } catch (err) {
    if (err instanceof RangeError) return json({ ok: false, error: err.message }, 400);
    throw err;
  }
  return json({ ok: false, error: "Not found." }, 404);
}

export async function handleAdmin(request, env, pathname) {
  if (!adminUsers(env).length && !env.ADMIN_PASSWORD) {
    return text("Admin isn't set up yet. Add the ADMIN_USERS secret (see the README).", 503);
  }
  const me = await whoIs(request, env);
  if (!me) {
    return text("Sign in to see this.", 401, { "www-authenticate": 'Basic realm="Teardown back office", charset="UTF-8"' });
  }
  if (!env.DB) return text("No database is connected yet. See the README.", 503);

  if (request.method === "POST") return handleAction(request, env, pathname, me);
  if (request.method !== "GET" && request.method !== "HEAD") return text("Not allowed.", 405);

  const params = new URL(request.url).searchParams;
  const filters = {
    stage: STAGES.includes(params.get("stage")) ? params.get("stage") : "",
    q: (params.get("q") || "").trim().slice(0, 100),
    reachable: params.get("reachable") === "1",
    tests: params.get("tests") === "1",
    due: params.get("due") === "1",
    sort: params.get("sort") === "score" ? "score" : "",
  };
  if (filters.tests || filters.due) filters.stage = "";

  if (pathname === "/teardown/admin/leads.csv") {
    const rows = await listLeads(env.DB, { ...filters, limit: 5000 });
    return new Response(toCsv(rows), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="teardown-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
        ...PRIVATE_HEADERS,
      },
    });
  }
  if (pathname === "/teardown/admin" || pathname === "/teardown/admin/") {
    const [rows, stats, settings] = await Promise.all([
      listLeads(env.DB, { ...filters, limit: 500 }),
      leadStats(env.DB),
      getSettings(env.DB),
    ]);
    const page = renderPage({ rows, stats, settings, filters, me, owners: ownerChoices(env), hasCache: Boolean(env.TEARDOWN_KV) });
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", ...PRIVATE_HEADERS } });
  }
  if (pathname.startsWith("/teardown/admin/lead/")) {
    const id = pathname.slice("/teardown/admin/lead/".length);
    const row = /^[0-9a-f-]{36}$/.test(id) ? await getLead(env.DB, id) : null;
    if (!row) return text("That teardown doesn't exist any more.", 404);
    const events = await listEvents(env.DB, id);
    return new Response(renderLeadPage({ row, me, owners: ownerChoices(env), events }), { headers: { "content-type": "text/html; charset=utf-8", ...PRIVATE_HEADERS } });
  }
  if (pathname === "/teardown/admin/prompt") {
    const [active, versions] = await Promise.all([getActivePrompt(env.DB), listPromptVersions(env.DB)]);
    return new Response(renderPromptPage({ active, versions, me }), { headers: { "content-type": "text/html; charset=utf-8", ...PRIVATE_HEADERS } });
  }
  return text("Not found.", 404);
}
