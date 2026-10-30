// Central orchestrator for one buyer message:
//   guards (opt-out, human request) -> verified context -> AI draft -> business-rule validation
//   (one corrected retry) -> decision (reply / handover / blocked / opt_out / paused / error) -> proposed CRM actions.
// In "simulate" mode nothing is written; applyActions() performs the writes for live channels (Phase 4).
import { isOptOut, wantsHuman, detectLanguage, fixedReply, languagePreference, requestedLanguage } from "../../sales/shared/guard.mjs";
import { validateReply } from "../../sales/shared/validator.mjs";
import { scoreLead } from "../../sales/shared/scoring.mjs";
import { loadContext } from "./context.mjs";
import { buildSystemPrompt, renderContext, buildMessages, REPLY_SCHEMA, REPLY_SCHEMA_SINGLE, normalizeReply } from "./prompt.mjs";
import { DEFAULT_MODEL, LlmError } from "./llm.mjs";
import { applyInsights } from "./insights.mjs";
import { routeLookups, webResearch, shouldResearch, renderLookup } from "./research.mjs";
import { nextDiscovery, readDiscoveryAnswer } from "./discovery.mjs";
import { extractDistances, extractMinutes } from "../../sales/shared/validator.mjs";
import { mergeFinancing, attachFinancing, renderFinancing, cleanInputs, isNewAssessment, advisorSummary } from "./financing.mjs";
import { addressFor, parseTitlePreference, fixSalutation } from "../../sales/shared/salutation.mjs";
import { limitEmojis, emojiAllowance } from "../../sales/shared/emoji.mjs";

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

/**
 * One reply call. If the API refuses the schema (kind "schema"), it is retried once with the single-text schema that
 * is known to work, and `base.degraded` records it, so the buyer still gets an AI reply (as one message) and the run
 * log says why. Later calls for the same message go straight to that schema. Any other error is thrown as is.
 */
async function callReply(llm, params, base) {
  if (base.degraded) return llm({ ...params, schema: REPLY_SCHEMA_SINGLE });
  try { return await llm({ ...params, schema: REPLY_SCHEMA }); }
  catch (e) {
    if (!(e instanceof LlmError) || e.kind !== "schema") throw e;
    base.degraded = `Sent as one message: the multi-message schema was refused (${e.message}).`;
    return await llm({ ...params, schema: REPLY_SCHEMA_SINGLE });
  }
}

