// Phase 3 — AI pipeline tests with a fake database and scripted AI replies (no API key or network needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isOptOut, wantsHuman, detectLanguage } from "../../../sales/shared/guard.mjs";
import { validateReply, extractAmounts } from "../../../sales/shared/validator.mjs";
import { buildMessages, buildSystemPrompt, REPLY_SCHEMA, normalizeReply } from "../../lib/prompt.mjs";
import { loadContext, buyerAmounts, searchQuery } from "../../lib/context.mjs";
import { respond, applyActions, mergeQualification, logRun } from "../../lib/orchestrator.mjs";
import { callClaude, LlmError } from "../../lib/llm.mjs";

const NOW = new Date("2026-10-27T03:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 864e5).toISOString();

/* ---------- TEST FIXTURES ONLY: an in-memory stand-in for the database ---------- */
function fakeDb(over = {}) {
  const t = {
    ai_settings: [{ id: 1, persona: { name: "OSC Property Assistant", allow_manglish: true }, ai: { confidence_threshold: 0.7, max_reply_chars: 700 }, business: { price_max_age_days: 30, inventory_max_age_hours: 72 }, scoring: {}, compliance: {} }],
    ai_objections: [{ key: "price_too_high", examples: ["Harga mahal"], guidance_en: "Acknowledge…", escalate: false }],
    settings: [{ data: { wa: "60123456789" } }],
    projects: [
      { id: "t1", slug: "test-residence", data: { n: "Test Residence", l: "Cheras", d: "Test Dev", t: "Condominium", s: "New Launch", tenure: "Freehold", year: "2028", types: [{ name: "Type A", size: "800", beds: "3", baths: "2", price: "RM450,000" }], facilities: ["Swimming pool"], brochure: "https://example.test/brochure.pdf" } },
      { id: "t2", slug: "test-heights", data: { n: "Test Heights", l: "Setapak", types: [{ name: "Type B", price: "RM380,000" }],
        // same shape as the live listings: near mixes lists, objects and strings
        near: { transit: [{ n: "MRT Taman Connaught", d: "800m", t: "MRT", ok: true }], schools: [], tod: "", todName: "", concl: { ai: true, ok: false, text: "" }, pop: { cov: "District(s)", catch: "Cheras" } } } },
    ],
    ai_project_facts: [{ project_id: "t1", booking_fee: "RM1,000", showroom_hours: "10am–6pm daily", maintenance_fee_psf: 0.35, verified_at: daysAgo(3), official_url: "https://dev.example.test/residence" }],
    ai_project_prices: [{ project_id: "t1", unit_type: "Type A", price_kind: "list", price_myr: 465000, effective_from: "2026-10-01", verified_at: daysAgo(5) },
                        { project_id: "t2", unit_type: "Type B", price_kind: "list", price_myr: 390000, effective_from: "2026-06-01", verified_at: daysAgo(90) }],
    ai_project_units: [{ project_id: "t1", unit_type: "Type A", status: "available", status_verified_at: daysAgo(1), list_price: 465000 }],
    ai_active_promotions: [],
    ai_leads: [], ai_lead_interests: [], ai_appointments: [],
    ...over,
  };
  const writes = [];
  return {
    writes,
    get: async (path) => { const name = path.split("?")[0]; return structuredClone(t[name] || []); },
    rpc: async (name, args) => (name === "ai_search_knowledge" ? (over.__kb || []) : []),
    post: async (path, body) => { writes.push({ op: "post", path, body }); return [{ id: "run-1" }]; },
    patch: async (path, body) => { writes.push({ op: "patch", path, body }); return null; },
  };
}

const draft = (o = {}) => ({
  reply: "Hai! Saya pembantu AI One Stop Centre. Harga terkini Type A di Test Residence ialah RM465,000. Tuan/puan cari untuk didiami atau pelaburan?",
  language: "ms", intent: "price", agent: "knowledge", confidence: 0.9, facts_used: ["price:t1:Type A"],
  // "unknown" placeholders exactly as the schema makes the model send them
  qualification_updates: { purpose: "", first_home: "", bedrooms: "", size_sqft: "", budget_min: 0, budget_max: 0, employment: "", financing: "", timeline_months: 0, readiness: "", concerns: "", preferred_project_id: "t1", asked_price: true, requested_brochure: false },
  appointment_request: { wanted: false, kind: "", preferred_text: "", project_id: "" },
  handover: { needed: false, reason: "", summary: "", next_action: "" },
  objection_key: "", ...o,
});
const scripted = (...replies) => { const calls = []; const fn = async (p) => { calls.push(p); const d = replies[Math.min(calls.length - 1, replies.length - 1)]; if (d instanceof Error) throw d; return { data: d, model: "claude-opus-5-5", usage: { input_tokens: 100, output_tokens: 50 } }; }; fn.calls = calls; return fn; };

/* ---------- guards ---------- */
test("opt-out detection (BM, EN) without false alarms", () => {
  for (const s of ["STOP", "stop", "Berhenti", "jangan hantar mesej lagi", "please don't message me anymore", "tolong padam nombor saya", "unsubscribe"]) assert.ok(isOptOut(s), s);
  for (const s of ["Bila projek ni stop jual?", "Harga dah stop naik ke?", "Nak tahu harga", "boleh hantar brochure?"]) assert.ok(!isOptOut(s), s);
});

test("human-request detection", () => {
  for (const s of ["nak cakap dengan orang", "can I talk to a real person?", "boleh call saya?", "agent", "I want to speak with an advisor"]) assert.ok(wantsHuman(s), s);
  for (const s of ["harga berapa?", "is it freehold?", "ada swimming pool?"]) assert.ok(!wantsHuman(s), s);
});

test("language detection: BM, English, Manglish", () => {
  assert.equal(detectLanguage("Berapa harga rumah ni untuk 3 bilik?"), "ms");
  assert.equal(detectLanguage("How much is the price for a 3 bedroom unit?"), "en");
  assert.equal(detectLanguage("Bro how much ah harga dia, monthly berapa?"), "mixed");
});

/* ---------- validator ---------- */
const RULES = { allowedAmounts: [465000, 1000, 0.35], indicativeAmounts: [450000, 380000], hasFreshAvailability: false, hasActivePromotion: false, appointmentConfirmed: false, isFirstReply: false, allowedUrls: ["https://example.test/brochure.pdf"], allowedHosts: ["onestopcentreproperty.com"], maxChars: 700 };
const codes = (text, rules = RULES) => validateReply(text, rules).violations.map((v) => v.code);

test("amount extraction understands RM formats", () => {
  assert.deepEqual(extractAmounts("RM450,000, RM 465k, RM1.2 juta, RM0.35 psf, RM 2,150").map((a) => a.value), [450000, 465000, 1200000, 0.35, 2150]);
});

test("prices: verified OK, invented blocked, website price only when labelled indicative", () => {
  assert.deepEqual(codes("Harga Type A ialah RM465,000."), []);
  assert.deepEqual(codes("Harga Type A ialah RM399,000."), ["unverified_price"]);
  assert.deepEqual(codes("Type A is RM450,000."), ["unlabelled_indicative_price"]);
  assert.deepEqual(codes("Type A dari RM450,000 (anggaran, perlu disahkan)."), []);
  assert.deepEqual(codes("Booking fee RM1,000 dan yuran RM0.35 psf."), []);
});

test("instalment estimate allowed only with assumptions", () => {
  assert.deepEqual(codes("Anggaran bulanan sekitar RM2,150 (pinjaman 90%, kadar 4%, tempoh 35 tahun)."), []);
  assert.deepEqual(codes("Bulanan RM2,150 sahaja."), ["unverified_price"]);
});

test("guarantees blocked, honest negations allowed", () => {
  assert.deepEqual(codes("Loan pasti lulus, jangan risau!"), ["guarantee_language"]);
  assert.deepEqual(codes("This is a guaranteed investment."), ["guarantee_language"]);
  assert.deepEqual(codes("Harga confirm naik tahun depan, 100% untung."), ["guarantee_language"]);
  assert.deepEqual(codes("Kelulusan loan tidak dapat dijamin; ia bergantung pada pihak bank."), []);
  assert.deepEqual(codes("We cannot guarantee rental returns."), []);
});

test("availability claims need fresh inventory", () => {
  assert.deepEqual(codes("Unit Type A masih ada lagi!"), ["unverified_availability"]);
  assert.deepEqual(codes("Unit Type A masih ada lagi!", { ...RULES, hasFreshAvailability: true }), []);
  assert.deepEqual(codes("Saya perlu semak dulu sama ada unit Type A masih ada."), [], "offering to check availability is fine");
  assert.deepEqual(codes("Ada soalan lain? Saya masih ada di sini untuk bantu."), []);
});

test("promotions need an approved promotion unless the reply clearly hedges", () => {
  assert.deepEqual(codes("Ada cashback RM10,000 untuk anda!"), ["unverified_price", "unverified_promotion"]);
  assert.deepEqual(codes("Cashback tertakluk pada syarat promosi rasmi; saya akan sahkan dengan penasihat."), []);
  assert.deepEqual(codes("Ada cashback untuk pembeli awal.", { ...RULES, hasActivePromotion: true }), []);
});

test("appointments are never 'confirmed' without the calendar", () => {
  assert.deepEqual(codes("Appointment anda hari Sabtu 3pm telah disahkan."), ["unconfirmed_appointment"]);
  assert.deepEqual(codes("Your viewing slot is confirmed for Saturday."), ["unconfirmed_appointment"]);
  assert.deepEqual(codes("Slot Sabtu petang belum disahkan — penasihat kami akan confirmkan."), []);
  assert.deepEqual(codes("Your viewing slot is confirmed for Saturday.", { ...RULES, appointmentConfirmed: true }), []);
});

test("no impersonation; AI disclosure on first reply; length; links", () => {
  assert.deepEqual(codes("Saya manusia, bukan bot."), ["impersonation"]);
  assert.deepEqual(codes("I have visited the showroom myself, it's lovely."), ["impersonation"]);
  assert.deepEqual(codes("Hai! Boleh saya bantu?", { ...RULES, isFirstReply: true }), ["missing_ai_disclosure"]);
  assert.deepEqual(codes("Hai! Saya pembantu AI One Stop Centre.", { ...RULES, isFirstReply: true }), []);
  assert.deepEqual(codes("x".repeat(701)), ["too_long"]);
  assert.deepEqual(codes("Brosur: https://example.test/brochure.pdf dan https://onestopcentreproperty.com/property/test-residence/"), []);
  assert.deepEqual(codes("Lihat https://random-site.example/deal"), ["unknown_link"]);
});

/* ---------- context ---------- */
test("context: verified vs stale vs indicative, freshness, allow-lists", async () => {
  const ctx = await loadContext(fakeDb(), { message: "budget saya 500k, booking fee berapa?", now: NOW });
  assert.ok(ctx.rules.allowedAmounts.includes(465000), "fresh verified price allowed");
  assert.ok(ctx.rules.indicativeAmounts.includes(390000), "90-day-old price is only indicative");
  assert.ok(ctx.rules.indicativeAmounts.includes(450000) && ctx.rules.indicativeAmounts.includes(380000), "website prices indicative");
  assert.ok(ctx.rules.allowedAmounts.includes(1000) && ctx.rules.allowedAmounts.includes(0.35), "verified fees");
  assert.ok(ctx.rules.allowedAmounts.includes(500000), "buyer's own budget figure");
  assert.equal(ctx.rules.hasFreshAvailability, true);
  assert.ok(ctx.rules.allowedUrls.includes("https://wa.me/60123456789"));
  assert.ok(ctx.rules.allowedUrls.includes("https://dev.example.test/residence"));
  assert.equal(ctx.rules.isFirstReply, true);
  assert.equal(ctx.projects.find((p) => p.id === "t2").prices[0].fresh, false);
});

test("context: tolerates the live listing shapes (near with objects/strings, odd fields)", async () => {
  const ctx = await loadContext(fakeDb(), { message: "hi", now: NOW });
  const t2 = ctx.projects.find((p) => p.id === "t2");
  assert.deepEqual(t2.nearby, { public_transport: ["MRT Taman Connaught (800m)"] });
  const odd = await loadContext(fakeDb({ projects: [{ id: "x", slug: "x", data: { n: "X", types: "n/a", facilities: { a: 1 }, near: "none" } }] }), { message: "hi", now: NOW });
  assert.deepEqual(odd.projects[0].layouts, []);
  assert.deepEqual(odd.projects[0].nearby, {});
});

test("prompt: schema stays within the API's structured-output limits", () => {
  // The API rejects schemas with more than 16 union-typed (anyOf / type-array / nullable) parameters.
  let unions = 0;
  const walk = (s) => { if (s && typeof s === "object") { if (s.anyOf || Array.isArray(s.type)) unions++; Object.values(s).forEach(walk); } };
  walk(REPLY_SCHEMA);
  assert.equal(unions, 0);
  const n = normalizeReply({ reply: "x", confidence: 0, objection_key: "",
    qualification_updates: { purpose: "", budget_max: 0, budget_min: 450000, bedrooms: "3", asked_price: false, requested_brochure: true },
    appointment_request: { wanted: false, kind: "", preferred_text: "", project_id: "" },
    handover: { needed: true, reason: "", summary: "s", next_action: "" } });
  assert.deepEqual(n.qualification_updates, { purpose: null, budget_max: null, budget_min: 450000, bedrooms: "3", asked_price: false, requested_brochure: true });
  assert.deepEqual(n.appointment_request, { wanted: false, kind: null, preferred_text: null, project_id: null });
  assert.deepEqual(n.handover, { needed: true, reason: null, summary: "s", next_action: null });
  assert.equal(n.objection_key, null);
  assert.equal(n.confidence, 0, "confidence is not a placeholder");
});

test("buyer amounts and search query helpers", () => {
  assert.deepEqual(buyerAmounts("budget dalam 450k atau 500 ribu, max RM520,000").sort(), [450000, 500000, 520000].sort());
  assert.equal(searchQuery("Berapa yuran penyelenggaraan untuk Test Residence?"), "berapa or yuran or penyelenggaraan or untuk or test or residence");
});

test("prompt: schema is strict and messages alternate with context last", () => {
  const walk = (s) => { if (s && typeof s === "object") { if (s.type === "object") { assert.equal(s.additionalProperties, false); assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort()); } Object.values(s).forEach(walk); } };
  walk(REPLY_SCHEMA);
  const m = buildMessages([{ role: "assistant", text: "Hi, saya pembantu AI" }, { role: "user", text: "a" }, { role: "user", text: "b" }], "<verified_context>{}</verified_context>", "harga?", "- unverified_price: x");
  assert.deepEqual(m.map((x) => x.role), ["user", "assistant", "user"]);
  assert.match(m[2].content, /^a\nb\n\n<verified_context>/);
  assert.match(m[2].content, /<buyer_message>\nharga\?\n<\/buyer_message>/);
  assert.match(m[2].content, /rejected_draft_feedback/);
  const sys = buildSystemPrompt({ persona: { name: "X", allow_manglish: false } }, [{ key: "loan_worry", examples: ["Takut loan"], guidance_en: "Never guarantee", escalate: true }]);
  assert.match(sys, /You are X/);
  assert.match(sys, /"Saya X, pembantu AI" \/ "I'm X, an AI assistant"/, "introduces itself by the persona name");
  assert.doesNotMatch(buildSystemPrompt({ persona: { name: "Hafizan Hanis AI Agent" } }, []), /pembantu AI One Stop Centre/);
  assert.match(sys, /do not use Manglish/);
  assert.match(sys, /loan_worry \[escalate to a human\]/);
  assert.doesNotMatch(sys, /\d{4}-\d\d-\d\d/, "no dates in the cached system prompt");
});

