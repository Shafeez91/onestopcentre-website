// WhatsApp Business Platform (Meta Cloud API) adapter. Zero dependencies.
// Official API only: webhook signature check, payload parsing, the 24-hour customer-service window and sending.
import { createHmac, timingSafeEqual } from "node:crypto";

export const WINDOW_MS = 24 * 3600 * 1000;
const DEFAULT_VERSION = "v23.0";

/** Checks Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the app secret). */
export function verifySignature(rawBody, header, appSecret) {
  if (!appSecret || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  let given;
  try { given = Buffer.from(header.slice(7), "hex"); } catch { return false; }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The text a buyer sent, for every message type the AI can read. Media and other types become "[type]". */
export function textOf(m) {
  if (!m) return "";
  if (m.type === "text") return String(m.text?.body || "");
  if (m.type === "button") return String(m.button?.text || "");
  if (m.type === "interactive") return String(m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "");
  if (["image", "video", "document"].includes(m.type) && m[m.type]?.caption) return `[${m.type}] ${m[m.type].caption}`;
  return `[${m.type || "unknown"}]`;
}
export const isReadable = (m) => ["text", "button", "interactive"].includes(m?.type) && textOf(m).trim() !== "";

/**
 * Flattens a webhook payload into inbound messages, delivery statuses and echoes.
 * Echoes ("smb_message_echoes") are messages the business sent from the WhatsApp Business app on the phone,
 * when the number is used in the app and the API at the same time (coexistence).
 * Only events for `phoneNumberId` are kept when it is given (other numbers on the same app are ignored).
 */
export function parseWebhook(payload, phoneNumberId = null) {
  const messages = [], statuses = [], echoes = [];
  if (payload?.object !== "whatsapp_business_account") return { messages, statuses, echoes };
  for (const entry of payload.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (phoneNumberId && v.metadata?.phone_number_id && String(v.metadata.phone_number_id) !== String(phoneNumberId)) continue;
      if (ch.field === "smb_message_echoes") {
        for (const m of v.message_echoes || []) {
          if (!m?.id || !m?.to) continue;
          echoes.push({ wa_id: String(m.to), wamid: String(m.id), type: m.type || "unknown", text: textOf(m).slice(0, 4096),
            sent_at: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null });
        }
        continue;
      }
      if (ch.field !== "messages") continue;
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name || null]));
      for (const m of v.messages || []) {
        if (!m?.id || !m?.from) continue;
        messages.push({
          wa_id: String(m.from), name: names[m.from] || null, wamid: String(m.id), type: m.type || "unknown",
          text: textOf(m).slice(0, 4096), readable: isReadable(m),
          sent_at: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null, raw: m,
        });
      }
      for (const s of v.statuses || []) {
        if (!s?.id || !s?.status) continue;
        const err = (s.errors || [])[0];
        statuses.push({ wamid: String(s.id), status: s.status, error: err ? `${err.code || ""} ${err.title || err.message || ""}`.trim() : null, raw: s });
      }
    }
  }
  return { messages, statuses, echoes };
}

/** True while free-form messages are allowed: within 24 hours of the buyer's last message. */
export function inWindow(lastInboundAt, now = new Date()) {
  if (!lastInboundAt) return false;
  const t = new Date(lastInboundAt).getTime();
  return Number.isFinite(t) && now.getTime() - t < WINDOW_MS - 60_000; // 1-minute safety margin
}

export class WhatsAppError extends Error {
  constructor(message, { code = null, status = null, kind = "error" } = {}) { super(message); this.code = code; this.status = status; this.kind = kind; }
}

/** WhatsApp settings from the environment; null when WhatsApp is not configured. */
export function waConfig(env) {
  const token = env("WHATSAPP_ACCESS_TOKEN"), phoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneNumberId) return null;
  return { token, phoneNumberId, version: env("WHATSAPP_API_VERSION") || DEFAULT_VERSION };
}

/**
 * Sends one message. `msg` is { text } (only inside the 24-hour window) or { template: { name, lang, params } }.
 * Returns the WhatsApp message id (wamid). Throws WhatsAppError with kind "window" when Meta refuses a free-form
 * message outside the window, "config" for credential problems, "rejected" otherwise.
 */
export async function sendWhatsApp(cfg, to, msg, { fetchImpl = fetch } = {}) {
  if (!cfg) throw new WhatsAppError("WhatsApp is not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID).", { kind: "config" });
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: String(to).replace(/\D/g, "") };
  let body;
  if (msg.template) {
    const params = (msg.template.params || []).map((t) => ({ type: "text", text: String(t ?? "").slice(0, 1000) || "-" }));
    body = { ...base, type: "template", template: { name: msg.template.name, language: { code: msg.template.lang || "ms" }, ...(params.length ? { components: [{ type: "body", parameters: params }] } : {}) } };
  } else {
    const text = String(msg.text || "").trim();
    if (!text) throw new WhatsAppError("Empty message", { kind: "rejected" });
    body = { ...base, type: "text", text: { body: text.slice(0, 4096), preview_url: false } };
  }
  let r;
  try {
    r = await fetchImpl(`https://graph.facebook.com/${cfg.version}/${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
      method: "POST", headers: { authorization: "Bearer " + cfg.token, "content-type": "application/json" }, body: JSON.stringify(body),
    });
  } catch (e) {
    throw new WhatsAppError("WhatsApp could not be reached: " + (e?.message || e), { kind: "network" });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = data?.error || {};
    const code = e.code ?? null;
    // 131047: more than 24 hours since the buyer's last message; 190: invalid/expired token; 10/200: permissions
    const kind = code === 131047 ? "window" : code === 190 || code === 10 || code === 200 || r.status === 401 ? "config" : "rejected";
    throw new WhatsAppError(`WhatsApp refused the message (${r.status}${code ? ", code " + code : ""}): ${e.message || "unknown error"}`, { code, status: r.status, kind });
  }
  const id = data?.messages?.[0]?.id;
  if (!id) throw new WhatsAppError("WhatsApp returned no message id", { kind: "rejected" });
  return id;
}

/** Graph API call with the WhatsApp token (setup checks). Returns parsed JSON or throws WhatsAppError. */
export async function graph(cfg, method, path, { fetchImpl = fetch } = {}) {
  if (!cfg) throw new WhatsAppError("WhatsApp is not configured.", { kind: "config" });
  let r;
  try { r = await fetchImpl(`https://graph.facebook.com/${cfg.version}/${path}`, { method, headers: { authorization: "Bearer " + cfg.token } }); }
  catch (e) { throw new WhatsAppError("Meta could not be reached: " + (e?.message || e), { kind: "network" }); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = d?.error || {};
    throw new WhatsAppError(`${e.message || "Meta refused the request"} (${r.status}${e.code ? ", code " + e.code : ""})`, { code: e.code ?? null, status: r.status, kind: e.code === 190 || r.status === 401 ? "config" : "rejected" });
  }
  return d;
}
