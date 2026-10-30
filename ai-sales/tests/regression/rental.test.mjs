// 31 Oct 2026: a buyer asked which M Aurora layout gives the better rental margin. The AI made up "RM2.50 psf" and the
// reply was blocked (its rents were also mistaken for loan instalments). Now rent and yield come from a sourced rate —
// the knowledge base first, then web research — and the figures are worked out in code. Fake database and AI only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRentRates, findRentRates, rentalEstimate, renderRental, RENTAL_Q } from "../../../sales/shared/rental.mjs";
import { respond } from "../../lib/orchestrator.mjs";
import { buildSystemPrompt } from "../../lib/prompt.mjs";

const AURORA = { name: "M AURORA", maintPsf: 0.33, layouts: [
  { layout: "Type D", size_sqft: "916", bedrooms: "3", price_from: "RM519,000" },
  { layout: "Type E", size_sqft: "1019", bedrooms: "4", price_from: "RM587,000" }] };

test("rates are read only from sentences about renting: psf ranges, single rates and per-room rents", () => {
  assert.deepEqual(parseRentRates("Sewa M Aurora: RM2.30–2.80 psf sebulan; bilik RM700–900 (iProperty, Okt 2026)"), { psf: [2.3, 2.8], room: [700, 900] });
  assert.deepEqual(parseRentRates("- Units are listed for rent at about RM2.50 per sq ft. Rooms rent for RM650 to RM850 per room."), { psf: [2.5, 2.5], room: [650, 850] });
  assert.deepEqual(parseRentRates("Maintenance RM0.33 psf. Harga dari RM519,000."), { psf: null, room: null }, "maintenance and prices are not rents");
  assert.ok(RENTAL_Q.test("Mana margin lg untung?") && RENTAL_Q.test("Boleh buat kiraan sewaan bilik") && !RENTAL_Q.test("Harga 3 bilik berapa?"));
});

test("the estimate: rent = rate × size, gross yield = 12 months ÷ price, rent after maintenance, per-room totals", () => {
  const r = { psf: [2.3, 2.8], room: [700, 900], source: { kind: "knowledge base", basis: "project", title: "Sewa M Aurora" } };
  const e = rentalEstimate(AURORA, r);
  const d = e.layouts.find((x) => x.layout === "Type D");
  assert.equal(d.whole_unit_rent_per_month, "RM2,110–RM2,560"); // 916 × 2.30 / 2.80, to the nearest RM10
  assert.equal(d.gross_yield, "4.9%–5.9%");
  assert.equal(d.maintenance_per_month, "RM300");
  assert.equal(d.rent_after_maintenance, "RM1,810–RM2,260");
  assert.equal(d.room_rent_total_per_month, "RM2,100–RM2,700"); // 3 rooms
  const view = renderRental([{ estimate: e, rates: r }]);
  assert.match(view.label, /ESTIMATE/);
  assert.equal(view.projects[0].source, 'our knowledge base ("Sewa M Aurora")');
  assert.equal(view.projects[0].based_on, "a rent rate recorded for this project");
  for (const v of [2110, 2560, 300, 1810, 2260, 2100, 2700]) assert.ok(e.amounts.includes(v), String(v));
  assert.equal(rentalEstimate(AURORA, { psf: null, room: null }), null);
});

// a general rental reference written like the owner's (figures here are made up for the test)
const REFERENCE = { id: "k1", project_id: null, title: "KL CONDO RENTAL REFERENCE", content: [
  "Purpose: rental per square foot (PSF) calculations.",
  "Source: Example Research, 1H 2026.",
  "| Location | Indicative asking rental (RM psf/month) |",
  "| Bangsar / Bangsar South / Seputeh | RM2.40–RM5.60 |",
  "| Cochrane / Maluri | RM3.80–RM4.50 |",
  "Use RM2.50 psf as an initial conservative scenario for preliminary calculations.",
  "Do not treat RM2.50 psf as the actual rental rate for every condominium.",
  "Examples using RM2.50 psf:", "| 600 sqft | RM1,500 |",
  "Old Klang Road maintenance RM0.60 psf."].join("\n") };

