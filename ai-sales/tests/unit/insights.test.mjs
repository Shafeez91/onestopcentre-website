// Client insights (migration 16): field cleaning, the evidence rule for stage moves, what is written and how,
// and how the reply path protects a person's entries. The database rules themselves are tested in DB T61–T63.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanUpdates, statusOf, showValue, PROFILE_FIELDS, QUAL_FIELDS } from "../../../sales/shared/profile.mjs";
import { applyInsights, profileContext, INSIGHTS_SCHEMA, INSIGHT_RULES } from "../../lib/insights.mjs";
import { memdb } from "./helpers/memdb.mjs";

const NOW = new Date("2026-10-29T02:00:00Z");
const empty = { profile_updates: [], summary: { changed: false, text: "", last_client_question: "", outstanding: "", next_question: "" }, next_action: { action: "", reason: "", priority: "", due_in_days: 0 }, stage_update: { stage: "", evidence: "" } };
const recorder = () => { const calls = []; return { calls, rpcs: Object.fromEntries(["ai_lead_profile_set", "ai_lead_summary_set", "ai_lead_set_stage"].map((n) => [n, (a) => { calls.push([n, a]); return n === "ai_lead_set_stage" ? true : {}; }])) }; };

test("profile fields: known keys only, options checked, numbers parsed, nothing empty", () => {
  assert.deepEqual(cleanUpdates([
    { field: "work_area", value: " KLCC ", status: "confirmed" },
    { field: "commute_mode", value: "rail, own_car, teleport", status: "inferred" },
    { field: "marital_status", value: "complicated", status: "confirmed" },
    { field: "max_monthly_instalment", value: "RM2,500", status: "confirmed" },
    { field: "purpose", value: "Own_Stay", status: "confirmed" },
    { field: "password", value: "x", status: "confirmed" },
    { field: "occupation", value: "", status: "confirmed" },
  ]), [
    { field: "work_area", value: "KLCC", status: "confirmed" },
    { field: "commute_mode", value: ["rail", "own_car"], status: "inferred" },
    { field: "max_monthly_instalment", value: 2500, status: "confirmed" },
    { field: "purpose", value: "own_stay", status: "confirmed" },
  ]);
  assert.equal(statusOf("", {}), "missing");
  assert.equal(statusOf("KLCC", { status: "inferred" }), "inferred");
  assert.equal(statusOf("KLCC", { status: "confirmed", conflict: { value: "Bangsar" } }), "conflict");
  assert.equal(showValue("commute_mode", ["rail", "bus"]), "LRT / MRT / Monorail, Bus");
  assert.equal(showValue("max_monthly_instalment", 2500), "RM2,500");
  // the instructions list exactly these fields; the schema keeps `field` as plain text (an enum of every key inside
  // the array made the API's compiled grammar too large) and cleanUpdates drops any other key
  for (const f of [...PROFILE_FIELDS, ...QUAL_FIELDS]) assert.match(INSIGHT_RULES, new RegExp(`\\b${f.key}\\b`), f.key);
  assert.equal(INSIGHTS_SCHEMA.properties.profile_updates.items.properties.field.type, "string");
  assert.equal(INSIGHTS_SCHEMA.properties.profile_updates.items.properties.field.enum, undefined);
});

test("insights are written through the database rules, tied to the buyer's message", async () => {
  const { calls, rpcs } = recorder(), db = memdb({}, rpcs);
  await applyInsights(db, { leadId: "L1", messageId: "M9", now: NOW, buyerText: "Saya kerja di KLCC", insights: { ...empty,
    profile_updates: [{ field: "work_area", value: "KLCC", status: "confirmed" }],
    summary: { changed: true, text: "Works in KLCC; wants a 3-bedroom unit.", last_client_question: "Ada unit 3 bilik?", outstanding: "", next_question: "Budget?" },
    next_action: { action: "Send the 3-bedroom layouts", reason: "Buyer asked for 3 bedrooms", priority: "high", due_in_days: 1 } } });
  assert.deepEqual(calls.map(([n]) => n), ["ai_lead_profile_set", "ai_lead_summary_set"]);
  assert.deepEqual(calls[0][1], { p_lead: "L1", p_changes: [{ field: "work_area", value: "KLCC", status: "confirmed" }], p_source: "ai", p_message: "M9" });
  assert.equal(calls[1][1].p_summary.text, "Works in KLCC; wants a 3-bedroom unit.");
  assert.deepEqual(calls[1][1].p_summary.next_action, { action: "Send the 3-bedroom layouts", reason: "Buyer asked for 3 bedrooms", priority: "high", due_at: "2026-10-30" });
  // small talk: nothing written
  const r2 = recorder();
  await applyInsights(memdb({}, r2.rpcs), { leadId: "L1", messageId: "M10", now: NOW, buyerText: "ok terima kasih", insights: empty });
  assert.equal(r2.calls.length, 0);
});

test("a stage milestone needs the buyer's own words from this message", async () => {
  const seed = { ai_pipeline_stages: [{ id: "ST-ub", key: "unit_booked" }] };
  const run = async (buyerText, evidence) => { const { calls, rpcs } = recorder(); await applyInsights(memdb(seed, rpcs), { leadId: "L1", messageId: "M1", buyerText, now: NOW, insights: { ...empty, stage_update: { stage: "unit_booked", evidence } } }); return calls; };
  let c = await run("Saya dah bayar booking fee semalam!", "dah bayar booking fee");
  assert.deepEqual(c, [["ai_lead_set_stage", { p_lead: "L1", p_stage: "ST-ub", p_note: null, p_source: "ai", p_evidence: "dah bayar booking fee" }]]);
  c = await run("Bila boleh booking?", "the buyer has booked");   // paraphrase, not the buyer's words
  assert.equal(c.length, 0);
  c = await run("Saya nak booking minggu depan", "");
  assert.equal(c.length, 0);
});

test("the AI sees the client's known fields, the summary and only the milestones it may set ahead of the lead", () => {
  const stages = [
    { id: "a", key: "new_enquiry", name: "New Enquiry", position: 1, active: true },
    { id: "b", key: "interested", name: "Interested / Qualified", position: 3, active: true, ai_settable: true },
    { id: "c", key: "unit_booked", name: "Unit Booked", position: 9, active: true, ai_settable: true, description: "The buyer has booked a unit" },
    { id: "d", key: "loan_approved", name: "Loan Approved", position: 12, active: true, ai_settable: false },
    { id: "e", key: "cancelled", name: "Cancelled / Lost", position: 17, active: true, is_lost: true, ai_settable: true },
  ];
  const ctx = profileContext({ stage_id: "b", profile: { work_area: "KLCC", occupants: "" }, profile_meta: { work_area: { status: "inferred" } }, qualification: { purpose: "own_stay", signals: {} },
    ai_summary: { text: "Works in KLCC.", next_action: { action: "Call", status: "open" } } }, stages);
  assert.deepEqual(ctx.known, { work_area: { value: "KLCC", status: "inferred" }, purpose: { value: "own_stay", status: "confirmed" } });
  assert.equal(ctx.summary, "Works in KLCC.");
  assert.equal(ctx.open_next_action, "Call");
  assert.deepEqual(ctx.stages_ai_may_set, [{ stage: "unit_booked", name: "Unit Booked", meaning: "The buyer has booked a unit" }]);
});
