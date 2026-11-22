const ALLOWED_HOSTS = new Set([
  "api.nexray.web.id", "api.nexray.eu.cc", "api.ikyyxd.my.id",
  "xyloapi.qzz.io", "api.nexadev.my.id", "apii.nexadev.my.id",
  "saavn.dev", "itunes.apple.com", "lrclib.net",
  "generativelanguage.googleapis.com", "api.vercel.com",
  "api.netlify.com", "tmpfiles.org", "uguu.se", "catbox.moe",
  "ipapi.co", "anita-studio.netlify.app", "www.tikwm.com"
]);
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const json = (statusCode, status, message, result = null) => new Response(
  JSON.stringify({ status, message, result }),
  { status: statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } }
);

function validateTarget(raw) {
  if (!raw || raw.length > 4096) throw new Error("URL target tidak valid.");
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Hanya HTTPS yang diizinkan.");
  if (url.username || url.password || url.port) throw new Error("Kredensial atau port khusus tidak diizinkan.");
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) throw new Error("Domain API tidak ada dalam allowlist.");
  return url;
}

export default async (request) => {
  if (request.method !== "GET" && request.method !== "POST") return json(405, "error", "Method tidak diizinkan.");
  const incoming = new URL(request.url);
  let target;
  try { target = validateTarget(incoming.searchParams.get("url") || ""); }
  catch (error) { return json(400, "error", error.message); }

  let body;
  if (request.method === "POST") {
    const rawLength = request.headers.get("content-length");
    const length = rawLength === null ? 0 : Number(rawLength);
    if (!Number.isFinite(length) || length < 0) return json(400, "error", "Content-Length tidak valid.");
    if (length > MAX_REQUEST_BYTES) return json(413, "error", "Ukuran request terlalu besar.");
    try {
      body = await request.arrayBuffer();
    } catch {
      return json(400, "error", "Body request tidak dapat dibaca.");
    }
    if (body.byteLength > MAX_REQUEST_BYTES) return json(413, "error", "Ukuran request terlalu besar.");
  }
  const headers = new Headers();
  for (const key of ["accept", "content-type"]) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    let upstream = await fetch(target, { method: request.method, headers, body, redirect: "manual", signal: controller.signal });
    // Follow only HTTPS redirects to domains in the same strict allowlist.
    for (let hop = 0; upstream.status >= 300 && upstream.status < 400 && upstream.headers.get("location") && hop < 3; hop++) {
      const next = validateTarget(new URL(upstream.headers.get("location"), target).toString());
      upstream = await fetch(next, { method: request.method, headers, body, redirect: "manual", signal: controller.signal });
      target = next;
    }

    const declaredResponseLength = Number(upstream.headers.get("content-length") || 0);
    if (declaredResponseLength > MAX_RESPONSE_BYTES) {
      try { await upstream.body?.cancel(); } catch {}
      return json(502, "error", "Respons API melewati batas 25 MB.");
    }
    const chunks = [];
    let total = 0;
    if (upstream.body) {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          try { await reader.cancel(); } catch {}
          return json(502, "error", "Respons API melewati batas 25 MB.");
        }
        chunks.push(value);
      }
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    const responseHeaders = new Headers({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-type": upstream.headers.get("content-type") || "application/octet-stream"
    });
    const disposition = upstream.headers.get("content-disposition");
    if (disposition) responseHeaders.set("content-disposition", disposition);
    return new Response(data, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    return json(502, "error", error?.name === "AbortError" || error?.name === "TimeoutError" ? "API timeout." : "Tidak dapat menghubungi API tujuan.");
  } finally {
    clearTimeout(timeout);
  }
};