/* ---------- orchestrator ---------- */
test("happy path: verified reply goes out, qualification and score updated, nothing blocked", async () => {
  const llm = scripted(draft());
  const r = await respond({ db: fakeDb(), llm, message: "Type A Test Residence berapa?", now: NOW, mode: "simulate" });
  assert.equal(r.decision, "reply");
  assert.match(r.reply, /RM465,000/);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].model, "claude-opus-5-5");
  assert.equal(llm.calls[0].effort, "low");
  const q = r.actions.find((a) => a.type === "update_qualification");
  assert.equal(q.qualification.signals.asked_price, true);
  assert.ok(r.actions.some((a) => a.type === "add_interest" && a.project_id === "t1"));
});

test("an invented price is caught, the AI retries with feedback, the corrected reply is used", async () => {
  const llm = scripted(draft({ reply: "Hai, saya pembantu AI. Type A sekarang RM399,000 sahaja!" }), draft());
  const r = await respond({ db: fakeDb(), llm, message: "harga Type A?", now: NOW });
  assert.equal(r.decision, "reply");
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1].messages.at(-1).content, /unverified_price/);
  assert.equal(r.attempts[0].violations[0].code, "unverified_price");
});

test("if the retry is still wrong, the reply is blocked, a safe message is used and a human is alerted", async () => {
  const bad = draft({ reply: "Hai, saya pembantu AI. Loan confirm lulus, unit masih ada lagi!" });
  const r = await respond({ db: fakeDb({ ai_project_units: [] }), llm: scripted(bad, bad), message: "boleh dapat loan?", now: NOW });
  assert.equal(r.decision, "blocked");
  assert.match(r.reply, /penasihat kami akan menghubungi/i);
  assert.ok(r.actions.some((a) => a.type === "handover" && /guarantee_language/.test(a.summary)));
  assert.ok(r.actions.some((a) => a.type === "cancel_follow_ups"));
});

