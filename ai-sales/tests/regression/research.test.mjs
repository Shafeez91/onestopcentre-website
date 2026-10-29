// Research upgrade (29 Oct 2026): Google Maps distances from the project's own map pin, web research when our data
// has no answer, and checks that only verified distances and real checks reach the buyer. Google and the web are
// mocked here with the documented response shapes (no key or network in tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapsService, coordsFromMapsUrl, parseLatLng, haversine, directionsLink, MapsError } from "../../lib/maps.mjs";
import { routeLookups, renderLookup, needsRoute, webResearch, shouldResearch } from "../../lib/research.mjs";
import { respond } from "../../lib/orchestrator.mjs";
import { validateReply, extractDistances } from "../../../sales/shared/validator.mjs";
import { researchClaude } from "../../lib/llm.mjs";
import { memdb } from "../unit/helpers/memdb.mjs";

const NOW = new Date("2026-10-29T07:00:00Z");
// M MIRA's pin and LRT Sri Rampai: illustrative test coordinates (not production data)
const MIRA = { lat: 3.19899, lng: 101.73702 }, SRI_RAMPAI = { lat: 3.19934, lng: 101.73729 };
const SHORT = "https://maps.app.goo.gl/9e3P2xPW2oNnFDQP9?g_st=ic";
const LONG = `https://www.google.com/maps/place/M+Mira/@3.1990,101.7350,17z/data=!3m1!4b1!4m6!3m5!1s0x31cc37:0x1!8m2!3d${MIRA.lat}!4d${MIRA.lng}!16s`;

/** A fake Google: short-link redirect, Places text search, Routes computeRoutes. Records every call. */
function google({ places, routes = {}, fail = {} } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body, headers: init.headers || {} });
    if (url.startsWith("https://maps.app.goo.gl/")) return new Response(null, { status: 302, headers: { location: LONG } });
    const f = fail[url.includes("places") ? "places" : "routes"];
    if (f) { const r = typeof f === "function" ? f() : f; if (r) return r; }
    if (url.includes("places:searchText")) return Response.json({ places: places ?? [
      { id: "ChIJ_shop", displayName: { text: "Sri Rampai Mart" }, formattedAddress: "Jalan Sri Rampai", location: { latitude: 3.2, longitude: 101.74 }, types: ["store"] },
      { id: "ChIJ_lrt", displayName: { text: "Sri Rampai LRT Station" }, formattedAddress: "Wangsa Maju, Kuala Lumpur", location: { latitude: SRI_RAMPAI.lat, longitude: SRI_RAMPAI.lng }, types: ["subway_station", "transit_station"] }] });
    if (url.includes("computeRoutes")) {
      const r = routes[body.travelMode] || { WALK: { distanceMeters: 2350, duration: "1860s" }, DRIVE: { distanceMeters: 3100, duration: "420s", staticDuration: "400s" }, TRANSIT: { distanceMeters: 2600, duration: "900s" } }[body.travelMode];
      return Response.json({ routes: r ? [r] : [] });
    }
    return new Response("not found", { status: 404 });
  };
  fn.calls = calls;
  return fn;
}
const miraProject = { id: "mm", name: "M MIRA", area: "Wangsa Maju", map_url: SHORT };

