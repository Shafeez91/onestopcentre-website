// Scheduled automation jobs (ai_automation_jobs), created by database triggers and run by the worker:
//   smart_follow_up    one AI-written check-in when the buyer has gone quiet for N hours (default 12) and nobody followed up
//   human_reminder     Telegram reminder to staff when a buyer is waiting for a person's reply
//   appt_confirmation  WhatsApp confirmation once an appointment is confirmed
//   appt_reminder      WhatsApp reminders before a confirmed appointment (default 24 h and 2 h)
// Every job re-checks the conversation's current state when it runs and records each check, so a job that is no
// longer appropriate is cancelled or skipped with the reason — never sent, and never marked sent when it was not.
import { composeFollowUp } from "./orchestrator.mjs";
import { inWindow } from "./whatsapp.mjs";
import { isOpen, nextOpening, consentState, templateParams } from "./followups.mjs";
import { confirmationText, reminderText, placeFor, formatWhen } from "./calendar.mjs";
import { sendOutbound } from "./outbound.mjs";

const enc = encodeURIComponent;
const SITE = "https://onestopcentreproperty.com/sales/";
const MAX_HISTORY = 30;
export const DEFAULT_AUTOMATION = { smart_follow_up: true, follow_up_delay_hours: 12, follow_up_template: "follow_up", appointment_confirmations: true,
  appointment_reminders: true, appointment_reminder_minutes: [1440, 120], human_reminders: true, human_reminder_minutes: 60 };
export const automationOf = (settings) => ({ ...DEFAULT_AUTOMATION, ...(settings?.automation || {}) });

const historyOf = (msgs) => msgs.filter((m) => m.body).map((m) => ({ role: m.direction === "inbound" ? "user" : "assistant", text: m.body }));
const toOf = (conv) => conv?.contact?.wa_id || conv?.contact?.phone_e164 || null;
const agoText = (ms) => (ms < 3600e3 ? Math.max(1, Math.round(ms / 60e3)) + " min" : (ms / 3600e3).toFixed(ms < 36e6 ? 1 : 0) + " h");
const lastBy = (msgs, pred) => msgs.find(pred) || null;

async function loadConv(db, id) {
  if (!id) return null;
  return (await db.get(`ai_conversations?id=eq.${enc(id)}&select=*,contact:ai_contacts(id,full_name,salutation,phone_e164,wa_id,preferred_language),lead:ai_leads(id,contact_id,lead_code,ai_paused,closed_at,primary_project_id,temperature,score,stage_id)`))?.[0] || null;
}
const consentOf = async (db, contactId) => consentState(contactId ? (await db.get(`ai_consent_current?contact_id=eq.${enc(contactId)}&select=channel,purpose,status`)) || [] : []);
const projectName = async (db, id) => (id ? (await db.get(`projects?id=eq.${enc(id)}&select=data`))?.[0]?.data?.n || null : null);

/** Telegram to staff: a buyer needs a person. Deduplicated per key; never raises. */
export async function alertHuman(deps, { conv, reason, key, lastMessage = null }) {
  const { db } = deps;
  try {
    const lead = conv?.lead || {}, c = conv?.contact || {};
    const project = await projectName(db, lead.primary_project_id);
    const since = lastMessage ? agoText(deps.now() - new Date(lastMessage.created_at)) : null;
    const to = toOf(conv);
    const text = [`🔔 Follow-up needed — ${reason}`,
      `👤 ${c.full_name || "(no name)"}${lead.lead_code ? " · " + lead.lead_code : ""}${lead.temperature ? " · " + lead.temperature : ""}${Number.isFinite(lead.score) ? ` (${lead.score}/100)` : ""}`,
      project ? `🏠 ${project}` : null,
      lastMessage ? `💬 "${String(lastMessage.body || "[media]").slice(0, 200)}"${since ? ` — ${since} ago` : ""}` : null,
      to ? `📞 https://wa.me/${to}` : null,
      `${SITE}#/inbox?c=${conv.id}`].filter(Boolean).join("\n");
    return await db.rpc("ai_send_telegram", { p_kind: "follow_up_due", p_ref: conv.id, p_key: key, p_text: text });
  } catch { return false; }
}

