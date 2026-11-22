const json = (statusCode, status, message) => new Response(
  JSON.stringify({ status, message }),
  { status: statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } }
);

export default async (request) => {
  if (request.method !== "POST") return json(405, "error", "Method tidak diizinkan.");
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return json(503, "error", "Telegram belum dikonfigurasi di environment Netlify.");

  try {
    const type = request.headers.get("content-type") || "";
    const rawLength = request.headers.get("content-length");
    const length = rawLength === null ? 0 : Number(rawLength);
    if (!Number.isFinite(length) || length < 0) return json(400, "error", "Content-Length tidak valid.");
    if (length > 9 * 1024 * 1024) return json(413, "error", "Ukuran request maksimal 9 MB.");
    let endpoint, payload;
    if (type.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("photo");
      if (!(file instanceof File) || file.size < 1 || file.size > 8 * 1024 * 1024) return json(400, "error", "Foto wajib diisi dan maksimal 8 MB.");
      if (!file.type.startsWith("image/")) return json(400, "error", "Berkas harus berupa gambar.");
      endpoint = "sendPhoto";
      payload = new FormData();
      payload.set("chat_id", chatId);
      payload.set("caption", String(form.get("caption") || "").slice(0, 900));
      payload.set("photo", file, (file.name || "evidence.jpg").replace(/[^a-zA-Z0-9._-]/g, "_"));
    } else {
      if (!type.includes("application/json")) return json(415, "error", "Content-Type harus application/json atau multipart/form-data.");
      const raw = await request.text();
      if (raw.length > 16000) return json(413, "error", "Pesan request terlalu besar.");
      let data;
      try { data = JSON.parse(raw); } catch { return json(400, "error", "JSON request tidak valid."); }
      if (!data || data.action !== "message") return json(400, "error", "Action tidak valid.");
      const text = String(data.text || "").trim();
      if (!text || text.length > 3900) return json(400, "error", "Pesan kosong atau terlalu panjang.");
      endpoint = "sendMessage";
      payload = JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true });
    }
    const response = await fetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
      method: "POST",
      headers: payload instanceof FormData ? undefined : { "content-type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(25000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) return json(502, "error", result.description || "Telegram menolak permintaan.");
    return json(200, "success", "Pesan berhasil dikirim.");
  } catch (error) {
    return json(502, "error", error?.name === "TimeoutError" ? "Telegram timeout." : "Pengiriman Telegram gagal.");
  }
};