/* ---------- 1–3: M MIRA → LRT Sri Rampai ---------- */
test("1-3 · M MIRA → LRT Sri Rampai: pin from the staff's map link, the real station (not a shop), walking and driving routes", async () => {
  const g = google(), maps = mapsService({ key: "K", fetchImpl: g, now: () => NOW });
  const l = await maps.lookup({ project: miraProject, destination: "LRT Sri Rampai station", modes: ["walk", "drive"] });
  assert.deepEqual(l.origin, { lat: MIRA.lat, lng: MIRA.lng, source: "the project's Google Maps pin (website editor)", precision: "pin" }, "the pin, not the map centre or the area");
  assert.equal(l.destination.name, "Sri Rampai LRT Station", "a station result, not 'Sri Rampai Mart'");
  assert.equal(l.straight_line_m, haversine(MIRA, SRI_RAMPAI));
  assert.deepEqual(l.routes.map((r) => [r.mode, r.distance_m, r.duration_s]), [["walk", 2350, 1860], ["drive", 3100, 400]], "driving uses the traffic-free time");
  const routeCalls = g.calls.filter((c) => c.url.includes("computeRoutes"));
  assert.deepEqual(routeCalls.map((c) => [c.body.travelMode, c.body.routingPreference]), [["WALK", undefined], ["DRIVE", "TRAFFIC_UNAWARE"]]);
  assert.deepEqual(routeCalls[0].body.destination, { placeId: "ChIJ_lrt" });
  assert.equal(routeCalls[0].headers["x-goog-api-key"], "K");
  assert.match(routeCalls[0].headers["x-goog-fieldmask"], /routes\.distanceMeters/);
  const places = g.calls.find((c) => c.url.includes("places"));
  assert.deepEqual(places.body.locationBias.circle.center, { latitude: MIRA.lat, longitude: MIRA.lng }, "search biased to the project");
  // what the AI sees: rounded, labelled, no coordinates
  const v = renderLookup(l);
  assert.deepEqual(v.routes, [{ mode: "walking", distance: "2.4 km", time: "31 min" }, { mode: "driving", distance: "3.1 km", time: "7 min", note: "typical driving time without live traffic" }]);
  assert.equal(v.straight_line, `${Math.round(haversine(MIRA, SRI_RAMPAI) / 10) * 10} m`, "straight line kept separate from route distances");
  assert.doesNotMatch(JSON.stringify(v).replace(v.maps_link, ""), /3\.19|101\.73/, "coordinates are not handed to the AI");
  assert.match(v.maps_link, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&origin=3\.19899%2C101\.73702&destination=Sri\+Rampai\+LRT\+Station&travelmode=walking&destination_place_id=ChIJ_lrt$/);
});

test("map pins: the place pin wins over the map centre; typed coordinates win over everything; bad input is rejected", () => {
  assert.deepEqual(coordsFromMapsUrl(LONG), { lat: MIRA.lat, lng: MIRA.lng, precision: "pin" });
  assert.deepEqual(coordsFromMapsUrl("https://www.google.com/maps/@3.2,101.7,15z"), { lat: 3.2, lng: 101.7, precision: "map_centre" });
  assert.deepEqual(coordsFromMapsUrl("https://maps.google.com/?q=3.1,101.6"), { lat: 3.1, lng: 101.6, precision: "pin" });
  assert.equal(coordsFromMapsUrl("https://www.google.com/maps/search/M+Mira"), null);
  assert.deepEqual(parseLatLng("3.2051, 101.7312"), { lat: 3.2051, lng: 101.7312 });
  assert.equal(parseLatLng("0,0"), null); assert.equal(parseLatLng("Wangsa Maju"), null); assert.equal(parseLatLng("95.1,10.2"), null);
  assert.match(directionsLink(MIRA, { name: "KLCC & Co", lat: 3.15, lng: 101.71 }, "drive"), /destination=3\.15%2C101\.71&travelmode=driving$/, "encoded; coordinates when there is no place id");
});

test("7 · missing or approximate addresses: typed coordinates first; search fallback is labelled approximate; nothing found is reported, never invented", async () => {
  const g = google();
  let maps = mapsService({ key: "K", fetchImpl: g, now: () => NOW });
  assert.equal((await maps.projectLocation({ id: "x", name: "X", latlng: "3.21, 101.73" })).source, "coordinates entered for the project");
  assert.equal(g.calls.length, 0, "no API call needed");
  const approx = await maps.projectLocation({ id: "a", name: "M ARIA", area: "Sentul", map_url: "" });
  assert.equal(approx.precision, "approximate");
  assert.match(approx.source, /approximate: no map pin on record/);
  const l = await maps.lookup({ project: { id: "a", name: "M ARIA", area: "Sentul" }, destination: "KLCC", modes: ["drive"] });
  assert.ok(l.missing.some((m) => /approximate/.test(m)), "the AI is told the location is approximate");
  maps = mapsService({ key: "K", fetchImpl: google({ places: [] }), now: () => NOW });
  const none = await maps.lookup({ project: { id: "z", name: "Unknown" }, destination: "KLCC" });
  assert.deepEqual([none.routes, none.missing], [[], ["no verified location for Unknown (add its Google Maps pin in the website editor)"]]);
});

