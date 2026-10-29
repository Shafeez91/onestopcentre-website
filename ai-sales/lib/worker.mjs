// Background worker for live channels. Runs from the WhatsApp webhook (right after a message arrives) and from a
// scheduled function every 2 minutes. Each job is claimed with SKIP LOCKED, so the two never process the same job.
//
//   wa_reply jobs   → AI reply on WhatsApp (or a staff alert when the AI is off/paused), CRM updates, calendar booking
//   follow-up steps → consent / hours / 24-hour-window rules, AI-written or approved-template message, next step
//   automation jobs → 12-hour follow-ups, staff follow-up reminders, appointment confirmations and reminders
//                     (scheduled by database triggers; see automation.mjs)
//
// deps: { db (service-role adapter), llm, wa: { send(to, msg) } | null, cal: { slots(settings, now), book(details) } | null, now() }
import { respond, applyActions, logRun, composeFollowUp } from "./orchestrator.mjs";
import { summarizeLead } from "./insights.mjs";
import { isOptOut, wantsHuman, fixedReply, replyLanguage } from "../../sales/shared/guard.mjs";
import { decideFollowUp, consentState, templateParams } from "./followups.mjs";
import { confirmationText, placeFor } from "./calendar.mjs";
import { sendOutbound, buyerLanguage } from "./outbound.mjs";
import { runAutomation, confirmAppointmentNow, automationOf, openHumanTaskAbout } from "./automation.mjs";

export { sendOutbound };

const enc = encodeURIComponent;
const MAX_HISTORY = 30;
const flagsOf = (settings) => ({ module: settings?.flags?.module_enabled !== false, ...settings?.flags });

export async function loadSettings(db) { return (await db.get("ai_settings?id=eq.1&select=*"))?.[0] || {}; }

const historyOf = (msgs) => msgs.filter((m) => m.body).map((m) => ({ role: m.direction === "inbound" ? "user" : "assistant", text: m.body }));
const nameOf = (c) => c?.full_name || null;

