# Brand Teardown

A visitor drops their website and gets one brutally honest note on the biggest problem with their brand. Every teardown is saved as a lead. Runs as a Cloudflare Worker.

**Built:** URL in, free note out. Lead storage, contact details pulled from the site, optional visitor email, and a back office for working the leads.

**Not built yet:** the shareable report card, Stripe and the full teardown, screenshots, automated outreach.

## Run it

```
cd teardown
npm install
cp .dev.vars.example .dev.vars    # then paste a Claude API key and admin logins into it
npm run dev                       # open the printed address
```

## Put it live

The database and the cache already exist in the Cloudflare account and are wired up in `wrangler.jsonc`. Two secrets and a deploy are left:

```
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ADMIN_USERS           # type: ned:a-long-password,brian:another-long-password
npm run deploy
```

It goes live at `ihatemybrand.com/teardown`. The rest of the domain stays with the main site.

## Back office

Open `/teardown/admin` and sign in with your name and your own password from `ADMIN_USERS`. Passwords can't contain a comma.

What it does:

- **Numbers at the top:** teardowns today, last 7 days, all time, how many you can reach, how many left their own email, how many you've won.
- **Work each lead:** set a stage (New, Contacted, Replied, Won, Not a fit, Do not contact), assign it to Ned or Brian, and keep notes. Every change is stamped with who made it.
- **Email them:** opens your own mail app with a draft built from their note, with an opt-out line. Nothing is sent by the system. Clicking it moves a New lead to Contacted.
- **Find things:** tabs per stage, search by site, email or note, and a "only leads we can reach" filter.
- **Download CSV:** exports whatever the current filter shows.
- **Delete:** removes a lead for good, for when someone asks you to.
- **Teardown controls:** pause new teardowns (stops all audit spending) and set how many free teardowns one visitor gets per day.
- **Auditor prompt** (its own tab): edit what the AI is told before it reads a site. Every save is a numbered version you can go back to, and "Try it before you save" runs a draft on a real site without saving or creating a lead. A saved change applies to the next teardown. The answer format and the never-invent rule are locked and added after your text.

Each teardown saves:

- the website they typed, where it ended up, and when
- the note they were shown (problem, why, fix)
- emails and phone numbers the site itself publishes (mailto and tel links, visible text, structured data, and one look at the contact page), plus the contact page link and social profiles
- the visitor's own email, if they leave it under the note
- the visitor's country

Sites that failed (down, blocking bots, empty) are saved too, with the reason and no note. Contact details are never sent back to the visitor's browser.

For an automated outreach system, read the same table (`teardowns` in the D1 database) or pull the CSV. Skip any row whose `stage` is `do_not_contact`.

**Before automating outreach, know this:** the person who typed a website is not always its owner, and nobody on this list has asked to hear from you unless `visitor_email` is filled. Cold email to a business address is generally allowed in the US if it is honest and has a working opt-out. Automated texts and calls to scraped numbers are a different matter and usually need consent. Check with a lawyer before turning on anything automatic.

## Where things are

| File | Job |
| --- | --- |
| `public/teardown/index.html` | The page. Colors and fonts are the variables at the top of the style block. |
| `src/index.js` | Routes, cache, rate limit, saving leads. |
| `src/safe-fetch.js` | Fetches the visitor's site. Blocks private addresses, caps time and size. |
| `src/extract.js` | Pulls page content for the auditor, and contact details for the lead. |
| `src/audit.js` | The auditor prompt and the Claude API call. |
| `src/leads.js` | The leads table and CSV. |
| `src/admin.js` | The back office: sign-in, dashboard, lead actions, settings. |
| `test/` | `npm test`. No network or key needed. |

## Placeholders Brian needs to fill

- Booking or pricing link (`index.html`, the "Have us fix it" button)
- Claude API key, admin logins, database id (above)
- Real font names, if different from the ones matched by eye
- Later phases: price, Stripe keys, sender email

## Known limits

- No screenshot, so the auditor is told not to comment on visual design.
- Sites that only show content after JavaScript runs come back as "too little content".
- Contact details are only what the site publishes in plain view. Sites that hide them behind forms will show none.
- The rate limit is per IP only.