test("STOP is honoured without calling the AI", async () => {
  const llm = scripted(draft());
  const r = await respond({ db: fakeDb(), llm, message: "STOP", now: NOW });
  assert.equal(r.decision, "opt_out");
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(r.actions.map((a) => a.type), ["record_consent", "record_consent", "cancel_follow_ups", "pause_ai"]);
});

test("asking for a person hands over immediately and pauses the AI", async () => {
  const llm = scripted(draft());
  const r = await respond({ db: fakeDb(), llm, message: "I want to talk to a real person", now: NOW });
  assert.equal(r.decision, "handover");
  assert.equal(llm.calls.length, 0);
  assert.equal(r.language, "en");
  assert.ok(r.actions.some((a) => a.type === "handover" && a.reason === "customer_request"));
});

test("the AI's own handover (negotiation) and low confidence both alert a human", async () => {
  let r = await respond({ db: fakeDb(), llm: scripted(draft({ reply: "Baik, permintaan diskaun perlu disemak oleh penasihat kami. Mereka akan hubungi tuan/puan.", intent: "negotiation", handover: { needed: true, reason: "negotiation", summary: "Wants extra discount on Type A", next_action: "Call about pricing" } })), message: "boleh bagi discount lagi?", history: [{ role: "assistant", text: "Hai, saya pembantu AI" }], now: NOW });
  assert.equal(r.decision, "handover");
  assert.ok(r.actions.some((a) => a.type === "handover" && a.reason === "negotiation"));
  r = await respond({ db: fakeDb(), llm: scripted(draft({ confidence: 0.4 })), message: "Type A berapa?", now: NOW });
  assert.equal(r.decision, "handover");
  assert.ok(r.actions.some((a) => a.reason === "low_confidence"));
});

