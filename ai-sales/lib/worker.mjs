// Background worker for live channels. Runs from the WhatsApp webhook (right after a message arrives) and from a
// scheduled function every 2 minutes. Each job is claimed with SKIP LOCKED, so the two never process the same job.
//
//   wa_reply jobs   → AI reply on WhatsApp (or a staff alert when the AI is off/paused), CRM updates, calendar booking
//   follow-up steps → consent / hours / 24-hour-window rules, AI-written or approved-template message, next step
//   appointments    → WhatsApp reminder to the buyer about 24 hours before a confirmed appointment
//
// deps: { db (service-role adapter), llm, wa: { send(to, msg) } | null, cal: { slots(settings, now), book(details) } | null, now() }
import { respond, applyActions, logRun, composeFollowUp } from "./orchestrator.mjs";
import { isOptOut, wantsHuman, detectLanguage, fixedReply } from "../../sales/shared/guard.mjs";
import { inWindow } from "./whatsapp.mjs";
import { decideFollowUp, consentState, renderTemplate, templateParams } from "./followups.mjs";
import { confirmationText, reminderText, placeFor } from "./calendar.mjs";

const enc = encodeURIComponent;
const MAX_HISTORY = 30;
const flagsOf = (settings) => ({ module: settings?.flags?.module_enabled !== false, ...settings?.flags });

export async function loadSettings(db) { return (await db.get("ai_settings?id=eq.1&select=*"))?.[0] || {}; }

/** Staff alert on Telegram (database sender: deduplicated, never raises). */
async function alertStaff(db, kind, ref, key, text) {
  try { await db.rpc("ai_send_telegram", { p_kind: kind, p_ref: ref, p_key: key, p_text: text }); } catch { /* alerts must not break the job */ }
}

/**
 * Sends one WhatsApp message and records it. `sourceJobId` makes the send idempotent for retried jobs.
 * Returns { sent, id, error }.
 */
export async function sendOutbound(deps, { conversation, to, text, template = null, senderType, senderEmail = null, purpose, runId = null, sourceJobId = null }) {
  const { db, wa } = deps;
  const body = template ? renderTemplate(template.body, template.params) : text;
  const row = { conversation_id: conversation.id, direction: "outbound", sender_type: senderType, sender_email: senderEmail, body, template_name: template?.wa_template_name || null,
    provider: "whatsapp_cloud", status: "queued", purpose, agent_run_id: runId, source_job_id: sourceJobId };
  let rec = (await db.post("ai_messages" + (sourceJobId ? "?on_conflict=source_job_id" : ""), row, { prefer: "return=representation" + (sourceJobId ? ",resolution=ignore-duplicates" : "") }))?.[0];
  if (!rec && sourceJobId) {
    rec = (await db.get(`ai_messages?source_job_id=eq.${enc(sourceJobId)}&select=id,status`))?.[0];
    if (rec && rec.status !== "queued" && rec.status !== "failed") return { sent: true, id: rec.id, duplicate: true };
  }
  if (!wa) { await db.patch(`ai_messages?id=eq.${enc(rec.id)}`, { status: "failed", status_reason: "WhatsApp is not configured" }); return { sent: false, id: rec.id, error: "WhatsApp is not configured" }; }
  try {
    const wamid = await wa.send(to, template ? { template: { name: template.wa_template_name, lang: template.lang, params: template.params } } : { text });
    await db.patch(`ai_messages?id=eq.${enc(rec.id)}`, { status: "sent", provider_message_id: wamid, status_reason: null });
    await db.patch(`ai_conversations?id=eq.${enc(conversation.id)}`, { last_outbound_at: deps.now().toISOString() });
    return { sent: true, id: rec.id, wamid };
  } catch (e) {
    await db.patch(`ai_messages?id=eq.${enc(rec.id)}`, { status: "failed", status_reason: String(e?.message || e).slice(0, 500) });
    return { sent: false, id: rec.id, error: e?.message || String(e), kind: e?.kind };
  }
}

const historyOf = (msgs) => msgs.filter((m) => m.body).map((m) => ({ role: m.direction === "inbound" ? "user" : "assistant", text: m.body }));
const nameOf = (c) => c?.full_name || null;

