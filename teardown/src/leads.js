// Lead storage in Cloudflare D1. One row per teardown someone ran.
// The table is created on first use, so there is no migration step to run.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS teardowns (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    input_url TEXT NOT NULL,
    final_url TEXT,
    domain TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL,
    from_cache INTEGER NOT NULL DEFAULT 0,
    site_title TEXT,
    note_problem TEXT,
    note_why TEXT,
    note_fix TEXT,
    visitor_email TEXT,
    site_emails TEXT,
    site_phones TEXT,
    contact_page TEXT,
    social_links TEXT,
    country TEXT,
    prompt_version INTEGER,
    stage TEXT NOT NULL DEFAULT 'new',
    owner TEXT,
    admin_notes TEXT,
    updated_at TEXT,
    updated_by TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS teardowns_created_at ON teardowns (created_at)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // Every saved auditor prompt. The newest row is the one in use. An empty prompt means "the built-in one".
  `CREATE TABLE IF NOT EXISTS prompt_versions (version INTEGER PRIMARY KEY, created_at TEXT NOT NULL, created_by TEXT, prompt TEXT NOT NULL)`,
];

// Columns added after the first version. Added to an existing table if they are missing.
const LATER_COLUMNS = {
  stage: "TEXT NOT NULL DEFAULT 'new'",
  owner: "TEXT",
  admin_notes: "TEXT",
  updated_at: "TEXT",
  updated_by: "TEXT",
  prompt_version: "INTEGER",
};

export const STAGES = ["new", "contacted", "replied", "won", "not_a_fit", "do_not_contact"];
export const DEFAULT_SETTINGS = { paused: false, dailyLimit: 5 };

const ready = new WeakMap();

export function ensureSchema(db) {
  if (!ready.has(db)) {
    const setup = (async () => {
      for (const sql of SCHEMA) await db.prepare(sql).run();
      const have = new Set(((await db.prepare(`PRAGMA table_info(teardowns)`).all()).results || []).map((c) => c.name));
      for (const [name, type] of Object.entries(LATER_COLUMNS)) {
        if (!have.has(name)) await db.prepare(`ALTER TABLE teardowns ADD COLUMN ${name} ${type}`).run();
      }
    })();
    setup.catch(() => ready.delete(db)); // try again on the next request
    ready.set(db, setup);
  }
  return ready.get(db);
}

const list = (value) => JSON.stringify(Array.isArray(value) ? value : []);

