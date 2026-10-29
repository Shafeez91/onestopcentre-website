// Property specifications as published on onestopcentreproperty.com, read from the website's own `projects`
// records with the same rules the property page uses (layouts merged from `types` and `layouts`, nearby places
// hidden when marked not OK). One module for the AI context and the knowledge coverage audit, so what the audit
// reports is exactly what the AI receives. Used in the browser and on the server.

const clean = (v) => { v = String(v ?? "").trim(); return /^(none|null|undefined|-|—|n\/a|tba|tbc)$/i.test(v) ? "" : v; };
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const strs = (v) => arr(v).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
export const numOf = (v) => { const m = String(v ?? "").replace(/,/g, "").match(/\d+(\.\d+)?/); return m ? parseFloat(m[0]) : 0; };
const nkey = (n) => String(n || "").toLowerCase().replace(/type|unit|layout/g, "").replace(/[^a-z0-9]/g, "");
/** "380,000" → "RM380,000"; "RM460,000" and "Enquire" are kept as they are. */
const money = (v) => { v = clean(v); return /^[\d,.\s]+$/.test(v) && numOf(v) >= 1000 ? "RM" + v.replace(/\s/g, "") : v; };
const distM = (s) => { const n = numOf(s); return /km/i.test(String(s)) ? n * 1000 : n || 1e9; };

/** Layouts as the website shows them: `types` first, then `layouts`, merged by name. */
export function unitList(d) {
  const out = [];
  const add = (t) => {
    if (!t || typeof t !== "object") return;
    const k = nkey(t.name), x = k ? out.find((o) => nkey(o.name) === k) : null;
    if (!x) { out.push({ ...t, name: String(t.name || "").trim() }); return; }
    for (const f in t) if ((x[f] === "" || x[f] == null) && t[f] !== "" && t[f] != null) x[f] = t[f];
  };
  arr(d.types).forEach(add); arr(d.layouts).forEach(add);
  return out.filter((u) => u.name);
}

const placeholder = (v, name) => !v || v.toLowerCase().replace(/[^a-z0-9]/g, "").includes(String(name).toLowerCase().replace(/[^a-z0-9]/g, "")) && v.length < String(name).length + 25 && !/\d/.test(v);

/**
 * Everything the public project page states, normalised. Empty values are left out by the callers.
 * @param {object} d the `projects.data` JSON of one project
 */