/* ---------------------------------------------------------------- replies */
export async function processReplyJob(deps, job, settings) {
  const { db } = deps;
  const { conversation_id: convId, message_id: msgId } = job.payload || {};
  const conv = (await db.get(`ai_conversations?id=eq.${enc(convId)}&select=*,contact:ai_contacts(id,full_name,phone_e164,wa_id,preferred_language),lead:ai_leads(id,ai_paused,closed_at,first_response_at,lead_code)`))?.[0];
  if (!conv) return { status: "done", note: "conversation not found" };

  // a retried job only re-sends the reply it already wrote: no second AI call, no duplicate CRM actions
  const prior = (await db.get(`ai_messages?source_job_id=eq.${enc(job.id)}&select=id,status,body`))?.[0];
  if (prior) {
    if (!["queued", "failed"].includes(prior.status)) return { status: "done", note: "already sent" };
    const s = await sendOutbound(deps, { conversation: conv, to: conv.contact?.wa_id || conv.contact?.phone_e164, text: prior.body, senderType: "ai", purpose: "reply", sourceJobId: job.id });
    if (!s.sent && s.kind !== "config") throw new Error("WhatsApp send failed: " + s.error);
    return { status: "done", resent: s.sent };
  }

  // id breaks ties between messages sent in the same second, so every job agrees on which message is newest
  const msgs = (await db.get(`ai_messages?conversation_id=eq.${enc(convId)}&order=created_at.desc,id.desc&limit=${MAX_HISTORY + 10}&select=id,direction,sender_type,body,media,created_at,status`)) || [];
  const newestIn = msgs.find((m) => m.direction === "inbound");
  if (!newestIn || newestIn.id !== msgId) return { status: "done", note: "superseded by a newer message" }; // the newer job answers both

  // everything the buyer sent since our last message is answered together
  const pending = [];
  for (const m of msgs) { if (m.direction === "outbound") break; pending.unshift(m); }
  const earlier = msgs.slice(pending.length).reverse();
  const message = pending.map((m) => m.body).filter(Boolean).join("\n").trim();
  const readable = pending.some((m) => !m.media && m.body);
  const lead = conv.lead, contact = conv.contact, to = contact?.wa_id || contact?.phone_e164;
  const f = flagsOf(settings);
  const canSend = f.module && f.whatsapp_outbound && !!deps.wa;
  const aiOn = f.module && f.ai_auto_reply && conv.mode === "ai" && !lead?.ai_paused && !lead?.closed_at;
  const guard = isOptOut(message) || wantsHuman(message);

  if (!aiOn && !guard) {
    if (settings.notifications?.whatsapp_alerts !== false) {
      const hour = deps.now().toISOString().slice(0, 13);
      await alertStaff(db, "whatsapp_message", conv.id, `wa:${conv.id}:${hour}`,
        `💬 New WhatsApp message${conv.mode !== "ai" || lead?.ai_paused ? " (a person is handling this buyer)" : " (AI auto-reply is off)"}\n👤 ${nameOf(contact) || "(no name)"} · +${to}${lead?.lead_code ? " · " + lead.lead_code : ""}\n"${message.slice(0, 500)}"\nhttps://onestopcentreproperty.com/sales/#/inbox`);
    }
    return { status: "done", note: "AI not answering this conversation; staff alerted" };
  }

  let result;
  if (!readable && !guard) {
    const lang = contact?.preferred_language === "en" ? "en" : "ms";
    const kinds = [...new Set(pending.flatMap((m) => (m.media || []).map((x) => x.type)))].join(", ") || "media";
    result = { decision: "handover", reply: fixedReply("safe_fallback", lang), language: lang, intent: "other", agent: "handover", confidence: 1, message,
      actions: [{ type: "handover", reason: "other", summary: `Buyer sent ${kinds}, which the AI cannot read.`, next_action: "Open the WhatsApp conversation and reply personally." }, { type: "cancel_follow_ups", reason: "conversation needs a human" }] };
  } else {
    let slots = null;
    // calendar unavailable → the AI collects a preferred time instead of offering slots
    if (f.calendar_booking && deps.cal) { try { slots = await deps.cal.slots(settings, deps.now()); } catch { slots = null; } }
    result = await respond({ db, llm: deps.llm, reserve: () => db.rpc("ai_reserve_ai_call", {}), leadId: lead.id, message, history: historyOf(earlier), now: deps.now(),
      mode: "live", calendar: !!slots, slots: slots || [] });
  }

  const runId = await logRun(db, { result, leadId: lead.id, conversationId: conv.id, channel: "whatsapp", input: { job: job.id } });
  const done = await applyActions(db, { leadId: lead.id, contactId: contact.id, result, conversationId: conv.id, runId });

  let sent = null;
  if (result.reply && result.decision !== "paused") {
    if (canSend) {
      sent = await sendOutbound(deps, { conversation: conv, to, text: result.reply, senderType: "ai", purpose: "reply", runId, sourceJobId: job.id });
      if (sent.sent) {
        await db.patch(`ai_conversations?id=eq.${enc(conv.id)}`, { unread_count: 0 });
        if (!lead.first_response_at) await db.patch(`ai_leads?id=eq.${enc(lead.id)}`, { first_response_at: deps.now().toISOString() });
      } else {
        await alertStaff(db, "whatsapp_message", conv.id, `wa-fail:${job.id}`, `⚠️ The AI reply to ${nameOf(contact) || "+" + to} could not be sent: ${sent.error}\nReply personally: https://onestopcentreproperty.com/sales/#/inbox`);
      }
    } else {
      await alertStaff(db, "whatsapp_message", conv.id, `wa-draft:${job.id}`, `💬 WhatsApp from ${nameOf(contact) || "+" + to}: "${message.slice(0, 300)}"\nAI draft (not sent — WhatsApp sending is off):\n${result.reply.slice(0, 600)}`);
    }
  }

  // calendar booking: only after the buyer picked one of the free slots we offered
  if (done.appointment?.slot && f.calendar_booking && deps.cal) {
    await bookAppointment(deps, { ref: done.appointment, conv, to, contact, lead, settings, canSend });
  }

  // follow-ups restart after every AI reply; the buyer's next message cancels them
  if (result.decision === "reply" && sent?.sent && f.follow_ups) {
    const pendingAppt = (await db.get(`ai_appointments?lead_id=eq.${enc(lead.id)}&status=eq.pending_confirmation&select=id&limit=1`))?.length;
    try { await db.rpc("ai_follow_up_start", { p_lead: lead.id, p_lead_type: pendingAppt ? "appointment_pending" : "new_enquiry" }); } catch { /* no sequence configured */ }
  }
  if (sent && !sent.sent && sent.kind !== "config") throw new Error("WhatsApp send failed: " + sent.error); // retried; the reply row prevents a double send
  return { status: "done", decision: result.decision, sent: !!sent?.sent };
}

