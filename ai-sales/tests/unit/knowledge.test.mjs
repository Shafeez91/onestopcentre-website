// Property knowledge retrieval, checked against the real website listings (helpers/live-projects.mjs):
// what the project page states reaches the AI for the right project, missing details are marked missing,
// conflicts are flagged, and a direct answer from published data is sent without an advisor hand-over.
// The model itself is scripted here; the live behaviour is covered by tests/eval/run-eval.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadContext } from "../../lib/context.mjs";
import { renderContext, buildSystemPrompt } from "../../lib/prompt.mjs";
import { respond } from "../../lib/orchestrator.mjs";
import { projectSpecs, coverage, conflicts, mentionedProjects, resolveFocus, unitList, textDistances, transitDistanceConflicts } from "../../../sales/shared/listing.mjs";
import { LIVE_PROJECTS } from "./helpers/live-projects.mjs";

const NOW = new Date("2026-10-28T04:00:00Z");
const ID = Object.fromEntries(LIVE_PROJECTS.map((p) => [p.data.n.trim(), p.id]));
const db = (over = {}) => {
  const t = { ai_settings: [{ id: 1, business: { price_max_age_days: 30 }, ai: { confidence_threshold: 0.7, max_reply_chars: 700 }, persona: {} }], projects: LIVE_PROJECTS,
    ai_project_facts: [], ai_project_prices: [], ai_project_units: [], ai_active_promotions: [], ai_objections: [], settings: [], ai_leads: [], ai_lead_interests: [], ai_appointments: [], ...over };
  return { get: async (p) => structuredClone(t[p.split("?")[0]] || []), rpc: async () => [], post: async () => [{ id: "r1" }], patch: async () => null };
};
const ctxJson = async (opts, over) => {
  const ctx = await loadContext(db(over), { now: NOW, ...opts });
  return { ctx, j: JSON.parse(renderContext(ctx).replace(/^<verified_context>\n|\n<\/verified_context>$/g, "")) };
};
const proj = (j, name) => j.projects.find((p) => p.name === name);
const carParks = (p) => Object.fromEntries(p.layouts_PUBLISHED.map((l) => [l.layout, l.car_parks]));
const draft = (reply, o = {}) => ({ reply, language: "ms", intent: "project_info", agent: "knowledge", confidence: 0.9, facts_used: [],
  qualification_updates: { purpose: "", first_home: "", bedrooms: "", size_sqft: "", budget_min: 0, budget_max: 0, employment: "", financing: "", timeline_months: 0, readiness: "", concerns: "", preferred_project_id: "", asked_price: false, requested_brochure: false },
  financing_updates: {}, appointment_request: { wanted: false, kind: "", preferred_text: "", project_id: "", slot_id: "" }, handover: { needed: false, reason: "", summary: "", next_action: "" }, objection_key: "", ...o });
const scripted = (d) => { const fn = async (p) => { fn.calls.push(p); return { data: d, model: "test", usage: { input_tokens: 1, output_tokens: 1 } }; }; fn.calls = []; return fn; };
const intro = { role: "assistant", text: "Hai! Saya pembantu AI One Stop Centre." };

test("the website's car parks per layout reach the AI (the field the old context dropped)", async () => {
  const { j } = await ctxJson({ message: "M Aurora Type C dapat berapa parking?" });
  assert.deepEqual(carParks(proj(j, "M AURORA")), { "Type A": "1", "Type B": "1", "Type C": "2 (Tandem)", "Type D": "2 (Tandem / SBS)", "Type E": "2 (SBS)" });
  // every published layout of every project carries its car parks, in focus or not
  for (const p of j.projects) for (const l of p.layouts_PUBLISHED) assert.ok(l.car_parks, `${p.name} ${l.layout}`);
  assert.deepEqual(carParks(proj(j, "M ASPIRA")), { "Type A": "1", "Type B": "2 (Tandem/SBS)", "Type C": "2-3" }, "ranges and notes kept exactly as published");
});