// Readability rules for one WhatsApp message (owner's style: at most 3 short paragraphs, short lists, about 20–60
// words, more only when needed) and for the whole turn (about 80 words in all; no monthly instalment the buyer did
// not ask for). Unlike the business rules they never block a reply: a draft that breaks them is rewritten once with
// the feedback, and if the rewrite still slightly breaks them it is sent as it is.
export const STYLE = { maxParagraphs: 3, maxParagraphWords: 40, maxBullets: 5, maxMessageWords: 65, maxTurnWords: 80 };
// "Short chat" (Settings → AI persona → Reply style, owner's choice 30 Oct): up to 3 messages of about 7–10 words —
// answer first, then a short explanation, then one more detail or a question. 15 words at most per message; the AI
// introduction on the first reply and a required note (indicative price, loan illustration) may add a few words.
// (one line per message, so only the message's length is checked, not its paragraphs')
export const STYLE_SHORT = { maxParagraphs: 2, maxParagraphWords: Infinity, maxBullets: 3, maxMessageWords: 15, maxTurnWords: 45, targetWords: "7–10", introWords: 8, noteWords: 6, short: true };
// "Adaptive" (master prompt v2): usually 20–60 words a reply, up to about 100 for a detailed answer, 1–3 messages
export const STYLE_ADAPTIVE = { maxParagraphs: 3, maxParagraphWords: 45, maxBullets: 5, maxMessageWords: 60, maxTurnWords: 100, targetWords: "20–60", adaptive: true };
export const styleFor = (persona) => (persona?.reply_style === "short" ? STYLE_SHORT : persona?.reply_style === "adaptive" ? STYLE_ADAPTIVE : STYLE);
// required wording that may make a short message longer: the AI introduction and the price / loan notes
const INTRO = /\b(pembantu AI|AI assistant|asisten AI)\b/i;
const extraWords = (style, text) => (style.short ? (INTRO.test(text) ? style.introWords : 0) + (NOTE.test(text) ? style.noteWords : 0) : 0);
const NOTE = /(anggaran|indicative|disahkan|confirmed at booking|final price|harga akhir|ilustrasi|illustration|bukan tawaran|not a loan offer|\d+(\.\d+)?%|tahun|years)/i;
export const STYLE_CODES = new Set(["too_long", "too_many_paragraphs", "long_paragraph", "long_list", "long_message", "long_turn", "unasked_instalment"]);
const BULLET = /^\s*(?:[•*\-–]|\d{1,2}[.)])\s+/;
// words only: bullet marks and dashes ("•", "–") are not words
const wordCount = (t) => (String(t).match(/\S*[\p{L}\p{N}]\S*/gu) || []).length;
// the buyer asking about monthly payments or financing (BM, English, Manglish)
export const MONTHLY_Q = /(bulanan|sebulan|\bbulan\b|ansuran|monthly|per\s+month|a\s+month|instal+ments?|\bloan|pinjaman|pembiayaan|financing|lppsa|\bgaji\b|salary|income|deposit|down\s*payment|\bdp\b|kelayakan|layak|eligib|afford|mampu|komitmen|commitment)/i;
// a monthly instalment figure in the reply
const MONTHLY_FIGURE = /(ansuran|instal+ment|RM\s?[\d,.]+\s*(?:k\b)?\s*(?:\/\s*(?:month|mth|mo|bulan|bln)\b|sebulan|a\s+month|per\s+month|monthly|bulanan))/i;

/** Style problems of one message: [{ code, detail }] */
export function messageStyle(text, i = 1, style = STYLE) {
  const out = [], paras = String(text || "").split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  if (paras.length > style.maxParagraphs) out.push({ code: "too_many_paragraphs", detail: `Message ${i} has ${paras.length} paragraphs; use at most ${style.maxParagraphs} short ones (move extra detail to the next message, or leave it out).` });
  paras.forEach((p, j) => {
    const lines = p.split("\n"), bullets = lines.filter((l) => BULLET.test(l));
    if (bullets.length > style.maxBullets) out.push({ code: "long_list", detail: `Message ${i}, paragraph ${j + 1} lists ${bullets.length} points; keep to the ${style.maxBullets} that matter most.` });
    const prose = bullets.length >= 2 ? lines.filter((l) => !BULLET.test(l)).join(" ") : p;
    if (wordCount(prose) > style.maxParagraphWords) out.push({ code: "long_paragraph", detail: `Message ${i}, paragraph ${j + 1} is ${wordCount(prose)} words; keep each paragraph to one idea in 1–3 short sentences.` });
  });
  const n = wordCount(text);
  const limit = style.maxMessageWords + extraWords(style, text);
  if (n > limit) out.push({ code: "long_message", detail: style.short
    ? `Message ${i} is ${n} words; keep each message to one short line of about ${style.targetWords} words (at most ${limit}). Move the rest to the next message (3 at most), or leave it out.`
    : `Message ${i} is ${n} words; aim for about 20–60 words per message.` });
  return out;
}

/**
 * The check for a whole turn. Business rules run on all its messages together (one turn, one set of facts) and
 * block a reply that breaks them (hardOk false); readability rules run per message and only ask for a rewrite.
 * ok: nothing to fix. hardOk: safe to send. styleNotes: the readability problems found.
 */
