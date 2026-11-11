// Brand Teardown: URL in, free note out, every teardown saved as a lead.
//
// Routes
//   POST /teardown/api/audit   { "url": "yourbrand.com" }        ->  { ok, leadId, domain, note }
//   POST /teardown/api/email   { "leadId": "...", "email": "" }  ->  { ok }
//   GET  /teardown/admin       private leads table (and /teardown/admin/leads.csv)
//   everything else            static files from ./public

import { TeardownError, normalizeUrl, safeFetchPage } from "./safe-fetch.js";
import { extractPage, extractContacts, mergeContacts, hasTooLittleContent } from "./extract.js";
import { runFreeAudit } from "./audit.js";
import { insertLead, updateContacts, saveVisitorEmail, getSettings, getActivePrompt, DEFAULT_SETTINGS } from "./leads.js";
import { handleAdmin } from "./admin.js";

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const EMAIL_SAVES_PER_IP_PER_DAY = 20;
const CACHE_VERSION = "v2";

// Failures worth keeping as leads: someone wanted an audit and their site let them down.
const LOGGED_FAILURES = new Set([
  "too_little_content", "bad_status", "timeout", "fetch_failed", "not_html", "too_many_redirects", "audit_failed",
]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function fail(err) {
  if (err instanceof TeardownError) {
    return json({ ok: false, error: { code: err.code, message: err.message } }, err.status);
  }
  console.error("Unexpected error", err?.stack || err);
  return json({ ok: false, error: { code: "server_error", message: "Something broke on our end. Try again in a minute." } }, 500);
}

export function domainOf(urlString) {
  return new URL(urlString).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

async function readJson(request) {
  if (!(request.headers.get("content-type") || "").includes("application/json")) {
    throw new TeardownError("bad_request", "Send JSON.", 415);
  }
  const raw = await request.text();
  if (raw.length > 4000) throw new TeardownError("bad_request", "That request is too big.", 413);
  try {
    return JSON.parse(raw);
  } catch {
    throw new TeardownError("bad_request", "Send JSON.", 400);
  }
}

// The counter is read-then-write, so two requests landing at the same instant
// can both slip through. Fine for a usage cap; not a security boundary.
async function checkRateLimit(env, bucket, ip, limit, message) {
  if (!env.TEARDOWN_KV || !ip) return;
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:${bucket}:${ip}:${day}`;
  const used = parseInt((await env.TEARDOWN_KV.get(key)) || "0", 10);
  if (used >= limit) throw new TeardownError("rate_limited", message, 429);
  await env.TEARDOWN_KV.put(key, String(used + 1), { expirationTtl: CACHE_TTL_SECONDS });
}

// Saving a lead must never cost the visitor their audit.
async function recordLead(env, lead) {
  if (!env.DB) return;
  try {
    await insertLead(env.DB, lead);
  } catch (err) {
    console.error("Could not save lead", err?.stack || err);
  }
}

// Homepages often hide the email on a contact page. Look at one, on the same site only.
async function enrichContacts(contacts, siteUrl) {
  if (!contacts.contactPage || (contacts.emails.length && contacts.phones.length)) return contacts;
  try {
    const fetched = await safeFetchPage(contacts.contactPage);
    if (domainOf(fetched.finalUrl) !== domainOf(siteUrl)) return contacts;
    return mergeContacts(contacts, extractContacts(fetched.html, fetched.finalUrl));
  } catch {
    return contacts;
  }
}

async function handleAudit(request, env, ctx) {
  const body = await readJson(request);
  const url = normalizeUrl(body?.url);
  const inputUrl = url.toString();
  const kv = env.TEARDOWN_KV;
  const ip = request.headers.get("cf-connecting-ip");

  const lead = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    inputUrl,
    domain: domainOf(inputUrl),
    country: request.cf?.country || request.headers.get("cf-ipcountry") || null,
  };

  // Ned and Brian can pause teardowns, change the daily cap and edit the auditor prompt from the back office.
  let settings = DEFAULT_SETTINGS;
  let auditor = { version: 0, prompt: "" };
  if (env.DB) {
    [settings, auditor] = await Promise.all([
      getSettings(env.DB).catch(() => DEFAULT_SETTINGS),
      getActivePrompt(env.DB).catch(() => ({ version: 0, prompt: "" })),
    ]);
  }
  lead.promptVersion = auditor.version;

  // Cached by the domain they typed, so repeat visitors cost nothing. A new prompt starts a fresh cache.
  const cacheKey = `note:${CACHE_VERSION}:p${auditor.version}:${lead.domain}`;
  if (kv) {
    const hit = await kv.get(cacheKey, "json");
    if (hit?.result?.note) {
      await recordLead(env, {
        ...lead, status: "ok", fromCache: true, finalUrl: hit.result.url, domain: hit.result.domain,
        note: hit.result.note, contacts: hit.contacts, socialLinks: hit.socialLinks, siteTitle: hit.siteTitle,
      });
      return json({ ok: true, cached: true, leadId: lead.id, ...hit.result });
    }
  }

  if (!env.ANTHROPIC_API_KEY) {
    throw new TeardownError("not_configured", "The teardown isn't switched on yet. Check back soon.", 503);
  }
  if (settings.paused) {
    throw new TeardownError("paused", "Teardowns are paused right now. Check back soon.", 503);
  }
  await checkRateLimit(env, "ip", ip, settings.dailyLimit, "That's enough free teardowns for one day. Come back tomorrow.");

  let fetched, page, contacts, note;
  try {
    fetched = await safeFetchPage(url);
    page = extractPage(fetched.html, fetched.finalUrl);
    contacts = extractContacts(fetched.html, fetched.finalUrl);
    if (hasTooLittleContent(page)) {
      throw new TeardownError(
        "too_little_content",
        "We loaded your site but found almost no text on it. It may be built so that content only shows up in a browser, or it may just be empty. Either way we won't make up an audit.",
      );
    }
    note = await runFreeAudit(page, env, fetch, auditor.prompt);
  } catch (err) {
    if (err instanceof TeardownError && LOGGED_FAILURES.has(err.code)) {
      await recordLead(env, {
        ...lead, status: err.code, finalUrl: fetched?.finalUrl, contacts, socialLinks: page?.socialLinks, siteTitle: page?.title,
      });
    }
    throw err;
  }

  // Only this goes back to the visitor. Contact details stay on our side.
  const result = { domain: domainOf(fetched.finalUrl), url: fetched.finalUrl, note, auditedAt: lead.createdAt };

  await recordLead(env, {
    ...lead, status: "ok", fromCache: false, finalUrl: fetched.finalUrl, domain: result.domain,
    note, contacts, socialLinks: page.socialLinks, siteTitle: page.title,
  });

  // After the visitor has their answer: check the contact page, then cache.
  const afterwards = (async () => {
    const full = await enrichContacts(contacts, fetched.finalUrl);
    if (full !== contacts && env.DB) await updateContacts(env.DB, lead.id, full);
    if (kv) {
      await kv.put(
        cacheKey,
        JSON.stringify({ result, contacts: full, socialLinks: page.socialLinks, siteTitle: page.title }),
        { expirationTtl: CACHE_TTL_SECONDS },
      );
    }
  })().catch((err) => console.error("Follow-up work failed", err?.stack || err));
  if (ctx?.waitUntil) ctx.waitUntil(afterwards);
  else await afterwards;

  return json({ ok: true, cached: false, leadId: lead.id, ...result });
}

async function handleEmail(request, env) {
  const body = await readJson(request);
  const leadId = String(body?.leadId ?? "");
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(leadId)) throw new TeardownError("bad_request", "Run a teardown first.", 400);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new TeardownError("bad_email", "That email doesn't look right.", 400);
  }
  if (!env.DB) throw new TeardownError("not_configured", "We can't save that right now. Email hello@ihatemybrand.com instead.", 503);
  await checkRateLimit(env, "email", request.headers.get("cf-connecting-ip"), EMAIL_SAVES_PER_IP_PER_DAY, "That's a lot of emails for one day. Try again tomorrow.");
  const saved = await saveVisitorEmail(env.DB, leadId, email);
  if (!saved) throw new TeardownError("bad_request", "We couldn't find that teardown. Run it again.", 404);
  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    const api = { "/teardown/api/audit": handleAudit, "/teardown/api/email": handleEmail }[pathname];
    if (api) {
      if (request.method !== "POST") {
        return json({ ok: false, error: { code: "method_not_allowed", message: "POST only." } }, 405);
      }
      try {
        return await api(request, env, ctx);
      } catch (err) {
        return fail(err);
      }
    }

    if (pathname === "/teardown/admin" || pathname.startsWith("/teardown/admin/")) {
      try {
        return await handleAdmin(request, env, pathname, ctx);
      } catch (err) {
        console.error("Admin error", err?.stack || err);
        return new Response("Something broke loading the leads.", { status: 500 });
      }
    }

    if (pathname === "/") return Response.redirect(new URL("/teardown/", request.url).toString(), 302);
    return env.ASSETS.fetch(request);
  },
};