export function projectSpecs(d) {
  d = obj(d);
  const name = clean(d.n);
  const projectBays = clean(obj(d.carpark).bays);
  const layouts = unitList(d).map((u) => ({
    layout: clean(u.name),
    size_sqft: clean(u.size),
    bedrooms: clean(u.beds),
    bathrooms: clean(u.baths),
    car_parks: clean(u.carparks) || projectBays,
    maintenance_fee_psf: numOf(u.maint) ? `RM${numOf(u.maint)} psf` : "",
    price_from: money(u.price),
  }));
  const towers = arr(d.towers).filter((t) => t && clean(t.name)).map((t) => ({ name: clean(t.name), floors: clean(t.floors), units: clean(t.units) }));
  const totalUnits = towers.reduce((a, t) => a + (parseInt(String(t.units).replace(/\D/g, ""), 10) || 0), 0);
  const near = obj(d.near), ok = (a) => arr(a).filter((x) => x && clean(x.n) && x.ok !== false).sort((a, b) => distM(a.d) - distM(b.d));
  const place = (x) => [clean(x.t) && !String(x.n).toLowerCase().split(/\W+/).includes(clean(x.t).toLowerCase()) ? `${clean(x.t)} ` : "", clean(x.n), clean(x.d) ? ` (${clean(x.d)})` : "", x.y ? `, ${clean(x.y)}` : "", x.st ? `, ${clean(x.st)}` : ""].join("");
  const nearby = Object.fromEntries(Object.entries({
    public_transport: ok(near.transit).map(place), schools: ok(near.schools).map(place), universities: ok(near.uni).map(place),
    amenities: ok(near.amen).map(place), future_infrastructure: arr(near.future).filter((x) => x && clean(x.n) && x.ok !== false).map(place),
  }).filter(([, v]) => v.length));
  const tenure = clean(d.tenure);
  const prices = layouts.map((l) => numOf(l.price_from)).filter((n) => n >= 10000);
  const sizes = layouts.flatMap((l) => (String(l.size_sqft).replace(/,/g, "").match(/\d+(\.\d+)?/g) || []).map(Number));
  const furn = clean(d.furn);
  return {
    name, area: clean(d.l), developer: clean(d.d), property_type: clean(d.t) || clean(d.c), status: clean(d.s),
    tenure, lease_years: /free/i.test(tenure) ? "" : clean(d.lease),
    expected_completion: clean(d.year),
    price_from: prices.length ? layouts.find((l) => numOf(l.price_from) === Math.min(...prices)).price_from : (numOf(d.p) >= 10000 ? money(d.p) : ""),
    size_range: sizes.length ? (Math.min(...sizes) === Math.max(...sizes) ? `${Math.min(...sizes)} sqft` : `${Math.min(...sizes)} – ${Math.max(...sizes)} sqft`) : clean(d.z) !== "Enquire" ? clean(d.z) : "",
    bedrooms_max: numOf(d.b) && !layouts.some((l) => l.bedrooms) ? String(numOf(d.b)) : "",
    layouts,
    car_parks_all_units: projectBays,
    maintenance_fee_psf: numOf(d.maintPsf) ? `RM${numOf(d.maintPsf)} psf` : "",
    furnishing: furn === "Yes" ? "Furnished" : furn === "No" ? "Unfurnished" : furn,
    furnished_items: strs(d.furnList),
    towers, total_units: totalUnits ? String(totalUnits) : "", floors: clean(d.height),
    facilities: strs(d.facilities),
    highlights: strs(d.hl),
    transit_oriented: clean(near.tod) === "Yes" ? (clean(near.todName) || "Yes") : "",
    nearby,
    address: placeholder(clean(d.address), name) ? "" : clean(d.address),
    description: clean(d.desc),
    surroundings: typeof d.nearby === "string" ? clean(d.nearby) : "",
    brochure_url: /^https?:/.test(d.brochure || "") ? d.brochure : "",
    map_url: /^https?:/.test(d.mapUrl || "") ? d.mapUrl : "",
  };
}

