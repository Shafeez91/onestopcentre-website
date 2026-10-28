// Central orchestrator for one buyer message:
//   guards (opt-out, human request) -> verified context -> AI draft -> business-rule validation
//   (one corrected retry) -> decision (reply / handover / blocked / opt_out / paused / error) -> proposed CRM actions.
// In "simulate" mode nothing is written; applyActions() performs the writes for live channels (Phase 4).
import { isOptOut, wantsHuman, detectLanguage, fixedReply } from "../../sales/shared/guard.mjs";
import { validateReply } from "../../sales/shared/validator.mjs";
import { scoreLead } from "../../sales/shared/scoring.mjs";
import { loadContext } from "./context.mjs";
import { buildSystemPrompt, renderContext, buildMessages, REPLY_SCHEMA, normalizeReply } from "./prompt.mjs";
import { DEFAULT_MODEL, LlmError } from "./llm.mjs";
import { mergeFinancing, attachFinancing, renderFinancing, cleanInputs, isNewAssessment, advisorSummary } from "./financing.mjs";

const QUAL_FIELDS = ["purpose", "first_home", "bedrooms", "size_sqft", "budget_min", "budget_max", "employment", "financing", "timeline_months", "readiness", "concerns"];

export function mergeQualification(current = {}, updates = {}) {
  const q = { ...current, signals: { ...(current.signals || {}) } };
  const changed = [];
  for (const k of QUAL_FIELDS) {
    const v = updates[k];
    if (v === null || v === undefined || v === "") continue;
    if (q[k] !== v) { q[k] = v; changed.push(k); }
  }
  for (const k of ["asked_price", "requested_brochure"]) if (updates[k] === true && !q.signals[k]) { q.signals[k] = true; changed.push(k); }
  return { qualification: q, changed };
}

/** Project data only (no buyer details): the projects in focus, the details they lack and any conflicts. */
export const retrievalTrace = (ctx) => ({
  focus: (ctx.focus?.ids || []).map((id) => ctx.projects.find((p) => p.id === id)?.name).filter(Boolean),
  focus_source: ctx.focus?.source || null, ambiguous: !!ctx.focus?.ambiguous,
  not_on_record: Object.fromEntries(ctx.projects.filter((p) => p.inFocus && p.notOnRecord.length).map((p) => [p.name, p.notOnRecord])),
  conflicts: Object.fromEntries(ctx.projects.filter((p) => p.inFocus && p.conflicts.length).map((p) => [p.name, p.conflicts.map((c) => c.field)])),
});

const summariseViolations = (vs) => vs.map((v) => `- ${v.code}: ${v.detail}`).join("\n");

/**
 * @param {object} p { db, llm, reserve?, leadId, message, history, now, mode: "simulate" | "live" }
 *   reserve(): Promise<{allowed, used, cap}> — books one AI reply against the daily cap
 */
