// Fetches a visitor-supplied URL without letting it reach anything private.
//
// Layers:
//   1. URL shape: http/https only, default ports, no credentials, no IP literals,
//      no single-label or internal-looking hostnames.
//   2. DNS: resolve the hostname over DNS-over-HTTPS and refuse if any answer is
//      a private, loopback, link-local or reserved address.
//   3. Redirects are followed by hand so every hop goes through 1 and 2 again.
//   4. Timeout and a hard cap on how much of the body we read.
//
// Known limit: the Worker runtime resolves DNS again when it actually connects,
// so a hostile DNS server could answer differently the second time. A Worker has
// no private network of ours behind it, so there is nothing internal to reach,
// but do not reuse this file unchanged on a server that sits inside a VPC.

export class TeardownError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const MAX_BYTES = 2_000_000;
export const TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 5;

const USER_AGENT =
  "Mozilla/5.0 (compatible; IHateMyBrandTeardown/1.0; +https://ihatemybrand.com/teardown)";

const BLOCKED_SUFFIXES = [
  ".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp",
  ".test", ".example", ".invalid", ".onion", ".arpa",
];

const BAD_URL = "That doesn't look like a website address. Try something like yourbrand.com.";
const BLOCKED = "We can only audit public websites.";

/** Turn whatever the visitor typed into a checked URL object, or throw. */
export function normalizeUrl(input) {
  let raw = String(input ?? "").trim();
  if (!raw || raw.length > 2000 || /\s/.test(raw)) {
    throw new TeardownError("bad_url", BAD_URL, 400);
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = "https://" + raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TeardownError("bad_url", BAD_URL, 400);
  }
  assertPublicUrlShape(url);
  url.hash = "";
  return url;
}

/** Checks that need no network. Run on the first URL and on every redirect hop. */
export function assertPublicUrlShape(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TeardownError("bad_url", BAD_URL, 400);
  }
  if (url.username || url.password || url.port) {
    throw new TeardownError("blocked", BLOCKED, 400);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // The URL parser has already turned forms like 0x7f.1 or 2130706433 into
  // dotted quads, so one check covers every IPv4 spelling.
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    throw new TeardownError("blocked", BLOCKED, 400);
  }
  if (!host.includes(".") || BLOCKED_SUFFIXES.some((s) => ("." + host).endsWith(s))) {
    throw new TeardownError("blocked", BLOCKED, 400);
  }
}

export function isPublicIp(ip) {
  return ip.includes(":") ? isPublicIPv6(ip) : isPublicIPv4(ip);
}

function isPublicIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false; // multicast and reserved
  return true;
}

function isPublicIPv6(ip) {
  const addr = ip.toLowerCase().split("%")[0];
  if (addr.includes(".")) return false; // IPv4-mapped or embedded: refuse outright
  const first = addr.startsWith("::") ? 0 : parseInt(addr.split(":")[0], 16);
  if (!Number.isInteger(first)) return false;
  if (first === 0) return false; // ::, ::1, ::ffff:x:x
  if ((first & 0xfe00) === 0xfc00) return false; // unique local
  if ((first & 0xffc0) === 0xfe80) return false; // link-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (addr.startsWith("2001:db8:") || addr.startsWith("64:ff9b:")) return false;
  return true;
}

/** Resolve over DoH and refuse unless every address is public. */
export async function assertPublicDns(hostname, fetchImpl = fetch) {
  const ips = [];
  for (const type of ["A", "AAAA"]) {
    let data;
    try {
      const res = await fetchImpl(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
        { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) throw new Error("dns status " + res.status);
      data = await res.json();
    } catch {
      // Fail closed: if we cannot check where it points, we do not fetch it.
      throw new TeardownError("dns_failed", "We couldn't look that site up. Try again in a minute.", 502);
    }
    const wanted = type === "A" ? 1 : 28;
    for (const answer of data.Answer ?? []) {
      if (answer.type === wanted) ips.push(String(answer.data));
    }
  }
  if (ips.length === 0) {
    throw new TeardownError("not_found", "We couldn't find a website at that address. Check the spelling.");
  }
  if (!ips.every(isPublicIp)) {
    throw new TeardownError("blocked", BLOCKED, 400);
  }
}

async function readCapped(response) {
  if (!response.body) return { html: "", truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= MAX_BYTES) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(total, MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const room = bytes.length - offset;
    if (room <= 0) break;
    bytes.set(chunk.subarray(0, room), offset);
    offset += Math.min(chunk.byteLength, room);
  }
  return { html: new TextDecoder("utf-8").decode(bytes), truncated };
}

/** Fetch a public HTML page. Returns { finalUrl, html, truncated }. */
export async function safeFetchPage(input, { fetchImpl = fetch } = {}) {
  let url = input instanceof URL ? input : normalizeUrl(input);
  const deadline = AbortSignal.timeout(TIMEOUT_MS);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertPublicUrlShape(url);
    await assertPublicDns(url.hostname, fetchImpl);

    let res;
    try {
      res = await fetchImpl(url.toString(), {
        redirect: "manual",
        signal: deadline,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "accept-language": "en",
        },
      });
    } catch (err) {
      if (err instanceof TeardownError) throw err;
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        throw new TeardownError("timeout", "Your site took too long to answer. That's a problem of its own, but we need it to load before we can audit it.");
      }
      throw new TeardownError("fetch_failed", "We couldn't reach that site. Check the address and try again.");
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location) throw new TeardownError("fetch_failed", "That site redirected us nowhere.");
      try {
        url = new URL(location, url);
      } catch {
        throw new TeardownError("fetch_failed", "That site redirected us somewhere we couldn't follow.");
      }
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new TeardownError(
        "bad_status",
        `Your site answered with an error (${res.status}). It may be down or blocking automated visitors, so we can't audit it.`,
      );
    }

    const type = (res.headers.get("content-type") || "").toLowerCase();
    if (type && !type.includes("html")) {
      await res.body?.cancel().catch(() => {});
      throw new TeardownError("not_html", "That address isn't a web page. Give us your homepage.");
    }

    let body;
    try {
      body = await readCapped(res);
    } catch {
      throw new TeardownError("timeout", "Your site took too long to finish loading, so we couldn't audit it.");
    }
    return { finalUrl: url.toString(), ...body };
  }
  throw new TeardownError("too_many_redirects", "That site keeps redirecting in circles. We gave up.");
}