/* ---------------------------------------------------------------- replies */
export async function processReplyJob(deps, job, settings) {
  const { db } = deps;
  const { conversation_id: convId, message_id: msgId } = job.payload || {};
  const conv = (await db.get(`ai_conversations?id=eq.${enc(convId)}&select=*,contact:ai_contacts(id,full_name,phone_e164,wa_id,preferred_language),lead:ai_leads(id,ai_paused,closed_at,first_response_at,lead_code)`))?.[0];
  if (!conv) return { status: "done", note: "conversation not found" };

  // a retried job only re-sends the reply it already wrote: no second AI call, no duplicate CRM actions
  const prior = (await db.get(`ai_messages?source_job_id=eq.${enc(job.id)}&select=id,status,body,sender_type`))?.[0];
  if (prior) {
    if (!["queued", "failed"].includes(prior.status)) return { status: "done", note: "already sent" };
    const s = await sendOutbound(deps, { conversation: conv, to: conv.contact?.wa_id || conv.contact?.phone_e164, text: prior.body, senderType: prior.sender_type || "ai", purpose: "reply", sourceJobId: job.id });
    if (s.blocked) return { status: "done", note: "not sent: " + s.error };
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

  // no Telegram for WhatsApp messages: Telegram carries new clients, follow-up tasks and appointments only
  if (!aiOn && !guard) {
    // a person handles this chat: the AI still keeps the client's profile and summary up to date (no message sent)
    if (f.module && (f.ai_auto_reply || settings.ai?.auto_insights === true) && settings.ai?.auto_insights !== false && deps.llm && lead?.id && !lead.closed_at && readable) {
      const r = await summarizeLead(deps, lead.id, { reserve: () => db.rpc("ai_reserve_ai_call", {}) }).catch((e) => ({ skipped: e?.message || String(e) }));
      return { status: "done", note: "AI not answering this conversation; client profile " + (r.applied ? "updated" : "not updated (" + r.skipped + ")") };
    }
    return { status: "done", note: "AI not answering this conversation" };
  }

  let result;
  if (!readable && !guard) {
    const lang = replyLanguage(contact?.preferred_language, msgs.filter((m) => m.direction === "inbound").map((m) => m.body).filter(Boolean));
    const kinds = [...new Set(pending.flatMap((m) => (m.media || []).map((x) => x.type)))].join(", ") || "media";
    result = { decision: "handover", reply: fixedReply("safe_fallback", lang), language: lang, intent: "other", agent: "handover", confidence: null, message,
      actions: [{ type: "handover", reason: "other", summary: `Buyer sent ${kinds}, which the AI cannot read.`, next_action: "Open the WhatsApp conversation and reply personally." }, { type: "cancel_follow_ups", reason: "conversation needs a human" }] };
  } else {
    let slots = null;
    // calendar unavailable → the AI collects a preferred time instead of offering slots
    if (f.calendar_booking && deps.cal) { try { slots = await deps.cal.slots(settings, deps.now()); } catch { slots = null; } }
    result = await respond({ db, llm: deps.llm, reserve: () => db.rpc("ai_reserve_ai_call", {}), leadId: lead.id, message, history: historyOf(earlier), now: deps.now(),
      mode: "live", calendar: !!slots, slots: slots || [] });
  }

  const runId = await logRun(db, { result, leadId: lead.id, conversationId: conv.id, channel: "whatsapp", input: { job: job.id } });
  const done = await applyActions(db, { leadId: lead.id, contactId: contact.id, result, conversationId: conv.id, runId, messageId: msgId });

  let sent = null;
  if (result.reply && result.decision !== "paused") {
    if (canSend) {
      // fixed replies to STOP / "talk to a person" are system messages: sent even while a person handles the chat
      sent = await sendOutbound(deps, { conversation: conv, to, text: result.reply, senderType: guard ? "system" : "ai", purpose: "reply", runId, sourceJobId: job.id });
      if (sent.blocked) {
        // a person took over while the AI was writing: their conversation, nothing more to do
      } else if (sent.sent) {
        await db.patch(`ai_conversations?id=eq.${enc(conv.id)}`, { unread_count: 0 });
        if (!lead.first_response_at) await db.patch(`ai_leads?id=eq.${enc(lead.id)}`, { first_response_at: deps.now().toISOString() });
      } else {
        // the buyer was not answered: one follow-up reminder per buyer per day, however many replies fail
        await openHumanTaskAbout(deps, conv.id, { cause: "undelivered", key: `${conv.id}:${deps.now().toISOString().slice(0, 10)}`, title: "Reply to the buyer: the AI's reply could not be delivered", details: `WhatsApp error: ${String(sent.error).slice(0, 160)}` });
      }
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
  if (sent && !sent.sent && !sent.blocked && sent.kind !== "config") throw new Error("WhatsApp send failed: " + sent.error); // retried; the reply row prevents a double send
  return { status: "done", decision: result.decision, sent: !!sent?.sent };
}

/** Books a slot the buyer chose, then sends the fixed confirmation. Never claims success unless the event exists. */
export async function bookAppointment(deps, { ref, conv, to, contact, lead, settings, canSend }) {
  const { db } = deps;
  const q = ref.id ? `id=eq.${enc(ref.id)}` : `idempotency_key=eq.${enc(ref.key)}`;
  const appt = (await db.get(`ai_appointments?${q}&select=*`))?.[0];
  if (!appt || appt.status !== "pending_confirmation" || !appt.start_at) return { booked: false };
  const { location, map } = await placeFor(db, appt, settings);
  const lang = await buyerLanguage(db, conv, contact);
  try {
    const eventId = await deps.cal.book({ start: appt.start_at, end: appt.end_at || new Date(new Date(appt.start_at).getTime() + 3600e3).toISOString(),
      summary: `${appt.kind.replace(/_/g, " ")} · ${nameOf(contact) || "+" + to} (${lead.lead_code || ""})`, description: `Booked by the AI assistant on WhatsApp.\nBuyer: ${nameOf(contact) || ""} +${to}\nhttps://onestopcentreproperty.com/sales/#/lead/${lead.id}${map ? "\nMap: " + map : ""}`, location });
    await db.patch(`ai_appointments?id=eq.${enc(appt.id)}`, { status: "confirmed", calendar_provider: "google", calendar_event_id: eventId, location: location || null,
      reminders: [...(appt.reminders || []), { type: "confirmation", at: deps.now().toISOString() }] });
    // the confirmation goes out through its automation job (created by the database when the status changed), so the
    // scheduled worker can never send it a second time; without a job (older database) it is sent directly
    const viaJob = await confirmAppointmentNow(deps, settings, appt.id);
    if (!viaJob && canSend && automationOf(settings).appointment_confirmations !== false) {
      await sendOutbound(deps, { conversation: conv, to, text: confirmationText({ kind: appt.kind, start: appt.start_at, location, map, lang }), senderType: "system", purpose: "reply", sourceJobId: null });
    }
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
  const d = decideFollowUp({ step, lead, conversation: { ...conv, lang: await buyerLanguage(db, conv) }, consent, marketingSentThisWeek, settings, templates, now });

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

/* ---------------------------------------------------------------- runner */
export async function runWorker(deps, { maxJobs = 10, followUps = true, reminders = true } = {}) {
  const { db } = deps;
  const out = { replies: 0, follow_ups: 0, automation: 0, errors: [] };
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
      if (dead && job.payload?.conversation_id) await openHumanTaskAbout(deps, job.payload.conversation_id, { cause: "undelivered", key: `${job.payload.conversation_id}:${deps.now().toISOString().slice(0, 10)}`, title: "Reply to the buyer: the AI could not answer their message", details: `Failed after ${job.attempts} tries.` });
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
  // follow-ups, staff reminders, appointment confirmations and reminders: every job decides for itself (and records why)
  if (reminders) {
    try {
      const r = await runAutomation(deps, settings, { max: 20 });
      out.automation = r.length; out.automation_sent = r.filter((x) => x.status === "sent").length;
      r.filter((x) => x.status === "failed").forEach((x) => out.errors.push(`${x.kind}: ${x.reason}`));
    } catch (e) { out.errors.push("automation: " + (e?.message || e)); }
  }
  // retention (privacy policy §6): once a day at 03:00 Malaysia time — the scheduled run at minute 0 or 1
  const t = deps.now();
  if (reminders && t.getUTCHours() === 19 && t.getUTCMinutes() < 2) {
    try { out.purged = await db.rpc("ai_purge_expired", {}); } catch (e) { out.errors.push("purge: " + (e?.message || e)); }
  }
  return out;
}