/** Same reminder for a conversation by id, with the buyer's latest message (used when a reply could not be delivered). */
export async function alertHumanAbout(deps, conversationId, reason, key) {
  try {
    const conv = await loadConv(deps.db, conversationId);
    if (!conv) return false;
    const last = (await deps.db.get(`ai_messages?conversation_id=eq.${enc(conversationId)}&direction=eq.inbound&order=created_at.desc&limit=1&select=id,body,created_at`))?.[0] || null;
    return await alertHuman(deps, { conv, reason, key, lastMessage: last });
  } catch { return false; }
}

/* ---------------------------------------------------------------- smart follow-up */
async function smartFollowUp(deps, job, settings, ck) {
  const { db } = deps, now = deps.now(), A = automationOf(settings), f = settings.flags || {};
  const conv = await loadConv(db, job.conversation_id), lead = conv?.lead;
  if (!ck("conversation open and lead not closed", !!conv && conv.status === "open" && !lead?.closed_at)) return { status: "cancelled", reason: "conversation or lead closed" };
  if (!ck("follow-ups allowed for this conversation", conv.automation?.follow_ups !== false)) return { status: "cancelled", reason: "follow-ups switched off for this conversation" };
  if (!ck("AI owns the conversation (no human takeover)", conv.mode === "ai" && !lead?.ai_paused)) return { status: "cancelled", reason: "a person is handling this conversation" };
  const msgs = (await db.get(`ai_messages?conversation_id=eq.${enc(conv.id)}&order=created_at.desc,id.desc&limit=${MAX_HISTORY}&select=id,direction,sender_type,purpose,body,created_at,status`)) || [];
  const anchor = msgs.find((m) => m.id === job.anchor_message_id) || (await db.get(`ai_messages?id=eq.${enc(job.anchor_message_id)}&select=id,body,created_at`))?.[0];
  const newestIn = lastBy(msgs, (m) => m.direction === "inbound");
  if (!ck("still the buyer's latest message", !!anchor && (!newestIn || newestIn.id === anchor.id))) return { status: "cancelled", reason: "superseded by a newer buyer message" };
  const after = (m) => new Date(m.created_at) >= new Date(anchor.created_at);
  const human = (conv.last_human_reply_at && new Date(conv.last_human_reply_at) >= new Date(anchor.created_at)) || msgs.some((m) => m.direction === "outbound" && m.sender_type === "human" && after(m));
  if (!ck("no human reply or follow-up since the buyer's message", !human)) return { status: "cancelled", reason: "a person already followed up" };
  const followedUp = (conv.last_follow_up_at && new Date(conv.last_follow_up_at) >= new Date(anchor.created_at)) || msgs.some((m) => m.direction === "outbound" && m.purpose === "service" && m.sender_type === "ai" && after(m) && m.status !== "skipped");
  if (!ck("not already followed up for this message", !followedUp)) return { status: "cancelled", reason: "already followed up" };
  const consent = await consentOf(db, conv.contact?.id);
  if (!ck("buyer has not opted out", consent.service !== "withdrawn")) return { status: "cancelled", reason: "buyer opted out" };
  const appts = (await db.get(`ai_appointments?lead_id=eq.${enc(lead.id)}&status=eq.confirmed&start_at=gt.${enc(now.toISOString())}&select=id&limit=1`)) || [];
  if (!ck("no confirmed appointment coming up (reminders handle that)", !appts.length)) return { status: "skipped", reason: "appointment already booked; appointment reminders will follow" };
  const seq = (await db.get(`ai_follow_up_jobs?lead_id=eq.${enc(lead.id)}&status=in.(scheduled,processing,sent)&select=status,run_at,updated_at`)) || [];
  const clash = seq.some((j) => Math.abs(new Date(j.status === "sent" ? j.updated_at : j.run_at) - now) < 12 * 3600e3);
  if (!ck("no other follow-up sequence due around now", !clash)) return { status: "skipped", reason: "another follow-up sequence is handling this buyer" };

  // switched off, or WhatsApp unavailable: a person should follow up instead
  const needHuman = async (reason) => { if (A.human_reminders) await alertHuman(deps, { conv, reason: `no reply for ${agoText(now - new Date(anchor.created_at))}; ${reason}`, key: `smart-human:${job.id}`, lastMessage: anchor }); return { status: "skipped", reason }; };
  if (!ck("automatic follow-ups switched on", !!f.follow_ups && A.smart_follow_up !== false)) return needHuman("automatic follow-ups are switched off");
  if (!ck("WhatsApp sending available", !!f.whatsapp_outbound && !!deps.wa)) return needHuman("WhatsApp sending is off or not connected");
  if (!isOpen(settings.business?.hours, now)) {
    const at = nextOpening(settings.business?.hours, now);
    ck("within business hours", false);
    if (at) return { status: "scheduled", reason: "waiting for business hours", run_at: at.toISOString() };
    return needHuman("no business hours configured");
  }
  ck("within business hours", true);

  const to = toOf(conv);
  if (inWindow(conv.last_inbound_at, now)) {
    ck("inside WhatsApp's 24-hour window (free-form message allowed)", true);
    // a retried job re-sends the follow-up it already wrote (no second AI call, same text)
    const prior = (await db.get(`ai_messages?source_job_id=eq.${enc(job.id)}&select=id,body,status`))?.[0];
    if (prior?.body) {
      const s = await sendOutbound(deps, { conversation: conv, to, text: prior.body, senderType: "ai", purpose: "service", sourceJobId: job.id });
      if (s.blocked) return { status: "cancelled", reason: s.error, message_id: s.id };
      if (!s.sent) return { status: "failed", reason: s.error, message_id: s.id, retry: s.kind !== "config" };
      await db.patch(`ai_conversations?id=eq.${enc(conv.id)}`, { last_follow_up_at: now.toISOString() });
      return { status: "sent", message_id: s.id };
    }
    const hours = Math.round((now - new Date(anchor.created_at)) / 3600e3);
    const c = await composeFollowUp({ db, llm: deps.llm, reserve: () => db.rpc("ai_reserve_ai_call", {}), leadId: lead.id, history: historyOf([...msgs].reverse()), now,
      instruction: `The buyer last wrote about ${hours} hours ago and has not replied since. Write ONE short, friendly check-in (1–2 sentences) about what they were actually asking — for a property question offer to compare layouts or prices; for a loan or LPPSA question offer a quick eligibility estimate; if they showed interest in visiting, offer to arrange a showroom visit. Use their name with Tuan/Puan if known. Do not greet as if starting a new conversation, do not repeat earlier information, and never mention urgency, scarcity or promotions unless they are verified in the context.` });
    if (!c.reply) return needHuman(c.skipped || "the AI could not write a suitable follow-up");
    const s = await sendOutbound(deps, { conversation: conv, to, text: c.reply, senderType: "ai", purpose: "service", sourceJobId: job.id });
    if (s.blocked) return { status: "cancelled", reason: s.error, message_id: s.id };
    if (!s.sent) return { status: "failed", reason: s.error, message_id: s.id, retry: s.kind !== "config" };
    await db.patch(`ai_conversations?id=eq.${enc(conv.id)}`, { last_follow_up_at: now.toISOString() });
    return { status: "sent", message_id: s.id };
  }
  ck("inside WhatsApp's 24-hour window (free-form message allowed)", false);
  const lang = conv.contact?.preferred_language === "en" ? "en" : "ms";
  const tpls = ((await db.get(`ai_message_templates?name=eq.${enc(A.follow_up_template || "follow_up")}&wa_status=eq.approved&active=is.true&select=*`)) || []).filter((t) => t.wa_template_name && t.category !== "marketing");
  const tpl = tpls.find((t) => t.lang === lang) || tpls[0];
  if (!ck(`approved "${A.follow_up_template || "follow_up"}" template available`, !!tpl)) return needHuman("more than 24 hours since the buyer's message and no approved follow-up template");
  const s = await sendOutbound(deps, { conversation: conv, to, senderType: "ai", purpose: "service", sourceJobId: job.id,
    template: { ...tpl, params: templateParams(tpl, { name: conv.contact?.full_name, project: await projectName(db, lead.primary_project_id) }) } });
  if (s.blocked) return { status: "cancelled", reason: s.error, message_id: s.id };
  if (!s.sent) return { status: "failed", reason: s.error, message_id: s.id, retry: s.kind !== "config" };
  await db.patch(`ai_conversations?id=eq.${enc(conv.id)}`, { last_follow_up_at: now.toISOString() });
  return { status: "sent", message_id: s.id };
}

