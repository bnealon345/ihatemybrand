// Adds the teardown entry points to the main site's homepage without touching the main site's code.
//
// The main site is a separate Worker ("ihatemybrand"), reached here through the SITE service binding.
// This Worker sits in front of the homepage only (route: ihatemybrand.com/), asks the main site for
// its page, and adds three things on the way through:
//   1. a "Free teardown" link in the nav
//   2. the thumbs logo beside the hero headline, flipping to thumbs-up when "hate" turns to "love"
//   3. the "Drop your website" band under the hero
// If the main site's markup changes and a target isn't found, that piece is skipped and the page is
// served as the main site sent it. To switch all of this off, remove the two "/" routes in wrangler.jsonc.

const CSS = `
nav a.tdn{display:inline-flex;align-items:center;gap:8px;color:var(--paper);font-weight:700}
nav a.tdn i{font-family:var(--mono);font-style:normal;font-weight:500;font-size:10px;letter-spacing:.14em;text-transform:uppercase;background:var(--lime);color:var(--navy);padding:3px 7px;border-radius:999px}

/* The headline is capped a little lower than the main site's 200px so both lines fit beside the thumb. */
.hero h1{font-size:clamp(72px,13.5vw,176px)}
.hero h1 .ihmb-thumb{float:left;width:1.61em;height:1.61em;margin:.062em .15em 0 0;background:var(--lime);display:flex;align-items:center;justify-content:center}
.ihmb-thumb svg{width:78%;height:78%;display:block}
.ihmb-thumb .thumb{transform-box:view-box;transform-origin:51px 46px;transition:transform .35s cubic-bezier(.3,1.4,.5,1)}
.hero h1:has(.swap.hov:hover) .ihmb-thumb .thumb{transform:rotate(180deg)}

.tdb{position:relative;background:var(--lime);color:var(--navy);margin-bottom:clamp(56px,7vw,96px)}
.tdb .wrap{position:relative;padding-top:clamp(56px,7vw,92px);padding-bottom:clamp(60px,7vw,96px)}
.tdb :focus-visible{outline-color:var(--navy)}
.tdb .eyebrow{color:var(--navy);font-size:13px;letter-spacing:.2em;padding-right:190px}
.tdb h2{font-size:clamp(44px,8.6vw,124px);line-height:.98;letter-spacing:-.025em;margin-top:20px}
.tdb h2 em{font-style:normal;display:inline-block;background:var(--navy);color:#fff;padding:0 .14em .04em;transform:rotate(-1.5deg)}
.tdb-tag{font-size:clamp(28px,3.4vw,44px);line-height:1.15;margin-top:22px}
.tdb-badge{position:absolute;z-index:2;right:var(--pad);top:-66px;width:164px;height:164px;border-radius:50%;background:#fff;color:var(--navy);border:6px solid var(--navy);box-shadow:8px 8px 0 var(--navy);display:flex;flex-direction:column;align-items:center;justify-content:center;transform:rotate(12deg)}
.tdb-badge b{font-weight:900;font-stretch:75%;font-size:50px;line-height:.9;text-transform:uppercase}
.tdb-badge span{margin-top:8px;font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase}
.tdb form{margin-top:40px;max-width:980px;background:#fff;border:4px solid var(--navy);border-radius:32px;padding:22px 22px 22px 30px;box-shadow:12px 12px 0 var(--navy)}
.tdb label{display:block;margin:4px 0 12px;font-family:var(--mono);font-size:12px;letter-spacing:.22em;text-transform:uppercase}
.tdb-row{display:flex;flex-wrap:wrap;align-items:center;gap:14px}
.tdb input{flex:1 1 260px;min-width:0;font:inherit;font-size:clamp(22px,2.6vw,34px);font-weight:700;color:var(--navy);background:transparent;border:0;border-bottom:3px solid var(--navy);border-radius:0;padding:8px 2px 10px}
.tdb input::placeholder{color:#5d6a85;opacity:1}
.tdb input:focus-visible{outline:3px solid var(--navy);outline-offset:6px}
.tdb button{font:inherit;font-weight:700;font-size:20px;white-space:nowrap;color:#fff;background:var(--navy);border:0;border-radius:999px;padding:22px 34px;cursor:pointer;transition:background .2s}
.tdb button:hover{background:#1b3460}
.tdb-points{display:flex;flex-wrap:wrap;gap:8px 28px;margin-top:34px;font-family:var(--mono);font-size:13px;letter-spacing:.16em;text-transform:uppercase}

@media (max-width:980px){nav a.tdn{display:none}}
@media (max-width:640px){
  .hero h1 .ihmb-thumb{float:none;width:1.15em;height:1.15em;margin:0 0 .2em}
  .tdb .eyebrow{padding-right:120px}
  .tdb-badge{width:112px;height:112px;top:-44px;border-width:4px;box-shadow:5px 5px 0 var(--navy)}
  .tdb-badge b{font-size:32px}
  .tdb-badge span{font-size:9px;margin-top:5px}
  .tdb form{padding:18px;border-radius:24px;box-shadow:8px 8px 0 var(--navy)}
  .tdb button{width:100%}
  .tdb-points{flex-direction:column;gap:6px}
  .tdb-points span[aria-hidden]{display:none}
}
`;

