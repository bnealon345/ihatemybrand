// A screenshot of the top of the visitor's page: what a stranger sees first.
// Taken with Cloudflare Browser Run through the BROWSER binding. Optional everywhere:
// if the binding is missing, the daily browser allowance is used up, or the site is slow,
// the teardown carries on with text only.

const WIDTH = 1280;
const HEIGHT = 800;
const MAX_BYTES = 1_500_000;
const TTL_SECONDS = 30 * 24 * 60 * 60;

/** Returns { bytes, mediaType, base64 } or null. Never throws. */
export async function takeScreenshot(env, url) {
  if (!env.BROWSER?.quickAction) return null;
  try {
    const res = await Promise.race([
      env.BROWSER.quickAction("screenshot", {
        url,
        viewport: { width: WIDTH, height: HEIGHT },
        screenshotOptions: { type: "jpeg", quality: 70 },
        gotoOptions: { waitUntil: "load", timeout: 12_000 },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("screenshot timed out")), 20_000)),
    ]);
    if (!res?.ok) {
      console.error("Screenshot failed", res?.status);
      await res?.body?.cancel().catch(() => {});
      return null;
    }
    const mediaType = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (!/^image\/(jpeg|png|webp)$/.test(mediaType)) return null;
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength < 1000 || bytes.byteLength > MAX_BYTES) return null;
    return { bytes, mediaType, base64: toBase64(bytes) };
  } catch (err) {
    console.error("Screenshot failed", err?.message || err);
    return null;
  }
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export async function saveScreenshot(env, id, shot) {
  if (!env.TEARDOWN_KV || !shot) return false;
  await env.TEARDOWN_KV.put(`shot:${id}`, shot.bytes, { expirationTtl: TTL_SECONDS, metadata: { type: shot.mediaType } });
  return true;
}

/** GET /teardown/shot/<id> */
export async function serveScreenshot(env, id) {
  const missing = new Response("Not found.", { status: 404, headers: { "x-robots-tag": "noindex" } });
  if (!env.TEARDOWN_KV || !/^[0-9a-f-]{36}$/.test(id)) return missing;
  const { value, metadata } = await env.TEARDOWN_KV.getWithMetadata(`shot:${id}`, "arrayBuffer");
  if (!value) return missing;
  return new Response(value, {
    headers: {
      "content-type": metadata?.type || "image/jpeg",
      "cache-control": "public, max-age=86400",
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
    },
  });
}