export function checkTurn(data, rules = {}) {
  const check = validateReply(data.reply, { ...rules, maxChars: 0 });
  const list = data.messages || [data.reply];
  const max = rules.maxChars, long = max ? list.map((m, i) => [i + 1, m.length]).filter(([, n]) => n > max) : [];
  if (long.length) check.violations.push({ code: "too_long", detail: long.map(([i, n]) => `Message ${i} is ${n} characters; the limit is ${max} per message.`).join(" ") });
  // a stray fragment ("x", "ok", a lone emoji) is never a WhatsApp message of its own; a reply needs some words
  const words = (m) => (String(m).match(/\p{L}{2,}/gu) || []).length;
  const frags = list.map((m, i) => [i + 1, m]).filter(([, m]) => (list.length > 1 ? words(m) < 3 : words(m) < 1));
  if (frags.length) check.violations.push({ code: "fragment", detail: frags.map(([i, m]) => `Message ${i} ("${String(m).slice(0, 20)}") is not a complete message; fold it into another message or remove it.`).join(" ") });
  const style = rules.style || STYLE;
  list.forEach((m, i) => check.violations.push(...messageStyle(m, i + 1, style)));
  const total = list.reduce((n, m) => n + wordCount(m), 0);
  const turnMax = style.maxTurnWords + extraWords(style, list.join(" "));
  if (total > turnMax) check.violations.push({ code: "long_turn", detail: `The whole reply is ${total} words${list.length > 1 ? ` across ${list.length} messages` : ""}; keep the whole turn to about ${turnMax} words: answer what was asked and leave out the rest.` });
  // rules.buyerAskedMonthly is set for replies to a buyer (false = they have not asked about monthly payments or loans)
  if (rules.buyerAskedMonthly === false && MONTHLY_FIGURE.test(data.reply || list.join("\n\n"))) check.violations.push({ code: "unasked_instalment", detail: "The buyer did not ask about monthly payments or loans: leave out the monthly instalment (and its assumptions). You may offer it in a short question instead, e.g. \"Nak saya kira anggaran bulanan?\"" });
  const styleNotes = check.violations.filter((v) => STYLE_CODES.has(v.code));
  return { ok: check.violations.length === 0, hardOk: check.violations.length === styleNotes.length, violations: check.violations, styleNotes };
}

/** What was looked up for this reply (shown in the test console and kept in the run log); no coordinates. */
function researchTrace(ctx, routes) {
  const t = {};
  if (routes) t.maps = { lookups: (routes.lookups || []).map(renderLookup), ...(routes.missing_place ? { ask_for: routes.missing_place } : {}), ...(routes.error ? { error: routes.error } : {}) };
  if (ctx.externalResearch) t.web = { question: ctx.externalResearch.question, found: !!ctx.externalResearch.found, sources: ctx.externalResearch.sources, searches: ctx.externalResearch.searches, ...(ctx.externalResearch.error ? { error: ctx.externalResearch.error } : {}) };
  return Object.keys(t).length ? t : null;
}

/**
 * The last checks on an AI reply's text before it is sent, in code (no AI call): a wrong title before the buyer's name
 * is replaced by the right address (Smart Salutation), and emojis are kept to one per turn, none in serious replies.
 */
export function finalTouches(messages, { decision = "reply", data = {}, ctx = {}, financing = false } = {}) {
  const adjustments = [];
  const addr = ctx.buyer?.address;
  let out = (messages || []).map((m) => {
    if (!addr) return m;
    const f = fixSalutation(m, addr, data.language === "en" ? "en" : "ms");
    adjustments.push(...f.fixed.map((x) => `salutation: ${x}`));
    return f.text;
  });
  const max = emojiAllowance({ decision, intent: data.intent, objectionKey: data.objection_key, financing });
  const e = limitEmojis(out, { max });
  if (e.removed) adjustments.push(`emojis: ${e.removed} removed (at most ${max} in this reply)`);
  out = e.messages.filter((m) => m && /\p{L}/u.test(m));
  return { messages: out.length ? out : messages, adjustments };
}