test("where the rate comes from: the project's own entry, then the area's row, then the conservative scenario, then the web", () => {
  const web = { found: true, findings: "- Similar condos nearby rent at RM2.40 to RM2.70 per sq ft. https://www.iproperty.com.my/x", sources: [{ url: "https://www.iproperty.com.my/x" }], at: "2026-10-31T00:00:00Z" };
  const own = { id: "k9", project_id: "pa", title: "Sewa M Aurora", content: "Sewa unit: RM2.30–2.80 psf" };
  const aurora = { id: "pa", name: "M AURORA", area: "Old Klang Road" };
  assert.equal(findRentRates({ knowledge: [REFERENCE, own], project: aurora, web }).source.basis, "project");
  const area = findRentRates({ knowledge: [REFERENCE], project: { id: "pb", name: "X", area: "Bangsar South" } });
  assert.deepEqual([area.psf, area.source.basis, area.source.place, area.source.cited], [[2.4, 5.6], "area", "Bangsar / Bangsar South / Seputeh", "Example Research, 1H 2026."]);
  const sc = findRentRates({ knowledge: [REFERENCE], project: aurora, web });
  assert.deepEqual([sc.psf, sc.source.basis], [[2.5, 2.5], "scenario"], "Old Klang Road is not in the table, and its maintenance line is not a rent");
  const w = findRentRates({ knowledge: [], project: aurora, web });
  assert.deepEqual([w.psf, w.source.kind, w.source.date, w.source.urls], [[2.4, 2.7], "web research", "2026-10-31", ["https://www.iproperty.com.my/x"]]);
  assert.equal(findRentRates({ knowledge: [], project: aurora, web: { found: false } }), null);
  const view = renderRental([{ estimate: rentalEstimate(AURORA, sc), rates: sc }]);
  assert.match(view.projects[0].based_on, /CONSERVATIVE SCENARIO .* not actual rent data for this area/);
});

/* ---------- the reply pipeline ---------- */
const NOW = new Date("2026-10-31T00:00:00Z");
function db(knowledge = []) {
  const t = {
    ai_settings: [{ id: 1, persona: { name: "Hafiz_Ai", reply_style: "adaptive" }, ai: { confidence_threshold: 0.7 }, business: {}, scoring: {}, compliance: {} }],
    projects: [{ id: "pa", slug: "m-aurora", data: { n: "M AURORA", l: "Old Klang Road", maintPsf: "0.33", types: [{ name: "Type D", price: "RM519,000", size: "916", beds: "3" }, { name: "Type E", price: "RM587,000", size: "1019", beds: "4" }] } }],
    ai_knowledge_chunks: knowledge, ai_leads: [], ai_lead_interests: [], ai_appointments: [], ai_project_facts: [], ai_project_prices: [], ai_project_units: [], ai_active_promotions: [],
  };
  return { get: async (p) => structuredClone(t[p.split("?")[0]] || []), rpc: async () => [], post: async () => [{}], patch: async () => null };
}
const draft = (messages, o = {}) => ({ messages, language: "ms", intent: "project_info", agent: "knowledge", confidence: 0.9, facts_used: [], qualification_updates: {}, appointment_request: { wanted: false }, handover: { needed: false }, objection_key: "", workflow: {}, ...o });
const llmOf = (...replies) => { const calls = []; const f = async (p) => { if (p.schema?.properties?.routes) return { data: { routes: [], missing_place: "" }, model: "m", usage: {} }; calls.push(p); return { data: replies[Math.min(calls.length - 1, replies.length - 1)], model: "m", usage: {} }; }; f.calls = calls; return f; };
const ctxOf = (call) => JSON.parse(call.messages.at(-1).content.match(/<verified_context>\s*([\s\S]*?)\s*<\/verified_context>/)[1]);
const history = [{ role: "user", text: "Share M Aurora info" }, { role: "assistant", text: "Saya Hafiz_Ai, pembantu AI Hafizan Hanis. M AURORA di Old Klang Road." }];
const KB = [{ id: "k9", project_id: "pa", title: "Sewa M Aurora", content: "Sewa M Aurora / Old Klang Road: RM2.30–2.80 psf sebulan, seunit penuh (iProperty, Okt 2026)." }];