export async function respond(p) {
  const t0 = Date.now();
  const now = p.now || new Date();
  const message = String(p.message || "").trim();
  const history = p.history || [];
  const base = { message, actions: [], attempts: [], violations: [], model: null, usage: null };
  const finish = (r) => ({ ...base, ...r, latency_ms: Date.now() - t0 });

  if (!message) return finish({ decision: "ignored", reply: null, reason: "empty message" });

  // 1) deterministic guards — honoured regardless of the AI
  const guessLang = detectLanguage(message);
  if (isOptOut(message)) {
    return finish({
      decision: "opt_out", reply: fixedReply("opt_out", guessLang), language: guessLang, intent: "opt_out", agent: "reception", confidence: 1,
      actions: [{ type: "record_consent", channel: "whatsapp", purpose: "marketing", status: "withdrawn", evidence: message.slice(0, 200) },
                { type: "record_consent", channel: "whatsapp", purpose: "service", status: "withdrawn", evidence: message.slice(0, 200) },
                { type: "cancel_follow_ups", reason: "customer opted out" }, { type: "pause_ai" }],
    });
  }
  if (wantsHuman(message)) {
    return finish({
      decision: "handover", reply: fixedReply("human", guessLang), language: guessLang, intent: "human_request", agent: "handover", confidence: 1,
      actions: [{ type: "handover", reason: "customer_request", summary: `Buyer asked to speak to a person: "${message.slice(0, 300)}"`, next_action: "Contact the buyer personally." },
                { type: "pause_ai" }, { type: "cancel_follow_ups", reason: "human requested" }],
    });
  }

  // 2) verified context
  const ctx = await loadContext(p.db, { leadId: p.leadId, message, history, now });
  if (ctx.aiPaused && p.mode === "live") return finish({ decision: "paused", reply: null, reason: "AI is paused for this lead; a human handles replies." });
  const settings = ctx.settings || {};
  const model = settings.ai?.model || DEFAULT_MODEL;
  const effort = settings.ai?.effort || "low";
  const threshold = Number(settings.ai?.confidence_threshold ?? 0.7);
  ctx.slots = p.calendar ? (p.slots || []) : null; // free calendar slots, only when calendar booking is on
  // loan engine: on by flag for live chats, always in the test console so it can be tried before switching on
  const finOn = !!settings.flags?.loan_engine || p.mode === "simulate";
  let finSaved = null;
  if (finOn) {
    if (p.leadId) finSaved = (await p.db.get(`ai_financing_profiles?lead_id=eq.${encodeURIComponent(p.leadId)}&select=id,inputs,result`).catch(() => []))?.[0] || null;
    attachFinancing(ctx, { inputs: { ...cleanInputs(finSaved?.inputs), ...cleanInputs(p.financingInputs) }, saved: finSaved });
    ctx.financingView = renderFinancing(ctx.financing);
  }
  const system = buildSystemPrompt(settings, ctx.objections, { calendar: !!p.calendar, financing: finOn });
  let contextText = renderContext(ctx);

  // 3) daily cost cap: reserve one AI reply before calling the model (fail closed if usage can't be checked)
  if (p.reserve) {
    let quota;
    try { quota = await p.reserve(); } catch (e) { quota = { allowed: false, error: e?.message || String(e) }; }
    if (!quota?.allowed) {
      const lang = ctx.buyer?.preferred_language === "en" ? "en" : guessLang;
      const why = quota?.error ? `AI usage could not be checked (${quota.error})` : `the daily AI limit (${quota.cap}) has been reached`;
      return finish({
        decision: "capped", reply: fixedReply("safe_fallback", lang), language: lang, agent: "handover", confidence: 0, quota,
        actions: [{ type: "handover", reason: "other", summary: `Not answered by the AI: ${why}. Buyer wrote: "${message.slice(0, 300)}"`, next_action: "Reply to the buyer personally." }],
      });
    }
    base.quota = quota;
  }

  // 4) AI draft + validation, with one corrected retry. When the buyer has just given new financing figures, the
  //    engine recalculates and the AI writes the reply again from the new result (at most one extra call).
  let data = null, check = null, feedback = null, usage = { input_tokens: 0, output_tokens: 0 }, servedBy = null;
  let finChanged = [], recalculated = false, retried = false;
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await p.llm({ system, messages: buildMessages(history, contextText, message, feedback), schema: REPLY_SCHEMA, model, effort });
      data = normalizeReply(r.data); servedBy = r.model || model;
      usage.input_tokens += r.usage?.input_tokens || 0; usage.output_tokens += r.usage?.output_tokens || 0;
      if (finOn && !recalculated) {
        const m = mergeFinancing(ctx.financing.inputs, data.financing_updates);
        if (m.changed.length) {
          finChanged = m.changed; recalculated = true;
          attachFinancing(ctx, { inputs: m.inputs, saved: finSaved, recalculated: true });
          ctx.financingView = renderFinancing(ctx.financing);
          contextText = renderContext(ctx);
          base.attempts.push({ attempt, reply: data.reply, violations: [], recalculated: m.changed });
          continue;
        }
      }
      check = validateReply(data.reply, ctx.rules);
      base.attempts.push({ attempt, reply: data.reply, violations: check.violations });
      if (check.ok || retried) break;
      retried = true;
      feedback = summariseViolations(check.violations);
    }
  } catch (e) {
    if (e instanceof LlmError && e.kind === "config") throw e;
    const lang = ctx.buyer?.preferred_language === "en" ? "en" : guessLang;
    return finish({
      decision: "error", error: e.message, errorKind: e.kind || "error", reply: fixedReply("safe_fallback", lang), language: lang, agent: "handover", confidence: 0,
      actions: [{ type: "handover", reason: e.kind === "refusal" ? "sensitive" : "low_confidence", summary: `The AI could not answer (${e.message}). Buyer wrote: "${message.slice(0, 300)}"`, next_action: "Reply to the buyer personally." }],
    });
  }
  base.model = servedBy; base.usage = usage;

  // 5) decision
  const actions = [];
  let decision = "reply", reply = data.reply;
  if (!check.ok) {
    decision = "blocked";
    reply = fixedReply("safe_fallback", data.language === "en" ? "en" : "ms");
    actions.push({ type: "handover", reason: "conflicting_info", summary: `AI draft blocked by business rules:\n${summariseViolations(check.violations)}\nBuyer wrote: "${message.slice(0, 300)}"`, next_action: "Check the facts and reply to the buyer personally." });
  } else if (data.handover?.needed) {
    decision = "handover";
    actions.push({ type: "handover", reason: data.handover.reason || "other", summary: data.handover.summary || `Buyer wrote: "${message.slice(0, 300)}"`, next_action: data.handover.next_action || null });
  } else if (Number(data.confidence) < threshold) {
    decision = "handover";
    actions.push({ type: "handover", reason: "low_confidence", summary: `AI confidence ${Number(data.confidence).toFixed(2)} is below ${threshold}. Draft sent: "${reply.slice(0, 300)}"`, next_action: "Review the conversation and follow up." });
  }

  // 6) qualification, scoring, interests, appointment request
  const leadQual = {};
  if (ctx.lead?.qualification_known) Object.assign(leadQual, ctx.lead.qualification_known);
  const { qualification, changed } = mergeQualification(leadQual, data.qualification_updates || {});
  const fin = finOn ? ctx.financing : null;
  if (fin?.result && finChanged.length) {
    if (fin.result.route && !qualification.financing) { qualification.financing = fin.result.route; changed.push("financing"); }
    if (qualification.financing_check !== fin.result.outcome) { qualification.financing_check = fin.result.outcome; changed.push("financing_check"); }
  }
  const prefId = data.qualification_updates?.preferred_project_id;
  const scopeProject = ctx.projects.find((x) => x.id === prefId) || ctx.projects.find((x) => x.id === ctx.lead?.primary_project_id);
  const priceFrom = scopeProject ? Math.min(...[...scopeProject.prices.filter((x) => x.fresh).map((x) => Number(x.price_myr)), ...scopeProject.websitePrices].filter(Boolean)) : null;
  const wantsAppt = !!data.appointment_request?.wanted;
  const scored = scoreLead({ ...qualification, project_price_from: isFinite(priceFrom) ? priceFrom : null }, {
    replies: history.filter((h) => h.role !== "assistant").length + 1,
    asked_price: qualification.signals.asked_price, requested_brochure: qualification.signals.requested_brochure,
    appointment_requested: wantsAppt || (ctx.lead?.open_appointments || []).length > 0,
    appointment_confirmed: (ctx.lead?.open_appointments || []).some((a) => a.status === "confirmed"),
  }, settings.scoring);
  if (changed.length || ctx.lead) actions.push({ type: "update_qualification", qualification, changed, score: scored.score, temperature: scored.temperature, rationale: scored.rationale });
  if (prefId && ctx.projects.some((x) => x.id === prefId)) actions.push({ type: "add_interest", project_id: prefId });
  // RMK pipeline: enrol on a clear confirmation; move on one stage only from the stage the buyer is at
  if (data.rmk?.interest === "confirmed" && !ctx.rmk && p.leadId) actions.push({ type: "rmk_enroll", source: "whatsapp" });
  if (ctx.rmk && data.rmk?.stage_done && data.rmk.stage_done === ctx.rmk.stage && ctx.rmk.stage !== "all_signed") actions.push({ type: "rmk_advance", from: ctx.rmk.stage });
  if (fin && finChanged.length) {
    const res = fin.result, isNew = isNewAssessment(res, finSaved?.result);
    actions.push({ type: "save_financing", inputs: fin.inputs, result: res, changed: finChanged, new_assessment: isNew, profile_id: finSaved?.id || null });
    const before = new Set(finSaved?.result?.escalate || []);
    const fresh = (res?.escalate || []).filter((x) => !before.has(x));
    if (isNew && fresh.length && decision === "reply" && !actions.some((a) => a.type === "handover")) {
      actions.push({ type: "handover", reason: "financing", summary: advisorSummary(res, fin.inputs), next_action: "Review the preliminary financing check and contact the buyer for a full assessment." });
    }
  }
  const pending = (ctx.lead?.open_appointments || []).find((a) => a.status === "pending_confirmation");
  const slot = (ctx.slots || []).find((x) => x.id === data.appointment_request?.slot_id); // only slots we offered count
  if (wantsAppt && (slot || !pending)) {
    actions.push({ type: "request_appointment", kind: data.appointment_request.kind || "showroom_visit", preferred_text: data.appointment_request.preferred_text || slot?.label_ms || null,
      project_id: ctx.projects.some((x) => x.id === data.appointment_request.project_id) ? data.appointment_request.project_id : (scopeProject?.id || null),
      ...(slot ? { slot_id: slot.id, start_at: slot.start, end_at: slot.end, appointment_id: pending?.id || null } : {}) });
  }
  if (decision !== "reply") actions.push({ type: "cancel_follow_ups", reason: "conversation needs a human" });

  return finish({
    decision, reply, draft: data.reply, language: data.language, intent: data.intent, agent: data.agent, confidence: Number(data.confidence),
    facts_used: data.facts_used || [], objection_key: data.objection_key || null, violations: check.violations, actions,
    qualification, score: scored.score, temperature: scored.temperature,
    ...(fin ? { financing: { inputs: fin.inputs, result: fin.result, recalculated } } : {}),
    // which project the reply was about and what its information lacked, so a hand-over can be traced to a data gap
    retrieval: retrievalTrace(ctx),
  });
}

