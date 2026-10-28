// AI Sales — WhatsApp Business Platform webhook (Meta Cloud API).
// GET: Meta's one-time verification. POST: signed events → messages stored and answered, delivery statuses recorded.
// Every request is checked against WHATSAPP_APP_SECRET; redelivered events change nothing (message ids are unique).
import { env, json, moduleEnabled } from "../../ai-sales/lib/server.mjs";
import { verifySignature, parseWebhook } from "../../ai-sales/lib/whatsapp.mjs";
import { isRmkAd } from "../../sales/shared/rmk.mjs";
import { liveDeps } from "../../ai-sales/lib/live.mjs";
import { runWorker } from "../../ai-sales/lib/worker.mjs";

export default async (req, context) => {
  if (req.method === "GET") {
    const u = new URL(req.url), expected = env("WHATSAPP_VERIFY_TOKEN");
    if (u.searchParams.get("hub.mode") === "subscribe" && expected && u.searchParams.get("hub.verify_token") === expected) {
      return new Response(u.searchParams.get("hub.challenge") || "", { status: 200, headers: { "content-type": "text/plain" } });
    }
    return new Response("Forbidden", { status: 403 });
  }
  // switched off: Meta keeps retrying for a while, so messages are not lost if the module is turned back on
  if (!moduleEnabled()) return new Response("AI Sales is switched off", { status: 503 });

  const raw = await req.text();
  const secret = env("WHATSAPP_APP_SECRET");
  if (!secret) return json({ error: "WHATSAPP_APP_SECRET is not set" }, 500);
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), secret)) return new Response("Invalid signature", { status: 401 });
  let payload;
  try { payload = JSON.parse(raw); } catch { return new Response("Invalid JSON", { status: 400 }); }

  const deps = liveDeps();
  if (!deps.db) return json({ error: "SUPABASE_SERVICE_ROLE_KEY is not set" }, 500);
  const { messages, statuses, echoes } = parseWebhook(payload, env("WHATSAPP_PHONE_NUMBER_ID"));
  let queued = 0;
  try {
    for (const m of messages) {
      const r = await deps.db.rpc("ai_wa_inbound", { p_wa_id: m.wa_id, p_name: m.name, p_wamid: m.wamid, p_type: m.type, p_body: m.text, p_sent_at: m.sent_at });
      if (r && !r.duplicate && r.job_id) queued++;
      // a click-to-WhatsApp ad about RMK: the buyer joins the RMK pipeline (the ad, not a typed keyword, says so)
      const ref = m.raw?.referral;
      if (r?.lead_id && !r.duplicate && isRmkAd(ref)) {
        await deps.db.rpc("ai_rmk_enroll", { p_lead: r.lead_id, p_source: /instagram/i.test(ref.source_url || "") ? "instagram" : "facebook", p_by: "ad" }).catch(() => {});
      }
    }
    for (const s of statuses) await deps.db.rpc("ai_wa_status", { p_wamid: s.wamid, p_status: s.status, p_error: s.error });
    // replies sent from the WhatsApp Business app on the phone: recorded, and the AI steps back for that chat
    for (const e of echoes) await deps.db.rpc("ai_wa_echo", { p_wa_id: e.wa_id, p_wamid: e.wamid, p_type: e.type, p_body: e.text, p_sent_at: e.sent_at });
  } catch (e) {
    return json({ error: "Could not store the event: " + (e?.message || e) }, 500); // Meta retries; storing is idempotent
  }
  if (queued) {
    // answer now; the 2-minute scheduled worker picks up anything this run does not finish
    const work = runWorker(deps, { maxJobs: 5, followUps: false, reminders: false }).catch((e) => console.error("worker:", e?.message || e));
    if (typeof context?.waitUntil === "function") context.waitUntil(work); else await work;
  }
  return json({ ok: true, messages: messages.length, statuses: statuses.length, echoes: echoes.length });
};

export const config = { path: "/api/sales/whatsapp/webhook", method: ["GET", "POST"] };