/** Books a slot the buyer chose, then sends the fixed confirmation. Never claims success unless the event exists. */
export async function bookAppointment(deps, { ref, conv, to, contact, lead, settings, canSend }) {
  const { db } = deps;
  const q = ref.id ? `id=eq.${enc(ref.id)}` : `idempotency_key=eq.${enc(ref.key)}`;
  const appt = (await db.get(`ai_appointments?${q}&select=*`))?.[0];
  if (!appt || appt.status !== "pending_confirmation" || !appt.start_at) return { booked: false };
  const { location, map } = await placeFor(db, appt, settings);
  const lang = contact?.preferred_language === "en" ? "en" : detectLanguage(appt.preferred_text || "", "ms");
  try {
    const eventId = await deps.cal.book({ start: appt.start_at, end: appt.end_at || new Date(new Date(appt.start_at).getTime() + 3600e3).toISOString(),
      summary: `${appt.kind.replace(/_/g, " ")} · ${nameOf(contact) || "+" + to} (${lead.lead_code || ""})`, description: `Booked by the AI assistant on WhatsApp.\nBuyer: ${nameOf(contact) || ""} +${to}\nhttps://onestopcentreproperty.com/sales/#/lead/${lead.id}${map ? "\nMap: " + map : ""}`, location });
    await db.patch(`ai_appointments?id=eq.${enc(appt.id)}`, { status: "confirmed", calendar_provider: "google", calendar_event_id: eventId, location: location || null,
      reminders: [...(appt.reminders || []), { type: "confirmation", at: deps.now().toISOString() }] });
    if (canSend) await sendOutbound(deps, { conversation: conv, to, text: confirmationText({ kind: appt.kind, start: appt.start_at, location, map, lang }), senderType: "system", purpose: "reply", sourceJobId: null });
    return { booked: true, eventId };
  } catch (e) {
    const taken = e?.kind === "taken";
    await db.patch(`ai_appointments?id=eq.${enc(appt.id)}`, { notes: (taken ? "Slot was taken before booking. " : "Calendar booking failed: ") + String(e?.message || e).slice(0, 300) });
    if (canSend) await sendOutbound(deps, { conversation: conv, to, senderType: "system", purpose: "reply",
      text: lang === "en" ? "Sorry, I couldn't book that time just now. One of our advisors will confirm a slot with you shortly." : "Maaf, saya tidak dapat menempah masa itu sebentar tadi. Penasihat kami akan mengesahkan slot dengan tuan/puan sebentar lagi." });
    await db.post("ai_handover_events", { lead_id: lead.id, conversation_id: conv.id, reason: "other", summary: { text: `Calendar booking for ${appt.start_at} failed: ${e?.message || e}`, next_action: "Confirm an appointment slot with the buyer.", source: "calendar" } });
    return { booked: false, error: e?.message };
  }
}