/* ---------- 15: authentication, rate limits, retries, caching ---------- */
test("15 · Google Maps: no key, refused key, rate limit retried once, cache reused, expired cache refreshed", async () => {
  await assert.rejects(mapsService({}).place("KLCC"), (e) => e instanceof MapsError && e.kind === "config");
  await assert.rejects(mapsService({ key: "bad", fetchImpl: google({ fail: { places: Response.json({ error: { message: "API key not valid" } }, { status: 403 }) } }) }).place("KLCC"), (e) => e.kind === "auth" && /API key not valid/.test(e.message));
  let n = 0;
  const flaky = google({ fail: { places: () => (n++ === 0 ? new Response("busy", { status: 429 }) : null) } });
  assert.equal((await mapsService({ key: "K", fetchImpl: flaky }).place("LRT Sri Rampai station")).place_id, "ChIJ_lrt", "429 retried once");
  await assert.rejects(mapsService({ key: "K", fetchImpl: google({ fail: { routes: new Response("down", { status: 503 }) } }) }).route(MIRA, SRI_RAMPAI, "walk"), (e) => e.kind === "unavailable");
  // cache: the second identical lookup makes no API call; an expired entry is fetched again
  const db = memdb({ ai_geo_cache: [] }), g = google();
  let clock = NOW;
  const maps = mapsService({ key: "K", db, fetchImpl: g, now: () => clock });
  await maps.lookup({ project: miraProject, destination: "LRT Sri Rampai station", modes: ["walk"] });
  const first = g.calls.length;
  const again = await maps.lookup({ project: miraProject, destination: "LRT Sri Rampai station", modes: ["walk"] });
  assert.equal(g.calls.length, first, "everything came from the cache");
  assert.equal(again.routes[0].cached, true);
  assert.ok(db.t.ai_geo_cache.every((r) => r.provider === "google" && r.fetched_at && r.expires_at));
  assert.deepEqual([...new Set(db.t.ai_geo_cache.map((r) => r.kind))].sort(), ["place", "project", "route"]);
  clock = new Date(NOW.getTime() + 15 * 864e5); // routes keep 14 days
  const g2 = google(); const maps2 = mapsService({ key: "K", db, fetchImpl: g2, now: () => clock });
  await maps2.route(MIRA, { place_id: "ChIJ_lrt" }, "walk");
  assert.equal(g2.calls.length, 1, "an expired route is looked up again");
});

/* ---------- router and follow-ups ---------- */
const PROJECTS = [{ id: "mm", name: "M MIRA", area: "Wangsa Maju", mapUrl: SHORT, latlng: "", inFocus: true, nearbyTransit: "LRT Wangsa Maju (2km); LRT Sri Rampai (2.4km)" },
  { id: "az", name: "M AZURA", area: "Setapak", mapUrl: "", latlng: "3.2,101.72", inFocus: false }];
const planner = (plan) => { const calls = []; const fn = async (p) => { calls.push(p); return { data: plan, model: "m", usage: {} }; }; fn.calls = calls; return fn; };