test("an appointment request is recorded as pending, never confirmed", async () => {
  const d = draft({ reply: "Boleh! Saya catat Sabtu petang. Penasihat kami akan sahkan slot dengan tuan/puan.", intent: "appointment", agent: "appointment", appointment_request: { wanted: true, kind: "showroom_visit", preferred_text: "Sabtu petang", project_id: "t1" } });
  const r = await respond({ db: fakeDb(), llm: scripted(d), message: "Saya nak datang showroom Sabtu", history: [{ role: "assistant", text: "Hai, saya pembantu AI" }], now: NOW });
  assert.equal(r.decision, "reply");
  const a = r.actions.find((x) => x.type === "request_appointment");
  assert.deepEqual([a.kind, a.preferred_text, a.project_id], ["showroom_visit", "Sabtu petang", "t1"]);
});

test("AI service failures and refusals fall back safely; a missing API key is reported, not hidden", async () => {
  let r = await respond({ db: fakeDb(), llm: scripted(new LlmError("busy", { kind: "unavailable" })), message: "harga?", now: NOW });
  assert.equal(r.decision, "error");
  assert.ok(r.actions.some((a) => a.type === "handover"));
  r = await respond({ db: fakeDb(), llm: scripted(new LlmError("declined", { kind: "refusal" })), message: "harga?", now: NOW });
  assert.ok(r.actions.some((a) => a.reason === "sensitive"));
  await assert.rejects(respond({ db: fakeDb(), llm: scripted(new LlmError("no key", { kind: "config" })), message: "harga?", now: NOW }), /no key/);
});

