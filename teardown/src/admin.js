// The back office for Ned and Brian.
//
//   GET  /teardown/admin               dashboard: numbers, filters, every lead
//   GET  /teardown/admin/leads.csv     download (same filters as the page)
//   POST /teardown/admin/api/lead      { id, stage?, owner?, notes? }
//   POST /teardown/admin/api/delete    { id }
//   POST /teardown/admin/api/settings  { paused?, dailyLimit? }
//   GET  /teardown/admin/prompt        edit the auditor prompt, try it on a site, see past versions
//   POST /teardown/admin/api/prompt       { prompt }   ("" goes back to the built-in prompt)
//   POST /teardown/admin/api/prompt-test  { url, prompt }   runs a draft without saving anything
//
// Sign-in is HTTP Basic auth. Set the ADMIN_USERS secret to "ned:password,brian:password"
// so each person has their own login and changes are stamped with who made them.
// (ADMIN_PASSWORD alone still works: one shared password, any username.)

import {
  STAGES, listLeads, leadStats, updateLead, deleteLead, getSettings, saveSettings, parseList, toCsv,
  getActivePrompt, savePrompt, listPromptVersions, PROMPT_MAX,
} from "./leads.js";
import { AUDITOR_PROMPT, runFreeAudit } from "./audit.js";
import { TeardownError, normalizeUrl, safeFetchPage } from "./safe-fetch.js";
import { extractPage, hasTooLittleContent } from "./extract.js";

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
export function outreachMailto(row, sender) {
  const to = row.visitor_email || parseList(row.site_emails)[0];
  if (!to || !row.note_problem || row.stage === "do_not_contact") return null;
  const opener = row.visitor_email
    ? `You ran ${row.domain} through our free Brand Teardown. Here's the note again, in case it got lost:`
    : `Someone ran ${row.domain} through our free Brand Teardown at ihatemybrand.com. This is the biggest thing it flagged:`;
  const body = [
    "Hi,",
    "",
    opener,
    "",
    clip(row.note_problem, 240),
    "",
    clip(row.note_why, 420),
    "",
    "The fix: " + clip(row.note_fix, 520),
    "",
    `If you'd rather have us handle it, our flat prices are at ${SITE}. No calls, done in days.`,
    "",
    "Not interested? Reply and say so, and we won't email again.",
    "",
    cap(sender),
    "I Hate My Brand",
  ].join("\n");
  const subject = `The biggest problem with ${row.domain}`;
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function queryString(filters, changes = {}) {
  const merged = { ...filters, ...changes };
  const params = new URLSearchParams();
  if (merged.stage) params.set("stage", merged.stage);
  if (merged.q) params.set("q", merged.q);
  if (merged.reachable) params.set("reachable", "1");
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
  table { border-collapse: collapse; width: 100%; min-width: 1040px; }
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
  #result { white-space: pre-wrap; }
  #result b { display: block; margin-top: 10px; color: #b4c3de; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
  #result h3 { margin: 0; font-size: 19px; }
`;

function adminNav(active) {
  const link = (key, href, label) => `<a${key === active ? ' class="on" aria-current="page"' : ""} href="${href}">${label}</a>`;
  return `<nav class="nav" aria-label="Back office">${link("leads", "/teardown/admin", "Leads")}${link("prompt", "/teardown/admin/prompt", "Auditor prompt")}</nav>`;
}

function renderRow(row, me, owners) {
  const emails = parseList(row.site_emails);
  const phones = parseList(row.site_phones);
  const socials = parseList(row.social_links);
  const mailto = outreachMailto(row, me);

  const contact = [
    row.visitor_email ? `<div><span class="tag">Gave us</span> ${esc(row.visitor_email)}</div>` : "",
    emails.length ? `<div>${emails.map(esc).join("<br>")}</div>` : "",
    phones.length ? `<div>${phones.map((p) => `<a href="tel:${esc(p)}">${esc(p)}</a>`).join("<br>")}</div>` : "",
    row.contact_page ? `<div>${safeLink(row.contact_page, "Contact page")}</div>` : "",
    socials.length ? `<div>${socials.map((s) => safeLink(s, hostLabel(s))).join(" · ")}</div>` : "",
  ].join("");

  const note = row.note_problem
    ? `<details><summary>${esc(row.note_problem)}</summary><p><b>Why:</b> ${esc(row.note_why)}</p><p><b>Fix:</b> ${esc(row.note_fix)}</p></details>`
    : `<span class="muted">No note. Their site failed: ${esc(String(row.status).replace(/_/g, " "))}</span>`;

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

  return `<tr data-id="${esc(row.id)}" data-domain="${esc(row.domain)}">
    <td class="nowrap">${esc(String(row.created_at).replace("T", " ").slice(0, 16))}${row.from_cache ? '<div class="muted">repeat site</div>' : ""}</td>
    <td>${safeLink(row.final_url || row.input_url, row.domain)}${row.site_title ? `<div class="muted">${esc(clip(row.site_title, 70))}</div>` : ""}${row.country ? `<div class="muted">Visitor in ${esc(row.country)}</div>` : ""}</td>
    <td class="wide">${note}</td>
    <td>${contact || '<span class="muted">None found</span>'}</td>
    <td class="work">
      ${stageSelect}
      ${ownerSelect}
      <textarea data-field="notes" rows="2" maxlength="4000" placeholder="Notes" aria-label="Notes for ${esc(row.domain)}">${esc(row.admin_notes)}</textarea>
      <div class="actions">
        ${mailto ? `<a class="btn small" data-action="email" href="${esc(mailto)}">Email them</a>` : ""}
        <button class="link danger" type="button" data-action="delete">Delete</button>
      </div>
      ${touched}
    </td>
  </tr>`;
}

function renderPage({ rows, stats, settings, filters, me, owners, hasCache }) {
  const tab = (stage, label, count) =>
    `<a class="tab${(filters.stage || "") === stage ? " on" : ""}" href="/teardown/admin${queryString(filters, { stage })}">${esc(label)} <span>${count}</span></a>`;

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

<div class="panel${settings.paused ? " paused" : ""}" id="settings">
  <div><h2 style="margin:0">Teardown controls</h2></div>
  <label><input type="checkbox" id="paused"${settings.paused ? " checked" : ""}> Pause new teardowns</label>
  <label>Free teardowns per visitor per day <input type="number" id="dailyLimit" min="1" max="100" value="${settings.dailyLimit}"></label>
  <span class="muted">${settings.paused ? "Paused. Visitors see a “check back soon” message and nothing is spent on audits." : "Live."}${hasCache ? "" : " The daily limit needs the cache turned on (see README)."}</span>
</div>

<nav class="tabs" aria-label="Filter by stage">
  ${tab("", "All", stats.total)}
  ${STAGES.map((s) => tab(s, STAGE_LABELS[s], stats.stages[s])).join("")}
</nav>

<form class="tools" method="get" action="/teardown/admin">
  ${filters.stage ? `<input type="hidden" name="stage" value="${esc(filters.stage)}">` : ""}
  <input type="search" name="q" value="${esc(filters.q)}" placeholder="Search site, email, note" aria-label="Search leads">
  <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" name="reachable" value="1"${filters.reachable ? " checked" : ""}> Only leads we can reach</label>
  <button class="btn small" type="submit">Filter</button>
  ${filters.q || filters.reachable ? `<a href="/teardown/admin${queryString({ stage: filters.stage })}">Clear</a>` : ""}
  <span class="muted">${rows.length} shown</span>
</form>

<div class="wrap"><table>
<thead><tr><th>When</th><th>Website</th><th>What we told them</th><th>Contact</th><th>Working it</th></tr></thead>
<tbody>${rows.map((r) => renderRow(r, me, owners)).join("") || '<tr><td colspan="5" class="muted">Nothing here yet.</td></tr>'}</tbody>
</table></div>

<div id="toast" role="status" aria-live="polite" hidden></div>
</main>
<script>
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
        if (!res.ok || !data.ok) throw new Error(data.error || "That didn't save.");
        return data;
      });
    });
  }
  document.addEventListener("change", function (e) {
    var field = e.target.getAttribute("data-field"), row = e.target.closest("tr[data-id]");
    if (field && row) {
      var body = { id: row.getAttribute("data-id") }; body[field] = e.target.value;
      send("lead", body).then(function () { say("Saved"); }).catch(function (err) { say(err.message, true); });
      return;
    }
    if (e.target.id === "paused" || e.target.id === "dailyLimit") {
      var change = e.target.id === "paused" ? { paused: e.target.checked } : { dailyLimit: Number(e.target.value) };
      send("settings", change).then(function () { say("Saved"); setTimeout(function () { location.reload(); }, 500); })
        .catch(function (err) { say(err.message, true); });
    }
  });
  document.addEventListener("click", function (e) {
    var action = e.target.getAttribute("data-action"), row = e.target.closest("tr[data-id]");
    if (!action || !row) return;
    var id = row.getAttribute("data-id");
    if (action === "delete") {
      if (!confirm("Delete the " + row.getAttribute("data-domain") + " lead for good? This can't be undone.")) return;
      send("delete", { id: id }).then(function () { row.remove(); say("Deleted"); }).catch(function (err) { say(err.message, true); });
    }
    if (action === "email") {
      // Opening your mail app counts as reaching out: move a new lead to Contacted.
      var stage = row.querySelector('[data-field="stage"]');
      if (stage && stage.value === "new") {
        stage.value = "contacted";
        send("lead", { id: id, stage: "contacted" }).then(function () { say("Marked as contacted"); }).catch(function (err) { say(err.message, true); });
      }
    }
  });
})();
</script>
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
      const found = await updateLead(env.DB, id, { stage: body.stage, owner: body.owner, notes: body.notes }, me);
      return found ? json({ ok: true }) : json({ ok: false, error: "That lead no longer exists." }, 404);
    }
    if (pathname === "/teardown/admin/api/delete") {
      if (!validId) return json({ ok: false, error: "Unknown lead." }, 400);
      const found = await deleteLead(env.DB, id);
      return found ? json({ ok: true }) : json({ ok: false, error: "That lead no longer exists." }, 404);
    }
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
  };

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
  if (pathname === "/teardown/admin/prompt") {
    const [active, versions] = await Promise.all([getActivePrompt(env.DB), listPromptVersions(env.DB)]);
    return new Response(renderPromptPage({ active, versions, me }), { headers: { "content-type": "text/html; charset=utf-8", ...PRIVATE_HEADERS } });
  }
  return text("Not found.", 404);
}
