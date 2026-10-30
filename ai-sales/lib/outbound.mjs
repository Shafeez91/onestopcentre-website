// Sends one WhatsApp message and records it in ai_messages (shared by the worker, the inbox and the appointment
// endpoints). Every AI-written message is checked against the conversation's owner immediately before it goes to
// WhatsApp, so an AI reply or follow-up prepared while a person took over is never delivered.
import { renderTemplate } from "./followups.mjs";
import { replyLanguage } from "../../sales/shared/guard.mjs";

const enc = encodeURIComponent;

/** Is the AI still allowed to speak in this conversation right now? (read fresh, just before sending) */
/** "en" or "ms" for system messages and templates: the buyer's saved language, else what their recent messages are in. */
export async function buyerLanguage(db, conv, contact = conv?.contact) {
  const pref = contact?.preferred_language;
  if (pref === "en" || pref === "ms" || !conv?.id) return replyLanguage(pref, []);
  const rows = (await db.get(`ai_messages?conversation_id=eq.${encodeURIComponent(conv.id)}&direction=eq.inbound&body=not.is.null&select=body&order=created_at.desc&limit=8`).catch(() => [])) || [];
  return replyLanguage(pref, rows.map((r) => r.body).filter((b) => b && !/^\[[a-z]+\]$/i.test(b)));
}

export async function aiMaySend(db, conversationId) {
  const c = (await db.get(`ai_conversations?id=eq.${enc(conversationId)}&select=mode,status,lead:ai_leads(ai_paused,closed_at)`))?.[0];
  if (!c) return { ok: false, reason: "conversation not found" };
  if (c.mode !== "ai" || c.lead?.ai_paused) return { ok: false, reason: "a person took over before it was sent" };
  if (c.status !== "open" || c.lead?.closed_at) return { ok: false, reason: "conversation or lead closed" };
  return { ok: true };
}

/**
 * Records and sends a message. `sourceJobId` makes the send idempotent for retried jobs (unique per job).
 * Returns { sent, id, error?, blocked?, duplicate? }.
 */
export async function sendOutbound(deps, { conversation, to, text, template = null, file = null, senderType, senderEmail = null, purpose, runId = null, sourceJobId = null }) {
  const { db, wa } = deps;
  // a file is recorded as "[document] title" (what the inbox and the AI's history show) with its document id in media
  const body = template ? renderTemplate(template.body, template.params) : file ? `[${file.kind}] ${file.title}` : text;
  const row = { conversation_id: conversation.id, direction: "outbound", sender_type: senderType, sender_email: senderEmail, body, template_name: template?.wa_template_name || null,
    ...(file ? { media: [{ type: file.kind, document_id: file.document_id, title: file.title }] } : {}),
    provider: "whatsapp_cloud", status: "queued", purpose, agent_run_id: runId, source_job_id: sourceJobId };
  let rec = (await db.post("ai_messages" + (sourceJobId ? "?on_conflict=source_job_id" : ""), row, { prefer: "return=representation" + (sourceJobId ? ",resolution=ignore-duplicates" : "") }))?.[0];
  if (!rec && sourceJobId) {
    rec = (await db.get(`ai_messages?source_job_id=eq.${enc(sourceJobId)}&select=id,status`))?.[0];
    if (rec && !["queued", "failed"].includes(rec.status)) return { sent: rec.status !== "skipped", id: rec.id, duplicate: true, blocked: rec.status === "skipped" };
  }
  if (!wa) { await db.patch(`ai_messages?id=eq.${enc(rec.id)}`, { status: "failed", status_reason: "WhatsApp is not configured" }); return { sent: false, id: rec.id, error: "WhatsApp is not configured", kind: "config" }; }
  if (senderType === "ai") {
    const may = await aiMaySend(db, conversation.id);
    if (!may.ok) { await db.patch(`ai_messages?id=eq.${enc(rec.id)}`, { status: "skipped", status_reason: may.reason }); return { sent: false, id: rec.id, blocked: true, error: may.reason }; }
  }
  try {
    const msg = template ? { template: { name: template.wa_template_name, lang: template.lang, params: template.params } }
      : file ? { file: { kind: file.kind, link: await file.link(), filename: file.filename, caption: file.caption } } : { text };
    const wamid = await wa.send(to, msg);
    await db.patch(`ai_messages?id=eq.${enc(rec.id)}`, { status: "sent", provider_message_id: wamid, status_reason: null });
    await db.patch(`ai_conversations?id=eq.${enc(conversation.id)}`, { last_outbound_at: deps.now().toISOString() });
    return { sent: true, id: rec.id, wamid };
  } catch (e) {
    await db.patch(`ai_messages?id=eq.${enc(rec.id)}`, { status: "failed", status_reason: String(e?.message || e).slice(0, 500) });
    return { sent: false, id: rec.id, error: e?.message || String(e), kind: e?.kind };
  }
}