test("Test 1 · exact specification: a direct car-park answer from published data is sent, not handed over", async () => {
  const llm = scripted(draft("Hai, saya pembantu AI 😊 M AURORA Type A datang dengan 1 petak parking, ikut maklumat projek semasa."));
  const r = await respond({ db: db(), llm, message: "M Aurora Type A ada berapa parking?", now: NOW, mode: "simulate" });
  assert.equal(r.decision, "reply", JSON.stringify(r.violations));
  assert.ok(!r.actions.some((a) => a.type === "handover"));
  assert.match(llm.calls[0].messages.at(-1).content, /"layout":"Type A","size_sqft":"556","bedrooms":"1\+1","bathrooms":"1","car_parks":"1"/);
  assert.deepEqual(r.retrieval, { focus: ["M AURORA"], focus_source: "named in the buyer's current message", ambiguous: false, not_on_record: { "M AURORA": ["address", "booking_fee", "sinking_fund", "title_type", "showroom"] }, conflicts: {} }, "logged with the run");
});

test("Test 2 · unit-specific values: per-layout car parks for the project in focus, ranges preserved", async () => {
  const { j } = await ctxJson({ message: "M ARIA parking berapa?" });
  assert.deepEqual(carParks(proj(j, "M ARIA")), { "Type A": "2", "Type B": "2-4" });
  assert.equal(proj(j, "M ARIA").in_focus, true);
  const sys = buildSystemPrompt({}, []);
  assert.match(sys, /When a value differs by layout, give it per layout/);
  assert.match(sys, /A range such as "1-2" means it depends on the unit or package/);
});

test("Test 3 · missing information: M ARAYA has no layouts, so car parks, bedrooms and maintenance are marked not on record", async () => {
  const { j } = await ctxJson({ message: "M Araya dapat berapa parking? maintenance berapa?" });
  const a = proj(j, "M ARAYA");
  assert.deepEqual(a.layouts_PUBLISHED, []);
  for (const k of ["layouts", "car_parks", "bathrooms", "maintenance_fee"]) assert.ok(a.not_on_record.includes(k), k);
  assert.equal(a.money_INDICATIVE.maintenance_fee_psf, undefined);
  assert.equal(a.specs_PUBLISHED.bedrooms_max, "3", "the website's 'up to 3 bedrooms' is still given");
  assert.match(buildSystemPrompt({}, []), /never borrow a figure from another project, a similar layout or industry norms/);
  // an invented fee is still blocked by the business-rule checker
  const r = await respond({ db: db(), llm: scripted(draft("Hai, saya pembantu AI. Maintenance M ARAYA RM0.45 psf.")), message: "Maintenance M Araya?", now: NOW, mode: "simulate" });
  assert.notEqual(r.decision, "reply");
});

test("Test 4 · several projects: the one named now wins; a comparison keeps both; another project's figures stay separate", async () => {
  const history = [intro, { role: "user", text: "Saya tengok M MIRA" }, { role: "assistant", text: "M MIRA di Wangsa Maju ada Type A, B dan C." }];
  let { j } = await ctxJson({ message: "Kalau M Aurora pula, parking berapa?", history });
  assert.deepEqual(j.conversation_focus.project_names, ["M AURORA"]);
  ({ j } = await ctxJson({ message: "Banding M Aria dengan M Mira", history }));
  assert.deepEqual(j.conversation_focus.project_names, ["M ARIA", "M MIRA"]);
  assert.equal(j.conversation_focus.ambiguous, false);
  assert.deepEqual(carParks(proj(j, "M MIRA")), { "Type A": "1-2", "Type B": "2", "Type C": "3" });
  assert.deepEqual(carParks(proj(j, "M ARIA")), { "Type A": "2", "Type B": "2-4" });
});