test("returning buyer: known answers are kept and only new information is merged", () => {
  const { qualification, changed } = mergeQualification({ budget_max: 500000, purpose: "own_stay" }, { budget_max: 550000, purpose: null, bedrooms: "3", asked_price: true });
  assert.deepEqual([qualification.budget_max, qualification.purpose, qualification.bedrooms, qualification.signals.asked_price], [550000, "own_stay", "3", true]);
  assert.deepEqual(changed.sort(), ["asked_price", "bedrooms", "budget_max"]);
});

test("applyActions writes idempotent, keyed records (for live WhatsApp in Phase 4)", async () => {
  const db = fakeDb();
  const r = await respond({ db, llm: scripted(draft({ appointment_request: { wanted: true, kind: "phone_call", preferred_text: "esok pagi", project_id: "t1" } })), message: "call saya esok pagi boleh? harga Type A?", now: NOW });
  // "call saya" counts as asking for a person, so it is a handover — check that path writes correctly too
  const done = await applyActions(db, { leadId: "L1", contactId: "C1", result: r, runId: "run-1" });
  assert.ok(done.includes("handover") && done.includes("pause_ai"));
  assert.ok(db.writes.some((w) => w.path === "ai_handover_events" && w.body.reason === "customer_request"));
  assert.ok(db.writes.some((w) => w.path.startsWith("ai_follow_up_jobs?lead_id=eq.L1&status=eq.scheduled") && w.body.status === "cancelled"));
});