/* ---------------------------------------------------------------- human reminder (Telegram) */
async function humanReminder(deps, job, settings, ck) {
  const { db } = deps, now = deps.now(), A = automationOf(settings), f = settings.flags || {};
  const conv = await loadConv(db, job.conversation_id);
  if (!ck("conversation open", !!conv && conv.status === "open" && !conv.lead?.closed_at)) return { status: "cancelled", reason: "conversation or lead closed" };
  const anchor = (await db.get(`ai_messages?id=eq.${enc(job.anchor_message_id)}&select=id,body,created_at`))?.[0];
  if (!ck("buyer message still recorded", !!anchor)) return { status: "cancelled", reason: "message no longer exists" };
  const later = (await db.get(`ai_messages?conversation_id=eq.${enc(conv.id)}&created_at=gte.${enc(anchor.created_at)}&select=id,direction,sender_type,status,created_at`)) || [];
  const human = later.some((m) => m.direction === "outbound" && m.sender_type === "human");
  if (!ck("no reply from a person yet", !human)) return { status: "cancelled", reason: "a person replied" };
  const aiHandles = conv.mode === "ai" && !conv.lead?.ai_paused && !!f.ai_auto_reply;
  const aiAnswered = later.some((m) => m.direction === "outbound" && m.sender_type === "ai" && ["sent", "delivered", "read"].includes(m.status));
  if (!ck("the AI did not answer it", !(aiHandles && aiAnswered))) return { status: "cancelled", reason: "the AI answered" };
  if (!ck("human follow-up reminders switched on", A.human_reminders !== false)) return { status: "skipped", reason: "human follow-up reminders are switched off" };
  if (!isOpen(settings.business?.hours, now)) {
    const at = nextOpening(settings.business?.hours, now);
    ck("within business hours", false);
    if (at) return { status: "scheduled", reason: "waiting for business hours", run_at: at.toISOString() };
  }
  const why = conv.mode !== "ai" || conv.lead?.ai_paused ? "the buyer is waiting for your reply" : "AI auto-reply is off; the buyer is waiting for a reply";
  const ok = await alertHuman(deps, { conv, reason: why, key: `human:${job.anchor_message_id}`, lastMessage: anchor });
  return ok ? { status: "sent" } : { status: "skipped", reason: "Telegram not configured or already notified" };
}

