import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeUrl, isPublicIp, safeFetchPage, TeardownError } from "../src/safe-fetch.js";
import { extractPage, hasTooLittleContent, decodeEntities } from "../src/extract.js";
import worker, { domainOf } from "../src/index.js";

const SAMPLE = `<!doctype html><html><head>
<title>Acme &amp; Co | Solutions</title>
<meta name="description" content="We deliver synergy.">
<meta property="og:image" content="/og.png">
<meta name="viewport" content="width=device-width">
<script>var secret = "do not leak";</script><style>.x{color:red}</style>
</head><body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<h1>Empowering <span>Tomorrow</span></h1>
<h2>What we do</h2>
<p>${"We leverage best in class solutions for forward thinking teams. ".repeat(8)}</p>
<a class="btn btn-primary" href="/contact">Learn More</a>
<button type="submit">Submit</button>
<a href="https://www.instagram.com/acme">IG</a>
<a href="https://notinstagram.com.evil.io/x">fake</a>
<img src="/a.png" alt="Team photo"><img src="/b.png">
<!-- <h1>commented out</h1> -->
</body></html>`;

// ---------- URL rules ----------

test("accepts ordinary sites and adds https", () => {
  assert.equal(normalizeUrl("example.com").toString(), "https://example.com/");
  assert.equal(normalizeUrl("  http://www.Example.com/path#frag ").toString(), "http://www.example.com/path");
});

test("blocks private, internal and odd targets", () => {
  const bad = [
    "localhost", "localhost:8080", "http://127.0.0.1", "http://2130706433", "http://0x7f.1",
    "http://10.0.0.5", "http://192.168.1.1/admin", "http://169.254.169.254/latest/meta-data",
    "http://[::1]", "http://[fd00::1]", "https://8.8.8.8", "intranet", "printer.local",
    "db.internal", "foo.localhost", "https://example.com:8443", "https://user:pw@example.com",
    "ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "", "two words.com",
  ];
  for (const input of bad) {
    assert.throws(() => normalizeUrl(input), TeardownError, `should block: ${input}`);
  }
});

test("classifies IP addresses", () => {
  for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700::1111"]) assert.equal(isPublicIp(ip), true, ip);
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fd12::1",
    "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "2001:db8::1", "64:ff9b::a00:1", "junk",
  ]) assert.equal(isPublicIp(ip), false, ip);
});

// ---------- fetching ----------

function dnsResponse(url, table) {
  const u = new URL(url);
  const name = u.searchParams.get("name");
  const type = u.searchParams.get("type");
  const ips = (table[name] || {})[type] || [];
  return Response.json({ Status: 0, Answer: ips.map((data) => ({ type: type === "A" ? 1 : 28, data })) });
}

function fakeNet({ dns, pages }) {
  const calls = [];
  const impl = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith("https://api.anthropic.com/") && init.body && String(init.body).includes('"lead_analysis"')) {
      return pages.__analysis ? pages.__analysis(init) : new Response("no analysis in this test", { status: 500 });
    }
    calls.push(url);
    if (url.startsWith("https://cloudflare-dns.com/")) return dnsResponse(url, dns);
    const page = pages[url];
    if (!page) throw new TypeError("fetch failed");
    return typeof page === "function" ? page(init) : page;
  };
  impl.calls = calls;
  return impl;
}

const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const redirect = (to) => new Response(null, { status: 302, headers: { location: to } });

test("fetches a public page and follows a safe redirect", async () => {
  const net = fakeNet({
    dns: { "acme.com": { A: ["93.184.216.34"] }, "www.acme.com": { A: ["93.184.216.34"] } },
    pages: { "https://acme.com/": redirect("https://www.acme.com/"), "https://www.acme.com/": html(SAMPLE) },
  });
  const out = await safeFetchPage("acme.com", { fetchImpl: net });
  assert.equal(out.finalUrl, "https://www.acme.com/");
  assert.match(out.html, /Empowering/);
});

test("refuses a hostname that resolves to a private address", async () => {
  const net = fakeNet({ dns: { "sneaky.com": { A: ["10.0.0.7"] } }, pages: { "https://sneaky.com/": html("secret") } });
  await assert.rejects(safeFetchPage("sneaky.com", { fetchImpl: net }), { code: "blocked" });
  assert.ok(!net.calls.includes("https://sneaky.com/"), "must not fetch the page at all");
});

test("refuses when only one of several addresses is private", async () => {
  const net = fakeNet({ dns: { "mixed.com": { A: ["93.184.216.34"], AAAA: ["::1"] } }, pages: {} });
  await assert.rejects(safeFetchPage("mixed.com", { fetchImpl: net }), { code: "blocked" });
});

test("refuses redirects into private space", async () => {
  for (const target of ["http://169.254.169.254/latest/meta-data/", "http://localhost/admin", "http://inside.corp/"]) {
    const net = fakeNet({ dns: { "bounce.com": { A: ["93.184.216.34"] } }, pages: { "https://bounce.com/": redirect(target) } });
    await assert.rejects(safeFetchPage("bounce.com", { fetchImpl: net }), { code: "blocked" }, target);
    assert.ok(!net.calls.includes(target));
  }
});

test("reports unknown domains, error statuses, non-HTML and redirect loops", async () => {
  await assert.rejects(safeFetchPage("nope-nothing.com", { fetchImpl: fakeNet({ dns: {}, pages: {} }) }), { code: "not_found" });

  const dns = { "acme.com": { A: ["93.184.216.34"] } };
  await assert.rejects(
    safeFetchPage("acme.com", { fetchImpl: fakeNet({ dns, pages: { "https://acme.com/": html("no", 403) } }) }),
    { code: "bad_status" },
  );
  await assert.rejects(
    safeFetchPage("acme.com", {
      fetchImpl: fakeNet({ dns, pages: { "https://acme.com/": new Response("%PDF", { headers: { "content-type": "application/pdf" } }) } }),
    }),
    { code: "not_html" },
  );
  await assert.rejects(
    safeFetchPage("acme.com", { fetchImpl: fakeNet({ dns, pages: { "https://acme.com/": () => redirect("https://acme.com/") } }) }),
    { code: "too_many_redirects" },
  );
});

test("caps oversized pages", async () => {
  const big = "<p>" + "a".repeat(3_000_000);
  const net = fakeNet({ dns: { "big.com": { A: ["93.184.216.34"] } }, pages: { "https://big.com/": html(big) } });
  const out = await safeFetchPage("big.com", { fetchImpl: net });
  assert.equal(out.truncated, true);
  assert.equal(out.html.length, 2_000_000);
});

// ---------- extraction ----------

test("extracts what the auditor needs", () => {
  const page = extractPage(SAMPLE, "https://www.acme.com/");
  assert.equal(page.title, "Acme & Co | Solutions");
  assert.equal(page.metaDescription, "We deliver synergy.");
  assert.equal(page.hasOgImage, true);
  assert.equal(page.hasViewportMeta, true);
  assert.deepEqual(page.headings, [{ level: "h1", text: "Empowering Tomorrow" }, { level: "h2", text: "What we do" }]);
  assert.deepEqual(page.nav, ["Home", "About"]);
  assert.deepEqual(page.ctas, ["Learn More", "Submit"]);
  assert.deepEqual(page.socialLinks, ["https://www.instagram.com/acme"]);
  assert.equal(page.imageCount, 2);
  assert.equal(page.imagesMissingAlt, 1);
  assert.ok(page.wordCount > 60);
  assert.doesNotMatch(page.bodyText, /do not leak|color:red|commented out/);
  assert.equal(hasTooLittleContent(page), false);
});