/**
 * Applies a result's actions to the CRM (live channels). `db` needs get/post/patch.
 * Every write is idempotent or keyed so a redelivered message cannot duplicate records.
 */
export async function applyActions(db, { leadId, contactId, result, conversationId = null, runId = null }) {
  const done = [];
  for (const a of result.actions || []) {
    if (a.type === "record_consent") {
      await db.post("ai_consent_records", { contact_id: contactId, channel: a.channel, purpose: a.purpose, status: a.status, source: "whatsapp_stop", evidence: a.evidence });
    } else if (a.type === "pause_ai") {
      await db.patch(`ai_leads?id=eq.${encodeURIComponent(leadId)}`, { ai_paused: true });
      if (conversationId) await db.patch(`ai_conversations?id=eq.${encodeURIComponent(conversationId)}`, { mode: "human" });
    } else if (a.type === "cancel_follow_ups") {
      await db.patch(`ai_follow_up_jobs?lead_id=eq.${encodeURIComponent(leadId)}&status=eq.scheduled`, { status: "cancelled", reason: a.reason });
      await db.patch(`ai_automation_jobs?lead_id=eq.${encodeURIComponent(leadId)}&status=eq.scheduled&kind=eq.smart_follow_up`, { status: "cancelled", reason: a.reason });
    } else if (a.type === "handover") {
      await db.post("ai_handover_events", { lead_id: leadId, conversation_id: conversationId, reason: a.reason, summary: { text: a.summary, next_action: a.next_action, source: "ai", agent_run_id: runId } });
      await db.patch(`ai_leads?id=eq.${encodeURIComponent(leadId)}`, { handover_status: "requested" });
    } else if (a.type === "update_qualification") {
      await db.patch(`ai_leads?id=eq.${encodeURIComponent(leadId)}`, { qualification: a.qualification, score: a.score, temperature: a.temperature, score_rationale: a.rationale });
    } else if (a.type === "save_financing") {
      const row = { route: a.result?.route || null, inputs: a.inputs, result: a.result, outcome: a.result?.outcome || null, source: "ai", updated_by: "ai" };
      const existing = a.profile_id ? [{ id: a.profile_id }] : await db.get(`ai_financing_profiles?lead_id=eq.${encodeURIComponent(leadId)}&select=id`);
      if (existing?.[0]) await db.patch(`ai_financing_profiles?id=eq.${encodeURIComponent(existing[0].id)}`, row);
      else await db.post("ai_financing_profiles?on_conflict=lead_id", { lead_id: leadId, ...row }, { prefer: "resolution=ignore-duplicates" });
      if (a.new_assessment && a.result?.route) {
        await db.post("ai_financing_assessments", { lead_id: leadId, route: a.result.route, inputs: a.inputs, result: a.result, outcome: a.result.outcome,
          rules_version: a.result.rules_version || null, engine_version: a.result.engine_version || null, source: "ai", created_by: "ai" });
      }
    } else if (a.type === "rmk_enroll") {
      await db.rpc("ai_rmk_enroll", { p_lead: leadId, p_source: a.source || "whatsapp", p_by: "ai" });
    } else if (a.type === "rmk_advance") {
      await db.rpc("ai_rmk_advance", { p_lead: leadId, p_from: a.from, p_by: "ai", p_via: "ai" });
    } else if (a.type === "add_interest") {
      await db.post("ai_lead_interests?on_conflict=lead_id,project_id", { lead_id: leadId, project_id: a.project_id, interest: "interested" }, { prefer: "resolution=ignore-duplicates" });
    } else if (a.type === "request_appointment") {
      // stays pending until the calendar booking succeeds or an advisor confirms; the key stops duplicates from redelivered messages
      const slot = a.start_at ? { start_at: a.start_at, end_at: a.end_at } : {};
      if (a.appointment_id) {
        await db.patch(`ai_appointments?id=eq.${encodeURIComponent(a.appointment_id)}&status=eq.pending_confirmation`, { kind: a.kind, preferred_text: a.preferred_text, ...slot });
        done.appointment = { id: a.appointment_id, slot: !!a.start_at };
      } else {
        const key = `ai-request:${leadId}:${runId || Date.now()}`;
        await db.post("ai_appointments?on_conflict=idempotency_key", { lead_id: leadId, kind: a.kind, project_id: a.project_id, preferred_text: a.preferred_text, status: "pending_confirmation", calendar_provider: null, idempotency_key: key, created_by: "ai", ...slot }, { prefer: "resolution=ignore-duplicates" });
        done.appointment = { key, slot: !!a.start_at };
      }
    } else continue;
    done.push(a.type);
  }
  return done;
}