test("11 · router: only distance questions look anything up; a follow-up ('kalau jalan kaki?') reuses the project and place", async () => {
  assert.equal(needsRoute("Harga Type A berapa?"), false);
  for (const q of ["M Mira ke Lrt sri rampai berapa jauh?", "Kalau jalan kaki?", "How far is it from KLCC?", "naik kereta berapa lama?", "Can I walk to the LRT?", "MRT paling dekat kat mana?"]) assert.ok(needsRoute(q), q);
  const maps = mapsService({ key: "K", fetchImpl: google(), now: () => NOW });
  let llm = planner({ routes: [] });
  assert.equal(await routeLookups({ llm, maps }, { message: "Harga berapa?", projects: PROJECTS }), null);
  assert.equal(llm.calls.length, 0, "no planning call for other questions");
  llm = planner({ routes: [{ project: "M MIRA", destination: "LRT Sri Rampai station", modes: ["walk"] }], missing_place: "" });
  const history = [{ role: "user", text: "M Mira ke Lrt sri rampai berapa jauh?" }, { role: "assistant", text: "Sekitar 2.4 km memandu." }];
  const r = await routeLookups({ llm, maps }, { message: "Kalau jalan kaki?", history, projects: PROJECTS });
  assert.match(llm.calls[0].messages[0].content, /BUYER: M Mira ke Lrt sri rampai berapa jauh\?[\s\S]*<buyer_message>\nKalau jalan kaki\?/, "the planner sees the earlier question");
  assert.match(llm.calls[0].messages[0].content, /M MIRA \(Wangsa Maju\) \[in focus\]/);
  assert.deepEqual(r.lookups[0].routes.map((x) => x.mode), ["walk"]);
  // a place the buyer has not named: nothing invented, the AI asks
  llm = planner({ routes: [], missing_place: "the area of your workplace" });
  assert.equal((await routeLookups({ llm, maps }, { message: "Berapa jauh dari office saya?", projects: PROJECTS })).missing_place, "the area of your workplace");
  // unknown project names from the planner are ignored
  llm = planner({ routes: [{ project: "Some Other Condo", destination: "KLCC", modes: ["drive"] }], missing_place: "" });
  assert.deepEqual((await routeLookups({ llm, maps }, { message: "how far to KLCC?", projects: PROJECTS })).lookups, []);
});

/* ---------- the reply pipeline ---------- */
function ctxDb(over = {}) {
  const t = { ai_settings: [{ id: 1, persona: { name: "OSC Property Assistant" }, ai: { confidence_threshold: 0.7 }, business: {}, scoring: {}, compliance: {} }],
    projects: [{ id: "mm", slug: "m-mira", data: { n: "M MIRA", l: "Wangsa Maju", mapUrl: SHORT, types: [{ name: "Type A", price: "RM476,000" }],
      near: { transit: [{ t: "LRT", n: "Wangsa Maju", d: "2km", ok: true }, { t: "LRT", n: "Sri Rampai", d: "2.4km", ok: true }] }, nearby: "PUBLIC TRANSPORT\n1. 650m – Sri Rampai LRT Station" } }],
    ai_leads: [], ai_lead_interests: [], ai_appointments: [], ai_project_facts: [], ai_project_prices: [], ai_project_units: [], ai_active_promotions: [], ...over };
  const writes = [];
  return { writes, get: async (p) => structuredClone(t[p.split("?")[0]] || []), rpc: async () => [], post: async (p, b) => { writes.push({ p, b }); return [{}]; }, patch: async (p, b) => { writes.push({ p, b }); } };
}
const base = { language: "ms", intent: "project_info", agent: "knowledge", confidence: 0.9, facts_used: [],
  qualification_updates: { purpose: "", first_home: "", bedrooms: "", size_sqft: "", budget_min: 0, budget_max: 0, employment: "", financing: "", timeline_months: 0, readiness: "", concerns: "", preferred_project_id: "", asked_price: false, requested_brochure: false },
  appointment_request: { wanted: false, kind: "", preferred_text: "", project_id: "", slot_id: "" }, handover: { needed: false, reason: "", summary: "", next_action: "" }, objection_key: "" };
const AI = "Saya OSC Property Assistant, pembantu AI.";
/** One fake model for everything: planner calls get the plan, reply calls get the scripted replies in order. */
function model(plan, ...replies) {
  const calls = { plan: [], reply: [] };
  const fn = async (p) => {
    if (p.schema?.properties?.routes) { calls.plan.push(p); return { data: plan, model: "m", usage: {} }; }
    calls.reply.push(p); const d = replies[Math.min(calls.reply.length - 1, replies.length - 1)]; return { data: d, model: "m", usage: {} };
  };
  fn.calls = calls; return fn;
}
const contextOf = (call) => JSON.parse(call.messages.at(-1).content.match(/<verified_context>\s*([\s\S]*?)\s*<\/verified_context>/)[1]);

