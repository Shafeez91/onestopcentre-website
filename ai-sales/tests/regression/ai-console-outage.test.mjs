// Regression: 29 Oct 2026 — every AI call failed with HTTP 400 "The compiled grammar is too large" after the
// insights schema (a ~45-value enum inside an array item) was nested into the reply schema. The console and live
// WhatsApp both fell back to the fixed safe reply. These tests pin the fix: the schema stays small, a schema refusal
// is classified and retried without insights, failures are reported honestly, and language requests are respected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { requestedLanguage, languagePreference } from "../../../sales/shared/guard.mjs";
import { REPLY_SCHEMA, REPLY_SCHEMA_CORE } from "../../lib/prompt.mjs";
import { respond, applyActions, logRun } from "../../lib/orchestrator.mjs";
import { callClaude, LlmError } from "../../lib/llm.mjs";
import { cleanUpdates } from "../../../sales/shared/profile.mjs";

const NOW = new Date("2026-10-29T03:00:00Z");

/* ---------- TEST FIXTURES ONLY: an in-memory database with two projects ---------- */
function fakeDb(over = {}) {
  const t = {
    ai_settings: [{ id: 1, persona: { name: "OSC Property Assistant", allow_manglish: true }, ai: { confidence_threshold: 0.7 }, business: {}, scoring: {}, compliance: {} }],
    projects: [
      { id: "mm", slug: "m-mira-test", data: { n: "M Mira", l: "Wangsa Maju", types: [{ name: "Type A", size: "850", beds: "3", price: "RM400,000" }] } },
      { id: "ma", slug: "m-aspira-test", data: { n: "M Aspira", l: "Cheras", types: [{ name: "Type B", price: "RM380,000" }] } },
    ],
    ai_leads: [], ai_lead_interests: [], ai_appointments: [], ai_project_facts: [], ai_project_prices: [], ai_project_units: [], ai_active_promotions: [],
    ...over,
  };
  const writes = [];
  return {
    writes,
    get: async (path) => structuredClone(t[path.split("?")[0]] || []),
    rpc: async () => [],
    post: async (path, body) => { writes.push({ op: "post", path, body }); return [{ id: "run-1" }]; },
    patch: async (path, body) => { writes.push({ op: "patch", path, body }); return null; },
  };
}
const draft = (o = {}) => ({
  reply: "Hi! I'm OSC Property Assistant, an AI assistant. Of course, I'll continue in English. Which project would you like to know about?",
  language: "en", intent: "greeting", agent: "reception", confidence: 0.85, facts_used: [],
  qualification_updates: { purpose: "", first_home: "", bedrooms: "", size_sqft: "", budget_min: 0, budget_max: 0, employment: "", financing: "", timeline_months: 0, readiness: "", concerns: "", preferred_project_id: "", asked_price: false, requested_brochure: false },
  appointment_request: { wanted: false, kind: "", preferred_text: "", project_id: "", slot_id: "" },
  handover: { needed: false, reason: "", summary: "", next_action: "" }, objection_key: "", ...o,
});
const scripted = (...replies) => {
  const calls = [];
  const fn = async (p) => { calls.push(p); const d = replies[Math.min(calls.length - 1, replies.length - 1)]; if (d instanceof Error) throw d; return { data: d, model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 } }; };
  fn.calls = calls; return fn;
};
const contextOf = (call) => JSON.parse(call.messages.at(-1).content.match(/<verified_context>\s*([\s\S]*?)\s*<\/verified_context>/)[1]);

/* ---------- the schema that broke ---------- */
function schemaStats(s) {
  let enumValues = 0, bigEnumInArray = 0, props = 0;
  const walk = (x, inArray) => {
    if (!x || typeof x !== "object") return;
    if (x.enum) { enumValues += x.enum.length; if (inArray && x.enum.length > 10) bigEnumInArray++; }
    if (x.properties) props += Object.keys(x.properties).length;
    for (const [k, v] of Object.entries(x)) walk(v, inArray || k === "items");
  };
  walk(s, false);
  return { enumValues, bigEnumInArray, props };
}

test("reply schema: no large enum inside an array, and close to the schema that is known to compile", () => {
  const full = schemaStats(REPLY_SCHEMA), core = schemaStats(REPLY_SCHEMA_CORE);
  assert.equal(full.bigEnumInArray, 0, "a large enum inside array items is what made the grammar too large");
  // the core schema (everything but insights) ran in production before the insights were added
  assert.ok(full.enumValues - core.enumValues <= 10, `insights add ${full.enumValues - core.enumValues} enum values`);
  assert.ok(full.props - core.props <= 25, `insights add ${full.props - core.props} properties`);
  assert.ok(!("insights" in REPLY_SCHEMA_CORE.properties) && !REPLY_SCHEMA_CORE.required.includes("insights"));
  assert.deepEqual([...REPLY_SCHEMA_CORE.required].sort(), Object.keys(REPLY_SCHEMA_CORE.properties).sort());
});