/* ---------------------------------------------------------------- follow-ups */
export async function processFollowUp(deps, fj, settings) {
  const { db } = deps;
  const now = deps.now();
  const finish = (status, reason, extra = {}) => db.patch(`ai_follow_up_jobs?id=eq.${enc(fj.id)}`, { status, reason: reason || null, ...extra });
  const seq = fj.sequence_id ? (await db.get(`ai_follow_up_sequences?id=eq.${enc(fj.sequence_id)}&select=*`))?.[0] : null;
  const step = seq?.steps?.[fj.step_index];
  if (!seq || !step) { await finish("cancelled", "sequence removed or changed"); return { status: "cancelled" }; }
  if (!seq.active) { await finish("cancelled", "sequence switched off"); return { status: "cancelled" }; }
  const lead = (await db.get(`ai_leads?id=eq.${enc(fj.lead_id)}&select=id,contact_id,closed_at,ai_paused,primary_project_id,lead_code`))?.[0];
  const conv = lead && (await db.get(`ai_conversations?contact_id=eq.${enc(lead.contact_id)}&channel=eq.whatsapp&status=eq.open&select=*,contact:ai_contacts(id,full_name,phone_e164,wa_id,preferred_language)`))?.[0];
  const consent = consentState(lead ? (await db.get(`ai_consent_current?contact_id=eq.${enc(lead.contact_id)}&select=channel,purpose,status`)) || [] : []);
  let marketingSentThisWeek = 0;
  if (conv && step.purpose === "marketing") {
    const since = new Date(now.getTime() - 7 * 864e5).toISOString();
    marketingSentThisWeek = ((await db.get(`ai_messages?conversation_id=eq.${enc(conv.id)}&direction=eq.outbound&purpose=eq.marketing&created_at=gte.${enc(since)}&status=neq.failed&select=id`)) || []).length;
  }
  const templates = step.template ? (await db.get(`ai_message_templates?name=eq.${enc(step.template)}&select=*`)) || [] : [];
  const d = decideFollowUp({ step, lead, conversation: conv, consent, marketingSentThisWeek, settings, templates, now });

  if (d.action === "cancel") { await finish("cancelled", d.reason); return { status: "cancelled", reason: d.reason }; }
  if (d.action === "defer") { await finish("scheduled", d.reason, { run_at: d.runAt.toISOString(), attempts: 0 }); return { status: "deferred" }; }

  let outcome = { status: "skipped", reason: d.reason };
  const to = conv?.contact?.wa_id || conv?.contact?.phone_e164;
  if (d.action === "send_ai") {
    const msgs = (await db.get(`ai_messages?conversation_id=eq.${enc(conv.id)}&order=created_at.desc&limit=${MAX_HISTORY}&select=direction,body`)) || [];
    const c = await composeFollowUp({ db, llm: deps.llm, reserve: () => db.rpc("ai_reserve_ai_call", {}), leadId: lead.id, history: historyOf(msgs.reverse()), instruction: step.instruction || "Check in politely.", now });
    if (c.reply) {
      const s = await sendOutbound(deps, { conversation: conv, to, text: c.reply, senderType: "ai", purpose: step.purpose === "marketing" ? "marketing" : "service", sourceJobId: fj.id });
      outcome = s.sent ? { status: "sent", message_id: s.id } : { status: "failed", reason: s.error };
    } else outcome = { status: "skipped", reason: c.skipped };
  } else if (d.action === "send_template") {
    const project = lead.primary_project_id ? (await db.get(`projects?id=eq.${enc(lead.primary_project_id)}&select=data`))?.[0]?.data?.n : null;
    const tpl = { ...d.template, params: templateParams(d.template, { name: conv.contact?.full_name, project }) };
    const s = await sendOutbound(deps, { conversation: conv, to, template: tpl, senderType: "ai", purpose: step.purpose === "marketing" ? "marketing" : "service", sourceJobId: fj.id });
    outcome = s.sent ? { status: "sent", message_id: s.id } : { status: "failed", reason: s.error };
  }

  await finish(outcome.status, outcome.reason, outcome.message_id ? { message_id: outcome.message_id } : {});
  // next step: counted from now, whether this one was sent or skipped
  const next = seq.steps[fj.step_index + 1];
  if (next && outcome.status !== "failed") {
    const delay = Math.max(1, Math.min(2160, Number(next.delay_hours) || 24));
    await db.post("ai_follow_up_jobs?on_conflict=idempotency_key", { lead_id: fj.lead_id, sequence_id: seq.id, step_index: fj.step_index + 1,
      run_at: new Date(now.getTime() + delay * 3600e3).toISOString(), idempotency_key: `fu:${fj.lead_id}:${seq.id}:${fj.step_index + 1}:${fj.id}` }, { prefer: "resolution=ignore-duplicates" });
  }
  return outcome;
}