test("flags empty and JavaScript-only pages", () => {
  const shell = `<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;
  assert.equal(hasTooLittleContent(extractPage(shell, "https://app.com/")), true);
  assert.equal(hasTooLittleContent(extractPage("", "https://app.com/")), true);
});

test("decodes entities without choking on junk", () => {
  assert.equal(decodeEntities("a &amp; b &#39;c&#x27; &bogus; &#99999999;"), "a & b 'c' &bogus; &#99999999;");
});

// ---------- the whole route ----------

function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function post(body, headers = {}) {
  return new Request("https://ihatemybrand.com/teardown/api/audit", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function withNet(net, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = net;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

function claudeReply(input) {
  return (init) => {
    claudeReply.last = { headers: init.headers, body: JSON.parse(init.body) };
    return Response.json({ content: [{ type: "tool_use", name: "free_note", input }] });
  };
}

const GOOD_NOTE = {
  can_audit: true,
  problem: "Nobody can tell what you sell.",
  why_its_costing_them: 'Your headline says "Empowering Tomorrow". That could be a bank or a gym.',
  fix: 'Say the thing. "Payroll software for restaurants."',
};

const acmeNet = (claude) =>
  fakeNet({
    dns: { "acme.com": { A: ["93.184.216.34"] } },
    pages: { "https://acme.com/": html(SAMPLE), "https://api.anthropic.com/v1/messages": claude },
  });

test("end to end: URL in, free note out, then served from cache", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test", TEARDOWN_KV: fakeKV() };
  const net = acmeNet(claudeReply(GOOD_NOTE));

  const first = await withNet(net, async () => (await worker.fetch(post({ url: "acme.com" }), env, {})).json());
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(first.domain, "acme.com");
  assert.equal(first.note.problem, GOOD_NOTE.problem);
  assert.equal(first.note.why, GOOD_NOTE.why_its_costing_them);
  assert.equal(first.note.fix, GOOD_NOTE.fix);
  assert.equal(first.shot, undefined, "no browser binding, so no screenshot");

  const sent = claudeReply.last;
  assert.equal(sent.headers["x-api-key"], "sk-test");
  assert.deepEqual(sent.body.tool_choice, { type: "auto" });
  assert.equal(sent.body.tools[0].name, "free_note");
  assert.match(sent.body.system, /brand auditor for I Hate Social/);
  assert.match(sent.body.messages[0].content, /MODE: FREE[\s\S]*Empowering Tomorrow/);

  const before = net.calls.length;
  const second = await withNet(net, async () => (await worker.fetch(post({ url: "https://www.acme.com/pricing" }), env, {})).json());
  assert.equal(second.cached, true);
  assert.equal(second.note.problem, GOOD_NOTE.problem);
  assert.equal(net.calls.length, before, "cache hit must make no network calls");
});

test("never invents an audit", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test", TEARDOWN_KV: fakeKV() };

  // Auditor declines.
  let res = await withNet(acmeNet(claudeReply({ can_audit: false, reason: "This is a parked domain page." })), () =>
    worker.fetch(post({ url: "acme.com" }), env, {}));
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.message, "This is a parked domain page.");

  // Auditor returns half an answer.
  res = await withNet(acmeNet(claudeReply({ can_audit: true, problem: "Hm." })), () => worker.fetch(post({ url: "acme.com" }), env, {}));
  assert.equal(res.status, 502);

  // Claude API is down.
  res = await withNet(acmeNet(() => new Response("overloaded", { status: 529 })), () => worker.fetch(post({ url: "acme.com" }), env, {}));
  assert.equal(res.status, 502);

  // Empty site: the auditor is never called.
  const emptyNet = fakeNet({ dns: { "acme.com": { A: ["93.184.216.34"] } }, pages: { "https://acme.com/": html("<html><body></body></html>") } });
  res = await withNet(emptyNet, () => worker.fetch(post({ url: "acme.com" }), env, {}));
  assert.equal((await res.json()).error.code, "too_little_content");
  assert.ok(!emptyNet.calls.some((u) => u.includes("anthropic")));

  assert.equal([...env.TEARDOWN_KV.store.keys()].filter((k) => k.startsWith("note:")).length, 0, "failures are not cached");
});

test("rejects bad input and missing setup", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test" };
  const none = fakeNet({ dns: {}, pages: {} });
  const code = async (req, e = env) => (await (await withNet(none, () => worker.fetch(req, e, {}))).json()).error.code;

  assert.equal(await code(post({ url: "http://169.254.169.254/" })), "blocked");
  assert.equal(await code(post({ url: "" })), "bad_url");
  assert.equal(await code(post({})), "bad_url");
  assert.equal(await code(post("not json")), "bad_request");
  assert.equal(await code(post({ url: "acme.com" }, { "content-type": "text/plain" })), "bad_request");
  assert.equal(await code(post({ url: "acme.com" }), {}), "not_configured");
  assert.equal(await code(new Request("https://ihatemybrand.com/teardown/api/audit")), "method_not_allowed");
  assert.equal(none.calls.length, 0);
});

test("limits free audits per IP per day", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test", TEARDOWN_KV: fakeKV() };
  const dns = {};
  const pages = { "https://api.anthropic.com/v1/messages": claudeReply(GOOD_NOTE) };
  for (let i = 0; i < 6; i++) {
    dns[`site${i}.com`] = { A: ["93.184.216.34"] };
    pages[`https://site${i}.com/`] = () => html(SAMPLE);
  }
  const net = fakeNet({ dns, pages });
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    statuses.push((await withNet(net, () => worker.fetch(post({ url: `site${i}.com` }), env, {}))).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);

  const other = await withNet(net, () => worker.fetch(post({ url: "site5.com" }, { "cf-connecting-ip": "198.51.100.4" }), env, {}));
  assert.equal(other.status, 200, "a different visitor is not affected");
});

test("serves the page and helpers", async () => {
  const env = { ASSETS: { fetch: async () => new Response("page") } };
  assert.equal(await (await worker.fetch(new Request("https://x.com/teardown/"), env, {})).text(), "page");
  const local = await worker.fetch(new Request("http://localhost/"), env, {});
  assert.equal(local.headers.get("location"), "http://localhost/teardown/");
  assert.equal(domainOf("https://WWW.Acme.com/pricing"), "acme.com");
});

// ---------- leads ----------

import { DatabaseSync } from "node:sqlite";
import { extractContacts } from "../src/extract.js";
import { toCsv } from "../src/leads.js";

// A stand-in for Cloudflare D1 backed by real SQLite, so the SQL itself is checked.
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  return {
    rows: () => db.prepare("SELECT * FROM teardowns ORDER BY created_at").all(),
    prepare(sql) {
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
      };
      return api;
    },
  };
}

const CONTACT_HOME = `<html><head><title>Bob's Auto</title>
<script type="application/ld+json">{"@type":"AutoRepair","telephone":"+1-732-555-0142","email":"service@bobsauto.com"}</script>
</head><body><h1>Quality service since 1987</h1>
<p>${"We fix cars and trucks for people all over town every single day. ".repeat(6)}</p>
<a href="/contact-us">Contact</a> <a href="tel:(732) 555-0142">Call</a>
<a href="https://facebook.com/bobsauto">FB</a>
<img src="logo@2x.png"> <p>Questions? you@example.com or name@domain.com</p>
<a href="/cdn-cgi/l/email-protection" data-cfemail="${cf("bob@bobsauto.com")}">[email&#160;protected]</a>
</body></html>`;
const CONTACT_PAGE = `<html><body><h1>Contact us</h1><p>Email <a href="mailto:Hello@BobsAuto.com?subject=Hi">us</a> or call 732.555.0199. Fax 12345.</p></body></html>`;

function cf(email) {
  const key = 0x5a;
  return [key, ...[...email].map((c) => c.charCodeAt(0) ^ key)].map((n) => n.toString(16).padStart(2, "0")).join("");
}

test("finds published contact details and ignores junk", () => {
  const c = extractContacts(CONTACT_HOME, "https://bobsauto.com/");
  assert.deepEqual(c.emails, ["service@bobsauto.com", "bob@bobsauto.com"]);
  assert.deepEqual(c.phones, ["+17325550142"]);
  assert.equal(c.contactPage, "https://bobsauto.com/contact-us");
  const none = extractContacts(`<p>Call 2024-11-10 or order 1234567890123. <a href="https://elsewhere.com/contact">Contact</a></p>`, "https://x.com/");
  assert.deepEqual(none, { emails: [], phones: [], contactPage: null });
});

