// Keeps each lead's trail in step with real email.
//
// Point a Cloudflare Email Routing address (for example log@ihatemybrand.com) at this Worker.
//   - BCC that address when you email a lead: the trail shows that you emailed them, and a New lead moves to Contacted.
//   - Forward a lead's reply to it, or have replies copied to it: if the sender is a lead, the trail shows the reply
//     and the lead moves to Replied.
// Only the sender, recipients and subject are read. The message body is never stored.

import { findLeadsByEmail, logEvent, updateLead } from "./leads.js";

const ADDRESS = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const addresses = (text) => [...new Set((String(text || "").toLowerCase().match(ADDRESS) || []))];

export async function handleInboundEmail(message, env) {
  if (!env.DB) return;
  try {
    const from = addresses(message.from)[0] || "";
    const subject = String(message.headers.get("subject") || "(no subject)").replace(/\s+/g, " ").trim().slice(0, 140);
    const who = from.split("@")[0] || "someone";
    const logAddress = addresses(message.to)[0];
    const recipients = addresses([message.headers.get("to"), message.headers.get("cc")].join(",")).filter((a) => a !== logAddress && a !== from);

    // A copy of something sent to a lead.
    for (const address of recipients.slice(0, 10)) {
      const lead = (await findLeadsByEmail(env.DB, address, 1))[0];
      if (!lead) continue;
      await logEvent(env.DB, lead.id, "email_out", `${who} emailed ${address}: "${subject}"`, from);
      if (lead.stage === "new") await updateLead(env.DB, lead.id, { stage: "contacted" }, who);
    }

    // Something sent by a lead.
    const sender = (await findLeadsByEmail(env.DB, from, 1))[0];
    if (sender) {
      await logEvent(env.DB, sender.id, "email_in", `They emailed: "${subject}"`, from);
      if (sender.stage === "new" || sender.stage === "contacted") await updateLead(env.DB, sender.id, { stage: "replied" }, "email");
    }
  } catch (err) {
    console.error("Could not log email", err?.message || err);
  }
}
