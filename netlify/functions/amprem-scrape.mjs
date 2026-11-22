const SITE = "https://www.amnoiir.web.id";
const HOSTS = new Set(["www.amnoiir.web.id", "amnoiir.web.id"]);
const MAX_HTML = 1_000_000;
const MAX_PAGES = 5;
const MAX_SCRIPTS = 4;
const TOTAL_TIMEOUT_MS = 8_500;

const json = (statusCode, payload) => new Response(JSON.stringify(payload), {
  status: statusCode,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }
});

function safeURL(value, base = SITE) {
  try {
    const u = new URL(value, base);
    if (u.protocol !== "https:" || !HOSTS.has(u.hostname.toLowerCase()) || u.username || u.password) return null;
    u.hash = "";
    return u;
  } catch { return null; }
}

function decodeText(value = "") {
  return String(value).replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/\s+/g, " ").trim();
}

function attr(tag, name) {
  const re = new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
  const m = tag.match(re);
  return decodeText(m ? (m[1] ?? m[2] ?? m[3] ?? "") : "");
}

function extractPage(html, pageURL) {
  const title = decodeText((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  const description = decodeText((html.match(/<meta\b(?=[^>]*\bname\s*=\s*["']description["'])[^>]*>/i) || [])[0] ? attr((html.match(/<meta\b(?=[^>]*\bname\s*=\s*["']description["'])[^>]*>/i) || [])[0], "content") : "");
  const canonicalTag = (html.match(/<link\b(?=[^>]*\brel\s*=\s*["']canonical["'])[^>]*>/i) || [])[0] || "";
  const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => decodeText(m[1].replace(/<[^>]+>/g, " "))).filter(Boolean).slice(0, 8);
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(m[0], "href");
    const url = safeURL(href, pageURL);
    if (url) links.push({ url: url.href, text: "" });
  }
  const scripts = [];
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attr(m[0], "src");
    const url = src ? safeURL(src, pageURL) : null;
    if (url) scripts.push(url.href);
  }
  const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join("\n");
  const endpoints = findEndpointReferences(html + "\n" + inlineScripts, pageURL);
  return {
    url: pageURL,
    title,
    description,
    canonical: canonicalTag ? (safeURL(attr(canonicalTag, "href"), pageURL)?.href || "") : "",
    headings: h1,
    links: [...new Set(links.map(x => x.url))].slice(0, 80),
    scripts: [...new Set(scripts)].slice(0, 30),
    endpointReferences: endpoints
  };
}

function findEndpointReferences(source, base) {
  const found = new Set();
  const patterns = [/(?:https?:\\?\/\\?\/[^\s"'<>\\]+|\/(?:api|v\d+|graphql|rpc)(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?)/gi];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const raw = m[0].replace(/\\\//g, "/").replace(/[),.;]+$/, "");
      const u = safeURL(raw, base);
      if (u && /\/(?:api|v\d+|graphql|rpc)(?:\/|$)/i.test(u.pathname)) found.add(u.href);
      if (found.size >= 40) break;
    }
  }
  return [...found];
}

function robotsAllows(robots, pathname) {
  if (!robots) return true;
  let active = false;
  const disallow = [];
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), value = m[2].trim();
    if (key === "user-agent") active = value === "*";
    else if (key === "disallow" && active && value) disallow.push(value);
  }
  return !disallow.some(rule => pathname.startsWith(rule.replace(/\*$/, "")));
}

export default async function handler(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  if (request.method !== "POST") return json(405, { success: false, error: "Method tidak didukung." });
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 1024) return json(413, { success: false, error: "Request terlalu besar." });
  if (request.headers.get("content-type") && !request.headers.get("content-type").toLowerCase().includes("application/json")) return json(415, { success: false, error: "Gunakan Content-Type application/json." });
  try { await request.json(); } catch { return json(400, { success: false, error: "JSON request tidak valid." }); }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  const started = Date.now();
  const warnings = [];
  const fetched = new Map();
  const fetchText = async (input, kind = "html") => {
    const target = safeURL(input);
    if (!target) throw new Error("Target di luar domain yang diizinkan.");
    let current = target;
    for (let i = 0; i < 4; i++) {
      const res = await fetch(current.href, { method: "GET", redirect: "manual", signal: controller.signal, headers: { "user-agent": "YugenNexus-PublicResearch/1.0", accept: kind === "script" ? "text/javascript, application/javascript, */*;q=0.5" : "text/html,application/xhtml+xml;q=0.9" } });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const next = safeURL(res.headers.get("location") || "", current.href);
        if (!next) throw new Error("Redirect ke host lain diblokir.");
        current = next;
        continue;
      }
      if (!res.ok) throw new Error("Server sumber merespons HTTP " + res.status + ".");
      const type = (res.headers.get("content-type") || "").toLowerCase();
      if (kind === "html" && !/(text\/html|application\/xhtml\+xml)/.test(type)) throw new Error("Respons sumber bukan HTML.");
      const declared = Number(res.headers.get("content-length") || 0);
      if (declared > MAX_HTML) throw new Error("Konten sumber melebihi batas ukuran.");
      const text = await res.text();
      if (text.length > MAX_HTML) throw new Error("Konten sumber melebihi batas ukuran.");
      return { text, url: current.href, status: res.status };
    }
    throw new Error("Terlalu banyak redirect.");
  };

  try {
    let robots = "";
    try { robots = (await fetchText(SITE + "/robots.txt", "script")).text; }
    catch { warnings.push("robots.txt tidak dapat dibaca; crawler hanya mengambil halaman publik utama dan tautan terbatas."); }
    const queue = [SITE + "/"];
    const rootPages = [];
    while (queue.length && fetched.size < MAX_PAGES && Date.now() - started < TOTAL_TIMEOUT_MS - 1200) {
      const next = queue.shift();
      const u = safeURL(next);
      if (!u || fetched.has(u.href) || !robotsAllows(robots, u.pathname)) continue;
      try {
        const result = await fetchText(u.href, "html");
        const page = extractPage(result.text, result.url);
        fetched.set(u.href, page);
        rootPages.push({ page, html: result.text });
        for (const link of page.links) {
          const linkURL = safeURL(link, SITE);
          if (!linkURL || fetched.has(linkURL.href) || queue.includes(linkURL.href)) continue;
          if (/\.(?:pdf|zip|png|jpe?g|gif|svg|webp|mp4|mp3|css|js|xml|json|woff2?)(?:$|\?)/i.test(linkURL.pathname)) continue;
          if (queue.length < 20) queue.push(linkURL.href);
        }
      } catch (error) {
        warnings.push("Gagal mengambil " + u.pathname + ": " + (error.name === "AbortError" ? "batas waktu tercapai" : error.message));
        if (!fetched.size) throw error;
      }
    }

    const scripts = [...new Set(rootPages.flatMap(x => x.page.scripts))].slice(0, MAX_SCRIPTS);
    const endpointSet = new Set(rootPages.flatMap(x => x.page.endpointReferences));
    for (const scriptURL of scripts) {
      if (Date.now() - started >= TOTAL_TIMEOUT_MS - 500) { warnings.push("Pemindaian JavaScript dihentikan karena batas waktu."); break; }
      try {
        const result = await fetchText(scriptURL, "script");
        findEndpointReferences(result.text, result.url).forEach(x => endpointSet.add(x));
      } catch (error) { warnings.push("Referensi script dilewati: " + (error.name === "AbortError" ? "batas waktu" : error.message)); }
    }

    const pages = [...fetched.values()].map(({ scripts: _scripts, ...page }) => page);
    const allLinks = [...new Set(pages.flatMap(p => p.links))].slice(0, 120);
    return json(200, {
      success: true,
      source: SITE,
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      totals: { pages: pages.length, links: allLinks.length, scripts: scripts.length, endpointReferences: endpointSet.size },
      pages,
      links: allLinks,
      scriptFiles: scripts,
      endpointReferences: [...endpointSet].slice(0, 80),
      warnings,
      safety: "Hanya mengambil konten publik pada domain amnoiir.web.id. Referensi endpoint hanya dideteksi, tidak dipanggil atau dieksploitasi."
    });
  } catch (error) {
    const timeout = error.name === "AbortError";
    return json(timeout ? 504 : 502, { success: false, error: timeout ? "Scraping melewati batas waktu. Coba lagi." : error.message || "Scraping gagal.", warnings });
  } finally { clearTimeout(timer); }
}