test("Test 5 · other specifications reach the AI for the project in focus", async () => {
  const { j } = await ctxJson({ message: "M Nova details?" });
  const n = proj(j, "M NOVA");
  assert.equal(n.tenure, "Leasehold"); assert.equal(n.specs_PUBLISHED.lease_years, "99");
  assert.deepEqual(n.expected_completion, { value: "2026", label: "PUBLISHED (developer's target)" });
  assert.equal(n.specs_PUBLISHED.furnishing, "80% FURNISHED");
  assert.ok(n.specs_PUBLISHED.furnished_items.includes("Washing machine"));
  assert.equal(n.specs_PUBLISHED.total_units, "2074"); assert.equal(n.specs_PUBLISHED.towers.length, 3);
  assert.equal(n.money_INDICATIVE.maintenance_fee_psf, "RM0.33 psf");
  assert.deepEqual(n.layouts_PUBLISHED[1], { layout: "Type B", size_sqft: "850", bedrooms: "3", bathrooms: "2", car_parks: "2", price_from: "RM430,000 (INDICATIVE)" });
  assert.deepEqual(n.nearby.public_transport, ["MRT Metro Prima (Putrajaya Line) (~2.5 km)", "MRT Kepong Baru"]);
  // freehold: no lease years, and that is "not applicable", not missing
  const { j: j2 } = await ctxJson({ message: "M Aria?" });
  assert.equal(proj(j2, "M ARIA").specs_PUBLISHED.lease_years, undefined);
  assert.equal(coverage(projectSpecs(LIVE_PROJECTS.find((p) => p.id === ID["M ARIA"]).data)).lease_years.status, "not_applicable");
  // booking fee is never on the website: it reaches the AI only as a staff-verified fact
  const { j: j3 } = await ctxJson({ message: "M Nova booking fee?" }, { ai_project_facts: [{ project_id: ID["M NOVA"], booking_fee: "RM1,000", verified_at: "2026-10-20T00:00:00Z" }] });
  assert.equal(proj(j3, "M NOVA").verified_facts.booking_fee, "RM1,000");
  assert.equal(proj(j3, "M NOVA").verified_facts.label, "VERIFIED");
});

test("Test 6 · long descriptions: details deep in the surroundings text and the description reach the AI in full", async () => {
  const long = "M TEST – SURROUNDINGS\n" + "1. 1km – Filler Place\n".repeat(150) + "99. 120m – SK Hidden Detail School";
  const projects = [{ id: "x1", slug: "m-test", data: { n: "M TEST", nearby: long, desc: "Each unit has 2 car parks. 29 EV bays.", types: [{ name: "Type A", beds: "3" }] } }];
  const { j } = await ctxJson({ message: "M Test sekolah dekat?" }, { projects });
  assert.ok(long.length > 3000);
  assert.match(proj(j, "M TEST").specs_PUBLISHED.surroundings, /SK Hidden Detail School/);
  assert.match(proj(j, "M TEST").specs_PUBLISHED.description, /2 car parks/);
  // the real M AZURA description carries the EV bays
  const { j: az } = await ctxJson({ message: "M Azura EV charging?" });
  assert.match(proj(az, "M AZURA").specs_PUBLISHED.description, /29 EV Bays/);
  assert.ok(proj(az, "M AZURA").facilities.includes("EV charging stations"), "the full facility list (51), not the first 15");
  assert.equal(proj(az, "M AZURA").facilities.length, 51);
});

