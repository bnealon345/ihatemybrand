// What happens after a lead lands: size it up, score it, add to its trail, and alert Ned and Brian.

import { getLead, saveAnalysis, logEvent, getSettings, parseList } from "./leads.js";
import { runLeadAnalysis, scoreLead } from "./analysis.js";
import { buildAlert, sendAlert } from "./notify.js";

export function parseAnalysis(row) {
  try {
    const parsed = JSON.parse(row?.analysis_json || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function scoreRow(row, analysis = parseAnalysis(row)) {
  return scoreLead({
    analysis, visitorEmail: row.visitor_email, siteEmails: parseList(row.site_emails), sitePhones: parseList(row.site_phones),
  });
}

/**
 * kind: "new" (a teardown was just run) or "email_left" (the visitor added their email).
 * Give page and note to have the lead analysed; give analysis to reuse one from a repeat site.
 * Returns the analysis, or null. Never throws.
 */
export async function scoreAndAlert(env, id, { page, note, analysis, kind = "new" } = {}) {
  if (!env.DB) return null;
  try {
    let row = await getLead(env.DB, id);
    if (!row) return null;
    let read = analysis || parseAnalysis(row);
    if (!read && page && note) read = await runLeadAnalysis(page, note, env);

    const score = scoreRow(row, read);
    await saveAnalysis(env.DB, id, read, score.score);
    const scored = `Lead score ${score.score} (${score.label})`;
    await logEvent(env.DB, id, "score",
      kind === "email_left" ? `${scored} now that they left an email`
      : read ? `${scored}. Business ${read.businessScore}/10, brand ${read.brandScore}/10.${read.package ? ` Suggested: ${read.package}.` : ""} Outreach drafted.`
      : `${scored}. No AI read on this one.`);

    if (!row.is_test) {
      const settings = await getSettings(env.DB);
      if (settings.alertTo) {
        row = (await getLead(env.DB, id)) || row;
        const result = await sendAlert(env, settings.alertTo, buildAlert({ kind, row, analysis: read, score }));
        await logEvent(env.DB, id, "alert", result.sent ? `Alert emailed to ${result.sent} ${result.sent === 1 ? "person" : "people"}` : `Alert not sent: ${result.error}`);
      }
    }
    return read;
  } catch (err) {
    console.error("Follow-up failed", err?.stack || err);
    return null;
  }
}