const NAV_LINK = `<a class="tdn" href="/teardown/">Free teardown <i>New</i></a>\n      `;

// Same mark as the header logo, so the two flip the same way.
const THUMB = `<span class="ihmb-thumb" aria-hidden="true"><svg viewBox="0 0 100 100"><path d="M8 8H92V80H58L50 93L42 80H8Z" fill="#0b1a33"/><g class="thumb"><rect x="69" y="18" width="11" height="36" fill="#eaf3fb"/><path d="M64 18H37C31 18 28.5 21.5 27.5 25.5L22.5 45C21 51 24.5 54.5 30 54.5H41L37 66C35.5 71 38.5 75 43 75H46.5L61 55H64Z" fill="#eaf3fb"/></g></svg></span>`;

const BAND = `
<section class="tdb" id="teardown" aria-labelledby="tdb-h">
  <div class="wrap">
    <div class="tdb-badge" aria-hidden="true"><b>Free</b><span>20 seconds</span></div>
    <span class="eyebrow">Not sure what's wrong? · Free brand teardown</span>
    <h2 id="tdb-h">Drop your website. We'll tell you <em>what's broken.</em></h2>
    <p class="serif tdb-tag">It's free. It might sting.</p>
    <form action="/teardown/" method="get">
      <label for="tdb-url">Your website</label>
      <div class="tdb-row">
        <input id="tdb-url" name="url" type="text" inputmode="url" autocomplete="url" autocapitalize="none" spellcheck="false" placeholder="yourbrand.com" required>
        <button type="submit">Tear it down <span aria-hidden="true">→</span></button>
      </div>
    </form>
    <p class="tdb-points"><span>One brutally honest note</span><span aria-hidden="true">/</span><span>The fix written out</span><span aria-hidden="true">/</span><span>No email</span><span aria-hidden="true">/</span><span>No call</span></p>
  </div>
</section>
`;

function isLocal(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** preview = true serves the changed homepage at a private address, for checking before it goes live. */
export async function serveHome(request, env, { preview = false } = {}) {
  const url = new URL(request.url);
  const upstream = preview ? new Request(new URL("/", url).toString(), { headers: { accept: "text/html" } }) : request;

  let res;
  if (env.SITE) res = await env.SITE.fetch(upstream);
  else if (isLocal(url.hostname)) return Response.redirect(new URL("/teardown/", url).toString(), 302);
  else res = await fetch(upstream);

  const isPage = request.method === "GET" && res.ok && (res.headers.get("content-type") || "").includes("text/html");
  if (!isPage || typeof HTMLRewriter === "undefined") return res;

  const out = new HTMLRewriter()
    .on("head", { element(el) { el.append(`<style>${CSS}</style>`, { html: true }); } })
    .on("header nav a.btn", { element(el) { el.before(NAV_LINK, { html: true }); } })
    .on("section.hero h1", { element(el) { el.prepend(THUMB, { html: true }); } })
    .on("section.hero", { element(el) { el.after(BAND, { html: true }); } })
    .transform(res);

  if (!preview) return out;
  const headers = new Headers(out.headers);
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set("cache-control", "no-store");
  return new Response(out.body, { status: out.status, headers });
}