/* ---------------------------------------------------------------- buyer reminders */
export async function processReminders(deps, settings) {
  const { db } = deps;
  const now = deps.now();
  const from = new Date(now.getTime() + 2 * 3600e3).toISOString(), to24 = new Date(now.getTime() + 24 * 3600e3).toISOString();
  const appts = (await db.get(`ai_appointments?status=eq.confirmed&start_at=gt.${enc(from)}&start_at=lte.${enc(to24)}&select=*,lead:ai_leads(id,contact_id,ai_paused)`)) || [];
  let n = 0;
  for (const a of appts) {
    if ((a.reminders || []).some((r) => r.type === "wa_24h")) continue;
    // just booked: the confirmation message is enough for now (checked again on later runs)
    if ((a.reminders || []).some((r) => r.type === "confirmation" && now - new Date(r.at) < 12 * 3600e3)) continue;
    const conv = (await db.get(`ai_conversations?contact_id=eq.${enc(a.lead.contact_id)}&channel=eq.whatsapp&status=eq.open&select=*,contact:ai_contacts(id,full_name,phone_e164,wa_id,preferred_language)`))?.[0];
    const consent = consentState((await db.get(`ai_consent_current?contact_id=eq.${enc(a.lead.contact_id)}&select=channel,purpose,status`)) || []);
    const mark = (status, reason) => db.patch(`ai_appointments?id=eq.${enc(a.id)}`, { reminders: [...(a.reminders || []), { type: "wa_24h", status, reason: reason || null, at: now.toISOString() }] });
    const to = conv?.contact?.wa_id || conv?.contact?.phone_e164;
    if (!conv || !to) { await mark("skipped", "no WhatsApp conversation"); continue; }
    if (consent.service === "withdrawn") { await mark("skipped", "buyer opted out"); continue; }
    const lang = conv.contact?.preferred_language === "en" ? "en" : "ms";
    // the place given at confirmation; the map link only when that is still the project's showroom
    const place = await placeFor(db, a, settings);
    const location = a.location || place.location, map = location === place.location ? place.map : "";
    let s;
    if (inWindow(conv.last_inbound_at, now)) {
      s = await sendOutbound(deps, { conversation: conv, to, text: reminderText({ kind: a.kind, start: a.start_at, location, map, lang }), senderType: "system", purpose: "service" });
    } else {
      const tpls = ((await db.get("ai_message_templates?name=eq.appointment_reminder&wa_status=eq.approved&active=is.true&select=*")) || []).filter((t) => t.wa_template_name);
      const t = tpls.find((x) => x.lang === lang) || tpls[0];
      if (!t) { await mark("skipped", "outside the 24-hour window and no approved \"appointment_reminder\" template"); continue; }
      const when = new Intl.DateTimeFormat(t.lang === "en" ? "en-MY" : "ms-MY", { timeZone: "Asia/Kuala_Lumpur", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(a.start_at));
      s = await sendOutbound(deps, { conversation: conv, to, template: { ...t, params: templateParams(t, { name: conv.contact?.full_name, appointment: when, location: [location, map].filter(Boolean).join(" ") }) }, senderType: "system", purpose: "service" });
    }
    await mark(s.sent ? "sent" : "failed", s.error);
    if (s.sent) n++;
  }
  return n;
}

/* ---------------------------------------------------------------- runner */
export async function runWorker(deps, { maxJobs = 10, followUps = true, reminders = true } = {}) {
  const { db } = deps;
  const out = { replies: 0, follow_ups: 0, reminders: 0, errors: [] };
  const settings = await loadSettings(db);
  const f = flagsOf(settings);
  if (!f.module) return { ...out, note: "module switched off in settings" };

  const jobs = (await db.rpc("ai_claim_jobs", { max_jobs: maxJobs })) || [];
  for (const job of jobs) {
    try {
      if (job.kind === "wa_reply") { await processReplyJob(deps, job, settings); out.replies++; }
      await db.patch(`ai_jobs?id=eq.${enc(job.id)}`, { status: "done", last_error: null });
    } catch (e) {
      const dead = job.attempts >= job.max_attempts;
      await db.patch(`ai_jobs?id=eq.${enc(job.id)}`, { status: dead ? "dead" : "failed", last_error: String(e?.message || e).slice(0, 500), run_at: new Date(deps.now().getTime() + 60e3 * job.attempts ** 2).toISOString() });
      if (dead) await alertStaff(db, "whatsapp_message", job.id, `job-dead:${job.id}`, `⚠️ A WhatsApp message could not be answered after ${job.attempts} tries: ${String(e?.message || e).slice(0, 300)}\nhttps://onestopcentreproperty.com/sales/#/inbox`);
      out.errors.push(String(e?.message || e));
    }
  }
  // follow-ups are only claimed while automation is on; otherwise the database announces due steps to staff instead
  if (followUps && f.follow_ups && f.whatsapp_outbound && deps.wa) {
    const due = (await db.rpc("ai_claim_follow_ups", { max_jobs: 20 })) || [];
    for (const fj of due) {
      try { await processFollowUp(deps, fj, settings); out.follow_ups++; }
      catch (e) { await db.patch(`ai_follow_up_jobs?id=eq.${enc(fj.id)}`, { status: fj.attempts >= 5 ? "failed" : "scheduled", reason: String(e?.message || e).slice(0, 300) }); out.errors.push(String(e?.message || e)); }
    }
  }
  if (reminders && f.whatsapp_outbound && deps.wa) {
    try { out.reminders = await processReminders(deps, settings); } catch (e) { out.errors.push(String(e?.message || e)); }
  }
  // retention (privacy policy §6): once a day at 03:00 Malaysia time — the scheduled run at minute 0 or 1
  const t = deps.now();
  if (reminders && t.getUTCHours() === 19 && t.getUTCMinutes() < 2) {
    try { out.purged = await db.rpc("ai_purge_expired", {}); } catch (e) { out.errors.push("purge: " + (e?.message || e)); }
  }
  return out;
}
