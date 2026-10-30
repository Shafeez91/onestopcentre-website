// Master Persona (30 Oct 2026) §3: the 9-step discovery order and its pathways, worked out in code from what the CRM
// knows. Scenario numbers follow the persona's own test list (§19).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextDiscovery, SHOWROOM_Q } from "../../lib/discovery.mjs";
import { respond } from "../../lib/orchestrator.mjs";
import { buildSystemPrompt } from "../../lib/prompt.mjs";
import { cleanUpdates } from "../../../sales/shared/profile.mjs";

const k = (o) => Object.fromEntries(Object.entries(o).map(([key, value]) => [key, { value, status: "confirmed" }]));
const step = (r) => r.next?.key ?? null;
const kn = (name, o) => k({ preferred_name: name, ...o });

test("1 · a new buyer: name first, then area familiarity, then purpose", () => {
  assert.equal(step(nextDiscovery({})), "name");
  assert.equal(step(nextDiscovery({ known: k({ preferred_name: "Aina" }) })), "area_familiarity");
  assert.equal(step(nextDiscovery({ known: k({ preferred_name: "Aina", area_familiarity: "familiar" }) })), "purpose");
});

test("2 + 3 · a name already in the CRM, or a buyer who declined to share it, is never asked for again", () => {
  // a WhatsApp / form name alone is only a guess: the AI checks it once ("Blh sy panggil Aina ya?") before moving on
  const r = nextDiscovery({ buyerName: "Aina" });
  assert.equal(step(r), "name");
  assert.match(r.next.ask, /Blh sy panggil Aina ya\?/);
  assert.equal(step(nextDiscovery({ known: kn("Aina", { preferred_name: "Aina" }) })), "area_familiarity", "confirmed name");
  assert.equal(step(nextDiscovery({ known: k({ preferred_name: "not_disclosed" }) })), "area_familiarity");
});

test("4 + 5 · area familiarity: 'unsure' still asks; familiar or not familiar moves on", () => {
  assert.equal(step(nextDiscovery({ known: kn("A", { area_familiarity: "unsure" }) })), "area_familiarity");
  assert.equal(step(nextDiscovery({ known: kn("A", { area_familiarity: "not_familiar" }) })), "purpose");
});

test("6 · own stay follows the whole order, one step at a time", () => {
  const seq = [];
  const known = { purpose: "own_stay", area_familiarity: "familiar" };
  const fill = { living_and_work_area: { residential_area: "Setapak" }, commute: { commute_mode: ["rail"] }, first_home: { first_home: "yes" },
    marital_status: { marital_status: "married" }, household: { occupants: "4 (couple + 2 children)" }, showroom: { showroom_visit: "not_visited" } };
  for (let i = 0; i < 8; i++) {
    const r = nextDiscovery({ known: kn("Aina", known) });
    if (!r.next) break;
    seq.push(r.next.step);
    Object.assign(known, fill[r.next.key]);
  }
  assert.deepEqual(seq, [4, 5, 6, 7, 8, 9]);
  assert.equal(nextDiscovery({ known: kn("Aina", known) }).next, null);
});

test("7 · investment skips where they live and work, commute, marital status and children", () => {
  let r = nextDiscovery({ known: kn("B", { area_familiarity: "familiar", purpose: "investment" }) });
  assert.equal(r.pathway, "investment");
  assert.equal(step(r), "first_home");
  r = nextDiscovery({ known: kn("B", { area_familiarity: "familiar", purpose: "investment", first_home: "no" }) });
  assert.equal(step(r), "investment_goals");
  r = nextDiscovery({ known: kn("B", { area_familiarity: "familiar", purpose: "investment", first_home: "no", budget_max: 600000 }) });
  assert.equal(step(r), "showroom");
});

test("8 · both: own-stay questions apply", () => {
  assert.equal(step(nextDiscovery({ known: kn("C", { area_familiarity: "familiar", purpose: "both" }) })), "living_and_work_area");
});

test("undecided / unknown purpose: clarify it before anything else", () => {
  const r = nextDiscovery({ known: kn("D", { area_familiarity: "familiar", purpose: "undecided" }) });
  assert.equal(step(r), "purpose");
  assert.equal(r.pathway, "unknown");
});

test("14 + 15 · marital status declined or single: no children question; married with the household known: no children question", () => {
  const base = { area_familiarity: "familiar", purpose: "own_stay", residential_area: "Setapak", commute_mode: ["own_car"], first_home: "yes" };
  assert.equal(step(nextDiscovery({ known: kn("E", { ...base, marital_status: "not_disclosed" }) })), "showroom");
  assert.equal(step(nextDiscovery({ known: kn("E", { ...base, marital_status: "single" }) })), "showroom");
  assert.equal(step(nextDiscovery({ known: kn("E", { ...base, marital_status: "married" }) })), "household");
  assert.equal(step(nextDiscovery({ known: kn("E", { ...base, marital_status: "married", occupants: "2 (couple, no children)" }) })), "showroom");
});

