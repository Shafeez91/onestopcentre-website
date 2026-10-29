// One AI turn can be 1–3 separate WhatsApp messages (29 Oct 2026). Before this, the reply schema had a single
// `reply` string, so the model folded the persona's "message 1 / message 2" into one long text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { REPLY_SCHEMA, REPLY_SCHEMA_CORE, normalizeReply, replyMessages, buildSystemPrompt, MAX_MESSAGES } from "../../lib/prompt.mjs";
import { respond, checkTurn } from "../../lib/orchestrator.mjs";

const NOW = new Date("2026-10-29T03:00:00Z");
function fakeDb() {
  const t = { ai_settings: [{ id: 1, persona: { name: "OSC Property Assistant", tone: "6A. ELITE WHATSAPP REPLY STYLE — MESSAGE 1 … MESSAGE 2 …" }, ai: { confidence_threshold: 0.7, max_reply_chars: 120 }, business: {}, scoring: {}, compliance: {} }],
    projects: [{ id: "mm", slug: "m-mira", data: { n: "M MIRA", l: "Wangsa Maju", types: [{ name: "Type A", price: "RM476,000" }] } }],
    ai_leads: [], ai_lead_interests: [], ai_appointments: [], ai_project_facts: [], ai_project_prices: [], ai_project_units: [], ai_active_promotions: [] };
  const writes = [];
  return { writes, get: async (p) => structuredClone(t[p.split("?")[0]] || []), rpc: async () => [], post: async (p, b) => { writes.push(b); return [{ id: "r" }]; }, patch: async (p, b) => { writes.push(b); } };
}
const base = { language: "ms", intent: "project_info", agent: "knowledge", confidence: 0.9, facts_used: [],
  qualification_updates: { purpose: "", first_home: "", bedrooms: "", size_sqft: "", budget_min: 0, budget_max: 0, employment: "", financing: "", timeline_months: 0, readiness: "", concerns: "", preferred_project_id: "", asked_price: false, requested_brochure: false },
  appointment_request: { wanted: false, kind: "", preferred_text: "", project_id: "", slot_id: "" }, handover: { needed: false, reason: "", summary: "", next_action: "" }, objection_key: "" };
const llmOf = (...d) => { const calls = []; const fn = async (p) => { calls.push(p); return { data: d[Math.min(calls.length - 1, d.length - 1)], model: "m", usage: {} }; }; fn.calls = calls; return fn; };
const AI = "Hai, saya OSC Property Assistant, pembantu AI.";

test("schema: a list of messages replaces the single reply (also in the core schema used for follow-ups)", () => {
  for (const s of [REPLY_SCHEMA, REPLY_SCHEMA_CORE]) {
    assert.equal(s.properties.messages.type, "array");
    assert.equal(s.properties.messages.items.type, "string");
    assert.ok(s.required.includes("messages") && !("reply" in s.properties));
  }
});

test("messages are cleaned, never split by us, and capped at three without losing text", () => {
  assert.deepEqual(replyMessages({ messages: [" A ", "", "B"] }), ["A", "B"]);
  assert.deepEqual(replyMessages({ reply: "Para 1\n\nPara 2" }), ["Para 1\n\nPara 2"], "older single replies: one message, paragraphs untouched");
  assert.deepEqual(replyMessages({ messages: ["1", "2", "3", "4"] }), ["1", "2", "3\n\n4"]);
  assert.equal(MAX_MESSAGES, 3);
  const n = normalizeReply({ messages: ["A", "B"] });
  assert.deepEqual([n.messages, n.reply], [["A", "B"], "A\n\nB"]);
});

test("the instructions explain separate messages vs paragraphs, keep the persona, and default to one", () => {
  const sys = buildSystemPrompt({ persona: { name: "X", tone: "6A. ELITE WHATSAPP REPLY STYLE" } }, []);
  assert.match(sys, /6A\. ELITE WHATSAPP REPLY STYLE/, "the owner's persona text is kept as is");
  assert.match(sys, /WhatsApp messages \(the "messages" list\)/);
  assert.match(sys, /A paragraph break inside one message is not a new message/);
  assert.match(sys, /Default to ONE message/);
  assert.match(sys, /Hand-overs, opt-outs, complaints.*one message/);
  assert.match(sys, /at most one question per turn/);
});

test("business rules: content rules run on the whole turn; the length limit is per message", () => {
  const ok = checkTurn(normalizeReply({ messages: ["a".repeat(100), "b".repeat(100)] }), { maxChars: 120 });
  assert.equal(ok.ok, true, "two messages of 100 characters are fine with a 120 limit");
  const long = checkTurn(normalizeReply({ messages: ["a".repeat(100), "b".repeat(130)] }), { maxChars: 120 });
  assert.deepEqual(long.violations.map((v) => v.code), ["too_long"]);
  assert.match(long.violations[0].detail, /Message 2 is 130 characters/);
});

test("respond(): a normal reply keeps the model's separate messages; a simple question stays one", async () => {
  let r = await respond({ db: fakeDb(), llm: llmOf({ ...base, messages: [AI + " Stesen paling dekat: LRT Sri Rampai.", "Tuan/puan kerja di mana?"] }), message: "MRT paling dekat kat mana?", now: NOW, mode: "simulate" });
  assert.equal(r.decision, "reply");
  assert.deepEqual(r.messages, [AI + " Stesen paling dekat: LRT Sri Rampai.", "Tuan/puan kerja di mana?"]);
  assert.equal(r.reply, r.messages.join("\n\n"));
  r = await respond({ db: fakeDb(), llm: llmOf({ ...base, messages: [AI + " Harga dari RM476,000."] }), message: "Hi, how much is this property?", now: NOW });
  assert.equal(r.messages.length, 1);
});

test("respond(): blocked drafts, hand-overs, opt-outs and outages are always one message", async () => {
  const two = { ...base, messages: [AI + " Unit ada lagi!", "Harga RM399,000 sahaja!"] }; // an unverified price → blocked after retry
  let r = await respond({ db: fakeDb(), llm: llmOf(two, two), message: "unit ada?", now: NOW });
  assert.equal(r.decision, "blocked"); assert.equal(r.messages.length, 1);
  r = await respond({ db: fakeDb(), llm: llmOf({ ...base, messages: [AI + " Baik.", "Penasihat akan hubungi."], handover: { needed: true, reason: "negotiation", summary: "s", next_action: "n" } }), message: "boleh diskaun?", now: NOW });
  assert.equal(r.decision, "handover"); assert.deepEqual(r.messages, [AI + " Baik.\n\nPenasihat akan hubungi."]);
  r = await respond({ db: fakeDb(), llm: llmOf(base), message: "STOP", now: NOW });
  assert.equal(r.messages.length, 1);
  r = await respond({ db: fakeDb(), llm: async () => { throw Object.assign(new Error("down"), { kind: "unavailable" }); }, message: "harga?", now: NOW });
  assert.equal(r.decision, "error"); assert.equal(r.messages.length, 1);
});

test("simulation writes nothing, whatever the number of messages", async () => {
  const db = fakeDb();
  await respond({ db, llm: llmOf({ ...base, messages: [AI + " A.", "B?"] }), message: "MRT paling dekat?", now: NOW, mode: "simulate" });
  assert.deepEqual(db.writes, []);
});