function bobNet(claude) {
  return fakeNet({
    dns: { "bobsauto.com": { A: ["93.184.216.34"] } },
    pages: {
      "https://bobsauto.com/": () => html(CONTACT_HOME),
      "https://bobsauto.com/contact-us": () => html(CONTACT_PAGE),
      "https://api.anthropic.com/v1/messages": claude,
    },
  });
}

test("saves every teardown as a lead, with contacts, and keeps contacts out of the response", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test", TEARDOWN_KV: fakeKV(), DB: fakeD1() };
  const net = bobNet(claudeReply(GOOD_NOTE));
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };

  const res = await withNet(net, async () => {
    const r = await worker.fetch(post({ url: "bobsauto.com" }, { "cf-ipcountry": "US" }), env, ctx);
    await Promise.all(pending);
    return r.json();
  });
  assert.equal(res.ok, true);
  assert.match(res.leadId, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(JSON.stringify(res), /service@|hello@|5550142|contact-us/i, "contact details never go to the visitor");

  let rows = env.DB.rows();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, res.leadId);
  assert.equal(row.domain, "bobsauto.com");
  assert.equal(row.status, "ok");
  assert.equal(row.site_title, "Bob's Auto");
  assert.equal(row.note_problem, GOOD_NOTE.problem);
  assert.equal(row.note_fix, GOOD_NOTE.fix);
  assert.equal(row.country, "US");
  assert.deepEqual(JSON.parse(row.site_emails), ["service@bobsauto.com", "bob@bobsauto.com"]);
  assert.deepEqual(JSON.parse(row.site_phones), ["+17325550142"]);
  assert.equal(row.contact_page, "https://bobsauto.com/contact-us");
  assert.deepEqual(JSON.parse(row.social_links), ["https://facebook.com/bobsauto"]);

  // A second visitor entering the same site is a second lead, served from cache.
  const again = await withNet(net, async () => (await worker.fetch(post({ url: "www.bobsauto.com" }), env, ctx)).json());
  assert.equal(again.cached, true);
  rows = env.DB.rows();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].from_cache, 1);
  assert.equal(rows[1].note_problem, GOOD_NOTE.problem);
  assert.deepEqual(JSON.parse(rows[1].site_emails), ["service@bobsauto.com", "bob@bobsauto.com"]);
});

test("checks the contact page when the homepage has no email", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test", DB: fakeD1() };
  const bare = CONTACT_HOME.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "").replace(/<a href="\/cdn-cgi[\s\S]*?<\/a>/, "");
  const net = bobNet(claudeReply(GOOD_NOTE));
  const home = "https://bobsauto.com/";
  const withBare = async (url, init) => (String(url) === home ? html(bare) : net(url, init));
  await withNet(withBare, () => worker.fetch(post({ url: "bobsauto.com" }), env, {}));
  const row = env.DB.rows()[0];
  assert.deepEqual(JSON.parse(row.site_emails), ["hello@bobsauto.com"]);
  assert.deepEqual(JSON.parse(row.site_phones), ["+17325550142", "+17325550199"]);
});

test("keeps failed sites as leads, but not blocked or mistyped addresses", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test", DB: fakeD1() };
  const net = fakeNet({ dns: { "down.com": { A: ["93.184.216.34"] } }, pages: { "https://down.com/": html("no", 503) } });
  await withNet(net, () => worker.fetch(post({ url: "down.com" }), env, {}));
  await withNet(net, () => worker.fetch(post({ url: "http://10.0.0.1" }), env, {}));
  await withNet(net, () => worker.fetch(post({ url: "no-such-site.com" }), env, {}));
  const rows = env.DB.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "bad_status");
  assert.equal(rows[0].note_problem, null);
});

test("a storage failure never costs the visitor their note", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test", DB: { prepare() { throw new Error("db down"); } } };
  const res = await withNet(acmeNet(claudeReply(GOOD_NOTE)), () => worker.fetch(post({ url: "acme.com" }), env, {}));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).note.problem, GOOD_NOTE.problem);
});