/* ---------- Claude API adapter ---------- */
test("LLM adapter: documented request shape, fallback opt-in, JSON parsing, refusal and retries", async () => {
  const sent = [];
  const ok = { content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify({ reply: "hi" }) }], stop_reason: "end_turn", model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5 } };
  const queue = [new Response("busy", { status: 529 }), Response.json(ok)];
  const r = await callClaude({ apiKey: "k", system: "S", messages: [{ role: "user", content: "x" }], schema: { type: "object" }, fetchImpl: async (u, i) => { sent.push({ u, i }); return queue.shift(); }, backoffScale: 0 });
  assert.deepEqual(r.data, { reply: "hi" });
  assert.equal(sent.length, 2, "retried once after 529");
  const body = JSON.parse(sent[1].i.body);
  assert.equal(sent[1].u, "https://api.anthropic.com/v1/messages");
  assert.equal(sent[1].i.headers["anthropic-version"], "2026-10-21");
  assert.equal(sent[1].i.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.fallbacks, "default");
  assert.deepEqual(body.output_config, { effort: "low", format: { type: "json_schema", schema: { type: "object" } } });
  assert.equal(body.system[0].cache_control.type, "ephemeral");
  assert.ok(!("thinking" in body) && !("temperature" in body) && !("tool_choice" in body), "no parameters Opus 5.5 rejects");
  await assert.rejects(callClaude({ apiKey: "k", system: "S", messages: [], schema: {}, fetchImpl: async () => Response.json({ ...ok, stop_reason: "refusal", content: [] }) }), (e) => e.kind === "refusal");
  await assert.rejects(callClaude({ apiKey: "k", system: "S", messages: [], schema: {}, fetchImpl: async () => Response.json({ error: { message: "bad key" } }, { status: 401 }) }), (e) => e.kind === "auth");
  await assert.rejects(callClaude({ system: "S", messages: [], schema: {}, fetchImpl: async () => Response.json(ok) }), (e) => e.kind === "config");
});

test("daily cap: the AI is not called once the limit is reached, and fails closed if usage can't be checked", async () => {
  const llm = scripted(draft());
  let r = await respond({ db: fakeDb(), llm, reserve: async () => ({ allowed: false, used: 200, cap: 200 }), message: "harga Type A?", now: NOW });
  assert.equal(r.decision, "capped");
  assert.equal(llm.calls.length, 0, "no model call, no cost");
  assert.match(r.reply, /penasihat kami/i);
  assert.ok(r.actions.some((a) => a.type === "handover" && /daily AI limit \(200\)/.test(a.summary)));
  r = await respond({ db: fakeDb(), llm, reserve: async () => { throw new Error("db down"); }, message: "harga Type A?", now: NOW });
  assert.equal(r.decision, "capped");
  assert.equal(llm.calls.length, 0);
  assert.match(r.actions[0].summary, /could not be checked \(db down\)/);
  r = await respond({ db: fakeDb(), llm, reserve: async () => ({ allowed: true, used: 5, cap: 200 }), message: "harga Type A?", now: NOW });
  assert.equal(r.decision, "reply");
  assert.equal(llm.calls.length, 1);
  const stop = await respond({ db: fakeDb(), llm, reserve: async () => { throw new Error("must not be called"); }, message: "STOP", now: NOW });
  assert.equal(stop.decision, "opt_out", "opt-outs never use up the AI allowance");
});

/* ---------- loan eligibility engine in the conversation ---------- */
const FIN_EMPTY = { route: "", age: 0, basic_salary: 0, fixed_allowances: 0, variable_income: 0, self_employed_income: 0, mandatory_deductions: 0, commitments_monthly: 0,
  credit_card_balance: 0, confirmed_service: "", service_years: 0, second_financing: "", property_price: 0, valuation: 0, requested_amount: 0, down_payment: 0,
  property_count: 0, co_age: 0, co_income: 0, co_mandatory_deductions: 0, co_commitments_monthly: 0 };
const LPPSA_SAID = { ...FIN_EMPTY, route: "lppsa", age: 30, basic_salary: 4000, fixed_allowances: 1000, mandatory_deductions: 500, commitments_monthly: 800, confirmed_service: "yes", property_price: 450000 };