test("Test 7 · CRM and conversation memory: a follow-up question uses the project already known", async () => {
  // from the conversation
  let { j } = await ctxJson({ message: "parking berapa?", history: [intro, { role: "user", text: "Nak tahu pasal M Aspira" }, { role: "assistant", text: "M ASPIRA di Taman Desa…" }] });
  assert.deepEqual(j.conversation_focus.project_names, ["M ASPIRA"]);
  assert.equal(j.conversation_focus.ambiguous, false);
  // from the CRM when the chat has not named one
  const lead = { id: "L1", lead_code: "OSC-1", primary_project_id: ID["M MIRA"], qualification: {}, contact: { full_name: "Aina" } };
  ({ j } = await ctxJson({ leadId: "L1", message: "parking berapa?" }, { ai_leads: [lead], ai_lead_interests: [{ lead_id: "L1", project_id: ID["M MIRA"] }] }));
  assert.deepEqual(j.conversation_focus, { project_ids: [ID["M MIRA"]], project_names: ["M MIRA"], source: "the lead's project in the CRM", ambiguous: false });
  // the production case of 28 Oct: three projects discussed, a buyer asks about parking for 2-bedroom units
  ({ j } = await ctxJson({ message: "Oh ye lupa nk Tanya. Parking klu dua bilik ada berapa ye?", history: [intro, { role: "assistant", text: "M NOVA Type A (Kepong) dan M ASPIRA Type A (Taman Desa) adalah 80% furnished. M AZURA Type A pula tiada perabot." }] }));
  assert.deepEqual(j.conversation_focus.project_names.sort(), ["M ASPIRA", "M AZURA", "M NOVA"]);
  assert.deepEqual([carParks(proj(j, "M NOVA"))["Type A"], carParks(proj(j, "M ASPIRA"))["Type A"], carParks(proj(j, "M AZURA"))["Type A"]], ["1-2", "1", "1-2"]);
  // nothing named anywhere and no CRM project: ambiguous, so the AI asks which project
  ({ j } = await ctxJson({ message: "parking berapa?" }));
  assert.deepEqual([j.conversation_focus.project_ids, j.conversation_focus.ambiguous], [[], true]);
});

test("Test 8 · conflicting records are flagged; an old staff figure does not settle a disagreement, a fresh one does", async () => {
  const facts = (verified_at) => ({ ai_project_facts: [{ project_id: ID["M MIRA"], maintenance_fee_psf: 0.42, verified_at }] });
  let { j } = await ctxJson({ message: "M Mira maintenance?" }, facts("2026-06-01T00:00:00Z"));
  const mf = (j) => proj(j, "M MIRA").conflicts.find((c) => c.field === "maintenance_fee");
  assert.deepEqual(mf(j), { field: "maintenance_fee", values: ["website: RM0.38 psf", "staff check: RM0.42 psf"], resolved: false });
  // the live M MIRA listing also contradicts itself on transit distances (brochure text vs transit list)
  assert.equal(proj(j, "M MIRA").conflicts.find((c) => c.field === "transport")?.resolved, false);
  ({ j } = await ctxJson({ message: "M Mira maintenance?" }, facts("2026-10-25T00:00:00Z")));
  assert.equal(mf(j).resolved, true);
  // the live M AZURA listing contradicts itself: "Unfurnished" with 12 furnished items listed
  ({ j } = await ctxJson({ message: "M Azura fully furnished ke?" }));
  assert.equal(proj(j, "M AZURA").conflicts[0].field, "furnishing");
  assert.equal(proj(j, "M AZURA").conflicts[0].resolved, false);
  assert.match(buildSystemPrompt({}, []), /if false, do not state either as fact: say that detail is being reconfirmed and hand over \(reason conflicting_info\)/);
});

test("Test 9 · answer rules: search before escalating, answer published specs directly, money figures stay indicative", async () => {
  const sys = buildSystemPrompt({ persona: { name: "Hafizan Hanis" } }, []);
  assert.match(sys, /Search before you escalate/);
  assert.match(sys, /Do not hand over or say an advisor must confirm a published specification/);
  assert.match(sys, /Do not hand over just because a figure is INDICATIVE/);
  assert.match(sys, /You are Hafizan Hanis/);
  // a maintenance answer with the indicative wording is sent; without it the checker still asks for the label
  let r = await respond({ db: db(), llm: scripted(draft("Hai, saya pembantu AI 😊 Maintenance fee M MIRA sekitar RM0.38 psf (anggaran dari listing).")), message: "Maintenance M Mira berapa?", now: NOW, mode: "simulate" });
  assert.equal(r.decision, "reply", JSON.stringify(r.violations));
  r = await respond({ db: db(), llm: scripted(draft("Hai, saya pembantu AI. Maintenance fee M MIRA RM0.38 psf.")), message: "Maintenance M Mira berapa?", now: NOW, mode: "simulate" });
  assert.equal(r.attempts[0].violations[0].code, "unlabelled_indicative_price");
});