test("insights: unknown field keys from the (now free-text) field are still dropped", () => {
  assert.deepEqual(cleanUpdates([{ field: "work_area", value: "PJ", status: "confirmed" }, { field: "religion", value: "x", status: "confirmed" }, { field: "", value: "y" }]),
    [{ field: "work_area", value: "PJ", status: "confirmed" }]);
});

/* ---------- the API adapter classifies the failures ---------- */
test("LLM adapter: schema refusal, bad key, rate limit, timeout/network, malformed and cut-off replies", async () => {
  const call = (fetchImpl) => callClaude({ apiKey: "k", system: "S", messages: [], schema: {}, fetchImpl, backoffScale: 0, retries: 1 });
  const ok = { content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", model: "m" };
  await assert.rejects(call(async () => Response.json({ error: { message: "The compiled grammar is too large, which would cause performance issues." } }, { status: 400 })), (e) => e.kind === "schema" && /HTTP 400/.test(e.message));
  await assert.rejects(call(async () => Response.json({ error: { message: "messages: field required" } }, { status: 400 })), (e) => e.kind === "rejected");
  await assert.rejects(call(async () => Response.json({ error: { message: "invalid x-api-key" } }, { status: 401 })), (e) => e.kind === "auth");
  let n = 0;
  await assert.rejects(call(async () => { n++; return new Response("slow down", { status: 429 }); }), (e) => e.kind === "unavailable" && e.status === 429);
  assert.equal(n, 2, "rate limit retried");
  await assert.rejects(call(async () => { throw new Error("The operation was aborted due to timeout"); }), (e) => e.kind === "network");
  await assert.rejects(call(async () => Response.json({ ...ok, content: [{ type: "text", text: "not json" }] })), (e) => e.kind === "bad_response");
  await assert.rejects(call(async () => Response.json({ ...ok, stop_reason: "max_tokens" })), (e) => e.kind === "truncated");
});

/* ---------- orchestrator ---------- */
test("a refused schema is retried once without insights: the buyer still gets a real AI reply, and the run says why", async () => {
  const llm = scripted(new LlmError("AI request rejected (HTTP 400): The compiled grammar is too large", { kind: "schema", status: 400 }), draft());
  const r = await respond({ db: fakeDb(), llm, message: "Saya nk speak in English", now: NOW, mode: "simulate" });
  assert.equal(r.decision, "reply");
  assert.equal(llm.calls.length, 2);
  assert.ok("insights" in llm.calls[0].schema.properties);
  assert.ok(!("insights" in llm.calls[1].schema.properties));
  assert.match(r.degraded, /Insights skipped/);
  assert.equal(r.reply, draft().reply);
  const db = fakeDb();
  await logRun(db, { result: r });
  assert.match(db.writes[0].body.output.degraded, /grammar is too large/);
  assert.equal(db.writes[0].body.decision, "reply");
  assert.equal(db.writes[0].body.confidence, 0.85);
});

test("after a refusal, the business-rule retry for the same message goes straight to the core schema", async () => {
  const e = new LlmError("AI request rejected (HTTP 400): grammar too large", { kind: "schema", status: 400 });
  const llm = scripted(e, draft({ reply: "Hi, I'm an AI assistant. M Mira is only RM199,000 now!" }), draft());
  const r = await respond({ db: fakeDb(), llm, message: "Send info M Mira", now: NOW });
  assert.equal(llm.calls.length, 3);
  assert.deepEqual(llm.calls.map((c) => "insights" in c.schema.properties), [true, false, false]);
  assert.equal(r.decision, "reply");
});

test("a genuine outage: fixed safe reply, labelled as a failure, confidence 'not available' (not 0)", async () => {
  for (const kind of ["unavailable", "network", "auth", "rejected", "bad_response", "truncated"]) {
    const llm = scripted(new LlmError("boom", { kind }));
    const r = await respond({ db: fakeDb(), llm, message: "Send info M Mira", now: NOW, mode: "simulate" });
    assert.equal(r.decision, "error", kind);
    assert.equal(r.errorKind, kind);
    assert.equal(r.confidence, null, "no invented confidence");
    assert.equal(r.model, null, "no claim that a model answered");
    assert.ok(r.actions.some((a) => a.type === "handover"));
    const db = fakeDb();
    await logRun(db, { result: r });
    assert.equal(db.writes[0].body.confidence, null);
    assert.equal(db.writes[0].body.decision, "error");
    assert.equal(db.writes[0].body.output.error_kind, kind);
  }
});

test("a schema refusal that persists on the core schema too is reported as an error, not looped", async () => {
  const e = new LlmError("AI request rejected (HTTP 400): grammar too large", { kind: "schema", status: 400 });
  const llm = scripted(e, e, e);
  const r = await respond({ db: fakeDb(), llm, message: "hi", now: NOW });
  assert.equal(r.decision, "error");
  assert.equal(r.errorKind, "schema");
  assert.equal(llm.calls.length, 2);
});

test("different buyer messages reach the model with their own text and project focus", async () => {
  const llm = scripted(draft(), draft({ intent: "project_info", agent: "knowledge", reply: "M Mira is in Wangsa Maju…", facts_used: ["project:mm"] }));
  await respond({ db: fakeDb(), llm, message: "Saya nk speak in English", now: NOW });
  const r = await respond({ db: fakeDb(), llm, message: "Send info M Mira", now: NOW, history: [{ role: "user", text: "Saya nk speak in English" }, { role: "assistant", text: draft().reply }] });
  assert.match(llm.calls[0].messages.at(-1).content, /Saya nk speak in English/);
  assert.match(llm.calls[1].messages.at(-1).content, /Send info M Mira/);
  assert.deepEqual(contextOf(llm.calls[1]).conversation_focus.project_names, ["M Mira"]);
  assert.deepEqual(r.retrieval.focus, ["M Mira"]);
  assert.equal(r.decision, "reply");
});

test("ambiguous: no project named yet is flagged so the AI asks which one", async () => {
  const llm = scripted(draft());
  const r = await respond({ db: fakeDb(), llm, message: "Send info pasal projek", now: NOW });
  assert.equal(contextOf(llm.calls[0]).conversation_focus.ambiguous, true);
  assert.equal(r.retrieval.ambiguous, true);
});

/* ---------- language ---------- */
test("language requests: English, Malay, and no false positives", () => {
  for (const s of ["Saya nk speak in English", "english pls", "Can you reply in English?", "English?", "boleh guna english je"]) assert.equal(requestedLanguage(s), "en", s);
  for (const s of ["boleh cakap melayu?", "BM boleh?", "in bahasa malaysia please", "bm please"]) assert.equal(requestedLanguage(s), "ms", s);
  for (const s of ["Send info pasal Mira", "Ada brochure english?", "My English not good", "Saya cikgu, boleh check layak LPPSA?", "Bro got unit left or not?"]) assert.equal(requestedLanguage(s), null, s);
  const h = [{ role: "user", text: "Saya nk speak in English" }, { role: "assistant", text: "Of course" }, { role: "user", text: "Send info M Mira" }];
  assert.equal(languagePreference("Monthly berapa?", h), "en", "kept across later turns");
  assert.equal(languagePreference("ok cakap melayu la", h), "ms", "the latest request wins");
  assert.equal(languagePreference("harga?", [{ role: "assistant", text: "Reply in English" }]), null, "only the buyer's own words count");
});

test("the requested language reaches the model, survives later turns, and is remembered on live chats", async () => {
  const llm = scripted(draft(), draft());
  const r1 = await respond({ db: fakeDb(), llm, message: "Saya nk speak in English", now: NOW });
  assert.equal(contextOf(llm.calls[0]).buyer.language_requested, "en");
  assert.ok(r1.actions.some((a) => a.type === "set_language" && a.language === "en"));
  const r2 = await respond({ db: fakeDb(), llm, message: "Monthly berapa?", history: [{ role: "user", text: "Saya nk speak in English" }], now: NOW });
  assert.equal(contextOf(llm.calls[1]).buyer.language_requested, "en");
  assert.ok(!r2.actions.some((a) => a.type === "set_language"), "only stored when asked in this message");
  assert.match(llm.calls[0].system, /buyer\.language_requested/);
  const db = fakeDb();
  const done = await applyActions(db, { leadId: "L1", contactId: "C1", result: r1 });
  assert.ok(done.includes("set_language"));
  assert.ok(db.writes.some((w) => w.path === "ai_contacts?id=eq.C1" && w.body.preferred_language === "en"));
});

test("fallback text follows the requested language when the AI is down", async () => {
  const r = await respond({ db: fakeDb(), llm: scripted(new LlmError("down", { kind: "unavailable" })), message: "Send info M Mira", history: [{ role: "user", text: "Saya nk speak in English" }], now: NOW });
  assert.equal(r.language, "en");
  assert.match(r.reply, /Thanks for your question/);
});

/* ---------- simulation isolation ---------- */
test("simulation writes nothing: respond() only proposes actions", async () => {
  const db = fakeDb();
  await respond({ db, llm: scripted(draft()), message: "Saya nk speak in English", now: NOW, mode: "simulate" });
  assert.deepEqual(db.writes, []);
});