test("1 + 8 · reply pipeline: the lookup reaches the AI, settles the listing's conflicting distances, its link is allowed, invented figures are blocked", async () => {
  const maps = mapsService({ key: "K", fetchImpl: google(), now: () => NOW });
  const plan = { routes: [{ project: "M MIRA", destination: "LRT Sri Rampai station", modes: ["walk", "drive"] }], missing_place: "" };
  const invented = { ...base, messages: [AI + " M MIRA ke LRT Sri Rampai cuma 5 minit jalan kaki, sekitar 400m."] };
  let link;
  const good = () => ({ ...base, messages: [AI + ` Dari M MIRA ke LRT Sri Rampai sekitar 2.4 km jalan kaki (lebih kurang 31 minit), atau 3.1 km memandu.\n\nGoogle Maps: ${link}`] });
  const llm = model(plan, invented, { get messages() { return good().messages; }, ...base, get reply() { return undefined; } });
  link = renderLookup(await maps.lookup({ project: miraProject, destination: "LRT Sri Rampai station", modes: ["walk", "drive"] })).maps_link;
  const r = await respond({ db: ctxDb(), llm, message: "M Mira ke Lrt sri rampai berapa jauh?", now: NOW, mode: "simulate", research: { maps } });
  const ctx = contextOf(llm.calls.reply[0]);
  assert.equal(ctx.route_lookups[0].routes[0].distance, "2.4 km");
  assert.equal(ctx.route_lookups[0].project_location, "the project's Google Maps pin (website editor)");
  assert.deepEqual(ctx.projects[0].conflicts?.map((c) => c.field) || [], ["transport"], "the listing's own contradiction is still shown");
  assert.match(llm.calls.reply[0].system, /route_lookups settle a distance conflict in the listing/);
  assert.deepEqual(r.attempts[0].violations.map((v) => v.code), ["unverified_distance"], "'5 minit' and '400m' were never measured");
  assert.equal(r.decision, "reply");
  assert.match(r.reply, /2\.4 km jalan kaki/);
  assert.ok(r.research.maps.lookups[0].routes.length === 2);
});

test("4 · a question our website answers: no planning call, no map call, no web research", async () => {
  const g = google(), maps = mapsService({ key: "K", fetchImpl: g });
  const research = async () => { throw new Error("must not be called"); };
  const llm = model({ routes: [] }, { ...base, intent: "price", messages: [AI + " M MIRA Type A dari RM476,000 (anggaran)."] });
  const r = await respond({ db: ctxDb(), llm, message: "Harga M Mira Type A?", now: NOW, research: { maps, research } });
  assert.equal(r.decision, "reply");
  assert.deepEqual([llm.calls.plan.length, g.calls.length, r.research], [0, 0, null]);
});

test("5 · an answer in the agency's approved knowledge (e.g. brochure content) is used directly, without web research", async () => {
  const research = async () => { throw new Error("must not be called"); };
  const db = ctxDb({ ai_knowledge_chunks: [] });
  db.rpc = async (name) => (name === "ai_search_knowledge" ? [{ id: "k1", kind: "chunk", project_id: "mm", title: "M MIRA brochure", content: "Facilities: 50m infinity pool, gym, surau." }] : []);
  const llm = model({ routes: [] }, { ...base, messages: [AI + " M MIRA ada kolam renang infiniti 50m, gym dan surau."], facts_used: ["kb:k1"] });
  const r = await respond({ db, llm, message: "Ada swimming pool kat M Mira?", now: NOW, research: { maps: mapsService({}), research } });
  assert.equal(r.decision, "reply");
  assert.match(r.reply, /50m/, "a distance-like figure from approved knowledge is allowed");
});