test("project names are matched as buyers type them, without mixing up similar names", () => {
  const ps = LIVE_PROJECTS.map((p) => ({ id: p.data.n.trim(), slug: p.slug, name: p.data.n }));
  assert.deepEqual(mentionedProjects("Berapa harga m-aria?", ps), ["M ARIA"]);
  assert.deepEqual(mentionedProjects("araya ok tak", ps), ["M ARAYA"], "'aria' is not found inside 'araya'");
  assert.deepEqual(mentionedProjects("MAURORA vs Nova", ps), ["M AURORA", "M NOVA"]);
  assert.deepEqual(mentionedProjects("I want to see the mirage", ps), []);
  assert.deepEqual(mentionedProjects("Projek mira yang wangsa maju", ps), ["M MIRA"]);
  assert.deepEqual(resolveFocus(ps, { message: "hi", history: [{ role: "user", text: "aspira dengan aurora" }] }), { ids: ["M ASPIRA", "M AURORA"], source: "the project(s) discussed most recently in this conversation", ambiguous: true });
});

test("coverage audit of the 7 live listings: per-field status, with not-applicable distinct from missing", () => {
  const rows = Object.fromEntries(LIVE_PROJECTS.map((p) => [p.data.n.trim(), coverage(projectSpecs(p.data))]));
  assert.equal(Object.keys(rows).length, 7);
  for (const [n, c] of Object.entries(rows)) if (n !== "M ARAYA") assert.equal(c.car_parks.status, "published", n);
  assert.equal(rows["M ARAYA"].car_parks.status, "missing");
  assert.equal(rows["M ARAYA"].maintenance_fee.status, "missing");
  assert.equal(rows["M ARIA"].lease_years.status, "not_applicable");
  assert.equal(rows["M AZURA"].furnishing.status, "conflict");
  assert.equal(rows["M MIRA"].towers.status, "missing", "M MIRA has no tower details on the website");
  assert.equal(rows["M AURORA"].address.status, "missing", "a placeholder address ('M Aurora') is not an address");
  assert.equal(rows["M ARAYA"].address.status, "published");
  assert.equal(rows["M MIRA"].booking_fee.status, "missing", "staff-only details stay missing until verified");
  assert.equal(conflicts(projectSpecs(LIVE_PROJECTS[0].data), null).length, 1);
});

// M MIRA as published on 29 Oct 2026: the brochure text in the "Location & accessibility" box said 650m / 820m while
// the transit list said 2.4km / 2km, and the AI quoted the text. The contradiction must be flagged, not answered.
const MIRA_TEXT = "M MIRA @ SRI RAMPAI – ACCESSIBILITY & SURROUNDING AMENITIES\n\nHIGHWAYS / ACCESSIBILITY\n\n1. DUKE Highway\n2. Middle Ring Road 2 (MRR2)\n\nPUBLIC TRANSPORT – LRT KELANA JAYA LINE\n\n1. 650m – Sri Rampai LRT Station\n2. 820m – Wangsa Maju LRT Station\n3. 4km – Setiawangsa LRT Station\n\nMRT 3 CIRCLE LINE (PROPOSED)\n\n1. 2km – Setapak MRT Station\n\nCOMMERCIAL / SHOPPING MALLS\n\n1. 500m – AEON Mall";
const mira = (transit, nearby = MIRA_TEXT) => ({ n: "M MIRA", l: "Wangsa Maju", near: { transit }, nearby });

test("distances in the location text are read line by line, in the formats staff paste", () => {
  assert.deepEqual(textDistances("1. 650m – Sri Rampai LRT Station\n• 1.2 km to KLCC\n* 820 m - Wangsa Maju LRT\nDUKE Highway\n2. Middle Ring Road 2").map((x) => [x.meters, x.key.trim()]),
    [[650, "sri rampai"], [1200, "klcc"], [820, "wangsa maju"]]);
});

