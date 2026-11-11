// Pulls the parts of a page the auditor needs out of raw HTML.
// Deliberately dependency-free string work: the output feeds a language model,
// so it has to be tolerant of messy markup, not a perfect DOM.

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  mdash: "—", ndash: "–", hellip: "…", copy: "©",
  reg: "®", trade: "™",
};

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

function textOf(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

function clip(text, max) {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function unique(list) {
  return [...new Set(list)];
}

const SOCIAL_HOSTS = [
  "instagram.com", "facebook.com", "tiktok.com", "linkedin.com", "x.com",
  "twitter.com", "youtube.com", "youtu.be", "pinterest.com", "threads.net",
  "threads.com", "snapchat.com", "bsky.app",
];

function socialHost(href, baseUrl) {
  try {
    const host = new URL(href, baseUrl).hostname.toLowerCase().replace(/^www\./, "");
    return SOCIAL_HOSTS.find((s) => host === s || host.endsWith("." + s)) ? host : null;
  } catch {
    return null;
  }
}

export function extractPage(html, baseUrl) {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ");

  const title = textOf((cleaned.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");

  const meta = {};
  for (const tag of cleaned.match(/<meta\b[^>]*>/gi) || []) {
    const a = attrs(tag);
    const key = (a.name || a.property || "").toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content.trim();
  }

  const headings = [];
  const headingRe = /<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = headingRe.exec(cleaned)) && headings.length < 40) {
    const text = textOf(m[2]);
    if (text) headings.push({ level: m[1].toLowerCase(), text: clip(text, 200) });
  }

  const navHtml = (cleaned.match(/<nav\b[\s\S]*?<\/nav\s*>/gi) || []).join(" ");
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;

  const nav = [];
  while ((m = anchorRe.exec(navHtml))) {
    const text = textOf(m[2]);
    if (text) nav.push(clip(text, 60));
  }

  const socials = [];
  const ctas = [];
  let linkCount = 0;
  anchorRe.lastIndex = 0;
  while ((m = anchorRe.exec(cleaned))) {
    linkCount++;
    const a = attrs(m[1]);
    const text = textOf(m[2]);
    if (a.href) {
      const host = socialHost(a.href, baseUrl);
      if (host) {
        try {
          socials.push(new URL(a.href, baseUrl).toString());
        } catch {
          /* ignore unparseable links */
        }
      }
    }
    const looksLikeButton = /\b(btn|button|cta)\b/i.test(a.class || "") || a.role === "button";
    if (looksLikeButton && text) ctas.push(clip(text, 80));
  }
  const buttonRe = /<button\b[^>]*>([\s\S]*?)<\/button\s*>/gi;
  while ((m = buttonRe.exec(cleaned))) {
    const text = textOf(m[1]);
    if (text) ctas.push(clip(text, 80));
  }
  for (const tag of cleaned.match(/<input\b[^>]*>/gi) || []) {
    const a = attrs(tag);
    if ((a.type || "").toLowerCase() === "submit" && a.value) ctas.push(clip(a.value, 80));
  }

  const images = [];
  let imageCount = 0;
  let missingAlt = 0;
  for (const tag of cleaned.match(/<img\b[^>]*>/gi) || []) {
    imageCount++;
    const a = attrs(tag);
    const alt = (a.alt || "").trim();
    if (!alt) missingAlt++;
    if (images.length < 30) {
      images.push({ src: clip(a.src || a["data-src"] || "", 160), alt: clip(alt, 160) });
    }
  }

  const bodyHtml = (cleaned.match(/<body\b[^>]*>([\s\S]*)/i) || [])[1] ?? cleaned;
  const fullText = textOf(bodyHtml.replace(/<\/(p|div|section|li|h[1-6]|br|tr)\s*>/gi, " . "))
    .replace(/(\s*\.\s*){2,}/g, ". ");
  const wordCount = fullText.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;

  return {
    url: baseUrl,
    title: clip(title, 300),
    metaDescription: clip(meta.description || "", 500),
    ogTitle: clip(meta["og:title"] || "", 300),
    ogDescription: clip(meta["og:description"] || "", 500),
    hasOgImage: Boolean(meta["og:image"]),
    hasViewportMeta: Boolean(meta.viewport),
    headings,
    nav: unique(nav).slice(0, 30),
    ctas: unique(ctas).slice(0, 25),
    socialLinks: unique(socials).slice(0, 15),
    linkCount,
    imageCount,
    imagesMissingAlt: missingAlt,
    images,
    wordCount,
    bodyText: clip(fullText, 6000),
  };
}

// ---------- contact details ----------
// Only what the site itself publishes: mailto and tel links, addresses and
// numbers in the visible text, structured data, and the link to a contact page.
// Found by pattern, not by the model, so nothing here can be invented.

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const US_PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g;
const JUNK_EMAIL_DOMAINS = [
  "example.com", "example.org", "domain.com", "email.com", "yourdomain.com", "sentry.io",
  "wixpress.com", "sentry-next.wixpress.com", "godaddy.com", "squarespace.com", "mysite.com",
];
const JUNK_EMAIL_NAMES = ["you", "your", "name", "email", "user", "username", "yourname", "youremail"];

function cleanEmail(raw) {
  const email = String(raw).trim().toLowerCase().replace(/^mailto:/, "").split("?")[0].replace(/[.,;:]+$/, "");
  if (email.length > 254 || !/^[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(email)) return null;
  if (/\.(png|jpe?g|gif|webp|svg|css|js)$/.test(email)) return null; // logo@2x.png and friends
  const [name, domain] = email.split("@");
  if (JUNK_EMAIL_NAMES.includes(name)) return null;
  if (JUNK_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) return null;
  return email;
}

function cleanPhone(raw) {
  const text = String(raw).trim().replace(/^tel:/i, "");
  const digits = text.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits[0] === "1") return "+" + digits;
  // Non-US numbers are only trusted when the site wrote them with a country code.
  if (text.startsWith("+") && digits.length >= 8 && digits.length <= 15) return "+" + digits;
  return null;
}

// Cloudflare hides emails from scrapers as hex in data-cfemail. First byte is the key.
function decodeCfEmail(hex) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

function sameSite(a, b) {
  const host = (u) => new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  try {
    return host(a) === host(b);
  } catch {
    return false;
  }
}

/** Returns { emails, phones, contactPage } found on this page. */
export function extractContacts(html, baseUrl) {
  const emails = [];
  const phones = [];
  const addEmail = (raw) => {
    const e = cleanEmail(raw);
    if (e) emails.push(e);
  };
  const addPhone = (raw) => {
    const p = cleanPhone(raw);
    if (p) phones.push(p);
  };
  let m;

  // Structured data that businesses publish for search engines.
  const ldRe = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  while ((m = ldRe.exec(html))) {
    for (const hit of m[1].matchAll(/"email"\s*:\s*"([^"]+)"/gi)) addEmail(hit[1]);
    for (const hit of m[1].matchAll(/"telephone"\s*:\s*"([^"]+)"/gi)) addPhone(hit[1]);
  }

  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ");

  for (const hit of cleaned.matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) {
    const decoded = decodeCfEmail(hit[1]);
    if (decoded) addEmail(decoded);
  }

  let contactPage = null;
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  while ((m = anchorRe.exec(cleaned))) {
    const a = attrs(m[1]);
    const href = (a.href || "").trim();
    if (!href) continue;
    if (/^mailto:/i.test(href)) {
      try {
        addEmail(decodeURIComponent(href));
      } catch {
        addEmail(href);
      }
      continue;
    }
    if (/^tel:/i.test(href)) {
      addPhone(href);
      continue;
    }
    if (!contactPage && !href.startsWith("#")) {
      const text = textOf(m[2]);
      let target;
      try {
        target = new URL(href, baseUrl);
      } catch {
        continue;
      }
      const looksLikeContact = /contact|get-in-touch|reach-us/i.test(target.pathname) || /^(contact|get in touch)\b/i.test(text);
      if (looksLikeContact && /^https?:$/.test(target.protocol) && sameSite(target, baseUrl)) {
        target.hash = "";
        if (target.toString() !== String(baseUrl)) contactPage = target.toString();
      }
    }
  }

  const text = textOf(cleaned);
  for (const hit of text.match(EMAIL_RE) || []) addEmail(hit);
  for (const hit of text.match(US_PHONE_RE) || []) addPhone(hit);

  return { emails: unique(emails).slice(0, 5), phones: unique(phones).slice(0, 5), contactPage };
}

export function mergeContacts(a, b) {
  return {
    emails: unique([...(a?.emails || []), ...(b?.emails || [])]).slice(0, 5),
    phones: unique([...(a?.phones || []), ...(b?.phones || [])]).slice(0, 5),
    contactPage: a?.contactPage || b?.contactPage || null,
  };
}

/** True when there is too little on the page to say anything honest about it. */
export function hasTooLittleContent(page) {
  return page.wordCount < 30 && page.headings.length === 0;
}