/** Lower-case words that name each project in a message: "m azura", "mazura", "azura" (the last only if 4+ letters). */
function projectKeys(p) {
  const n = String(p.name || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const keys = new Set([n, n.replace(/\s/g, "")]);
  const core = n.replace(/^m\s+/, "");
  if (core !== n && core.length >= 4) keys.add(core);
  if (p.slug) keys.add(String(p.slug).toLowerCase().replace(/-/g, " "));
  return [...keys].filter((k) => k.length >= 3);
}

/** Ids of the projects named in a text, in the order they first appear. */
export function mentionedProjects(text, projects) {
  const t = " " + String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ") + " ";
  const hits = [];
  for (const p of projects) {
    let at = Infinity;
    for (const k of projectKeys(p)) { const i = t.indexOf(" " + k + " "); if (i >= 0 && i < at) at = i; }
    if (at < Infinity) hits.push([at, p.id]);
  }
  return hits.sort((a, b) => a[0] - b[0]).map((h) => h[1]);
}

/**
 * Which project(s) the buyer means: named in this message, else the latest message in the conversation that
 * named one, else the lead's project in the CRM. `ambiguous` when several remain and none was named now.
 */
export function resolveFocus(projects, { message = "", history = [], lead = null } = {}) {
  const now = mentionedProjects(message, projects);
  if (now.length) return { ids: now, source: "named in the buyer's current message", ambiguous: false };
  for (let i = (history || []).length - 1; i >= 0; i--) {
    const ids = mentionedProjects(history[i].text, projects);
    if (ids.length) return { ids, source: "the project(s) discussed most recently in this conversation", ambiguous: ids.length > 1 };
  }
  const known = new Set(projects.map((p) => p.id));
  if (lead?.primary_project_id && known.has(lead.primary_project_id)) return { ids: [lead.primary_project_id], source: "the lead's project in the CRM", ambiguous: false };
  const interests = (lead?.interested_project_ids || []).filter((id) => known.has(id));
  if (interests.length) return { ids: [...new Set(interests)], source: "the lead's projects of interest in the CRM", ambiguous: interests.length > 1 };
  return { ids: [], source: "no project named yet", ambiguous: projects.length > 1 };
}

// ---- knowledge coverage -------------------------------------------------------------------------------------

/** The specifications buyers ask about most, with where each is read from. */
export const COVERAGE_FIELDS = [
  ["developer", "Developer"], ["area", "Location"], ["address", "Full address"], ["property_type", "Property type"],
  ["tenure", "Tenure"], ["lease_years", "Lease years"], ["status", "Project status"], ["expected_completion", "Completion"],
  ["layouts", "Unit types"], ["size", "Built-up sizes"], ["bedrooms", "Bedrooms"], ["bathrooms", "Bathrooms"],
  ["car_parks", "Car parks"], ["price_from", "Price from"], ["maintenance_fee", "Maintenance fee"], ["furnishing", "Furnishing"],
  ["facilities", "Facilities"], ["towers", "Towers / units"], ["transport", "Public transport"], ["brochure", "Brochure"],
  ["booking_fee", "Booking fee"], ["sinking_fund", "Sinking fund"], ["title_type", "Title type"], ["showroom", "Showroom address"],
];

/**
 * Per field: status "verified" (staff-checked, fresh) · "published" (on the website) · "partial" (some layouts only)
 * · "stale" (staff-checked, too old) · "conflict" · "not_applicable" · "missing"; plus the value shown.
 * @param specs projectSpecs(); facts the ai_project_facts row (or null); factsFresh whether it is recent
 */
export function coverage(specs, facts = null, { factsFresh = false } = {}) {
  const f = facts || {};
  const has = (v) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length);
  const L = specs.layouts || [];
  const perLayout = (k) => {
    if (!L.length) return { status: "missing", value: "" };
    const got = L.filter((l) => l[k]);
    if (!got.length) return { status: "missing", value: "" };
    return { status: got.length === L.length ? "published" : "partial", value: L.map((l) => `${l.layout}: ${l[k] || "—"}`).join(" · ") };
  };
  const staff = (k, fmt = (x) => x) => (has(f[k]) ? { status: factsFresh ? "verified" : "stale", value: String(fmt(f[k])) } : { status: "missing", value: "" });
  const site = (v) => (has(v) ? { status: "published", value: Array.isArray(v) ? `${v.length} listed` : String(v) } : { status: "missing", value: "" });
  const out = {
    developer: site(specs.developer), area: site(specs.area), address: site(specs.address), property_type: site(specs.property_type),
    tenure: site(specs.tenure),
    lease_years: /free/i.test(specs.tenure) ? { status: "not_applicable", value: "Freehold" } : site(specs.lease_years),
    status: site(specs.status),
    expected_completion: has(f.completion_date) ? staff("completion_date") : site(specs.expected_completion),
    layouts: site(L.map((l) => l.layout)),
    size: L.length ? perLayout("size_sqft") : site(specs.size_range),
    bedrooms: L.length ? perLayout("bedrooms") : site(specs.bedrooms_max && `up to ${specs.bedrooms_max}`),
    bathrooms: perLayout("bathrooms"),
    car_parks: has(f.parking_allocation) ? staff("parking_allocation") : specs.car_parks_all_units ? site(specs.car_parks_all_units) : perLayout("car_parks"),
    price_from: site(specs.price_from),
    maintenance_fee: has(f.maintenance_fee_psf) ? staff("maintenance_fee_psf", (x) => `RM${x} psf`) : site(specs.maintenance_fee_psf || (L.some((l) => l.maintenance_fee_psf) ? perLayout("maintenance_fee_psf").value : "")),
    furnishing: site(specs.furnishing),
    facilities: site(specs.facilities),
    towers: has(specs.towers) ? { status: "published", value: `${specs.towers.length} tower(s)${specs.total_units ? `, ${specs.total_units} units` : ""}` } : { status: "missing", value: "" },
    transport: site(specs.nearby?.public_transport),
    brochure: site(specs.brochure_url && "PDF uploaded"),
    booking_fee: staff("booking_fee"), sinking_fund: staff("sinking_fund_psf", (x) => `RM${x} psf`), title_type: staff("title_type"), showroom: staff("showroom_address"),
  };
  for (const c of conflicts(specs, facts, { factsFresh })) if (!c.resolved) out[c.field] = { status: "conflict", value: c.values.join(" · ") };
  return out;
}