test("loan engine: new figures → engine recalculates → the AI rewrites from the result; only engine figures pass", async () => {
  const first = draft({ reply: "Baik Tuan, saya kira sekejap.", intent: "instalment", financing_updates: LPPSA_SAID });
  const second = draft({ reply: "Anggaran awal LPPSA: pembiayaan RM456,158 (rumah RM450,000 + yuran guaman RM6,158), ansuran lebih kurang RM2,020 sebulan, tempoh 35 tahun. Ini anggaran awal, bukan kelulusan.", intent: "instalment", financing_updates: LPPSA_SAID });
  const llm = scripted(first, second);
  const r = await respond({ db: fakeDb(), llm, message: "Saya cikgu, gaji pokok 4000, elaun 1000, potongan wajib 500, hutang kereta 800, umur 30, dah sah jawatan. Rumah 450k", history: [{ role: "assistant", text: "Hai, saya pembantu AI." }], now: NOW, mode: "simulate" });
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[0].system, /Loan eligibility and affordability/);
  const ctx2 = llm.calls[1].messages.at(-1).content;
  assert.match(ctx2, /"financing_engine"/);
  assert.match(ctx2, /"instalment_for_needed":2020/);
  assert.match(ctx2, /"recalculated_this_turn":true/);
  assert.equal(r.decision, "reply");
  assert.match(r.reply, /RM2,020/);
  assert.deepEqual(r.attempts[0].recalculated.slice(0, 2), ["route", "age"]);
  const save = r.actions.find((a) => a.type === "save_financing");
  assert.equal(save.result.outcome, "potentially_affordable");
  assert.equal(save.new_assessment, true);
  assert.equal(r.qualification.financing, "lppsa");
  assert.equal(r.qualification.financing_check, "potentially_affordable");
  assert.ok(!r.actions.some((a) => a.type === "handover"), "nothing to escalate");
  assert.equal(r.financing.inputs.commitments_monthly, 800);
});

test("loan engine: an instalment the engine did not calculate is blocked, even with assumptions stated", async () => {
  const bad = draft({ reply: "Hai, saya pembantu AI. Anggaran ansuran RM1,500 sebulan, kadar 4%, 35 tahun.", intent: "instalment" });
  const r = await respond({ db: fakeDb(), llm: scripted(bad, bad), message: "monthly berapa?", now: NOW, mode: "simulate" });
  assert.equal(r.decision, "blocked");
  assert.equal(r.attempts[0].violations[0].code, "uncalculated_amount");
  // the illustrative example for a listed price is an engine figure: RM465,000 × 90% at 4.2% over 35 years
  const ok = draft({ reply: "Hai, saya pembantu AI. Contoh: pinjaman RM418,500 (90%) pada kadar andaian 4.2%, 35 tahun ≈ RM1,904 sebulan. Anggaran sahaja, bukan tawaran pinjaman.", intent: "instalment" });
  const r2 = await respond({ db: fakeDb(), llm: scripted(ok), message: "monthly berapa?", now: NOW, mode: "simulate" });
  assert.equal(r2.decision, "reply", JSON.stringify(r2.violations));
});

test("loan engine: switched off for live chats unless the loan_engine flag is on", async () => {
  const llm = scripted(draft({ financing_updates: LPPSA_SAID }));
  const r = await respond({ db: fakeDb(), llm, message: "gaji 4000", now: NOW, mode: "live" });
  assert.equal(llm.calls.length, 1);
  assert.doesNotMatch(llm.calls[0].system, /Loan eligibility and affordability/);
  assert.ok(!r.actions.some((a) => a.type === "save_financing"));
  assert.equal(r.financing, undefined);
});

test("loan engine (live): a challenging result is saved and escalated to an advisor with a summary", async () => {
  const settings = [{ id: 1, flags: { loan_engine: true }, persona: {}, ai: { confidence_threshold: 0.7 }, business: {}, scoring: {}, compliance: {} }];
  const lead = { id: "L1", lead_code: "OSC-000001", qualification: {}, contact: { full_name: "Ali" } };
  const saved = { id: "FP1", inputs: { route: "lppsa", age: 60, basic_salary: 4000, fixed_allowances: 1000, mandatory_deductions: 500, commitments_monthly: 800, confirmed_service: "yes" }, result: null };
  const db = fakeDb({ ai_settings: settings, ai_leads: [lead], ai_financing_profiles: [saved] });
  const said = draft({ reply: "Terima kasih Tuan, saya semak.", financing_updates: { ...FIN_EMPTY, property_price: 700000 } });
  const r = await respond({ db, llm: scripted(said, draft({ reply: "Untuk RM700,000, anggaran awal menunjukkan ia berpotensi mencabar. Penasihat kami akan bantu semak pilihan lain. Ini bukan keputusan kelulusan.", financing_updates: FIN_EMPTY })),
    leadId: "L1", message: "rumah 700k boleh?", history: [{ role: "assistant", text: "Hai" }], now: NOW, mode: "live" });
  assert.equal(r.decision, "reply", JSON.stringify(r.violations));
  const save = r.actions.find((a) => a.type === "save_financing");
  assert.equal(save.profile_id, "FP1");
  assert.equal(save.inputs.age, 60, "earlier answers kept");
  assert.equal(save.result.outcome, "potentially_challenging");
  const h = r.actions.find((a) => a.type === "handover");
  assert.equal(h.reason, "financing");
  assert.match(h.summary, /Potentially challenging[\s\S]*not an approval/);

  await applyActions(db, { leadId: "L1", contactId: "C1", result: r });
  assert.ok(db.writes.some((w) => w.op === "patch" && w.path.startsWith("ai_financing_profiles?id=eq.FP1") && w.body.outcome === "potentially_challenging"));
  assert.ok(db.writes.some((w) => w.op === "post" && w.path === "ai_financing_assessments" && w.body.route === "lppsa" && w.body.rules_version));
  assert.ok(db.writes.some((w) => w.op === "patch" && w.path.startsWith("ai_leads") && w.body.qualification?.financing_check === "potentially_challenging"));
});

