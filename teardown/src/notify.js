// Email alerts to Ned and Brian when a lead comes in.
// Uses Cloudflare's send_email binding (EMAIL). On the free plan it can only send to addresses
// verified in the account's Email Routing, which is exactly who these alerts are for.
// Recipients live in the back office settings, not in this repo.

const FROM = "alerts@ihatemybrand.com";
const ADMIN = "https://ihatemybrand.com/teardown/admin";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function parseRecipients(value) {
  return [...new Set(String(value || "").split(/[\s,;]+/).map((a) => a.trim().toLowerCase()).filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(a)))].slice(0, 5);
}

export function buildAlert({ kind, row, analysis, score }) {
  const list = (value) => {
    try {
      return JSON.parse(value || "[]");
    } catch {
      return [];
    }
  };
  const emails = list(row.site_emails);
  const phones = list(row.site_phones);
  const scoreText = score ? `${score.score} (${score.label})` : "not scored";
  const subject =
    kind === "email_left" ? `${row.domain} left their email. Lead score ${scoreText}`
    : kind === "test" ? "Test alert from the teardown back office"
    : `New teardown: ${row.domain}. Lead score ${scoreText}`;

  const lines = [
    kind === "email_left" ? `The visitor who ran ${row.domain} just left their email: ${row.visitor_email}` : `Someone just ran ${row.domain} through the teardown.`,
    row.from_cache ? "(This site was already audited today, so they saw the saved note.)" : "",
    "",
    `Lead score: ${scoreText}`,
    analysis ? `Business: ${analysis.businessType}. Looks real: ${analysis.businessScore}/10. Brand: ${analysis.brandScore}/10.` : "",
    analysis?.businessSummary || "",
    analysis?.package ? `Suggested: ${analysis.package} (${analysis.packagePrice}). ${analysis.packageWhy}` : "",
    "",
    row.note_problem ? `What we told them: ${row.note_problem}` : `No note: their site failed (${row.status}).`,
    "",
    "How to reach them:",
    row.visitor_email ? `  Left with us: ${row.visitor_email}` : "",
    emails.length ? `  On their site: ${emails.join(", ")}` : "",
    phones.length ? `  Phone: ${phones.join(", ")}` : "",
    !row.visitor_email && !emails.length && !phones.length ? "  Nothing found. Check their contact page." : "",
    "",
    `Open the lead: ${ADMIN}/lead/${row.id}`,
    analysis?.outreachBody ? `\nDraft email (edit before sending):\nSubject: ${analysis.outreachSubject}\n\n${analysis.outreachBody}` : "",
  ].filter((line, i, all) => line !== "" || all[i - 1] !== "");

  const textBody = kind === "test" ? `This is a test. If you're reading it, lead alerts are working.\n\n${ADMIN}` : lines.join("\n");
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0b1a33;white-space:pre-wrap">${esc(textBody)}</div>`;
  return { subject, text: textBody, html };
}

/** Returns { sent, failed, error }. Never throws. */
export async function sendAlert(env, recipients, message) {
  const to = parseRecipients(recipients);
  if (!env.EMAIL?.send) return { sent: 0, failed: to.length, error: "Email sending isn't connected to this Worker yet." };
  if (!to.length) return { sent: 0, failed: 0, error: "No alert addresses are set." };
  let sent = 0;
  let error = "";
  for (const address of to) {
    try {
      await env.EMAIL.send({ to: address, from: FROM, subject: message.subject, text: message.text, html: message.html });
      sent++;
    } catch (err) {
      error = String(err?.message || err).slice(0, 200);
      console.error("Alert email failed", address.replace(/^[^@]+/, "***"), error);
    }
  }
  return { sent, failed: to.length - sent, error };
}