/* ---------------------------------------------------------------- appointment confirmation / reminder */
async function appointmentMessage(deps, job, settings, ck) {
  const { db } = deps, now = deps.now(), A = automationOf(settings), f = settings.flags || {};
  const isConfirm = job.kind === "appt_confirmation";
  const a = (await db.get(`ai_appointments?id=eq.${enc(job.appointment_id)}&select=*,lead:ai_leads(id,contact_id,primary_project_id)`))?.[0];
  if (!ck("appointment exists", !!a)) return { status: "cancelled", reason: "appointment deleted" };
  if (!ck("appointment is confirmed", a.status === "confirmed")) return { status: "cancelled", reason: "appointment " + String(a.status).replace(/_/g, " ") };
  if (!ck("time unchanged since it was scheduled", !job.ref_time || new Date(job.ref_time).getTime() === new Date(a.start_at).getTime())) return { status: "cancelled", reason: "appointment rescheduled" };
  if (!ck("appointment still ahead", new Date(a.start_at) > new Date(now.getTime() + (isConfirm ? 0 : 10 * 60e3)))) return { status: "skipped", reason: "too late: the appointment time has (almost) arrived" };
  if (!ck("WhatsApp messages on for this appointment", a.wa_reminders !== false)) return { status: "cancelled", reason: "reminders switched off for this appointment" };
  if (!ck(`${isConfirm ? "confirmations" : "reminders"} switched on in settings`, isConfirm ? A.appointment_confirmations !== false : A.appointment_reminders !== false)) return { status: "skipped", reason: "switched off in settings" };
  const conv = (await loadConv(db, job.conversation_id)) || (await db.get(`ai_conversations?contact_id=eq.${enc(a.lead?.contact_id)}&channel=eq.whatsapp&status=eq.open&select=id`).then((r) => loadConv(db, r?.[0]?.id)));
  const to = toOf(conv);
  if (!ck("buyer has a WhatsApp conversation", !!conv && !!to)) return { status: "skipped", reason: "no WhatsApp conversation for this buyer" };
  if (!ck("appointment messages allowed for this conversation", conv.automation?.appointment_reminders !== false)) return { status: "cancelled", reason: "appointment reminders switched off for this conversation" };
  const consent = await consentOf(db, conv.contact?.id);
  if (!ck("buyer has not opted out", consent.service !== "withdrawn")) return { status: "cancelled", reason: "buyer opted out" };
  const remindHuman = async (reason) => { if (A.human_reminders) await alertHuman(deps, { conv, reason: `the WhatsApp appointment ${isConfirm ? "confirmation" : "reminder"} could not be sent (${reason}) — please message the buyer`, key: `appt-human:${job.id}` }); return { status: "skipped", reason }; };
  if (!ck("WhatsApp sending available", !!f.whatsapp_outbound && !!deps.wa)) return remindHuman("WhatsApp sending is off or not connected");

  const place = await placeFor(db, a, settings);
  const location = a.location || place.location, map = location === place.location ? place.map : "";
  const project = await projectName(db, a.project_id || a.lead?.primary_project_id);
  const lang = conv.contact?.preferred_language === "en" ? "en" : "ms";
  const sendText = async (text) => sendOutbound(deps, { conversation: conv, to, text, senderType: "system", purpose: "service", sourceJobId: job.id });
  let s;
  if (inWindow(conv.last_inbound_at, now)) {
    ck("inside WhatsApp's 24-hour window (free-form message allowed)", true);
    s = await sendText(isConfirm ? confirmationText({ kind: a.kind, start: a.start_at, location, map, lang, project })
      : reminderText({ kind: a.kind, start: a.start_at, location, map, lang, project, ask: !a.attendance_confirmed_at }));
  } else {
    ck("inside WhatsApp's 24-hour window (free-form message allowed)", false);
    const name = isConfirm ? "appointment_confirmation" : "appointment_reminder";
    const tpls = ((await db.get(`ai_message_templates?name=eq.${name}&wa_status=eq.approved&active=is.true&select=*`)) || []).filter((t) => t.wa_template_name);
    const t = tpls.find((x) => x.lang === lang) || tpls[0];
    if (!ck(`approved "${name}" template available`, !!t)) return remindHuman(`outside the 24-hour window and no approved "${name}" template`);
    const when = formatWhen(a.start_at, t.lang);
    s = await sendOutbound(deps, { conversation: conv, to, senderType: "system", purpose: "service", sourceJobId: job.id,
      template: { ...t, params: templateParams(t, { name: conv.contact?.full_name, project, appointment: when, location: [location, map].filter(Boolean).join(" ") }) } });
  }
  if (!s.sent) return { status: "failed", reason: s.error, message_id: s.id, retry: s.kind !== "config" };
  // kept for the appointment's own history (and the older reminder log)
  await db.patch(`ai_appointments?id=eq.${enc(a.id)}`, { reminders: [...(a.reminders || []), { type: isConfirm ? "confirmation" : `wa_${job.offset_minutes}m`, status: "sent", at: now.toISOString() }] });
  return { status: "sent", message_id: s.id };
}