function emailPost(body) {
  return new Request("https://ihatemybrand.com/teardown/api/email", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

test("saves the visitor's email onto their teardown", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test", DB: fakeD1() };
  const first = await withNet(acmeNet(claudeReply(GOOD_NOTE)), async () => (await worker.fetch(post({ url: "acme.com" }), env, {})).json());

  let res = await worker.fetch(emailPost({ leadId: first.leadId, email: " Owner@Acme.com " }), env, {});
  assert.equal(res.status, 200);
  assert.equal(env.DB.rows()[0].visitor_email, "owner@acme.com");

  res = await worker.fetch(emailPost({ leadId: first.leadId, email: "not-an-email" }), env, {});
  assert.equal((await res.json()).error.code, "bad_email");
  res = await worker.fetch(emailPost({ leadId: "00000000-0000-4000-8000-000000000000", email: "a@b.co" }), env, {});
  assert.equal(res.status, 404);
  res = await worker.fetch(emailPost({ leadId: "x'; DROP TABLE teardowns;--", email: "a@b.co" }), env, {});
  assert.equal(res.status, 400);
  assert.equal(env.DB.rows().length, 1);
});

test("admin is locked, and shows leads safely once unlocked", async () => {
  const db = fakeD1();
  const env = { ANTHROPIC_API_KEY: "sk-test", DB: db, ADMIN_PASSWORD: "correct horse" };
  const evil = { ...GOOD_NOTE, problem: '<script>alert(1)</script> "Quality"', fix: "=HYPERLINK(\"http://evil\")" };
  await withNet(bobNet(claudeReply(evil)), () => worker.fetch(post({ url: "bobsauto.com" }), env, {}));

  const get = (path, password, e = env) =>
    worker.fetch(new Request("https://ihatemybrand.com" + path, password === undefined ? {} : { headers: { authorization: "Basic " + btoa("ned:" + password) } }), e, {});

  assert.equal((await get("/teardown/admin")).status, 401);
  assert.equal((await get("/teardown/admin", "wrong")).status, 401);
  assert.equal((await get("/teardown/admin/leads.csv", "")).status, 401);
  assert.equal((await get("/teardown/admin", "x", { DB: db })).status, 503, "no password set means locked, not open");

  const page = await get("/teardown/admin", "correct horse");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const body = await page.text();
  assert.match(body, /bobsauto\.com/);
  assert.match(body, /service@bobsauto\.com/);
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(body, /<script>alert/);

  const csv = await get("/teardown/admin/leads.csv", "correct horse");
  assert.match(csv.headers.get("content-disposition"), /teardown-leads-.*\.csv/);
  const text = await csv.text();
  const [header, line] = text.trim().split("\r\n");
  assert.match(header, /^created_at,domain,status,visitor_email,site_emails,site_phones/);
  assert.match(line, /bobsauto\.com,ok,,service@bobsauto\.com; bob@bobsauto\.com,'\+17325550142,https:\/\/bobsauto\.com\/contact-us/);
  assert.match(line, /"'=HYPERLINK\(""http:\/\/evil""\)"/, "formulas are defused");

  assert.equal(toCsv([]).trim().split(",").length, 23);
});

// ---------- back office ----------

import { outreachMailto } from "../src/admin.js";

const USERS = "ned:nedpass-1, brian:brianpass-2";
const ORIGIN = "https://ihatemybrand.com";
const basic = (user, pw) => ({ authorization: "Basic " + btoa(user + ":" + pw) });

function admin(env, path, { user = "ned", pw = "nedpass-1", body, origin = ORIGIN, type = "application/json" } = {}) {
  const headers = { ...basic(user, pw) };
  const init = { headers };
  if (body !== undefined) {
    init.method = "POST";
    init.body = JSON.stringify(body);
    if (origin) headers.origin = origin;
    if (type) headers["content-type"] = type;
  }
  return worker.fetch(new Request(ORIGIN + path, init), env, {});
}

async function seeded() {
  const env = { ANTHROPIC_API_KEY: "sk-test", DB: fakeD1(), ADMIN_USERS: USERS };
  await withNet(bobNet(claudeReply(GOOD_NOTE)), () => worker.fetch(post({ url: "bobsauto.com" }), env, {}));
  await withNet(acmeNet(claudeReply(GOOD_NOTE)), () => worker.fetch(post({ url: "acme.com" }), env, {}));
  const rows = env.DB.rows();
  return { env, bob: rows.find((r) => r.domain === "bobsauto.com"), acme: rows.find((r) => r.domain === "acme.com") };
}

test("each founder signs in with their own password", async () => {
  const { env } = await seeded();
  assert.equal((await admin(env, "/teardown/admin")).status, 200);
  assert.match(await (await admin(env, "/teardown/admin", { user: "Brian", pw: "brianpass-2" })).text(), /Signed in as Brian/);
  assert.equal((await admin(env, "/teardown/admin", { user: "ned", pw: "brianpass-2" })).status, 401, "no borrowing passwords");
  assert.equal((await admin(env, "/teardown/admin", { user: "mallory", pw: "nedpass-1" })).status, 401);
  assert.equal((await admin(env, "/teardown/admin", { user: "ned", pw: "" })).status, 401);
  assert.equal((await worker.fetch(new Request(ORIGIN + "/teardown/admin"), env, {})).status, 401);
  assert.equal((await worker.fetch(new Request(ORIGIN + "/teardown/admin"), { DB: env.DB }, {})).status, 503);
});

test("works a lead: stage, owner, notes, stamped with who did it", async () => {
  const { env, bob } = await seeded();
  let res = await admin(env, "/teardown/admin/api/lead", { user: "brian", pw: "brianpass-2", body: { id: bob.id, stage: "contacted", owner: "Ned", notes: "Called, left voicemail" } });
  assert.deepEqual(await res.json(), { ok: true });
  const row = env.DB.rows().find((r) => r.id === bob.id);
  assert.equal(row.stage, "contacted");
  assert.equal(row.owner, "ned");
  assert.equal(row.admin_notes, "Called, left voicemail");
  assert.equal(row.updated_by, "brian");
  assert.ok(row.updated_at);

  res = await admin(env, "/teardown/admin/api/lead", { body: { id: bob.id, stage: "hacked" } });
  assert.equal(res.status, 400);
  res = await admin(env, "/teardown/admin/api/lead", { body: { id: "11111111-1111-4111-8111-111111111111", stage: "won" } });
  assert.equal(res.status, 404);
  assert.equal(env.DB.rows().find((r) => r.id === bob.id).stage, "contacted");

  const page = await (await admin(env, "/teardown/admin")).text();
  assert.match(page, /<option value="contacted" selected>/);
  assert.match(page, /Called, left voicemail/);
  assert.match(page, /Changed by Brian/);
});

test("refuses changes that don't come from the admin page itself", async () => {
  const { env, bob } = await seeded();
  const change = { id: bob.id, stage: "won" };
  assert.equal((await admin(env, "/teardown/admin/api/lead", { body: change, origin: "https://evil.example" })).status, 403);
  assert.equal((await admin(env, "/teardown/admin/api/lead", { body: change, origin: null })).status, 403);
  assert.equal((await admin(env, "/teardown/admin/api/delete", { body: { id: bob.id }, type: "text/plain" })).status, 403);
  assert.equal((await admin(env, "/teardown/admin/api/delete", { body: { id: bob.id }, pw: "wrong" })).status, 401);
  const row = env.DB.rows().find((r) => r.id === bob.id);
  assert.equal(row.stage, "new");
});

test("filters, searches, counts and exports", async () => {
  const { env, bob } = await seeded();
  await admin(env, "/teardown/admin/api/lead", { body: { id: bob.id, stage: "won" } });

  const text = async (path) => (await admin(env, path)).text();
  const shows = (page, domain) => new RegExp(`data-domain="${domain.replace(".", "\\.")}"`).test(page);

  let page = await text("/teardown/admin");
  assert.ok(shows(page, "bobsauto.com") && shows(page, "acme.com"));
  assert.match(page, /<b>2<\/b>all time/);
  assert.match(page, /<b>1<\/b>with a way to reach them/);
  assert.match(page, /<b>1<\/b>won/);

  page = await text("/teardown/admin?stage=won");
  assert.ok(shows(page, "bobsauto.com") && !shows(page, "acme.com"));
  page = await text("/teardown/admin?reachable=1");
  assert.ok(shows(page, "bobsauto.com") && !shows(page, "acme.com"));
  page = await text("/teardown/admin?q=ACME");
  assert.ok(!shows(page, "bobsauto.com") && shows(page, "acme.com"));
  page = await text("/teardown/admin?q=service%40bobs");
  assert.ok(shows(page, "bobsauto.com") && !shows(page, "acme.com"));
  page = await text("/teardown/admin?q=%25");
  assert.ok(!shows(page, "bobsauto.com") && !shows(page, "acme.com"), "% is a plain character, not a wildcard");
  page = await text("/teardown/admin?q=%22%3E%3Cscript%3Ex");
  assert.doesNotMatch(page, /"><script>x/);

  const csv = await text("/teardown/admin/leads.csv?stage=won");
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /country,stage,owner,admin_notes,prompt_version,lead_score,follow_up,id$/);
  assert.match(lines[1], /,won,,,0,\d+,,[0-9a-f-]{36}$/);
});

test("deletes a lead for good", async () => {
  const { env, bob } = await seeded();
  assert.deepEqual(await (await admin(env, "/teardown/admin/api/delete", { body: { id: bob.id } })).json(), { ok: true });
  assert.deepEqual(env.DB.rows().map((r) => r.domain), ["acme.com"]);
  assert.equal((await admin(env, "/teardown/admin/api/delete", { body: { id: bob.id } })).status, 404);
});

test("pause switch and daily limit control the public teardown", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test", DB: fakeD1(), TEARDOWN_KV: fakeKV(), ADMIN_USERS: USERS };
  const dns = {};
  const pages = { "https://api.anthropic.com/v1/messages": claudeReply(GOOD_NOTE) };
  for (let i = 0; i < 4; i++) {
    dns[`shop${i}.com`] = { A: ["93.184.216.34"] };
    pages[`https://shop${i}.com/`] = () => html(SAMPLE);
  }
  const net = fakeNet({ dns, pages });
  const run = (i) => withNet(net, () => worker.fetch(post({ url: `shop${i}.com` }), env, {}));

  assert.equal((await admin(env, "/teardown/admin/api/settings", { body: { dailyLimit: 0 } })).status, 400);
  assert.equal((await admin(env, "/teardown/admin/api/settings", { body: { dailyLimit: 2 } })).status, 200);
  assert.deepEqual([(await run(0)).status, (await run(1)).status, (await run(2)).status], [200, 200, 429]);

  const paused = await (await admin(env, "/teardown/admin/api/settings", { body: { paused: true } })).json();
  assert.deepEqual(paused.settings, { paused: true, dailyLimit: 2, alertTo: "" });
  const calls = net.calls.length;
  const blocked = await run(3);
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).error.code, "paused");
  assert.equal(net.calls.length, calls, "nothing is fetched or spent while paused");
  assert.equal((await run(0)).status, 200, "sites already audited today still load from cache");
  assert.match(await (await admin(env, "/teardown/admin")).text(), /id="paused" checked/);

  await admin(env, "/teardown/admin/api/settings", { body: { paused: false, dailyLimit: 10 } });
  assert.equal((await run(3)).status, 200);
});