const summariseViolations = (vs) => vs.map((v) => `- ${v.code}: ${v.detail}`).join("\n");

/**
 * @param {object} p { db, llm, reserve?, leadId, message, history, now, mode: "simulate" | "live", budgetMs?, deferWeb? }
 *   reserve(): Promise<{allowed, used, cap}> — books one AI reply against the daily cap
 *   budgetMs: time this call may take in all (Netlify ends a request at 30 s). Each AI call is cut off at the end of
 *     the budget, and an optional second AI call (a style rewrite, a recalculation, web research) is only made when
 *     there is time for it.
 *   deferWeb: don't run web research here; return `pending_research` so the caller runs it as a separate step
 */
export async function respond(p) {
  const t0 = p._t0 || Date.now(); // a second pass after web research keeps the original start
  const deadline = p.budgetMs ? t0 + p.budgetMs : null;
  const left = () => (deadline ? deadline - Date.now() : Infinity);
  // where the time went (shown to managers in the test console and kept in the run log)
  const timings = { ...(p._timings || {}) };
  const clock = async (key, fn) => { const s0 = Date.now(); try { return await fn(); } finally { timings[key] = (timings[key] || 0) + (Date.now() - s0); } };
  const now = p.now || new Date();
  const message = String(p.message || "").trim();
  const history = p.history || [];
  const base = { message, actions: [], attempts: [], violations: [], model: null, usage: null };
  // every result carries `messages` (what would be sent, in order); fixed replies are one message
  const finish = (r) => ({ ...base, ...r, messages: r.messages || (r.reply ? [r.reply] : []), latency_ms: Date.now() - t0, timings: { ...timings, total_ms: Date.now() - t0 } });

  if (!message) return finish({ decision: "ignored", reply: null, reason: "empty message" });

  // 1) deterministic guards — honoured regardless of the AI
  // a language the buyer explicitly asked for (now or earlier in the chat) beats a guess from the words they used
  const askedLang = languagePreference(message, history);
  const guessLang = askedLang || detectLanguage(message);
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
  const ctx = await clock("context_ms", () => loadContext(p.db, { leadId: p.leadId, message, history, now }));
  if (askedLang) ctx.buyer = { ...(ctx.buyer || {}), language_requested: askedLang };
  // the buyer says how to be addressed in this message ("call me Mr Tan", "panggil saya Puan"): used from this reply on
  const titlePref = parseTitlePreference(message);
  if (titlePref && ctx.buyer) ctx.buyer.address = addressFor({ full_name: titlePref.name || ctx.buyer.name, salutation: titlePref.salutation, gender: titlePref.gender, salutation_source: "customer" });
  // the buyer's answer to the name / area question the AI just asked: saved now (not only by the later insights call),
  // so this reply already uses it and the question is never asked again
  const lastAiText = [...(history || [])].reverse().find((h) => h.role === "assistant")?.text || "";
  const profileAnswers = ctx.buyer ? readDiscoveryAnswer({ message, lastAiText, buyerName: ctx.buyer.name, known: ctx.clientProfile?.known }) : [];
  if (profileAnswers.length) {
    ctx.clientProfile = ctx.clientProfile || { known: {} };
    ctx.clientProfile.known = { ...(ctx.clientProfile.known || {}) };
    for (const a of profileAnswers) ctx.clientProfile.known[a.field] = { value: a.value, status: "confirmed" };
    const pn = profileAnswers.find((a) => a.field === "preferred_name");
    const contact = titlePref ? { full_name: titlePref.name || ctx.buyer.name, salutation: titlePref.salutation, gender: titlePref.gender, salutation_source: "customer" } : (ctx.contact || { full_name: ctx.buyer.name });
    if (pn) ctx.buyer.address = addressFor(contact, { preferredName: pn.value });
  }
  if (ctx.buyer?.address) ctx.buyer.name_status = ctx.buyer.address.name_status;
  // the owner's discovery order: the next question worth asking, from what the CRM already knows
  ctx.discovery = nextDiscovery({ known: ctx.clientProfile?.known, buyerName: ctx.buyer?.name, appointments: (ctx.lead?.open_appointments || []).length,
    message, readiness: ctx.lead?.qualification_known?.readiness,
    aiReplies: (history || []).filter((h) => h.role === "assistant").length, projectInFocus: (ctx.projects || []).some((x) => x.inFocus) });
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
  // research tools (p.research: { maps, research, web }): Google Maps for distance questions; web research is decided
  // after the first draft (below). Switches in Settings → AI: maps_distances, web_research (both on unless false).
  const R = p.research || null;
  const mapsOn = !!R?.maps?.configured && settings.ai?.maps_distances !== false;
  const found = p._prior || {};
  const routes = found.routes !== undefined ? found.routes
    // a map lookup needs a planning call and the map requests: only when the reply itself still has time after it
    : mapsOn && left() > 20000 ? await clock("maps_ms", () => routeLookups({ llm: p.llm, maps: R.maps, model, deadline: deadline ? Date.now() + Math.min(7000, left() - 14000) : null }, { message, history, projects: ctx.projects })) : null;
  ctx.routeLookups = routes?.lookups || [];
  ctx.routeMissingPlace = routes?.missing_place || "";
  ctx.externalResearch = found.web?.found ? found.web : found.web ? { ...found.web, findings: "", sources: [] } : null;
  const system = buildSystemPrompt(settings, ctx.objections, { calendar: !!p.calendar, financing: finOn });
  let contextText = renderContext(ctx);
  // distances and travel times the reply may state: those in the context (listing, lookups, research) or the buyer's
  // own words; and whether a map or web check really happened for this reply
  const said = [message, ...history.filter((h) => h.role !== "assistant").map((h) => h.text)].join("\n");
  ctx.rules.allowedDistances = [...extractDistances(contextText), ...extractDistances(said)].map((d) => d.value);
  ctx.rules.allowedMinutes = [...extractMinutes(contextText), ...extractMinutes(said)].map((d) => d.value);
  ctx.rules.usedMaps = ctx.routeLookups.some((l) => l.routes?.length || l.straight_line_m != null);
  ctx.rules.usedWeb = !!found.web?.found;
  // stations whose distance the listing gives twice: no figure for them unless a map lookup measured it
  ctx.rules.disputedDistances = ctx.rules.usedMaps ? [] : ctx.projects.filter((x) => x.inFocus).flatMap((x) => x.distanceDisputes || []);
  // monthly figures only once the buyer has asked about monthly payments, loans or financing (now or recently)
  ctx.rules.style = styleFor(settings.persona); // the owner's reply style (standard or short chat)
  ctx.rules.buyerAskedMonthly = MONTHLY_Q.test([message, ...history.filter((h) => h.role !== "assistant").slice(-4).map((h) => h.text)].join("\n"));
  for (const l of ctx.routeLookups) if (l.maps_link) ctx.rules.allowedUrls.push(l.maps_link);

  // 3) daily cost cap: reserve one AI reply before calling the model (fail closed if usage can't be checked)
  if (p.reserve) {
    let quota;
    try { quota = await p.reserve(); } catch (e) { quota = { allowed: false, error: e?.message || String(e) }; }
    if (!quota?.allowed) {
      const lang = askedLang || (ctx.buyer?.preferred_language === "en" ? "en" : guessLang);
      const why = quota?.error ? `AI usage could not be checked (${quota.error})` : `the daily AI limit (${quota.cap}) has been reached`;
      return finish({
        decision: "capped", reply: fixedReply("safe_fallback", lang), language: lang, agent: "handover", confidence: null, quota,
        actions: [{ type: "handover", reason: "other", summary: `Not answered by the AI: ${why}. Buyer wrote: "${message.slice(0, 300)}"`, next_action: "Reply to the buyer personally." }],
      });
    }
    base.quota = quota;
  }

  // 4) AI draft + validation, with one corrected retry. When the buyer has just given new financing figures, the
  //    engine recalculates and the AI writes the reply again from the new result (at most one extra call).
  let data = null, check = null, feedback = null, usage = { input_tokens: 0, output_tokens: 0 }, servedBy = null;
  let finChanged = [], recalculated = false, retried = false, lastMs = 0;
  // another AI call only when it can finish inside the budget (the last call's time plus a margin)
  const timeForAnother = () => left() > lastMs * 1.15 + 2500;
  timings.ai_ms = timings.ai_ms || [];
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const s0 = Date.now();
      const r = await callReply(p.llm, { system, messages: buildMessages(history, contextText, message, feedback), model, effort, deadline }, base);
      lastMs = Date.now() - s0; timings.ai_ms.push(lastMs);
      data = normalizeReply(r.data); servedBy = r.model || model;
      usage.input_tokens += r.usage?.input_tokens || 0; usage.output_tokens += r.usage?.output_tokens || 0;
      if (finOn && !recalculated && timeForAnother()) {
        const m = mergeFinancing(ctx.financing.inputs, data.financing_updates);
        if (m.changed.length) {
          finChanged = m.changed; recalculated = true;
          attachFinancing(ctx, { inputs: m.inputs, saved: finSaved, recalculated: true });
          ctx.financingView = renderFinancing(ctx.financing);
          contextText = renderContext(ctx);
          base.attempts.push({ attempt, reply: data.reply, messages: data.messages, violations: [], recalculated: m.changed });
          continue;
        }
      }
      check = checkTurn(data, ctx.rules);
      base.attempts.push({ attempt, reply: data.reply, messages: data.messages, violations: check.violations });
      if (check.ok || retried) break;
      // no time to rewrite: a draft with only style notes is sent as it is; one that breaks a business rule is blocked
      if (!timeForAnother()) { base.rewrite_skipped = "not enough time left in this request for a rewrite"; break; }
      retried = true;
      feedback = summariseViolations(check.violations);
    }
  } catch (e) {
    if (e instanceof LlmError && e.kind === "config") throw e;
    const lang = askedLang || (ctx.buyer?.preferred_language === "en" ? "en" : guessLang);
    return finish({
      decision: "error", error: e.message, errorKind: e.kind || "error", reply: fixedReply("safe_fallback", lang), language: lang, agent: "handover", confidence: null,
      actions: [{ type: "handover", reason: e.kind === "refusal" ? "sensitive" : "low_confidence", summary: `The AI could not answer (${e.message}). Buyer wrote: "${message.slice(0, 300)}"`, next_action: "Reply to the buyer personally." }],
    });
  }
  base.model = servedBy; base.usage = usage;

  // 5) decision
  const actions = [];
  let decision = "reply", reply = data.reply;
  if (!check.hardOk) {
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
  // a person's entry is never overwritten here: the separate insights call records a different value as a conflict
  const qualUpdates = { ...(data.qualification_updates || {}) };
  for (const [k, v] of Object.entries(qualUpdates)) {
    if (ctx.profileMeta?.[k]?.source === "staff" && v !== null && v !== undefined && v !== "" && leadQual[k] !== v) {
      delete qualUpdates[k];
    }
  }
  const { qualification, changed } = mergeQualification(leadQual, qualUpdates);
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
  // follow-up workflows: join one offered on a clear confirmation; move on one stage only from the stage the buyer is at
  const wfKey = data.workflow?.key, inWf = (ctx.workflows || []).find((w) => w.workflow === wfKey);
  if (data.workflow?.interest === "confirmed" && !inWf && p.leadId && (ctx.workflowOffers || []).some((w) => w.workflow === wfKey)) actions.push({ type: "workflow_enroll", workflow: wfKey, source: "whatsapp" });
  if (inWf && data.workflow?.stage_done && data.workflow.stage_done === inWf.stage && inWf.current_step) actions.push({ type: "workflow_advance", workflow: wfKey, from: inWf.stage });
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
  // files the AI chose to send (only ones staff marked shareable and the context offered); sent after the reply
  if (decision === "reply") for (const id of data.send_files || []) {
    const f = (ctx.files || []).find((x) => x.id === id);
    if (f && !actions.some((a) => a.type === "send_file" && a.document_id === id)) actions.push({ type: "send_file", document_id: f.id, title: f.title, kind: f.kind, project_id: f.project_id });
  }
  if (titlePref && p.leadId) actions.push({ type: "set_salutation", salutation: titlePref.salutation, gender: titlePref.gender });
  if (profileAnswers.length && p.leadId) actions.push({ type: "set_profile", changes: profileAnswers });
  // remember a language the buyer asked for in this message, so later replies and follow-ups use it
  const askedNow = requestedLanguage(message);
  if (askedNow && askedNow !== ctx.buyer?.preferred_language) actions.push({ type: "set_language", language: askedNow });

  // separate WhatsApp messages only for a normal AI reply; a safe reply or a hand-over is one message
  const raw = decision === "reply" ? data.messages : [reply];
  const { messages, adjustments } = finalTouches(raw, { decision, data, ctx, financing: !!fin && /instal|ansuran|financ|pembiayaan|loan|lppsa/i.test(String(data.intent) + raw.join(" ")) });
  // the draft hands a factual question to an advisor because our data lacks it: research it once on the web and,
  // if something was found, write the reply again with the findings (no second daily-limit charge)
  const handoverReason = actions.find((a) => a.type === "handover")?.reason;
  const webOn = !!R?.research && R.web !== false && settings.ai?.web_research !== false;
  let pendingResearch = null;
  if (webOn && !found.web && shouldResearch({ decision, handoverReason, intent: data.intent })) {
    const focusNames = ctx.projects.filter((x) => x.inFocus).map((x) => x.name);
    const question = [history.filter((h) => h.role !== "assistant").slice(-1)[0]?.text, message].filter(Boolean).join("\n");
    const webMs = R.webTimeoutMs ?? 20000;
    // research and a second draft must both fit; otherwise the caller runs them as separate steps (test console), or
    // the hand-over stands (WhatsApp worker)
    if (p.deferWeb || left() < webMs + lastMs * 1.15 + 2500 || (!deadline && Date.now() - t0 >= (R.webStartWithinMs ?? 20000))) {
      pendingResearch = { question: question.slice(0, 600), projectNames: focusNames };
    } else {
      const web = await clock("web_ms", () => webResearch({ research: R.research, model, webTimeoutMs: webMs }, { question, projectNames: focusNames }));
      if (web?.found) return respond({ ...p, reserve: null, _t0: t0, _timings: timings, _prior: { routes: routes ?? null, web } });
      ctx.externalResearch = web; // nothing usable found: keep the hand-over, and show what was tried
    }
  }

  return finish({
    decision, reply: messages.join("\n\n"), messages, draft: data.reply, draft_messages: data.messages, language: data.language, intent: data.intent, agent: data.agent, confidence: Number(data.confidence),
    facts_used: data.facts_used || [], objection_key: data.objection_key || null, violations: check.violations, style_notes: check.styleNotes, actions,
    ...(adjustments.length ? { adjustments } : {}),
    qualification, score: scored.score, temperature: scored.temperature,
    ...(fin ? { financing: { inputs: fin.inputs, result: fin.result, recalculated } } : {}),
    // which project the reply was about and what its information lacked, so a hand-over can be traced to a data gap
    retrieval: retrievalTrace(ctx),
    research: researchTrace(ctx, routes),
    ...(pendingResearch ? { pending_research: pendingResearch } : {}),
  });
}