test("loan engine: the run log keeps no income figures", async () => {
  const db = fakeDb();
  const r = await respond({ db, llm: scripted(draft({ financing_updates: LPPSA_SAID }), draft({ financing_updates: LPPSA_SAID })), message: "gaji 4000", now: NOW, mode: "simulate" });
  await logRun(db, { result: r });
  const run = db.writes.find((w) => w.path === "ai_agent_runs").body;
  assert.doesNotMatch(JSON.stringify(run.output), /4000|"inputs"|"result"/, "field names only, no figures");
  assert.equal(run.output.actions.find((a) => a.type === "save_financing").outcome, "potentially_affordable");
});

test("brochure: the project's brochure link from the website CMS is given to the AI and may be shared", async () => {
  const llm = scripted(draft({ reply: "Hai, saya pembantu AI. Ini brochure Test Residence: https://example.test/brochure.pdf", facts_used: [] }));
  const r = await respond({ db: fakeDb(), llm, message: "boleh send brochure Test Residence?", now: NOW, mode: "simulate" });
  const ctx = llm.calls[0].messages.at(-1).content;
  assert.match(ctx, /"brochure_url":"https:\/\/example\.test\/brochure\.pdf"/);
  assert.match(ctx, /"id":"t2"[^}]*"brochure_url":null/);
  assert.match(llm.calls[0].system, /If there is no such file, send the project's brochure_url/);
  assert.equal(r.decision, "reply", JSON.stringify(r.violations));
});

test("website listing details reach the AI: specifications as published, money figures as indicative", async () => {
  const db = fakeDb({ projects: [{ id: "t3", slug: "m-mira", data: { n: "M MIRA", maintPsf: "0.38", furn: "Partially Furnished", furnList: ["Air-conditioners"], hl: ["Low Density 633 Units Only"],
    lease: "99", height: "40", z: "800 sqft - 1050 sqft", address: "M MIRA", desc: "", nearby: "650m – Sri Rampai LRT Station", types: [{ name: "Type A", price: "RM476,000" }] } }] });
  const llm = scripted(draft({ reply: "Hai, saya pembantu AI. Yuran penyelenggaraan M MIRA dianggarkan RM0.38 psf (indikatif, tertakluk pengesahan).", facts_used: [] }));
  const r = await respond({ db, llm, message: "Berapa maintenance fee M Mira?", now: NOW, mode: "simulate" });
  const ctx = llm.calls[0].messages.at(-1).content;
  // the project is named in the message, so it is in focus with its full details; a placeholder address is left out
  assert.match(ctx, /"specs_PUBLISHED":\{"lease_years":"99","size_range":"800 sqft - 1050 sqft","furnishing":"Partially Furnished","furnished_items":\["Air-conditioners"\],"floors":"40","highlights":\["Low Density 633 Units Only"\],"surroundings":"650m – Sri Rampai LRT Station"\},"money_INDICATIVE":\{"price_from":"RM476,000","maintenance_fee_psf":"RM0.38 psf"\}/);
  assert.equal(r.decision, "reply", JSON.stringify(r.violations));
  // an unlabelled fee is still caught
  const bad = await respond({ db, llm: scripted(draft({ reply: "Hai, saya pembantu AI. Maintenance fee M MIRA RM0.38 psf." }), draft({ reply: "Hai, saya pembantu AI. Maintenance fee M MIRA RM0.38 psf." })), message: "maintenance?", now: NOW, mode: "simulate" });
  assert.equal(bad.attempts[0].violations[0].code, "unlabelled_indicative_price");
});
