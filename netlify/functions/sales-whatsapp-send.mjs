// AI Sales — a staff member replies to a buyer on WhatsApp from the inbox (advisors and above).
// Free text only inside the 24-hour window; outside it only a Meta-approved template can be sent.
import { json, getCaller, hasRole, moduleEnabled, disabled, userDb, audit } from "../../ai-sales/lib/server.mjs";
import { inWindow } from "../../ai-sales/lib/whatsapp.mjs";
import { liveDeps } from "../../ai-sales/lib/live.mjs";
import { sendOutbound, loadSettings } from "../../ai-sales/lib/worker.mjs";
import { templateParams } from "../../ai-sales/lib/followups.mjs";

const enc = encodeURIComponent;

export default async (req) => {
  if (!moduleEnabled()) return disabled();
  const caller = await getCaller(req);
  if (!caller) return json({ error: "Sign in required" }, 401);
  if (!hasRole(caller.role, "advisor")) return json({ error: "Advisors, managers and owners only" }, 403);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (!/^[0-9a-f-]{36}$/i.test(body?.conversation_id || "")) return json({ error: "conversation_id is required" }, 400);

  const deps = liveDeps();
  if (!deps.db) return json({ error: "SUPABASE_SERVICE_ROLE_KEY is not set in Netlify.", setup_needed: "SUPABASE_SERVICE_ROLE_KEY" }, 501);
  if (!deps.wa) return json({ error: "WhatsApp is not connected yet (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID).", setup_needed: "WHATSAPP" }, 501);
  const settings = await loadSettings(deps.db);
  if (settings.flags?.module_enabled === false || !settings.flags?.whatsapp_outbound) return json({ error: "WhatsApp sending is switched off in Settings → Feature switches." }, 409);

  // read through the caller's own permissions: no access, no send
  const conv = (await userDb(caller).get(`ai_conversations?id=eq.${enc(body.conversation_id)}&select=*,contact:ai_contacts(id,full_name,phone_e164,wa_id,preferred_language),lead:ai_leads(id,primary_project_id)`))?.[0];
  if (!conv) return json({ error: "Conversation not found" }, 404);
  const to = conv.contact?.wa_id || conv.contact?.phone_e164;
  if (!to) return json({ error: "This buyer has no WhatsApp number" }, 409);

  // an opted-out buyer can only be answered after they write again
  const consent = (await deps.db.get(`ai_consent_current?contact_id=eq.${enc(conv.contact.id)}&select=channel,purpose,status,recorded_at`)) || [];
  const stop = consent.find((c) => c.purpose === "service" && c.status === "withdrawn" && ["whatsapp", "any"].includes(c.channel));
  if (stop && !(conv.last_inbound_at && new Date(conv.last_inbound_at) > new Date(stop.recorded_at))) {
    return json({ error: "This buyer opted out of WhatsApp messages. You can reply only after they message you again." }, 409);
  }

  let r;
  if (body.template_id) {
    const tpl = (await deps.db.get(`ai_message_templates?id=eq.${enc(body.template_id)}&wa_status=eq.approved&active=is.true&select=*`))?.[0];
    if (!tpl?.wa_template_name) return json({ error: "Only active templates approved by WhatsApp can be sent." }, 400);
    if (tpl.category === "marketing" && !consent.some((c) => c.purpose === "marketing" && c.status === "granted" && ["whatsapp", "any"].includes(c.channel))) {
      return json({ error: "This buyer has not given marketing consent, so a marketing template cannot be sent." }, 409);
    }
    const project = conv.lead?.primary_project_id ? (await deps.db.get(`projects?id=eq.${enc(conv.lead.primary_project_id)}&select=data`))?.[0]?.data?.n : null;
    r = await sendOutbound(deps, { conversation: conv, to, template: { ...tpl, params: templateParams(tpl, { name: conv.contact.full_name, project }) }, senderType: "human", senderEmail: caller.email, purpose: tpl.category === "marketing" ? "marketing" : "service" });
  } else {
    const text = String(body.text || "").trim();
    if (!text || text.length > 4096) return json({ error: "Type a message (up to 4,096 characters)." }, 400);
    if (!inWindow(conv.last_inbound_at, new Date())) return json({ error: "More than 24 hours since the buyer's last message. WhatsApp only allows an approved template now.", needs_template: true }, 409);
    r = await sendOutbound(deps, { conversation: conv, to, text, senderType: "human", senderEmail: caller.email, purpose: "reply" });
  }
  if (!r.sent) return json({ error: r.error || "WhatsApp did not accept the message" }, 502);

  // a person replied, so the conversation is theirs: the AI stops until someone presses "Resume AI". The database
  // trigger on the recorded message already did this (and cancelled the AI's pending work); this repeats it as the
  // staff member, so it holds even on a database without that trigger.
  const db = userDb(caller);
  await db.patch(`ai_conversations?id=eq.${enc(conv.id)}`, { unread_count: 0, mode: "human", assigned_email: caller.email });
  if (conv.lead?.id) await db.patch(`ai_leads?id=eq.${enc(conv.lead.id)}`, { ai_paused: true, owner_email: caller.email });
  await audit(caller, "whatsapp_send", { table: "ai_messages", id: r.id, conversation_id: conv.id, template: body.template_id || null });
  return json({ ok: true, message_id: r.id });
};

export const config = { path: "/api/sales/whatsapp/send", method: ["POST"], rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] } };