/**
 * Applies a result's actions to the CRM (live channels). `db` needs get/post/patch.
 * Every write is idempotent or keyed so a redelivered message cannot duplicate records.
 */
export async function applyActions(db, { leadId, contactId, result, conversationId = null, runId = null, messageId = null }) {
  const done = [];
  for (const a of result.actions || []) {
    if (a.type === "record_consent") {
      await db.post("ai_consent_records", { contact_id: contactId, channel: a.channel, purpose: a.purpose, status: a.status, source: "whatsapp_stop", evidence: a.evidence });
    } else if (a.type === "set_salutation") {
      // the buyer's own words: their title and (if it implies one) gender, marked as customer-confirmed. Before migration 20
      // the new columns do not exist: the title alone is saved then.
      if (contactId) {
        const path = `ai_contacts?id=eq.${encodeURIComponent(contactId)}`;
        try { await db.patch(path, { salutation: a.salutation, ...(a.gender ? { gender: a.gender } : {}), salutation_source: "customer", salutation_confidence: "confirmed" }); }
        catch { await db.patch(path, { salutation: a.salutation }); }
      }
    } else if (a.type === "set_profile") {
      // the buyer's own answer (name, area familiarity): an advisor's entry is never overwritten, the RPC flags a conflict
      try { await db.rpc("ai_lead_profile_set", { p_lead: leadId, p_changes: a.changes, p_source: "ai", p_message: messageId }); }
      catch { continue; }
    } else if (a.type === "set_language") {
      if (contactId) await db.patch(`ai_contacts?id=eq.${encodeURIComponent(contactId)}`, { preferred_language: a.language });
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
    } else if (a.type === "insights") {
      done.insights = await applyInsights(db, { leadId, insights: a.insights, messageId, buyerText: a.buyer_text });
    } else if (a.type === "workflow_enroll" || a.type === "workflow_advance") {
      const w = (await db.get(`ai_workflows?key=eq.${encodeURIComponent(a.workflow)}&status=eq.active&select=id`))?.[0];
      if (w && a.type === "workflow_enroll") await db.rpc("ai_wf_enroll", { p_wf: w.id, p_lead: leadId, p_source: a.source || "whatsapp", p_by: "ai" });
      if (w && a.type === "workflow_advance") await db.rpc("ai_wf_advance", { p_wf: w.id, p_lead: leadId, p_from: a.from, p_by: "ai", p_via: "ai" });
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
      output: { reply: result.reply, messages: result.messages || null, draft: result.draft, attempts: result.attempts, retrieval: result.retrieval || null, degraded: result.degraded || null, error_kind: result.errorKind || null,
        research: result.research || null, timings: result.timings || null,
        actions: (result.actions || []).map((a) => (a.type === "save_financing" ? { type: a.type, changed: a.changed, outcome: a.result?.outcome || null, new_assessment: a.new_assessment } : a)) },
      // confidence null = the model gave none (a fixed reply or a failed call)
      confidence: Number.isFinite(result.confidence) ? Math.max(0, Math.min(1, result.confidence)) : null, decision: result.decision,
      validation: { ok: !(result.violations || []).some((v) => !STYLE_CODES.has(v.code)), violations: result.violations }, input_tokens: result.usage?.input_tokens ?? null,
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
  ctx.rules.style = styleFor(ctx.settings?.persona);
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
    check = checkTurn(data, ctx.rules);
    if (check.ok || (attempt === 2 && check.hardOk)) return { reply: finalTouches([data.reply], { data, ctx }).messages.join("\n\n"), language: data.language, usage, model: served };
    feedback = summariseViolations(check.violations);
  }
  return { skipped: "the follow-up draft failed the business-rule check", violations: check?.violations || [], usage, model: served };
}