test("drafts an outreach email, and never for do-not-contact leads", async () => {
  const { env, bob, acme } = await seeded();
  const link = outreachMailto(bob, "brian");
  assert.match(link, /^mailto:service%40bobsauto\.com\?subject=/);
  const body = decodeURIComponent(link.split("&body=")[1]);
  assert.match(body, /Someone ran bobsauto\.com through our free Brand Teardown/);
  assert.match(body, /Nobody can tell what you sell\./);
  assert.match(body, /Reply and say so, and we won't email again\./);
  assert.match(body, /Brian\nI Hate My Brand$/);
  assert.ok(link.length < 2100, "short enough for mail apps");

  assert.match(outreachMailto({ ...bob, visitor_email: "owner@bobsauto.com" }, "ned"), /^mailto:owner%40bobsauto\.com/);
  assert.match(decodeURIComponent(outreachMailto({ ...bob, visitor_email: "owner@bobsauto.com" }, "ned")), /You ran bobsauto\.com/);
  assert.equal(outreachMailto(acme, "ned"), null, "no address, no email button");
  assert.equal(outreachMailto({ ...bob, stage: "do_not_contact" }, "ned"), null);

  await admin(env, "/teardown/admin/api/lead", { body: { id: bob.id, stage: "do_not_contact" } });
  assert.doesNotMatch(await (await admin(env, "/teardown/admin")).text(), /data-action="email"/);
});

test("adds the new columns to a database created by the first version", async () => {
  const db = fakeD1();
  await db.prepare(`CREATE TABLE teardowns (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, input_url TEXT NOT NULL, final_url TEXT,
    domain TEXT NOT NULL, tier TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL, from_cache INTEGER NOT NULL DEFAULT 0, site_title TEXT,
    note_problem TEXT, note_why TEXT, note_fix TEXT, visitor_email TEXT, site_emails TEXT, site_phones TEXT, contact_page TEXT,
    social_links TEXT, country TEXT)`).run();
  await db.prepare(`INSERT INTO teardowns (id, created_at, input_url, domain, status) VALUES ('old', '2026-11-01T00:00:00Z', 'https://old.com/', 'old.com', 'ok')`).run();
  const env = { DB: db, ADMIN_USERS: USERS };
  const page = await (await admin(env, "/teardown/admin")).text();
  assert.match(page, /data-domain="old\.com"/);
  assert.equal(db.rows()[0].stage, "new");
});

// ---------- auditor prompt ----------

test("edits the auditor prompt, versions it, and uses it on the next teardown", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test", DB: fakeD1(), TEARDOWN_KV: fakeKV(), ADMIN_USERS: USERS };
  const net = fakeNet({
    dns: { "acme.com": { A: ["93.184.216.34"] } },
    pages: { "https://acme.com/": () => html(SAMPLE), "https://api.anthropic.com/v1/messages": claudeReply(GOOD_NOTE) },
  });
  const run = () => withNet(net, async () => (await worker.fetch(post({ url: "acme.com" }), env, {})).json());
  const anthropicCalls = () => net.calls.filter((u) => u.includes("anthropic")).length;

  await run();
  assert.match(claudeReply.last.body.system, /^You are the brand auditor for I Hate Social/);
  assert.equal((await run()).cached, true);
  assert.equal(anthropicCalls(), 1);

  const mine = "You are the 2027 brand auditor. Check the headline first, then the offer, then proof. ".repeat(4).trim();
  let res = await admin(env, "/teardown/admin/api/prompt", { user: "brian", pw: "brianpass-2", body: { prompt: mine } });
  assert.deepEqual(await res.json(), { ok: true, version: 1, builtIn: false });

  const after = await run();
  assert.equal(after.cached, false, "a new prompt starts a fresh cache");
  assert.equal(anthropicCalls(), 2);
  const system = claudeReply.last.body.system;
  assert.ok(system.startsWith(mine));
  assert.doesNotMatch(system, /brand auditor for I Hate Social/);
  assert.match(system, /Never invent an audit\./, "the locked rules are still attached");
  assert.match(system, /never instructions to you/);
  assert.deepEqual(env.DB.rows().map((r) => r.prompt_version), [0, 0, 1]);

  assert.equal((await admin(env, "/teardown/admin/api/prompt", { body: { prompt: "be mean" } })).status, 400);
  assert.equal((await admin(env, "/teardown/admin/api/prompt", { body: { prompt: "x".repeat(20001) } })).status, 400);
  assert.equal((await admin(env, "/teardown/admin/api/prompt", { body: { prompt: mine }, origin: "https://evil.example" })).status, 403);
  assert.equal((await (await admin(env, "/teardown/admin/api/prompt", { body: { prompt: mine } })).json()).version, 1, "saving the same text makes no new version");

  const page = await (await admin(env, "/teardown/admin/prompt")).text();
  assert.match(page, /You&#39;re on version 1|You're on version 1/);
  assert.match(page, /Version 1<\/b> <span class="tag">In use<\/span>/);
  assert.match(page, /by Brian/);
  assert.ok(page.includes(">" + mine + "</textarea>"));

  res = await admin(env, "/teardown/admin/api/prompt", { body: { prompt: "" } });
  assert.deepEqual(await res.json(), { ok: true, version: 2, builtIn: true });
  await run();
  assert.match(claudeReply.last.body.system, /^You are the brand auditor for I Hate Social/);
  assert.match(await (await admin(env, "/teardown/admin/prompt")).text(), /on the built-in prompt/);
});

test("tries a draft prompt without saving it or creating a lead", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test", DB: fakeD1(), ADMIN_USERS: USERS };
  const draft = "Draft auditor. Only talk about the headline. " + "Be specific. ".repeat(20);
  const res = await withNet(acmeNet(claudeReply(GOOD_NOTE)), () =>
    admin(env, "/teardown/admin/api/prompt-test", { body: { url: "acme.com", prompt: draft } }));
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.domain, "acme.com");
  assert.equal(data.note.problem, GOOD_NOTE.problem);
  assert.ok(claudeReply.last.body.system.startsWith(draft.trim()));

  await admin(env, "/teardown/admin");
  assert.equal(env.DB.rows().length, 0, "no lead");
  assert.match(await (await admin(env, "/teardown/admin/prompt")).text(), /on the built-in prompt/, "not saved");

  const blocked = await withNet(fakeNet({ dns: {}, pages: {} }), () =>
    admin(env, "/teardown/admin/api/prompt-test", { body: { url: "http://169.254.169.254/", prompt: draft } }));
  assert.equal(blocked.status, 400, "the same address rules apply to admins");
  const escaped = await (await admin(env, "/teardown/admin/prompt")).text();
  assert.doesNotMatch(escaped, /<textarea[^>]*>[^<]*<script/);
});

// ---------- homepage ----------

test("homepage comes from the main site and is passed through untouched when it isn't a normal page", async () => {
  const asked = [];
  const site = (res) => ({ SITE: { fetch: async (req) => { asked.push(new URL(req.url).pathname + ":" + req.method); return res(); } } });

  // No HTMLRewriter in Node, which is the same path as "can't rewrite": the main site's page is served as is.
  let res = await worker.fetch(new Request("https://ihatemybrand.com/"), site(() => html("<h1>real site</h1>")), {});
  assert.equal(await res.text(), "<h1>real site</h1>");

  res = await worker.fetch(new Request("https://ihatemybrand.com/"), site(() => new Response("down", { status: 503 })), {});
  assert.equal(res.status, 503);
  res = await worker.fetch(new Request("https://ihatemybrand.com/", { method: "POST", body: "x" }), site(() => html("ok")), {});
  assert.equal(await res.text(), "ok");

  await worker.fetch(new Request("https://ihatemybrand.com/teardown/preview-home"), site(() => html("x")), {});
  assert.deepEqual(asked, ["/:GET", "/:GET", "/:POST", "/:GET"], "the preview asks the main site for its homepage");
});

test("homepage additions are applied to the real markup", async () => {
  const calls = [];
  globalThis.HTMLRewriter = class {
    on(selector, handlers) { calls.push([selector, handlers]); return this; }
    transform(res) { return new Response("rewritten", { headers: res.headers }); }
  };
  try {
    const env = { SITE: { fetch: async () => html("<html></html>") } };
    const res = await worker.fetch(new Request("https://ihatemybrand.com/teardown/preview-home"), env, {});
    assert.equal(await res.text(), "rewritten");
    assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.deepEqual(calls.map((c) => c[0]), ["head", "header nav a.btn", "section.hero h1", "section.hero"]);

    const added = {};
    for (const [selector, handlers] of calls) {
      const record = (how) => (content, opts) => { added[selector] = { how, content, html: opts?.html }; };
      handlers.element({ append: record("append"), before: record("before"), prepend: record("prepend"), after: record("after") });
    }
    assert.equal(added["header nav a.btn"].how, "before");
    assert.match(added["header nav a.btn"].content, /href="\/teardown\/">Free teardown/);
    assert.equal(added["section.hero h1"].how, "prepend");
    assert.match(added["section.hero h1"].content, /class="ihmb-thumb"[\s\S]*class="thumb"/);
    assert.equal(added["section.hero"].how, "after");
    assert.match(added["section.hero"].content, /<form action="\/teardown\/" method="get">[\s\S]*name="url"/);
    assert.match(added["head"].content, /h1:has\(\.swap\.hov:hover\) \.ihmb-thumb \.thumb\{transform:rotate\(180deg\)\}/);
    assert.ok(Object.values(added).every((a) => a.html === true));
  } finally {
    delete globalThis.HTMLRewriter;
  }
});