export async function insertLead(db, lead) {
  await ensureSchema(db);
  await db
    .prepare(
      `INSERT INTO teardowns (id, created_at, input_url, final_url, domain, tier, status, from_cache, site_title,
         note_problem, note_why, note_fix, site_emails, site_phones, contact_page, social_links, country, prompt_version)
       VALUES (?, ?, ?, ?, ?, 'free', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      lead.id,
      lead.createdAt,
      lead.inputUrl,
      lead.finalUrl ?? null,
      lead.domain,
      lead.status,
      lead.fromCache ? 1 : 0,
      lead.siteTitle ?? null,
      lead.note?.problem ?? null,
      lead.note?.why ?? null,
      lead.note?.fix ?? null,
      list(lead.contacts?.emails),
      list(lead.contacts?.phones),
      lead.contacts?.contactPage ?? null,
      list(lead.socialLinks),
      lead.country ?? null,
      lead.promptVersion ?? null,
    )
    .run();
}

export async function updateContacts(db, id, contacts) {
  await ensureSchema(db);
  await db
    .prepare(`UPDATE teardowns SET site_emails = ?, site_phones = ?, contact_page = ? WHERE id = ?`)
    .bind(list(contacts?.emails), list(contacts?.phones), contacts?.contactPage ?? null, id)
    .run();
}

/** Returns true if a teardown with that id exists and now has the email on it. */
export async function saveVisitorEmail(db, id, email) {
  await ensureSchema(db);
  const res = await db.prepare(`UPDATE teardowns SET visitor_email = ? WHERE id = ?`).bind(email, id).run();
  return (res?.meta?.changes ?? 0) > 0;
}

const REACHABLE = `(visitor_email IS NOT NULL OR site_emails NOT IN ('[]', '') OR site_phones NOT IN ('[]', ''))`;

/** Newest first. Filters: stage, q (search text), reachable (only leads with a way to contact them). */
export async function listLeads(db, { stage, q, reachable, limit = 500 } = {}) {
  await ensureSchema(db);
  const where = [];
  const args = [];
  if (STAGES.includes(stage)) {
    where.push(`stage = ?`);
    args.push(stage);
  }
  if (reachable) where.push(REACHABLE);
  const needle = String(q || "").trim().toLowerCase().slice(0, 100);
  if (needle) {
    // instr, not LIKE, so % and _ in a search are just characters.
    where.push(
      `(instr(lower(domain), ?) OR instr(lower(coalesce(visitor_email, '')), ?) OR instr(lower(coalesce(site_emails, '')), ?)
        OR instr(lower(coalesce(site_title, '')), ?) OR instr(lower(coalesce(note_problem, '')), ?) OR instr(lower(coalesce(admin_notes, '')), ?))`,
    );
    args.push(needle, needle, needle, needle, needle, needle);
  }
  const sql = `SELECT * FROM teardowns ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
  const res = await db.prepare(sql).bind(...args, limit).all();
  return res.results || [];
}

export async function leadStats(db, now = new Date()) {
  await ensureSchema(db);
  const today = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  const totals = (
    await db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today,
                SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS week,
                SUM(CASE WHEN visitor_email IS NOT NULL THEN 1 ELSE 0 END) AS gave_email,
                SUM(CASE WHEN ${REACHABLE} THEN 1 ELSE 0 END) AS reachable
         FROM teardowns`,
      )
      .bind(today, weekAgo)
      .all()
  ).results?.[0] || {};
  const stages = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const row of (await db.prepare(`SELECT stage, COUNT(*) AS n FROM teardowns GROUP BY stage`).all()).results || []) {
    if (row.stage in stages) stages[row.stage] = Number(row.n);
  }
  const num = (v) => Number(v || 0);
  return {
    total: num(totals.total), today: num(totals.today), week: num(totals.week),
    gaveEmail: num(totals.gave_email), reachable: num(totals.reachable), stages,
  };
}

/** Change stage, owner or notes. Returns true if the lead exists. Throws on a bad value. */
export async function updateLead(db, id, changes, by, now = new Date()) {
  await ensureSchema(db);
  const sets = [];
  const args = [];
  if (changes.stage !== undefined) {
    if (!STAGES.includes(changes.stage)) throw new RangeError("Unknown stage.");
    sets.push(`stage = ?`);
    args.push(changes.stage);
  }
  if (changes.owner !== undefined) {
    const owner = String(changes.owner || "").trim().toLowerCase().slice(0, 40);
    sets.push(`owner = ?`);
    args.push(owner || null);
  }
  if (changes.notes !== undefined) {
    sets.push(`admin_notes = ?`);
    args.push(String(changes.notes || "").slice(0, 4000) || null);
  }
  if (!sets.length) throw new RangeError("Nothing to change.");
  sets.push(`updated_at = ?`, `updated_by = ?`);
  args.push(now.toISOString(), by);
  const res = await db.prepare(`UPDATE teardowns SET ${sets.join(", ")} WHERE id = ?`).bind(...args, id).run();
  return (res?.meta?.changes ?? 0) > 0;
}

export async function deleteLead(db, id) {
  await ensureSchema(db);
  const res = await db.prepare(`DELETE FROM teardowns WHERE id = ?`).bind(id).run();
  return (res?.meta?.changes ?? 0) > 0;
}

export async function getSettings(db) {
  await ensureSchema(db);
  const out = { ...DEFAULT_SETTINGS };
  for (const row of (await db.prepare(`SELECT key, value FROM settings`).all()).results || []) {
    if (row.key === "paused") out.paused = row.value === "1";
    if (row.key === "dailyLimit") {
      const n = parseInt(row.value, 10);
      if (Number.isInteger(n) && n >= 1 && n <= 100) out.dailyLimit = n;
    }
  }
  return out;
}

export async function saveSettings(db, changes) {
  await ensureSchema(db);
  const put = (key, value) =>
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, value).run();
  if (changes.paused !== undefined) await put("paused", changes.paused ? "1" : "0");
  if (changes.dailyLimit !== undefined) {
    const n = Number(changes.dailyLimit);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new RangeError("The daily limit must be a whole number from 1 to 100.");
    await put("dailyLimit", String(n));
  }
  return getSettings(db);
}

// ---------- auditor prompt versions ----------

export const PROMPT_MIN = 200;
export const PROMPT_MAX = 20000;
const PROMPT_HISTORY = 40;

/** The prompt in use: { version, prompt }. version 0 and an empty prompt mean the built-in one. */
export async function getActivePrompt(db) {
  await ensureSchema(db);
  const row = (await db.prepare(`SELECT version, prompt FROM prompt_versions ORDER BY version DESC LIMIT 1`).all()).results?.[0];
  return row ? { version: Number(row.version), prompt: String(row.prompt || "") } : { version: 0, prompt: "" };
}

/** Saves a new version and makes it the one in use. Pass "" to go back to the built-in prompt. */
export async function savePrompt(db, prompt, by, now = new Date()) {
  await ensureSchema(db);
  const text = String(prompt ?? "").replace(/\r\n/g, "\n").trim();
  if (text && text.length < PROMPT_MIN) throw new RangeError(`That prompt is too short to audit with. Give it at least ${PROMPT_MIN} characters.`);
  if (text.length > PROMPT_MAX) throw new RangeError(`That prompt is too long. Keep it under ${PROMPT_MAX} characters.`);
  const current = await getActivePrompt(db);
  if (current.prompt === text) return current; // nothing changed, no new version
  const version = current.version + 1;
  await db.prepare(`INSERT INTO prompt_versions (version, created_at, created_by, prompt) VALUES (?, ?, ?, ?)`)
    .bind(version, now.toISOString(), by, text).run();
  await db.prepare(`DELETE FROM prompt_versions WHERE version <= ?`).bind(version - PROMPT_HISTORY).run();
  return { version, prompt: text };
}

export async function listPromptVersions(db, limit = 15) {
  await ensureSchema(db);
  return (await db.prepare(`SELECT * FROM prompt_versions ORDER BY version DESC LIMIT ?`).bind(limit).all()).results || [];
}

export function parseList(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

const CSV_COLUMNS = [
  "created_at", "domain", "status", "visitor_email", "site_emails", "site_phones", "contact_page",
  "social_links", "note_problem", "note_why", "note_fix", "site_title", "input_url", "final_url",
  "from_cache", "country", "stage", "owner", "admin_notes", "prompt_version", "id",
];
const LIST_COLUMNS = new Set(["site_emails", "site_phones", "social_links"]);

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  // Stop spreadsheet apps from running a cell as a formula. Site content is written by strangers.
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      CSV_COLUMNS.map((col) => csvCell(LIST_COLUMNS.has(col) ? parseList(row[col]).join("; ") : row[col])).join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