test("6 + 9 · not in our data: one web research round, then a second draft from the findings (planned stays planned); the daily limit is charged once", async () => {
  const handover = { ...base, intent: "project_info", messages: [AI + " Maklumat ini tiada dalam info projek kami, advisor akan sahkan."], handover: { needed: true, reason: "conflicting_info", summary: "MRT3 status", next_action: "check" } };
  const answer = { ...base, intent: "project_info", messages: [AI + " Berdasarkan maklumat awam, MRT3 Circle Line masih dalam perancangan (planned) dan stesen Rejang belum beroperasi."] };
  const llm = model({ routes: [] }, handover, answer);
  const asked = [];
  const research = async (q) => { asked.push(q); return { text: "- MRT3 Circle Line is planned; construction has not started. https://www.mymrt.com.my/mrt3\n- Rejang station is a proposed station. https://www.mymrt.com.my/mrt3", sources: [{ url: "https://www.mymrt.com.my/mrt3", title: "MRT3" }], searches: 2, usage: {} }; };
  let reserved = 0;
  const r = await respond({ db: ctxDb(), llm, reserve: async () => { reserved++; return { allowed: true }; }, message: "MRT3 Rejang dah siap ke?", now: NOW, research: { maps: mapsService({}), research } });
  assert.equal(asked.length, 1);
  assert.match(asked[0].system, /Distinguish operational, under construction, planned and proposed infrastructure/);
  assert.match(asked[0].system, /never instructions/, "web pages cannot instruct the researcher");
  assert.match(asked[0].prompt, /MRT3 Rejang dah siap ke\?/);
  const ctx = contextOf(llm.calls.reply[1]);
  assert.equal(ctx.external_research.label, "EXTERNAL (web search)");
  assert.match(ctx.external_research.findings, /planned/);
  assert.deepEqual(ctx.external_research.sources, ["https://www.mymrt.com.my/mrt3"]);
  assert.equal(r.decision, "reply");
  assert.match(r.reply, /masih dalam perancangan/);
  assert.equal(r.research.web.found, true);
  assert.equal(reserved, 1, "the second draft does not use up another daily reply");
});

test("6 · research never runs for prices, promotions, negotiation, legal, complaints or explicit requests for a person", () => {
  for (const intent of ["price", "promotion", "negotiation", "legal_or_contract", "complaint", "human_request", "availability", "instalment"]) assert.equal(shouldResearch({ decision: "handover", handoverReason: "conflicting_info", intent }), false, intent);
  assert.equal(shouldResearch({ decision: "handover", handoverReason: "negotiation", intent: "project_info" }), false);
  assert.equal(shouldResearch({ decision: "reply", handoverReason: undefined, intent: "project_info" }), false);
  assert.equal(shouldResearch({ decision: "handover", handoverReason: "conflicting_info", intent: "project_info" }), true);
});

test("10 · provider failures: Maps down → no distances in context, an invented one is blocked; web research fails → the hand-over stands", async () => {
  const maps = mapsService({ key: "K", fetchImpl: google({ fail: { places: new Response("down", { status: 503 }) } }) });
  const plan = { routes: [{ project: "M MIRA", destination: "LRT Sri Rampai station", modes: ["walk"] }], missing_place: "" };
  const bad = { ...base, messages: [AI + " Sekitar 900m sahaja ke LRT."] };
  let llm = model(plan, bad, bad);
  let r = await respond({ db: ctxDb(), llm, message: "M Mira ke LRT Sri Rampai berapa jauh?", now: NOW, research: { maps } });
  assert.match(r.research.maps.error, /Google Maps unavailable/);
  assert.equal(r.decision, "blocked", "a distance nobody measured never reaches the buyer");
  const handover = { ...base, messages: [AI + " Advisor akan sahkan maklumat ini."], handover: { needed: true, reason: "conflicting_info", summary: "s", next_action: "n" } };
  llm = model({ routes: [] }, handover);
  r = await respond({ db: ctxDb(), llm, message: "Sekolah antarabangsa paling dekat?", now: NOW, research: { maps: mapsService({}), research: async () => { throw new Error("web search is not enabled for this organisation"); } } });
  assert.equal(r.decision, "handover");
  assert.equal(llm.calls.reply.length, 1, "no second draft without findings");
  assert.match(r.research.web.error, /not enabled/);
  // switched off in settings: no research at all
  const db = ctxDb(); db.get = (orig => async (p) => { const rows = await orig(p); if (p.startsWith("ai_settings")) rows[0].ai = { ...rows[0].ai, web_research: false, maps_distances: false }; return rows; })(db.get);
  let called = 0;
  llm = model(plan, handover);
  r = await respond({ db, llm, message: "M Mira ke LRT berapa jauh?", now: NOW, research: { maps: mapsService({ key: "K", fetchImpl: google() }), research: async () => { called++; return {}; } } });
  assert.deepEqual([llm.calls.plan.length, called], [0, 0]);
});