test("accepts a JSON answer when the model replies in text instead of calling the tool", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test" };
  const asText = (text) => () => Response.json({ content: [{ type: "text", text }] });
  let res = await withNet(acmeNet(asText("Here you go:\n```json\n" + JSON.stringify(GOOD_NOTE) + "\n```")), () => worker.fetch(post({ url: "acme.com" }), env, {}));
  assert.equal((await res.json()).note.problem, GOOD_NOTE.problem);
  res = await withNet(acmeNet(asText("Your headline is weak. Fix it.")), () => worker.fetch(post({ url: "acme.com" }), env, {}));
  assert.equal(res.status, 502, "free text with no structure is not shown as an audit");
});

test("retries once when the answer is incomplete, then gives up without inventing anything", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test" };
  let calls = 0;
  const flaky = (init) => {
    calls++;
    const input = calls === 1 ? { can_audit: true, problem: "Only this." } : GOOD_NOTE;
    if (calls === 2) assert.match(JSON.parse(init.body).messages[0].content, /Your last answer was incomplete/);
    return Response.json({ content: [{ type: "tool_use", name: "free_note", input }] });
  };
  let res = await withNet(acmeNet(flaky), () => worker.fetch(post({ url: "acme.com" }), env, {}));
  assert.equal((await res.json()).note.fix, GOOD_NOTE.fix);
  assert.equal(calls, 2);

  calls = 0;
  const never = () => { calls++; return Response.json({ content: [{ type: "tool_use", name: "free_note", input: { can_audit: true } }] }); };
  res = await withNet(acmeNet(never), () => worker.fetch(post({ url: "acme.com" }), env, {}));
  assert.equal(res.status, 502);
  assert.equal(calls, 2, "two tries at most");
});

// ---------- screenshots and the structured note ----------

const RICH_NOTE = {
  can_audit: true,
  problem: "Your headline says nothing.",
  evidence: [
    { quote: "Empowering Tomorrow", where: "Hero headline" },
    { quote: "\u201cLearn More\u201d", where: "Main button" },
    { quote: "We are the best in the world", where: "Made up by the model" },
  ],
  why_its_costing_them: ["A stranger can't tell what you sell.", "They leave before they scroll.", "Your button doesn't help."],
  fix: ["Say what you sell in the headline.", "Make the button say what happens next."],
  rewrite: { before: "Empowering Tomorrow", after: "Payroll software for restaurants." },
};

function fakeBrowser(response) {
  const calls = [];
  return { calls, quickAction: async (action, opts) => { calls.push({ action, opts }); return response(); } };
}
const jpeg = () => new Response(new Uint8Array(4000).fill(7), { headers: { "content-type": "image/jpeg" } });
function kvWithMeta() {
  const kv = fakeKV();
  const meta = new Map();
  const put = kv.put;
  kv.put = async (key, value, opts) => { if (opts?.metadata) meta.set(key, opts.metadata); return put(key, value); };
  kv.getWithMetadata = async (key) => ({ value: kv.store.get(key) ?? null, metadata: meta.get(key) ?? null });
  return kv;
}

test("takes a screenshot, shows it to the auditor, and serves it back with the note", async () => {
  const browser = fakeBrowser(jpeg);
  const env = { ANTHROPIC_API_KEY: "sk-test", TEARDOWN_KV: kvWithMeta(), BROWSER: browser };
  const data = await withNet(acmeNet(claudeReply(RICH_NOTE)), async () => (await worker.fetch(post({ url: "acme.com" }), env, {})).json());

  assert.equal(browser.calls[0].action, "screenshot");
  assert.equal(browser.calls[0].opts.url, "https://acme.com/");
  assert.deepEqual(browser.calls[0].opts.viewport, { width: 1280, height: 800 });

  const sent = claudeReply.last.body.messages[0].content;
  assert.equal(sent[0].type, "image");
  assert.equal(sent[0].source.media_type, "image/jpeg");
  assert.equal(atob(sent[0].source.data).length, 4000);
  assert.match(sent[1].text, /A screenshot of the top of their page is attached/);

  assert.match(data.shot, /^\/teardown\/shot\/[0-9a-f-]{36}$/);
  assert.equal(data.shot, "/teardown/shot/" + data.leadId);
  const img = await worker.fetch(new Request("https://ihatemybrand.com" + data.shot), env, {});
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  assert.equal((await img.arrayBuffer()).byteLength, 4000);

  const none = await worker.fetch(new Request("https://ihatemybrand.com/teardown/shot/00000000-0000-4000-8000-000000000000"), env, {});
  assert.equal(none.status, 404);
  const bad = await worker.fetch(new Request("https://ihatemybrand.com/teardown/shot/..%2Fnote"), env, {});
  assert.equal(bad.status, 404);
});

test("breaks the note into paragraphs and steps, and only quotes words that are really on the page", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test" };
  const { note } = await withNet(acmeNet(claudeReply(RICH_NOTE)), async () => (await worker.fetch(post({ url: "acme.com" }), env, {})).json());

  assert.deepEqual(note.whyPoints, RICH_NOTE.why_its_costing_them);
  assert.deepEqual(note.fixSteps, RICH_NOTE.fix);
  assert.equal(note.why, RICH_NOTE.why_its_costing_them.join("\n\n"));
  assert.equal(note.fix, RICH_NOTE.fix.join("\n\n"));
  assert.deepEqual(note.evidence, [
    { quote: "Empowering Tomorrow", where: "Hero headline" },
    { quote: "Learn More", where: "Main button" },
  ], "the invented quote is dropped");
  assert.deepEqual(note.rewrite, { before: "Empowering Tomorrow", after: "Payroll software for restaurants." });

  const invented = { ...RICH_NOTE, rewrite: { before: "A line that is not on the site", after: "Better line." } };
  const second = await withNet(acmeNet(claudeReply(invented)), async () => (await worker.fetch(post({ url: "acme.com" }), env, {})).json());
  assert.deepEqual(second.note.rewrite, { before: "", after: "Better line." });
});

test("a failed or oversized screenshot never blocks the teardown", async () => {
  for (const response of [
    () => new Response("limit", { status: 429 }),
    () => { throw new Error("browser exploded"); },
    () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    () => new Response(new Uint8Array(2_000_000), { headers: { "content-type": "image/jpeg" } }),
  ]) {
    const env = { ANTHROPIC_API_KEY: "sk-test", TEARDOWN_KV: kvWithMeta(), BROWSER: fakeBrowser(response) };
    const data = await withNet(acmeNet(claudeReply(GOOD_NOTE)), async () => (await worker.fetch(post({ url: "acme.com" }), env, {})).json());
    assert.equal(data.ok, true);
    assert.equal(data.shot, undefined);
    assert.equal(typeof claudeReply.last.body.messages[0].content, "string", "text only");
    assert.match(claudeReply.last.body.messages[0].content, /There is no screenshot/);
  }
});

