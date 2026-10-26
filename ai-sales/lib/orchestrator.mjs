// Central orchestrator for one buyer message:
//   guards (opt-out, human request) -> verified context -> AI draft -> business-rule validation
//   (one corrected retry) -> decision (reply / handover / blocked / opt_out / paused / error) -> proposed CRM actions.
// In "simulate" mode nothing is written; applyActions() performs the writes for live channels (Phase 4).
import { isOptOut, wantsHuman, detectLanguage, fixedReply } from "../../sales/shared/guard.mjs";
import { validateReply } from "../../sales/shared/validator.mjs";
import { scoreLead } from "../../sales/shared/scoring.mjs";
import { loadContext } from "./context.mjs";
import { buildSystemPrompt, renderContext, buildMessages, REPLY_SCHEMA } from "./prompt.mjs";
import { DEFAULT_MODEL, LlmError } from "./llm.mjs";

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
  const system = buildSystemPrompt(settings, ctx.objections);
  const contextText = renderContext(ctx);

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

  // 4) AI draft + validation, with one corrected retry
  let data = null, check = null, feedback = null, usage = { input_tokens: 0, output_tokens: 0 }, servedBy = null;
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await p.llm({ system, messages: buildMessages(history, contextText, message, feedback), schema: REPLY_SCHEMA, model, effort });
      data = r.data; servedBy = r.model || model;
      usage.input_tokens += r.usage?.input_tokens || 0; usage.output_tokens += r.usage?.output_tokens || 0;
      check = validateReply(data.reply, ctx.rules);
      base.attempts.push({ attempt, reply: data.reply, violations: check.violations });
      if (check.ok) break;
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
  if (wantsAppt && !(ctx.lead?.open_appointments || []).some((a) => a.status === "pending_confirmation")) {
    actions.push({ type: "request_appointment", kind: data.appointment_request.kind || "showroom_visit", preferred_text: data.appointment_request.preferred_text || null,
      project_id: ctx.projects.some((x) => x.id === data.appointment_request.project_id) ? data.appointment_request.project_id : (scopeProject?.id || null) });
  }
  if (decision !== "reply") actions.push({ type: "cancel_follow_ups", reason: "conversation needs a human" });

  return finish({
    decision, reply, draft: data.reply, language: data.language, intent: data.intent, agent: data.agent, confidence: Number(data.confidence),
    facts_used: data.facts_used || [], objection_key: data.objection_key || null, violations: check.violations, actions,
    qualification, score: scored.score, temperature: scored.temperature,
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
    } else if (a.type === "handover") {
      await db.post("ai_handover_events", { lead_id: leadId, conversation_id: conversationId, reason: a.reason, summary: { text: a.summary, next_action: a.next_action, source: "ai", agent_run_id: runId } });
      await db.patch(`ai_leads?id=eq.${encodeURIComponent(leadId)}`, { handover_status: "requested" });
    } else if (a.type === "update_qualification") {
      await db.patch(`ai_leads?id=eq.${encodeURIComponent(leadId)}`, { qualification: a.qualification, score: a.score, temperature: a.temperature, score_rationale: a.rationale });
    } else if (a.type === "add_interest") {
      await db.post("ai_lead_interests?on_conflict=lead_id,project_id", { lead_id: leadId, project_id: a.project_id, interest: "interested" }, { prefer: "resolution=ignore-duplicates" });
    } else if (a.type === "request_appointment") {
      // pending until the calendar (Phase 4) or an advisor confirms; the key stops duplicates from redelivered messages
      await db.post("ai_appointments?on_conflict=idempotency_key", { lead_id: leadId, kind: a.kind, project_id: a.project_id, preferred_text: a.preferred_text, status: "pending_confirmation", calendar_provider: null, idempotency_key: `ai-request:${leadId}:${runId || Date.now()}`, created_by: "ai" }, { prefer: "resolution=ignore-duplicates" });
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
      input: { channel, message: result.message, ...input }, output: { reply: result.reply, draft: result.draft, actions: result.actions, attempts: result.attempts },
      confidence: isFinite(result.confidence) ? Math.max(0, Math.min(1, result.confidence)) : null, decision: result.decision,
      validation: { ok: !(result.violations || []).length, violations: result.violations }, input_tokens: result.usage?.input_tokens ?? null,
      output_tokens: result.usage?.output_tokens ?? null, latency_ms: result.latency_ms, error: result.error || null,
    }, { prefer: "return=representation" });
    return Array.isArray(rows) && rows[0] ? rows[0].id : null;
  } catch { return null; }
}