const HANDLERS = { smart_follow_up: smartFollowUp, human_reminder: humanReminder, appt_confirmation: appointmentMessage, appt_reminder: appointmentMessage };
// a job that could not run on time (worker stopped, switched off, deployed late) is dropped, not sent late in a burst
const LATE_HOURS = { smart_follow_up: 6, human_reminder: 12, appt_confirmation: 24, appt_reminder: 3 };

/** Runs one claimed job and records the outcome, the checks made and the message sent (if any). */
export async function processAutomationJob(deps, job, settings) {
  const { db } = deps;
  const checks = [];
  const ck = (check, ok) => { checks.push({ check, ok: !!ok }); return !!ok; };
  let out;
  const late = (deps.now() - new Date(job.run_at)) / 3600e3;
  if (late > (LATE_HOURS[job.kind] ?? 24)) out = { status: "cancelled", reason: `too late to send (${Math.round(late)} h after it was due)` };
  else try { out = await (HANDLERS[job.kind] || (async () => ({ status: "cancelled", reason: "unknown job kind" })))(deps, job, settings, ck); }
  catch (e) { out = { status: "failed", reason: String(e?.message || e).slice(0, 300), retry: true }; }
  const retry = out.status === "failed" && out.retry && (job.attempts || 0) < 5;
  await db.patch(`ai_automation_jobs?id=eq.${enc(job.id)}`, {
    status: retry ? "scheduled" : out.status, reason: out.reason || null, checks, message_id: out.message_id || null,
    ...(out.status === "sent" ? { sent_at: deps.now().toISOString() } : {}),
    ...(out.run_at ? { run_at: out.run_at, attempts: 0 } : retry ? { run_at: new Date(deps.now().getTime() + 5 * 60e3 * (job.attempts || 1)).toISOString() } : {}),
  });
  return { ...out, checks };
}

/** Claims and runs due jobs (or one job by id). */
export async function runAutomation(deps, settings, { max = 20, onlyId = null } = {}) {
  const jobs = (await deps.db.rpc("ai_claim_automation_jobs", { max_jobs: max, ...(onlyId ? { only_id: onlyId } : {}) })) || [];
  const results = [];
  for (const j of jobs) results.push({ id: j.id, kind: j.kind, ...(await processAutomationJob(deps, j, settings)) });
  return results;
}

/**
 * Sends the confirmation for an appointment right away (after AI booking or staff confirmation), through its job so
 * the worker can never send it a second time. Returns the job outcome, or null when no confirmation job exists.
 */
export async function confirmAppointmentNow(deps, settings, appointmentId) {
  const job = (await deps.db.get(`ai_automation_jobs?appointment_id=eq.${enc(appointmentId)}&kind=eq.appt_confirmation&status=eq.scheduled&select=id&order=created_at.desc&limit=1`))?.[0];
  if (!job) return null;
  const [r] = await runAutomation(deps, settings, { max: 1, onlyId: job.id });
  return r || { status: "processing", reason: "already being sent" };
}
