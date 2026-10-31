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
import { createHash } from "node:crypto";
import { purgeDocuments } from "./documents.mjs";

export { sendOutbound };

const enc = encodeURIComponent;
const MAX_HISTORY = 30;
const flagsOf = (settings) => ({ module: settings?.flags?.module_enabled !== false, ...settings?.flags });

export async function loadSettings(db) { return (await db.get("ai_settings?id=eq.1&select=*"))?.[0] || {}; }

// a part of a reply that was never delivered (a person took over, or the buyer wrote again first) is not history
const delivered = (m) => !(m.direction === "outbound" && m.status === "skipped");
const historyOf = (msgs) => msgs.filter((m) => m.body && delivered(m)).map((m) => ({ role: m.direction === "inbound" ? "user" : "assistant", text: m.body }));

/**
 * The idempotency key (ai_messages.source_job_id) of message i of a reply job: the job id for the first, exactly as
 * before, and a fixed UUID derived from it for the second and third. A retried job finds the same keys, so no
 * message is recorded or sent twice.
 */
export function segmentKey(jobId, i) {
  if (!i) return jobId;
  return uuidFrom(`${jobId}:message:${i}`);
}
/** A fixed UUID derived from a text (name-based, version 5 layout): the same seed always gives the same key. */
function uuidFrom(seed) {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const FILE_REPEAT_MS = 10 * 60 * 1000;
/**
 * Sends the files the AI chose (send_file actions) after its reply, each as a WhatsApp document (PDF) or image,
 * by a 1-hour signed link to the private knowledge bucket. Only files still marked shareable go; the same file is not
 * sent twice to one chat within 10 minutes; a retried job never sends a file twice (key per job and file).
 */
export async function sendFiles(deps, { conversation, to, files, jobId, runId = null }) {
  const { db } = deps, out = [];
  if (!deps.knowledgeFiles) return out;
  for (const a of files) {
    const doc = (await db.get(`ai_documents?id=eq.${enc(a.document_id)}&share_with_customers=eq.true&select=id,title,storage_path,mime_type`))?.[0];
    if (!doc?.storage_path) { out.push({ document_id: a.document_id, sent: false, reason: "no longer shareable" }); continue; }
    const since = new Date(deps.now().getTime() - FILE_REPEAT_MS).toISOString();
    const recent = await db.get(`ai_messages?conversation_id=eq.${enc(conversation.id)}&direction=eq.outbound&status=in.(queued,sent,delivered,read)&created_at=gte.${enc(since)}&media=cs.${enc(JSON.stringify([{ document_id: doc.id }]))}&select=id&limit=1`).catch(() => []);
    if (recent?.length) { out.push({ document_id: doc.id, sent: false, reason: "just sent" }); continue; }
    const kind = doc.mime_type === "application/pdf" ? "document" : "image";
    const title = String(doc.title || "Brochure");
    const filename = kind === "document" && !/\.pdf$/i.test(title) ? title + ".pdf" : title;
    const r = await sendOutbound(deps, { conversation, to, senderType: "ai", purpose: "reply", runId, sourceJobId: uuidFrom(`${jobId}:file:${doc.id}`),
      file: { kind, document_id: doc.id, title, filename, caption: title.replace(/\.[a-z0-9]{2,4}$/i, ""), link: () => deps.knowledgeFiles.sign(doc.storage_path, 3600) } });
    out.push({ document_id: doc.id, sent: !!r.sent, ...(r.error ? { reason: r.error } : {}) });
    if (r.blocked) break;
  }
  return out;
}

/**
 * Sends the messages of one reply turn in order, each as its own WhatsApp message and ai_messages row.
 * All rows are recorded first (status queued, keyed per message), then sent one by one. Before every message after
 * the first: a short pause, and a check that the buyer has not written again (their newer message gets a fresh
 * reply that sees what was already sent). sendOutbound re-checks who owns the conversation before each AI message.
 * Anything not sent because of a take-over or a newer buyer message is marked skipped and never sent later.
 * Returns { sent: number, total, blocked?, superseded?, error?, kind? }.
 */
export async function sendTurn(deps, { conversation, to, messages, senderType, runId = null, jobId, inboundId }) {
  const { db } = deps;
  const keys = messages.map((_, i) => segmentKey(jobId, i));
  for (let i = 0; i < messages.length; i++) {
    await db.post("ai_messages?on_conflict=source_job_id", { conversation_id: conversation.id, direction: "outbound", sender_type: senderType, body: messages[i],
      provider: "whatsapp_cloud", status: "queued", purpose: "reply", agent_run_id: runId, source_job_id: keys[i] }, { prefer: "return=minimal,resolution=ignore-duplicates" });
  }
  const skipRest = (from, reason) => db.patch(`ai_messages?source_job_id=in.(${keys.slice(from).join(",")})&status=in.(queued,failed)`, { status: "skipped", status_reason: reason });
  let sent = 0;
  for (let i = 0; i < messages.length; i++) {
    if (i > 0) {
      const pause = deps.messageGapMs ?? 1200;
      if (pause) await new Promise((r) => setTimeout(r, pause));
    }
    // the buyer wrote again while this reply was being written or sent: the reply to their newer message (another
    // job, which sees every message since our last delivered one) answers everything, so the rest of this one is
    // dropped — before the first message too, so two quick buyer messages never get two overlapping replies.
    // Fixed replies (STOP, "talk to a person") always go out.
    if (senderType === "ai" && inboundId) {
      const newest = (await db.get(`ai_messages?conversation_id=eq.${enc(conversation.id)}&direction=eq.inbound&order=created_at.desc,id.desc&limit=1&select=id`))?.[0];
      if (newest && newest.id !== inboundId) {
        await skipRest(i, i ? "the buyer wrote again before this part was sent; the next reply answers them" : "the buyer wrote again while this reply was being written; the next reply answers both");
        return { sent, total: messages.length, superseded: true };
      }
    }
    const r = await sendOutbound(deps, { conversation, to, text: messages[i], senderType, purpose: "reply", runId, sourceJobId: keys[i] });
    if (r.blocked) { await skipRest(i, r.error || "not sent"); return { sent, total: messages.length, blocked: true, error: r.error }; }
    if (!r.sent) return { sent, total: messages.length, error: r.error, kind: r.kind }; // the rest stay queued for the retry
    sent++;
  }
  return { sent, total: messages.length };
}
const nameOf = (c) => c?.full_name || null;

/* ---------------------------------------------------------------- replies */
const SILENT = new Set(["reaction", "sticker", "revoke"]);
const kindsOf = (m) => (m.media?.length ? m.media.map((x) => x.type) : [/^\[(\w+)\]$/.exec(String(m.body || "").trim())?.[1]].filter(Boolean));
const silentOnly = (m) => { const k = kindsOf(m); return k.length > 0 && k.every((x) => SILENT.has(x)) && !captionOf(m); };
const captionOf = (m) => String(m.body || "").replace(/^\[\w+\]\s*/, "").trim();

export async function processReplyJob(deps, job, settings) {
  const { db } = deps;
  const { conversation_id: convId, message_id: msgId } = job.payload || {};
  const conv = (await db.get(`ai_conversations?id=eq.${enc(convId)}&select=*,contact:ai_contacts(id,full_name,phone_e164,wa_id,preferred_language),lead:ai_leads(id,ai_paused,closed_at,first_response_at,lead_code)`))?.[0];
  if (!conv) return { status: "done", note: "conversation not found" };

  // a retried job only re-sends the messages it already wrote: no second AI call, no duplicate CRM actions
  const keys = [0, 1, 2].map((i) => segmentKey(job.id, i));
  const prior = ((await db.get(`ai_messages?source_job_id=in.(${keys.join(",")})&select=id,status,body,sender_type,source_job_id,agent_run_id`)) || [])
    .sort((a, b) => keys.indexOf(a.source_job_id) - keys.indexOf(b.source_job_id));
  if (prior.length) {
    if (!prior.some((m) => ["queued", "failed"].includes(m.status))) return { status: "done", note: "already sent" };
    const s = await sendTurn(deps, { conversation: conv, to: conv.contact?.wa_id || conv.contact?.phone_e164, messages: prior.map((m) => m.body), senderType: prior[0].sender_type || "ai",
      runId: prior[0].agent_run_id || null, jobId: job.id, inboundId: msgId });
    if (s.blocked || s.superseded) return { status: "done", note: "not all sent: " + (s.error || "the buyer wrote again") };
    if (s.sent < s.total && s.kind !== "config") throw new Error("WhatsApp send failed: " + s.error);
    return { status: "done", resent: s.sent };
  }

  // id breaks ties between messages sent in the same second, so every job agrees on which message is newest
  const msgs = (await db.get(`ai_messages?conversation_id=eq.${enc(convId)}&order=created_at.desc,id.desc&limit=${MAX_HISTORY + 10}&select=id,direction,sender_type,body,media,created_at,status`)) || [];
  const newestIn = msgs.find((m) => m.direction === "inbound");
  if (!newestIn || newestIn.id !== msgId) return { status: "done", note: "superseded by a newer message" }; // the newer job answers both

  // everything the buyer sent since our last delivered message is answered together. Only a message sent BEFORE the
  // buyer's newest one can have answered it: one written after it was drafted without it (an earlier reply job still
  // queuing its messages), so it does not count — otherwise each job leaves the answer to the other (30 Oct: "Hi",
  // then "Can send me details?" 19 s later, and no reply at all)
  const newestAt = Date.parse(newestIn.created_at);
  let cut = msgs.findIndex((m) => m.direction === "outbound" && delivered(m) && Date.parse(m.created_at) < newestAt);
  if (cut < 0) cut = msgs.length;
  const all = msgs.slice(0, cut).filter((m) => m.direction === "inbound").reverse();
  // messages an earlier reply did send meanwhile are part of what the buyer saw: kept in the history
  const sentSince = msgs.slice(0, cut).filter((m) => m.direction === "outbound" && ["sent", "delivered", "read"].includes(m.status)).reverse();
  const earlier = [...msgs.slice(cut).reverse(), ...sentSince];
  // reactions, stickers and deleted messages need no answer: never an "our advisor will contact you" for a 👍
  const pending = all.filter((m) => !silentOnly(m));
  if (!pending.length) return { status: "done", note: "nothing to answer (" + [...new Set(all.flatMap(kindsOf))].join(", ") + ")" };
  const message = pending.map((m) => m.body).filter(Boolean).join("\n").trim();
  // text, or the words written with a photo or document ("[image] ini unit?")
  const readable = pending.some((m) => (!m.media?.length && m.body) || captionOf(m));
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
    result = { decision: "handover", reply: fixedReply(kinds === "audio" ? "audio" : "media", lang), language: lang, intent: "other", agent: "handover", confidence: null, message,
      actions: [{ type: "handover", reason: "other", summary: `Buyer sent ${kinds}, which the AI cannot read.`, next_action: "Open the WhatsApp conversation and reply personally." }, { type: "cancel_follow_ups", reason: "conversation needs a human" }] };
  } else {
    let slots = null;
    // calendar unavailable → the AI collects a preferred time instead of offering slots
    if (f.calendar_booking && deps.cal) { try { slots = await deps.cal.slots(settings, deps.now()); } catch { slots = null; } }
    result = await respond({ db, llm: deps.llm, reserve: () => db.rpc("ai_reserve_ai_call", {}), leadId: lead.id, message, history: historyOf(earlier), now: deps.now(),
      mode: "live", calendar: !!slots, slots: slots || [], research: deps.research || null, budgetMs: deps.replyBudgetMs || null });
    // the AI ran out of this run's time: try twice more on later runs (fresh time) before the buyer gets the safe reply
    if (result.decision === "error" && result.errorKind === "timeout" && (job.attempts || 1) < 3) throw new Error("AI reply timed out; retrying on the next run");
  }

  const runId = await logRun(db, { result, leadId: lead.id, conversationId: conv.id, channel: "whatsapp", input: { job: job.id } });
  const done = await applyActions(db, { leadId: lead.id, contactId: contact.id, result, conversationId: conv.id, runId, messageId: msgId });

  let sent = null;
  const out = result.messages?.length ? result.messages : result.reply ? [result.reply] : [];
  if (out.length && result.decision !== "paused") {
    if (canSend) {
      // fixed replies to STOP / "talk to a person" are system messages: sent even while a person handles the chat
      const t = await sendTurn(deps, { conversation: conv, to, messages: out, senderType: guard ? "system" : "ai", runId, jobId: job.id, inboundId: msgId });
      sent = { ...t, sent: t.sent > 0, complete: t.sent === t.total };
      if ((t.blocked || t.superseded) && !t.sent) {
        // a person took over while the AI was writing (their conversation), or the buyer wrote again and the reply
        // to their newer message answers everything: nothing more to do here
      } else if (sent.sent) {
        await db.patch(`ai_conversations?id=eq.${enc(conv.id)}`, { unread_count: 0 });
        // brochures and other files the AI said it is sending: after the whole reply went out
        const files = (result.actions || []).filter((a) => a.type === "send_file");
        if (files.length && sent.complete) sent.files = await sendFiles(deps, { conversation: conv, to, files, jobId: job.id, runId }).catch((e) => [{ sent: false, reason: String(e?.message || e) }]);
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
  // client insights (profile, summary, next action) from the buyer's message: a separate, smaller AI call in its own
  // job, so it never delays or blocks the reply; one per buyer message (dedupe key). It is due 90 s later: jobs run
  // oldest first, and a buyer's next reply must not wait behind it (30 Oct: replies took 60–80 s instead of ~15)
  if (lead?.id && readable && !guard && settings.ai?.auto_insights !== false && ["reply", "handover", "blocked"].includes(result.decision)) {
    await db.post("ai_jobs?on_conflict=dedupe_key", { kind: "lead_insights", status: "queued", payload: { lead_id: lead.id, message_id: msgId }, dedupe_key: `insights:${msgId}`,
      run_at: new Date(deps.now().getTime() + INSIGHTS_DELAY_MS).toISOString() },
      { prefer: "return=minimal,resolution=ignore-duplicates" }).catch(() => null);
  }
  // retried: the recorded rows (one per message) prevent a double send; only what is still queued or failed goes out
  if (sent && !sent.complete && !sent.blocked && !sent.superseded && sent.kind !== "config") throw new Error("WhatsApp send failed: " + sent.error);
  return { status: "done", decision: result.decision, sent: !!sent?.sent, ...(sent?.files ? { files: sent.files } : {}) };
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
// an AI reply takes 15–20 s: a job is only claimed when it can finish before the function is stopped
// a job is started only with nearly a whole run left: an AI reply can need ~7 s of data lookups plus 12–15 s of AI on
// a busy turn (31 Oct: the 4th reply in one run had 12 s left and timed out twice). Each incoming message starts its
// own run, so taking one reply per run does not hold the others up.
export const MIN_JOB_MS = 22000;
// profile updates wait this long, so replies to buyers always go first
export const INSIGHTS_DELAY_MS = 90e3;

/**
 * budgetMs: how long this run may take (Netlify stops functions at 30 s). With a budget, jobs are claimed one at a
 * time and only while one can still finish, so a job is never left locked (and the buyer kept waiting 5 minutes)
 * because the function ran out of time; the AI reply itself gets the time that is left.
 */
export async function runWorker(deps, { maxJobs = 10, followUps = true, reminders = true, budgetMs = null } = {}) {
  const { db } = deps;
  const out = { replies: 0, follow_ups: 0, automation: 0, errors: [] };
  const start = Date.now();
  const remaining = () => (budgetMs ? budgetMs - (Date.now() - start) : Infinity);
  const settings = await loadSettings(db);
  const f = flagsOf(settings);
  if (!f.module) return { ...out, note: "module switched off in settings" };

  // without a budget: one batch, as before; with one: one job at a time, while a job can still finish
  const batch = budgetMs ? null : (await db.rpc("ai_claim_jobs", { max_jobs: maxJobs })) || [];
  let claimed = 0;
  const next = async () => {
    if (batch) return batch.shift() || null;
    if (claimed >= maxJobs || remaining() < MIN_JOB_MS) return null;
    claimed++;
    return ((await db.rpc("ai_claim_jobs", { max_jobs: 1 })) || [])[0] || null;
  };
  for (let job = await next(); job; job = await next()) {
    try {
      if (job.kind === "wa_reply") { await processReplyJob(budgetMs ? { ...deps, replyBudgetMs: remaining() - 2000 } : deps, job, settings); out.replies++; }
      else if (job.kind === "lead_insights" && deps.llm && job.payload?.lead_id) {
        // never fails the job: insights are a convenience, and summarizeLead skips a message it already covered
        const r = await summarizeLead(deps, job.payload.lead_id).catch((e) => ({ skipped: e?.message || String(e) }));
        out.insights = (out.insights || 0) + (r.applied ? 1 : 0);
      }
      await db.patch(`ai_jobs?id=eq.${enc(job.id)}`, { status: "done", last_error: null });
    } catch (e) {
      const dead = job.attempts >= job.max_attempts;
      await db.patch(`ai_jobs?id=eq.${enc(job.id)}`, { status: dead ? "dead" : "failed", last_error: String(e?.message || e).slice(0, 500), run_at: new Date(deps.now().getTime() + 60e3 * job.attempts ** 2).toISOString() });
      if (dead && job.payload?.conversation_id) await openHumanTaskAbout(deps, job.payload.conversation_id, { cause: "undelivered", key: `${job.payload.conversation_id}:${deps.now().toISOString().slice(0, 10)}`, title: "Reply to the buyer: the AI could not answer their message", details: `Failed after ${job.attempts} tries.` });
      out.errors.push(String(e?.message || e));
    }
  }
  // follow-ups are only claimed while automation is on; otherwise the database announces due steps to staff instead
  // a follow-up is an AI call too: only with time for it
  if (followUps && f.follow_ups && f.whatsapp_outbound && deps.wa && remaining() >= MIN_JOB_MS) {
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
  // financing documents (payslips, CCRIS, statements): every hour, so an erased or expired file goes within the hour
  if (deps.storage && t.getUTCMinutes() < 2) {
    try { out.documents_purged = await purgeDocuments(deps); } catch (e) { out.errors.push("documents purge: " + (e?.message || e)); }
  }
  return out;
}