test("a scheduled limit change takes over on its date, and a manual change cancels it", async () => {
  const { getSettings, saveSettings } = await import("../src/leads.js");
  const db = fakeD1();
  await saveSettings(db, { dailyLimit: 25 });
  await db.prepare(`INSERT INTO settings (key, value) VALUES ('scheduledLimit', '10'), ('scheduledLimitFrom', '2026-11-13T05:00:00Z')`).run();

  const before = await getSettings(db, new Date("2026-11-13T04:59:00Z"));
  assert.equal(before.dailyLimit, 25);
  assert.deepEqual(before.upcoming, { dailyLimit: 10, from: "2026-11-13T05:00:00Z" });
  const after = await getSettings(db, new Date("2026-11-13T05:00:00Z"));
  assert.equal(after.dailyLimit, 10);
  assert.equal(after.upcoming, undefined);

  const env = { DB: db, ADMIN_USERS: USERS };
  assert.match(await (await admin(env, "/teardown/admin")).text(), /The daily limit changes to 10 on Nov 13\./);

  await saveSettings(db, { dailyLimit: 7 });
  assert.equal((await getSettings(db, new Date("2026-12-01T00:00:00Z"))).dailyLimit, 7);
});

// ---------- back office: full view, tests, bulk delete ----------

test("opens one teardown in full, with the screenshot, quotes, paragraphs and steps", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test", DB: fakeD1(), TEARDOWN_KV: kvWithMeta(), BROWSER: fakeBrowser(jpeg), ADMIN_USERS: USERS };
  const data = await withNet(acmeNet(claudeReply(RICH_NOTE)), async () => (await worker.fetch(post({ url: "acme.com" }), env, {})).json());

  const list = await (await admin(env, "/teardown/admin")).text();
  assert.ok(list.includes(`href="/teardown/admin/lead/${data.leadId}"`));
  assert.ok(list.includes(`src="/teardown/shot/${data.leadId}"`), "thumbnail in the list");
  new Function(list.match(/<script>([\s\S]*?)<\/script>/)[1]);

  const res = await admin(env, "/teardown/admin/lead/" + data.leadId);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.ok(page.includes(`<img src="/teardown/shot/${data.leadId}"`));
  assert.match(page, /<p class="big">Your headline says nothing\.<\/p>/);
  assert.match(page, /“Empowering Tomorrow”<\/i><span>Hero headline<\/span>/);
  assert.match(page, /<p>They leave before they scroll\.<\/p>/);
  assert.match(page, /<li>Make the button say what happens next\.<\/li>/);
  assert.match(page, /<s>Empowering Tomorrow<\/s>[\s\S]*<b>Payroll software for restaurants\.<\/b>/);
  assert.match(page, /data-field="stage"/);
  assert.match(page, /<body data-page="lead">/);

  assert.equal((await admin(env, "/teardown/admin/lead/" + data.leadId, { pw: "wrong" })).status, 401);
  assert.equal((await admin(env, "/teardown/admin/lead/11111111-1111-4111-8111-111111111111")).status, 404);
  assert.equal((await admin(env, "/teardown/admin/lead/nope")).status, 404);
});

test("older leads without the structured note still open", async () => {
  const { env, bob } = await seeded();
  const page = await (await admin(env, "/teardown/admin/lead/" + bob.id)).text();
  assert.match(page, /<p class="big">Nobody can tell what you sell\.<\/p>/);
  assert.match(page, /No screenshot was taken for this one\./);
  assert.match(page, /service@bobsauto\.com/);
});

test("a test run skips the daily limit, is filed under Tests and stays out of the numbers", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-test", DB: fakeD1(), TEARDOWN_KV: kvWithMeta(), BROWSER: fakeBrowser(jpeg), ADMIN_USERS: USERS };
  await admin(env, "/teardown/admin/api/settings", { body: { dailyLimit: 1 } });
  const net = () => acmeNet(claudeReply(RICH_NOTE));

  const ids = [];
  for (let i = 0; i < 3; i++) {
    const res = await withNet(net(), () => admin(env, "/teardown/admin/api/test-run", { body: { url: "acme.com" } }));
    const data = await res.json();
    assert.equal(data.ok, true, "no limit on test runs");
    ids.push(data.id);
  }
  assert.equal((await withNet(net(), () => admin(env, "/teardown/admin/api/test-run", { body: { url: "acme.com" }, origin: "https://evil.example" }))).status, 403);
  assert.equal((await withNet(fakeNet({ dns: {}, pages: {} }), () => admin(env, "/teardown/admin/api/test-run", { body: { url: "http://10.0.0.1" } }))).status, 400);

  const main = await (await admin(env, "/teardown/admin")).text();
  assert.match(main, /<b>0<\/b>all time/);
  assert.match(main, /Tests <span>3<\/span>/);
  assert.doesNotMatch(main, /data-domain="acme\.com"/);
  const tests = await (await admin(env, "/teardown/admin?tests=1")).text();
  assert.equal(tests.match(/data-domain="acme\.com"/g).length, 3);
  assert.equal((await (await admin(env, "/teardown/admin/leads.csv")).text()).trim().split("\r\n").length, 1, "tests are not exported with leads");

  const detail = await (await admin(env, "/teardown/admin/lead/" + ids[0])).text();
  assert.match(detail, /Test run from the back office/);
  assert.match(detail, /All tests/);
});

test("deletes several teardowns at once", async () => {
  const { env, bob, acme } = await seeded();
  let res = await admin(env, "/teardown/admin/api/delete-many", { body: { ids: [bob.id, acme.id, "junk", "11111111-1111-4111-8111-111111111111"] } });
  assert.deepEqual(await res.json(), { ok: true, deleted: 2 });
  assert.equal(env.DB.rows().length, 0);
  res = await admin(env, "/teardown/admin/api/delete-many", { body: { ids: "all" } });
  assert.equal(res.status, 400);
});

// ---------- lead analysis, score, trail, alerts ----------

const ANALYSIS = {
  business_type: "Payroll software company",
  business_summary: "Sells payroll software to restaurants.",
  business_score: 7,
  business_reasons: ["Clear product", "Has a contact page"],
  brand_score: 4,
  brand_reasons: ["Vague headline"],
  package: "website",
  package_why: "The homepage is the problem.",
  outreach_subject: "Your headline says nothing",
  outreach_body: "Hi,\n\nYour headline reads \"Empowering Tomorrow\".\n\nReply \"no thanks\" and we won't email again.\n\n[Your name]\nI Hate My Brand",
};
const analysisReply = (input = ANALYSIS) => () => Response.json({ content: [{ type: "tool_use", name: "lead_analysis", input }] });

function fakeMailer({ fail = false } = {}) {
  const sent = [];
  return { sent, send: async (msg) => { if (fail) throw new Error("destination address not verified"); sent.push(msg); return { messageId: "m" + sent.length }; } };
}

function bobNetWithAnalysis(analysis = analysisReply()) {
  return fakeNet({
    dns: { "bobsauto.com": { A: ["93.184.216.34"] } },
    pages: {
      "https://bobsauto.com/": () => html(CONTACT_HOME),
      "https://bobsauto.com/contact-us": () => html(CONTACT_PAGE),
      "https://api.anthropic.com/v1/messages": claudeReply(GOOD_NOTE),
      __analysis: analysis,
    },
  });
}

async function leadEnv() {
  const env = { ANTHROPIC_API_KEY: "sk-test", DB: fakeD1(), TEARDOWN_KV: kvWithMeta(), ADMIN_USERS: USERS, EMAIL: fakeMailer() };
  await admin(env, "/teardown/admin/api/settings", { body: { alertTo: "Brian@Example.com, ned@example.com, not-an-email" } });
  return env;
}
const trail = async (env, id) => (await (await import("../src/leads.js")).listEvents(env.DB, id)).map((e) => e.detail).reverse();