/** Records the run in ai_agent_runs (needs the service-role adapter). Returns the run id, or null. */
export async function logRun(db, { result, leadId = null, conversationId = null, channel = "simulate", input = {} }) {
  try {
    const rows = await db.post("ai_agent_runs", {
      lead_id: leadId, conversation_id: conversationId, agent: result.agent || "orchestrator", intent: result.intent || null, model: result.model,
      input: { channel, message: result.message, ...input },
      // financing figures stay in the access-controlled financing tables, not in the run log
      output: { reply: result.reply, draft: result.draft, attempts: result.attempts, retrieval: result.retrieval || null,
        actions: (result.actions || []).map((a) => (a.type === "save_financing" ? { type: a.type, changed: a.changed, outcome: a.result?.outcome || null, new_assessment: a.new_assessment } : a)) },
      confidence: isFinite(result.confidence) ? Math.max(0, Math.min(1, result.confidence)) : null, decision: result.decision,
      validation: { ok: !(result.violations || []).length, violations: result.violations }, input_tokens: result.usage?.input_tokens ?? null,
      output_tokens: result.usage?.output_tokens ?? null, latency_ms: result.latency_ms, error: result.error || null,
    }, { prefer: "return=representation" });
    return Array.isArray(rows) && rows[0] ? rows[0].id : null;
  } catch { return null; }
}