test("transit list vs location text: a clear distance contradiction is a conflict the AI must not answer", async () => {
  const c = conflicts(projectSpecs(mira([{ t: "LRT", n: "Wangsa Maju", d: "2km", ok: true }, { t: "LRT", n: "Sri Rampai", d: "2.4km", ok: true }])), null);
  assert.deepEqual(c, [{ field: "transport", resolved: false, values: [
    "transit list: LRT Wangsa Maju 2km · location text: 820m – Wangsa Maju LRT Station",
    "transit list: LRT Sri Rampai 2.4km · location text: 650m – Sri Rampai LRT Station"] }]);
  assert.equal(coverage(projectSpecs(mira([{ t: "LRT", n: "Sri Rampai", d: "2.4km", ok: true }]))).transport.status, "conflict", "shown on 'What the AI knows'");
  // the same distances, small differences, a blank distance, or a station only one side names: no conflict
  for (const transit of [[{ t: "LRT", n: "Sri Rampai", d: "650m", ok: true }], [{ t: "LRT", n: "Sri Rampai", d: "800m", ok: true }], [{ t: "LRT", n: "Sri Rampai", d: "", ok: true }],
    [{ t: "MRT", n: "Setapak", d: "2.2km", ok: true }], [{ t: "LRT", n: "Setiawangsa", d: "4km", ok: true }], [{ t: "LRT", n: "Gombak", d: "9km", ok: true }]]) {
    assert.deepEqual(transitDistanceConflicts(projectSpecs(mira(transit))), [], JSON.stringify(transit));
  }
  assert.deepEqual(transitDistanceConflicts(projectSpecs(mira([{ t: "LRT", n: "Wangsa Maju", d: "2km", ok: true }], "* LRT Wangsa Maju\n* LRT Setiawangsa"))), [], "text without distances");
  assert.deepEqual(transitDistanceConflicts(projectSpecs(mira([{ t: "LRT", n: "Wangsa Maju", d: "4km", ok: true }], "4km – Setiawangsa LRT Station"))), [], "Setiawangsa is not Wangsa Maju");
  // the AI sees it as an unresolved conflict on the project
  const { j } = await ctxJson({ message: "M MIRA LRT dekat?" }, { projects: [{ id: "mm", slug: "m-mira", published: true, data: mira([{ t: "LRT", n: "Sri Rampai", d: "2.4km", ok: true }]) }] });
  assert.deepEqual(proj(j, "M MIRA").conflicts.map((x) => [x.field, x.resolved]), [["transport", false]]);
});

test("layouts are merged from 'types' and 'layouts' like the website does", () => {
  assert.deepEqual(unitList({ types: [{ name: "Type A", beds: "3", carparks: "" }], layouts: [{ name: "A", carparks: "2", img: "x" }, { name: "Type B" }] }).map((u) => [u.name, u.beds, u.carparks]),
    [["Type A", "3", "2"], ["Type B", undefined, undefined]]);
  const s = projectSpecs({ n: "X", carpark: { bays: "2" }, types: [{ name: "Type A" }, { name: "Type B", carparks: "3" }] });
  assert.deepEqual(s.layouts.map((l) => l.car_parks), ["2", "3"], "a project-wide car park figure fills layouts without their own");
});