test("respond(): with a rate in the knowledge base the AI gets the estimate and a reply quoting it is sent (rents are not instalments)", async () => {
  const llm = llmOf(draft(["Anggaran sewa (rujukan knowledge base kami, bukan jaminan):\n• Type D: ~RM2,110–RM2,560 sebulan, gross yield 4.9%–5.9%\n• Type E: ~RM2,340–RM2,850 sebulan, gross yield 4.8%–5.8%\n\nType D sedikit lebih tinggi. Selepas maintenance, Type D ~RM1,810–RM2,260 🏡"], { intent: "objection" }));
  const r = await respond({ db: db(KB), llm, message: "Mana margin lg untung?", history, now: NOW, mode: "simulate" });
  const c = ctxOf(llm.calls[0]);
  assert.match(c.rental_estimates.label, /ESTIMATE/);
  assert.equal(c.rental_estimates.projects[0].layouts[0].whole_unit_rent_per_month, "RM2,110–RM2,560");
  assert.equal(r.decision, "reply", JSON.stringify(r.violations));
  assert.match(r.reply, /RM2,110–RM2,560 sebulan/);
});

test("respond(): the owner's conservative scenario is used (labelled) when the area has no rate", async () => {
  const llm = llmOf(draft(["Anggaran senario konservatif (RM2.50 psf, bukan data sewa sebenar Old Klang Road): Type D ~RM2,290 sebulan, gross yield 5.3%. Bukan jaminan."], { intent: "objection" }));
  const r = await respond({ db: db([REFERENCE]), llm, message: "Mana margin lg untung?", history, now: NOW, mode: "simulate" });
  const est = ctxOf(llm.calls[0]).rental_estimates.projects[0];
  assert.match(est.based_on, /CONSERVATIVE SCENARIO/);
  assert.equal(est.layouts[0].whole_unit_rent_per_month, "RM2,290");
  assert.equal(r.decision, "reply", JSON.stringify(r.violations));
});

test("respond(): no source — no figures; an invented rent is blocked as an unsourced rent, and the web is searched for rental listings", async () => {
  const invented = draft(["Kalau ikut RM2.50 psf, anggaran sewa Type D ~RM2,290 sebulan, yield ~5.3%."], { intent: "objection" });
  const llm = llmOf(invented);
  const r = await respond({ db: db(), llm, message: "Boleh buat kiraan? Anggaran utk sewaan bilik", history, now: NOW, mode: "simulate", deferWeb: true, research: { research: async () => ({ text: "", sources: [] }) } });
  assert.equal(ctxOf(llm.calls[0]).rental_estimates.status, "NO SOURCE");
  assert.ok(r.violations.some((v) => v.code === "unsourced_rent"), JSON.stringify(r.violations));
  assert.notEqual(r.decision, "reply");
  assert.match(r.pending_research.question, /rental rates for M AURORA \(Old Klang Road\)/);
  // the second step: web findings give a rate, and the estimate is built from it
  const web = { question: "x", found: true, findings: "- Condos near M Aurora rent at RM2.40 to RM2.70 per sq ft. https://www.iproperty.com.my/x", sources: [{ url: "https://www.iproperty.com.my/x" }], searches: 2, at: "2026-10-31T00:00:00Z" };
  const llm2 = llmOf(draft(["Anggaran ikut listing semasa (iProperty, 31 Okt): Type D ~RM2,200–RM2,470 sebulan. Bukan jaminan."], { intent: "objection" }));
  const r2 = await respond({ db: db(), llm: llm2, message: "Boleh buat kiraan? Anggaran utk sewaan bilik", history, now: NOW, mode: "simulate", _prior: { routes: null, web } });
  const est = ctxOf(llm2.calls[0]).rental_estimates;
  assert.match(est.projects[0].source, /web research \(2026-10-31\): https:\/\/www\.iproperty\.com\.my\/x/);
  assert.equal(est.projects[0].layouts[0].whole_unit_rent_per_month, "RM2,200–RM2,470");
  assert.equal(r2.decision, "reply", JSON.stringify(r2.violations));
});

test("prompt: rent and yield only from rental_estimates, labelled as estimates with the source; none without a source", () => {
  const sys = buildSystemPrompt({ persona: { name: "Hafiz_Ai" } });
  assert.match(sys, /Rent, gross yield and "which layout gives the better margin \/ return" come only from rental_estimates/);
  assert.match(sys, /Never work out a rent, yield or rate yourself/);
  assert.match(sys, /If rental_estimates says NO SOURCE: give no rent or yield figure/);
});