/**
 * Writes one AI follow-up for a buyer who has gone quiet (inside the 24-hour window only).
 * Same context, rules and business-rule checker as replies; returns { reply, model, usage } or { skipped, violations? }.
 */
export async function composeFollowUp(p) {
  const now = p.now || new Date();
  const history = p.history || [];
  const ctx = await loadContext(p.db, { leadId: p.leadId, message: p.instruction, history, now });
  if (ctx.aiPaused) return { skipped: "AI is paused for this lead" };
  const settings = ctx.settings || {};
  const model = settings.ai?.model || DEFAULT_MODEL;
  if (p.reserve) {
    let quota;
    try { quota = await p.reserve(); } catch (e) { quota = { allowed: false, error: e?.message || String(e) }; }
    if (!quota?.allowed) return { skipped: quota?.error ? "AI usage could not be checked" : `daily AI limit (${quota.cap}) reached` };
  }
  const system = buildSystemPrompt(settings, ctx.objections);
  const contextText = renderContext(ctx);
  let feedback = null, check = null, usage = { input_tokens: 0, output_tokens: 0 }, served = model;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await p.llm({ system, messages: buildMessages(history, contextText, "", feedback, { task: p.instruction }), schema: REPLY_SCHEMA, model, effort: settings.ai?.effort || "low" });
    const data = normalizeReply(r.data); served = r.model || model;
    usage.input_tokens += r.usage?.input_tokens || 0; usage.output_tokens += r.usage?.output_tokens || 0;
    if (data.handover?.needed) return { skipped: "the AI judged that a person should follow up", usage, model: served };
    check = validateReply(data.reply, ctx.rules);
    if (check.ok) return { reply: data.reply, language: data.language, usage, model: served };
    feedback = summariseViolations(check.violations);
  }
  return { skipped: "the follow-up draft failed the business-rule check", violations: check?.violations || [], usage, model: served };
}