test("monthly instalment per layout matches the website's loan calculator and is answered without asking for income first", async () => {
  const site = { settings: [{ data: { loan: { m: 100, r: 3.7, y: 35 } } }] };
  const history = [intro, { role: "user", text: "M Aurora ada 3 bilik?" }, { role: "assistant", text: "Ada, M AURORA Type C dan Type D." }];
  const reply = "Type C M AURORA (dari RM517,000): anggaran ansuran ~RM2,197 sebulan (100% pembiayaan, 3.7% setahun, 35 tahun), campur maintenance ~RM283 jadi ~RM2,480. Ini ilustrasi sahaja, bukan tawaran pinjaman 😊";
  const llm = scripted(draft(reply, { intent: "instalment" }));
  const r = await respond({ db: db(site), llm, message: "Type C berapa bulanan?", history, now: NOW, mode: "simulate" });
  assert.equal(r.decision, "reply", JSON.stringify(r.violations));
  const ctx = llm.calls[0].messages.at(-1).content;
  // the website: Math.round(517000 × i / (1 − (1 + i)^−420)), i = 3.7 / 1200; maintenance 858 sqft × RM0.33
  assert.match(ctx, /"project":"M AURORA","layout":"Type C","price_label":"INDICATIVE","price":517000,"bank":\{"financing_pct":100,"rate_pct":3.7,"tenure_years":35,"loan":517000,"monthly":2197\},"lppsa":\{"financing_pct":100,"tenure_years":35,"loan":517000,"monthly":2289,[^}]*"rules_verified":false\},"maintenance_monthly":283,"bank_monthly_with_maintenance":2480/);
  assert.match(llm.calls[0].system, /answer at once from instalment_examples[\s\S]*Do not ask for the route, age or income before giving this/);
  // a figure the engine did not produce is still refused
  const bad = await respond({ db: db(site), llm: scripted(draft("Type C M AURORA anggaran ~RM2,050 sebulan (100% pembiayaan, 3.7% setahun, 35 tahun).")), message: "Type C berapa bulanan?", history, now: NOW, mode: "simulate" });
  assert.notEqual(bad.decision, "reply");
});

test("approved knowledge (the staff's 'SALES PACKAGE & COST' entry) is always given and answered, however the buyer words it", async () => {
  const entry = { id: "k1", project_id: null, approved: true, title: "SALES PACKAGE & COST", content: "Legal Fees:\n-SPA & LA Legal fees free by MahSing.\n-Only MOT Stamp duty need to borne by purchaser.\n\nBumi Discount: \n-5% (For property in KL, usually)\n-7%-10% (For property in Selangor, usually)\n\n-Fyi price in website is the price after discount & rebates. Keep this for your knowledge only." };
  const other = { id: "k2", project_id: ID["M NOVA"], approved: true, title: "M NOVA note", content: "Only for M NOVA." };
  const draftEntry = { id: "k3", project_id: null, approved: false, title: "Draft", content: "Not approved yet." };
  const kb = { ai_knowledge_chunks: [entry, other, draftEntry].filter((k) => k.approved) };   // the query asks for approved only
  const history = [intro, { role: "user", text: "M Aurora 3 bilik ada?" }, { role: "assistant", text: "Ada, M AURORA Type C dan D." }];
  // Malay wording that a word search on the English entry would miss
  const { ctx, j } = await ctxJson({ message: "Diskaun bumi ada?", history }, kb);
  assert.deepEqual(j.knowledge.map((k) => k.title), ["SALES PACKAGE & COST"], "general entry given; another project's entry left out");
  assert.equal(ctx.rules.knowledgeCoversPromotion, true);
  const sys = buildSystemPrompt({}, []);
  assert.match(sys, /knowledge entries are the agency's own approved policies/);
  assert.match(sys, /follow those notes and never quote them/);
  // the answer from the entry is sent; it is not blocked as an "unverified promotion" nor handed over
  const reply = "Ada Bang Zan 😊 Untuk M AURORA (KL), Bumi discount biasanya 5%. Legal fees SPA & LA pula free oleh Mah Sing, cuma duti setem MOT ditanggung pembeli.";
  const r = await respond({ db: db(kb), llm: scripted(draft(reply, { intent: "promotion" })), message: "Diskaun bumi ada?", history, now: NOW, mode: "simulate" });
  assert.equal(r.decision, "reply", JSON.stringify(r.violations));
  // without the entry, the same unqualified claim is still blocked
  const r2 = await respond({ db: db(), llm: scripted(draft(reply, { intent: "promotion" })), message: "Diskaun bumi ada?", history, now: NOW, mode: "simulate" });
  assert.notEqual(r2.decision, "reply");
  assert.equal(r2.attempts[0].violations[0].code, "unverified_promotion");
});