test("a new lead is analysed, scored, logged and announced by email", async () => {
  const env = await leadEnv();
  const data = await withNet(bobNetWithAnalysis(), async () => (await worker.fetch(post({ url: "bobsauto.com" }), env, {})).json());
  assert.doesNotMatch(JSON.stringify(data), /Payroll software company|business_score|outreach/i, "the private read never goes to the visitor");

  const row = env.DB.rows()[0];
  const read = JSON.parse(row.analysis_json);
  assert.equal(read.businessScore, 7);
  assert.equal(read.brandScore, 4);
  assert.equal(read.package, "Website");
  assert.equal(read.packagePrice, "$999");
  // 7*4 business + (10-4)*2 room to fix + 12 site email + 6 phone
  assert.equal(row.lead_score, 28 + 12 + 12 + 6);

  assert.deepEqual(env.EMAIL.sent.map((m) => m.to), ["brian@example.com", "ned@example.com"]);
  const mail = env.EMAIL.sent[0];
  assert.equal(mail.from, "alerts@ihatemybrand.com");
  assert.equal(mail.subject, "New teardown: bobsauto.com. Lead score 58 (Warm)");
  assert.match(mail.text, /On their site: service@bobsauto\.com/);
  assert.match(mail.text, /Suggested: Website \(\$999\)/);
  assert.match(mail.text, new RegExp("https://ihatemybrand\\.com/teardown/admin/lead/" + row.id));
  assert.match(mail.text, /Draft email[\s\S]*Your headline says nothing/);

  assert.deepEqual(await trail(env, row.id), [
    "Ran a teardown on bobsauto.com",
    "Lead score 58 (Warm). Business 7/10, brand 4/10. Suggested: Website. Outreach drafted.",
    "Alert emailed to 2 people",
  ]);
});

test("leaving an email raises the score, goes on the trail and sends a second alert", async () => {
  const env = await leadEnv();
  const data = await withNet(bobNetWithAnalysis(), async () => (await worker.fetch(post({ url: "bobsauto.com" }), env, {})).json());
  await worker.fetch(emailPost({ leadId: data.leadId, email: "bob@bobsauto.com" }), env, {});

  const row = env.DB.rows()[0];
  assert.equal(row.lead_score, 28 + 12 + 30 + 4 + 8);
  assert.equal(env.EMAIL.sent.length, 4);
  assert.equal(env.EMAIL.sent[2].subject, "bobsauto.com left their email. Lead score 82 (Hot)");
  assert.match(env.EMAIL.sent[2].text, /just left their email: bob@bobsauto\.com/);
  assert.deepEqual((await trail(env, row.id)).slice(3), [
    "Left their email: bob@bobsauto.com",
    "Lead score 82 (Hot) now that they left an email",
    "Alert emailed to 2 people",
  ]);
});

test("a repeat site reuses the saved read without paying for another analysis", async () => {
  const env = await leadEnv();
  let analysisCalls = 0;
  const net = bobNetWithAnalysis(() => { analysisCalls++; return analysisReply()(); });
  await withNet(net, () => worker.fetch(post({ url: "bobsauto.com" }), env, {}));
  await withNet(net, () => worker.fetch(post({ url: "bobsauto.com" }), env, {}));
  assert.equal(analysisCalls, 1);
  const rows = env.DB.rows();
  assert.equal(rows[1].from_cache, 1);
  assert.equal(JSON.parse(rows[1].analysis_json).package, "Website");
  assert.equal(env.EMAIL.sent.length, 4, "each visit is announced");
});

test("alerts and analysis failing never break a teardown, and the trail says why", async () => {
  const env = await leadEnv();
  env.EMAIL = fakeMailer({ fail: true });
  const res = await withNet(bobNetWithAnalysis(() => new Response("down", { status: 529 })), () => worker.fetch(post({ url: "bobsauto.com" }), env, {}));
  assert.equal(res.status, 200);
  const row = env.DB.rows()[0];
  assert.equal(row.analysis_json, null);
  assert.equal(row.lead_score, 18);
  assert.deepEqual((await trail(env, row.id)).slice(1), [
    "Lead score 18 (Cool). No AI read on this one.",
    "Alert not sent: destination address not verified",
  ]);

  const test = await admin(env, "/teardown/admin/api/test-alert", { body: {} });
  assert.equal(test.status, 502);
  assert.match((await test.json()).error, /not verified/);
  env.EMAIL = fakeMailer();
  assert.match((await (await admin(env, "/teardown/admin/api/test-alert", { body: {} })).json()).message, /Test sent to 2/);
  assert.equal(env.EMAIL.sent[0].subject, "Test alert from the teardown back office");
});

test("the lead page shows the score, the read, an editable draft and the trail", async () => {
  const env = await leadEnv();
  const data = await withNet(bobNetWithAnalysis(), async () => (await worker.fetch(post({ url: "bobsauto.com" }), env, {})).json());
  const id = data.leadId;

  await admin(env, "/teardown/admin/api/lead", { user: "brian", pw: "brianpass-2", body: { id, stage: "contacted", owner: "ned", followUp: "2026-11-01" } });
  await admin(env, "/teardown/admin/api/event", { body: { id, type: "note", detail: "Called, left a voicemail <b>" } });
  await admin(env, "/teardown/admin/api/event", { body: { id, type: "reply", detail: "wants a quote" } });
  assert.equal((await admin(env, "/teardown/admin/api/lead", { body: { id, followUp: "next week" } })).status, 400);
  assert.equal((await admin(env, "/teardown/admin/api/event", { body: { id, type: "hack" } })).status, 400);
  assert.equal((await admin(env, "/teardown/admin/api/event", { body: { id, type: "note", detail: "x" }, origin: "https://evil.example" })).status, 403);

  const page = await (await admin(env, "/teardown/admin/lead/" + id, { user: "brian", pw: "brianpass-2" })).text();
  new Function(page.match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.match(page, /<div class="bignum">58/);
  assert.match(page, /Business looks real: 7\/10<\/span><b>\+28<\/b>/);
  assert.match(page, /<b>Payroll software company\.<\/b> Sells payroll software to restaurants\./);
  assert.match(page, /Pitch: Website \(\$999\)/);
  assert.match(page, /id="draftto" value="service@bobsauto\.com"/);
  assert.match(page, /id="draftsubject" value="Your headline says nothing"/);
  assert.match(page, /Brian\nI Hate My Brand<\/textarea>/, "the draft is signed with whoever is signed in");
  assert.doesNotMatch(page, /\[Your name\]/);
  assert.match(page, /type="date" data-field="followUp" value="2026-11-01"/);
  for (const line of ["Stage: new to contacted", "Assigned to ned", "Follow-up set for 2026-11-01", "Called, left a voicemail &lt;b&gt;", "They replied: wants a quote", "Stage: contacted to replied"]) {
    assert.ok(page.includes(line), line);
  }

  const list = await (await admin(env, "/teardown/admin")).text();
  assert.match(list, /<span class="score warm" title="Lead score">58 Warm<\/span>/);
  assert.match(list, /Follow-ups due <span>1<\/span>/);
  assert.match(list, /<b>1<\/b>Replied <i>100%<\/i>/);
  const due = await (await admin(env, "/teardown/admin?due=1")).text();
  assert.match(due, /data-domain="bobsauto\.com"/);
  await admin(env, "/teardown/admin/api/lead", { body: { id, stage: "won" } });
  assert.doesNotMatch(await (await admin(env, "/teardown/admin?due=1")).text(), /data-domain="bobsauto\.com"/, "won leads drop off the due list");

  await admin(env, "/teardown/admin/api/delete", { body: { id } });
  assert.deepEqual(await trail(env, id), [], "deleting a lead deletes its trail");
});

test("email copied to the logging address updates the right lead's trail and stage", async () => {
  const env = await leadEnv();
  const data = await withNet(bobNetWithAnalysis(), async () => (await worker.fetch(post({ url: "bobsauto.com" }), env, {})).json());
  const msg = (from, to, subject) => ({ from, to: "log@ihatemybrand.com", headers: new Headers({ subject, to, cc: "" }) });

  await worker.email(msg("brian@gmail.example", "Bob <Service@BobsAuto.com>", "Your headline says nothing"), env);
  let row = env.DB.rows()[0];
  assert.equal(row.stage, "contacted");
  await worker.email(msg("service@bobsauto.com", "brian@gmail.example", "Re: Your headline says nothing"), env);
  row = env.DB.rows()[0];
  assert.equal(row.stage, "replied");
  await worker.email(msg("stranger@elsewhere.example", "nobody@nowhere.example", "spam"), env);

  assert.deepEqual((await trail(env, data.leadId)).slice(3), [
    'brian emailed service@bobsauto.com: "Your headline says nothing"',
    "Stage: new to contacted",
    'They emailed: "Re: Your headline says nothing"',
    "Stage: contacted to replied",
  ]);
});