/* ---------- business rules ---------- */
test("rules: distances and times must come from the context; 'I checked Google Maps' only when a lookup happened", () => {
  const ctx = { allowedDistances: [2350, 3100, 650], allowedMinutes: [31, 7], usedMaps: false, usedWeb: false };
  assert.deepEqual(validateReply("Sekitar 2.4 km jalan kaki, lebih kurang 30 minit.", ctx).violations, [], "rounding is fine");
  assert.deepEqual(validateReply("Cuma 400m, 5 minit!", ctx).violations.map((v) => v.code), ["unverified_distance"]);
  assert.deepEqual(validateReply("Saya dah semak Google Maps, sekitar 2.4 km.", ctx).violations.map((v) => v.code), ["unverified_check"]);
  assert.deepEqual(validateReply("Saya dah semak Google Maps, sekitar 2.4 km.", { ...ctx, usedMaps: true }).violations, []);
  assert.deepEqual(validateReply("I searched online and found it is planned.", ctx).violations.map((v) => v.code), ["unverified_check"]);
  assert.deepEqual(validateReply("Harga RM476,000, 3.65% setahun, 35 tahun, 850 sqft.", { allowedAmounts: [476000], ...ctx }).violations.filter((v) => v.code === "unverified_distance"), [], "prices, rates, years and sizes are not distances");
  assert.deepEqual(extractDistances("1,500m · 1,2km · 650 m").map((d) => d.value), [1500, 1200, 650]);
});

/* ---------- the web research call itself ---------- */
test("web research call: Claude web tools with limits and Malaysia location, no structured output, sources from citations, pause resumed once", async () => {
  const sent = [];
  const replies = [
    { content: [{ type: "server_tool_use", name: "web_search", input: { query: "MRT3 status" } }, { type: "text", text: "- MRT3 is planned. ", citations: [{ url: "https://a.gov.my/x", title: "A" }] }], stop_reason: "pause_turn", model: "m", usage: { input_tokens: 5, output_tokens: 5 } },
    { content: [{ type: "text", text: "- Rejang is proposed.", citations: [{ url: "https://a.gov.my/x" }, { url: "https://b.com.my/y", title: "B" }] }], stop_reason: "end_turn", model: "m", usage: { input_tokens: 5, output_tokens: 5 } },
  ];
  const r = await researchClaude({ apiKey: "k", system: "S", prompt: "Q", fetchImpl: async (u, i) => { sent.push(JSON.parse(i.body)); return Response.json(replies.shift()); } });
  assert.equal(sent[0].tools[0].type, "web_search_20260209");
  assert.equal(sent[0].tools[0].max_uses, 3);
  assert.deepEqual(sent[0].tools[0].user_location, { type: "approximate", country: "MY", city: "Kuala Lumpur", timezone: "Asia/Kuala_Lumpur" });
  assert.equal(sent[0].tools[1].type, "web_fetch_20260209");
  assert.ok(!("format" in (sent[0].output_config || {})), "no structured output (incompatible with citations)");
  assert.equal(sent[1].messages.at(-1).role, "assistant", "the paused turn is resumed, with no extra user message");
  assert.equal(r.text, "- MRT3 is planned. - Rejang is proposed.");
  assert.deepEqual(r.sources.map((s) => s.url), ["https://a.gov.my/x", "https://b.com.my/y"]);
  assert.equal(r.searches, 1);
  const nf = await webResearch({ research: async () => ({ text: "NOT FOUND — no public source", sources: [], searches: 3 }) }, { question: "q" });
  assert.equal(nf.found, false);
});