test("17 + 18 + 19 · a showroom question jumps to step 9; a buyer ready to act gets no discovery; a booked or visited buyer is not asked again", () => {
  for (const m of ["Showroom kat mana?", "Can I view the show unit this Saturday?", "Nak datang tengok esok boleh?", "Buka pukul berapa?", "Boleh buat appointment?", "where is the showroom"]) {
    const r = nextDiscovery({ message: m });
    assert.equal(r.showroom_priority, true, m);
    assert.equal(step(r), "showroom");
  }
  for (const m of ["Berapa harga M Mira?", "How far is the LRT?", "Monthly berapa?"]) assert.equal(SHOWROOM_Q.test(m), false, m);
  assert.equal(nextDiscovery({ readiness: "ready", buyerName: "F" }).next, null);
  const all = { area_familiarity: "familiar", purpose: "own_stay", residential_area: "KL", commute_mode: ["own_car"], first_home: "yes", marital_status: "single" };
  assert.equal(nextDiscovery({ known: kn("G", all), appointments: 1 }).next, null, "an open appointment counts as step 9");
  assert.equal(nextDiscovery({ known: kn("G", { ...all, showroom_visit: "visited" }) }).next, null);
});

test("profile fields for the new steps are accepted from the AI (preferred name, showroom visit)", () => {
  assert.deepEqual(cleanUpdates([{ field: "preferred_name", value: "Puan Aina", status: "confirmed" }, { field: "showroom_visit", value: "visited", status: "confirmed" }, { field: "showroom_visit", value: "maybe", status: "confirmed" }]),
    [{ field: "preferred_name", value: "Puan Aina", status: "confirmed" }, { field: "showroom_visit", value: "visited", status: "confirmed" }]);
});

test("the prompt follows the persona: discovery order, one question after the answer, showroom booking is not a hand-over", () => {
  const sys = buildSystemPrompt({ persona: { tone: "MASTER PERSONA" } }, [], { calendar: true });
  assert.match(sys, /Buyer discovery \(the owner's order/);
  assert.match(sys, /Always answer the buyer's actual question first\. Then, when it fits naturally, ask the one question in discovery\.next/);
  assert.match(sys, /investment buyers skip where they live and work, commute, marital status and children/);
  assert.match(sys, /discovery\.showroom_priority is true/);
  assert.match(sys, /ready to book a unit, pay or sign \(a showroom visit is not a reason/);
  assert.doesNotMatch(sys, /is ready to book, pay or sign;/);
  assert.match(sys, /MASTER PERSONA/, "the owner's persona text is kept");
});

test("respond(): the reply AI gets the discovery step worked out from the lead's CRM profile", async () => {
  const t = { ai_settings: [{ id: 1, persona: { name: "Hafiz_Ai" }, ai: { confidence_threshold: 0.7 }, business: {}, scoring: {}, compliance: {} }],
    projects: [{ id: "mm", slug: "m-mira", data: { n: "M MIRA", l: "Wangsa Maju", types: [{ name: "Type A", price: "RM476,000" }] } }],
    ai_leads: [{ id: "L1", lead_code: "OSC-1", contact: { full_name: "Aina", salutation: null, preferred_language: "ms" }, qualification: { purpose: "own_stay" }, profile: { preferred_name: "Aina", area_familiarity: "familiar" }, profile_meta: {}, ai_summary: {} }],
    ai_pipeline_stages: [], ai_appointments: [] };
  const db = { get: async (p) => structuredClone(t[p.split("?")[0]] || []), rpc: async () => [], post: async () => [{}], patch: async () => null };
  const calls = [];
  const llm = async (p) => { calls.push(p); return { data: { language: "ms", intent: "price", agent: "knowledge", confidence: 0.9, facts_used: [], messages: ["Saya Hafiz_Ai, pembantu AI. M MIRA dari RM476,000 (anggaran)."],
    qualification_updates: {}, appointment_request: { wanted: false }, handover: { needed: false }, objection_key: "" }, model: "m", usage: {} }; };
  await respond({ db, llm, leadId: "00000000-0000-0000-0000-000000000001", message: "Berapa harga M Mira?", now: new Date("2026-10-30T02:00:00Z") });
  const ctx = JSON.parse(calls[0].messages.at(-1).content.match(/<verified_context>\s*([\s\S]*?)\s*<\/verified_context>/)[1]);
  assert.equal(ctx.discovery.next.key, "living_and_work_area", "name, familiarity and purpose are known: step 4 is next");
  assert.equal(ctx.discovery.pathway, "own_stay");
  assert.equal(ctx.discovery.showroom_priority, false);
});