// words that say what kind of stop it is, not which one ("Sri Rampai LRT Station" and "LRT Sri Rampai" are the same)
const STOP_WORDS = /\b(lrt|mrt|ktm|brt|erl|monorail|komuter|station|stesen|stn|line|laluan|bus|stop|hentian)\b/g;
const stopKey = (s) => ` ${String(s || "").toLowerCase().replace(/\(.*?\)/g, " ").replace(STOP_WORDS, " ").replace(/[^a-z0-9]+/g, " ").trim()} `;

/** Distances written in free text, one per line: "650m – Sri Rampai LRT Station", "• 1.2 km to KLCC", "1. 820m - Wangsa Maju LRT". */
export function textDistances(text) {
  const out = [];
  for (const line of String(text || "").split(/\n+/)) {
    const m = line.match(/(~?\d[\d.,]*)\s?(km|m)\b\.?\s*(?:[–—:-]|to|ke)\s*(.+)$/i);
    if (m) out.push({ meters: numOf(m[1]) * (/km/i.test(m[2]) ? 1000 : 1), label: `${m[1]}${m[2]} – ${m[3].trim()}`, key: stopKey(m[3]) });
  }
  return out;
}

/**
 * The listing's transit list against distances written in its own text (the "Location & accessibility" box):
 * the same station with clearly different distances (more than 300 m and more than 1.5×) is a contradiction.
 */
export function transitDistanceConflicts(specs) {
  return transitDistanceDisputes(specs).map((d) => d.text);
}

/**
 * The same disagreements with the station and both figures, so a reply can be checked: a distance for that station is
 * not stated while the listing gives two (a map lookup settles it). [{ station, key, meters: [listed, written], text }]
 */
export function transitDistanceDisputes(specs) {
  const written = textDistances([specs.surroundings, specs.description].filter(Boolean).join("\n"));
  if (!written.length) return [];
  const out = [];
  for (const entry of specs.nearby?.public_transport || []) {
    const m = String(entry).match(/^(.*?)\s*\(([^)]*\d[^)]*)\)/); // "LRT Sri Rampai (2.4km)"
    if (!m) continue;
    const key = stopKey(m[1]).trim(), listed = distM(m[2]);
    if (key.length < 3 || listed >= 1e9) continue;
    const t = written.find((w) => w.key.includes(` ${key} `));
    if (!t || !t.meters) continue;
    const hi = Math.max(t.meters, listed), lo = Math.min(t.meters, listed);
    if (hi - lo > 300 && hi / lo > 1.5) out.push({ station: m[1].trim(), key, meters: [listed, t.meters], text: `transit list: ${m[1].trim()} ${m[2].trim()} · location text: ${t.label}` });
  }
  return out;
}

/**
 * Details where the sources disagree: a website figure against a staff check (a fresh staff check settles it, an
 * old one does not), or the listing contradicting itself (e.g. "Unfurnished" with furnished items listed).
 */
export function conflicts(specs, facts, { factsFresh = false } = {}) {
  const out = [];
  if (/^unfurnished$/i.test(specs.furnishing) && specs.furnished_items?.length) {
    out.push({ field: "furnishing", values: ["website furnishing: Unfurnished", `website furnished items: ${specs.furnished_items.join(", ")}`], resolved: false });
  }
  const transit = transitDistanceConflicts(specs);
  if (transit.length) out.push({ field: "transport", values: transit, resolved: false });
  if (!facts) return out;
  const web = numOf(specs.maintenance_fee_psf), staff = Number(facts.maintenance_fee_psf);
  if (web && staff && Math.abs(web - staff) > 0.001) out.push({ field: "maintenance_fee", values: [`website: RM${web} psf`, `staff check: RM${staff} psf`], resolved: factsFresh });
  const wy = String(specs.expected_completion).match(/\b(20\d\d)\b/)?.[1], sy = String(facts.completion_date || "").match(/\b(20\d\d)\b/)?.[1];
  if (wy && sy && wy !== sy) out.push({ field: "expected_completion", values: [`website: ${wy}`, `staff check: ${facts.completion_date}`], resolved: factsFresh });
  return out;
}