/* ---------- simulation stays safe ---------- */
test("simulation: lookups write only the map cache — never leads, messages or anything a buyer sees", async () => {
  const cache = memdb({ ai_geo_cache: [] });
  const maps = mapsService({ key: "K", db: cache, fetchImpl: google() });
  const db = ctxDb();
  const llm = model({ routes: [{ project: "M MIRA", destination: "LRT Sri Rampai station", modes: ["walk"] }], missing_place: "" }, { ...base, messages: [AI + " Sekitar 2.4 km jalan kaki."] });
  await respond({ db, llm, message: "M Mira ke LRT Sri Rampai berapa jauh?", now: NOW, mode: "simulate", research: { maps } });
  assert.deepEqual(db.writes, [], "nothing written through the CRM database");
  assert.ok(cache.t.ai_geo_cache.length >= 3);
  assert.ok(Object.keys(cache.t).filter((k) => !["ai_geo_cache"].includes(k) && (cache.t[k] || []).length).length === 0);
});

test("29 Oct (console screenshot): a station the listing gives two distances for (650 m text, 2.4 km list) gets no figure until a map lookup settles it; other stations keep theirs", async () => {
  const picked = { ...base, intent: "project_info", messages: [AI + " The nearest operating station to M MIRA is LRT Sri Rampai (Kelana Jaya Line), around 2.4km away.\n\nThe proposed MRT3 stations at Setapak and Rejang are around 2km away."] };
  const honest = { ...base, intent: "project_info", messages: [AI + " The nearest operating station to M MIRA is LRT Sri Rampai (Kelana Jaya Line); the exact distance is being confirmed by our advisor.\n\nThe proposed MRT3 stations at Setapak and Rejang are around 2km away."] };
  const llm = model({ routes: [] }, picked, honest);
  const r = await respond({ db: ctxDb(), llm, message: "How far m mira from nearest public transport?", now: NOW });
  const v = r.attempts[0].violations.filter((x) => x.code === "disputed_distance");
  assert.equal(v.length, 1);
  assert.match(v[0].detail, /2\.4km for LRT Sri Rampai: the project information gives two different distances \(2\.4 km and 650 m\)/);
  assert.equal(r.decision, "reply");
  assert.match(r.reply, /being confirmed/);
  assert.match(r.reply, /around 2km/, "the MRT3 figures are not disputed and stay");
  // the other figure from the dispute is caught too, in either language
  const { validateReply } = await import("../../../sales/shared/validator.mjs");
  const disputedDistances = [{ station: "LRT Sri Rampai", key: "sri rampai", meters: [2400, 650] }];
  assert.equal(validateReply("Stesen LRT Sri Rampai cuma 650m dari projek.", { disputedDistances }).violations[0].code, "disputed_distance");
  assert.deepEqual(validateReply("AEON Mall is 500m away. Sri Rampai LRT is nearby.", { disputedDistances }).violations, []);
});

test("a Google Maps measurement settles the dispute: the measured distance may be stated", async () => {
  const llm = model({ routes: [{ project: "M MIRA", destination: "LRT Sri Rampai station", modes: ["walk"] }] }, { ...base, messages: [AI + " LRT Sri Rampai is about 2.4 km on foot from M MIRA (Google Maps)."] });
  const maps = mapsService({ key: "k", db: memdb({}), fetchImpl: google() });
  const r = await respond({ db: ctxDb(), llm, message: "How far is M Mira from LRT Sri Rampai walking?", now: NOW, research: { maps } });
  assert.ok(!r.attempts[0].violations.some((x) => x.code === "disputed_distance"));
  assert.equal(r.decision, "reply");
});
