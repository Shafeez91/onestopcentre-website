// Builds the verified context for one buyer turn, plus the allow-lists the validator checks the reply against.
// `db` is a small adapter: { get(path) -> rows[], rpc(name, args) -> result } over PostgREST.
import { extractAmounts, PROMOTION, layoutKey } from "../../sales/shared/validator.mjs";
import { projectSpecs, resolveFocus, coverage, conflicts as findConflicts, numOf } from "../../sales/shared/listing.mjs";
import { workflowContext } from "./workflows.mjs";
import { profileContext } from "./insights.mjs";

const SITE = "https://onestopcentreproperty.com/";
const DAY = 864e5;
const enc = encodeURIComponent;
const clean = (v) => { v = String(v ?? "").trim(); return /^(none|null|undefined)$/i.test(v) ? "" : v; };
const num = (v) => { const n = +String(v ?? "").replace(/[^\d.]/g, ""); return n > 0 ? n : null; };

/** Buyer-written figures such as "budget 500k", "RM450,000", "dalam 400 ribu". */
export function buyerAmounts(text) {
  const out = extractAmounts(text).map((a) => a.value);
  for (const m of String(text || "").matchAll(/\b(\d{2,4}(?:\.\d+)?)\s?(k|ribu)\b/gi)) out.push(Number(m[1]) * 1000);
  for (const m of String(text || "").matchAll(/\b(\d{3},\d{3}|\d{6,7})\b/g)) out.push(Number(m[1].replace(/,/g, "")));
  return out;
}

/** OR-query for full-text search from the buyer's words (BM + EN), skipping short words. */
export function searchQuery(text) {
  const words = [...new Set(String(text || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4))].slice(0, 12);
  return words.join(" or ");
}

export async function loadContext(db, { leadId = null, message = "", history = [], now = new Date() } = {}) {
  const [settingsRows, objections, siteSettings, projectRows, facts, prices, units, promotions] = await Promise.all([
    db.get("ai_settings?id=eq.1&select=*"),
    db.get("ai_objections?active=eq.true&select=key,examples,guidance_en,guidance_ms,escalate&order=key"),
    db.get("settings?id=eq.1&select=data"),
    db.get("projects?published=eq.true&select=id,slug,data"),
    db.get("ai_project_facts?select=*"),
    db.get("ai_project_prices?effective_to=is.null&select=*"),
    db.get("ai_project_units?select=project_id,unit_type,status,status_verified_at,list_price"),
    db.get("ai_active_promotions?select=*"),
  ]);
  const settings = settingsRows[0] || {};
  const B = settings.business || {};
  const priceMaxMs = (B.price_max_age_days || 30) * DAY, invMaxMs = (B.inventory_max_age_hours || 72) * 36e5;
  const wa = clean(siteSettings?.[0]?.data?.wa).replace(/\D/g, "");
  const L = siteSettings?.[0]?.data?.loan || {};
  const websiteLoan = num(L.r) || num(L.m) ? { margin_pct: num(L.m) || 90, rate_pct: num(L.r) || 4.5, tenure_years: num(L.y) || 35 } : null;

  let lead = null, buyer = null, interests = [], appointments = [], aiPaused = false, workflows = [], workflowOffers = [], clientProfile = null, profileMeta = {};
  if (leadId) {
    const rows = await db.get(`ai_leads?id=eq.${enc(leadId)}&select=*,contact:ai_contacts(full_name,salutation,preferred_language,phone_e164)`);
    const l = rows[0];
    if (l) {
      interests = (await db.get(`ai_lead_interests?lead_id=eq.${enc(leadId)}&select=project_id,interest`)) || [];
      appointments = (await db.get(`ai_appointments?lead_id=eq.${enc(leadId)}&status=in.(pending_confirmation,confirmed,rescheduled)&select=id,kind,status,start_at,preferred_text,project_id`)) || [];
      ({ workflows, offers: workflowOffers } = await workflowContext(db, leadId).catch(() => ({ workflows: [], offers: [] })));
      const stages = (await db.get("ai_pipeline_stages?select=id,key,name,position,is_won,is_lost,active,ai_settable,description&order=position.asc").catch(() => [])) || [];
      clientProfile = profileContext(l, stages);
      profileMeta = l.profile_meta || {};
      aiPaused = !!l.ai_paused;
      buyer = { name: clean(l.contact?.full_name) || null, salutation: clean(l.contact?.salutation) || null, preferred_language: l.contact?.preferred_language || null };
      lead = {
        lead_code: l.lead_code, temperature: l.temperature, score: l.score,
        qualification_known: Object.fromEntries(Object.entries(l.qualification || {}).filter(([k, v]) => k !== "signals" && v !== null && v !== "")),
        interested_project_ids: interests.map((i) => i.project_id), primary_project_id: l.primary_project_id,
        open_appointments: appointments,
      };
    }
  }

  const factsBy = Object.fromEntries((facts || []).map((f) => [f.project_id, f]));
  const focus = resolveFocus((projectRows || []).map((r) => ({ id: r.id, slug: r.slug, name: clean(r.data?.n) })), { message, history, lead });
  const projects = (projectRows || []).map((r) => {
    const d = r.data || {}, f = factsBy[r.id], spec = projectSpecs(d);
    const factsFresh = !!f?.verified_at && now - new Date(f.verified_at) <= priceMaxMs;
    const pr = (prices || []).filter((x) => x.project_id === r.id).map((x) => ({ ...x, fresh: !!x.verified_at && now - new Date(x.verified_at) <= priceMaxMs }));
    const us = (units || []).filter((u) => u.project_id === r.id);
    const freshAvail = us.filter((u) => u.status === "available" && u.status_verified_at && now - new Date(u.status_verified_at) <= invMaxMs);
    const factFields = f ? Object.fromEntries(["title_type", "booking_fee", "payment_terms", "maintenance_fee_psf", "sinking_fund_psf", "parking_allocation", "completion_date", "eligibility", "restrictions", "showroom_address", "showroom_hours", "showroom_map_url", "official_url", "notes"]
      .filter((k) => k !== "notes" && f[k] !== null && f[k] !== "").map((k) => [k, f[k]])) : null;
    const cov = coverage(spec, f, { factsFresh });
    const inFocus = focus.ids.includes(r.id);
    // full details for the project(s) being discussed; a compact summary of the others keeps every turn small
    const full = inFocus;
    return {
      id: r.id, name: spec.name, area: spec.area, developer: spec.developer, type: spec.property_type, status: spec.status, tenure: spec.tenure,
      inFocus,
      completion: f?.completion_date || spec.expected_completion || null, completionVerified: !!f?.completion_date,
      url: SITE + "property/" + r.slug + "/", urlMs: SITE + "ms/property/" + r.slug + "/", brochure: spec.brochure_url || null, mapUrl: spec.map_url || null,
      layouts: spec.layouts,
      websitePrices: [...spec.layouts.map((l) => l.price_from), d.p].map(num).filter((n) => n && n >= 10000),
      maintPsfWebsite: numOf(spec.maintenance_fee_psf) || null,
      layoutMaintPsf: spec.layouts.map((l) => numOf(l.maintenance_fee_psf)).filter(Boolean),
      // what the project page states (published specifications)
      specs: Object.fromEntries(Object.entries({
        lease_years: spec.lease_years, size_range: spec.size_range, bedrooms_max: spec.bedrooms_max, car_parks_all_units: spec.car_parks_all_units,
        furnishing: spec.furnishing, furnished_items: full ? spec.furnished_items : [],
        towers: full ? spec.towers : [], total_units: spec.total_units, floors: spec.floors,
        highlights: spec.highlights.slice(0, full ? 12 : 4), transit_oriented: spec.transit_oriented, address: spec.address,
        description: full ? spec.description.slice(0, 3000) : "",
        surroundings: full ? spec.surroundings.slice(0, 4000) : "",
      }).filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && !v.length))),
      money: Object.fromEntries(Object.entries({ price_from: spec.price_from, maintenance_fee_psf: spec.maintenance_fee_psf }).filter(([, v]) => v)),
      facilities: full ? spec.facilities : spec.facilities.slice(0, 8),
      facilitiesTotal: spec.facilities.length,
      nearby: full ? spec.nearby : Object.fromEntries(Object.entries(spec.nearby).filter(([k]) => k === "public_transport").map(([k, v]) => [k, v.slice(0, 2)])),
      notOnRecord: full ? Object.entries(cov).filter(([, c]) => c.status === "missing").map(([k]) => k) : [],
      partial: full ? Object.entries(cov).filter(([, c]) => c.status === "partial").map(([k]) => k) : [],
      conflicts: findConflicts(spec, f, { factsFresh }),
      facts: factFields, factsFresh,
      prices: pr,
      availability: us.length
        ? { recently_checked_available_units: freshAvail.length, units_on_record: us.length, by_layout: [...new Set(freshAvail.map((u) => u.unit_type).filter(Boolean))], label: freshAvail.length ? "VERIFIED" : "STALE" }
        : { note: "No unit inventory on record — availability must be confirmed by an advisor.", label: "UNKNOWN" },
      freshAvailable: freshAvail.length,
      freshUnitPrices: freshAvail.map((u) => num(u.list_price)).filter(Boolean),
    };
  });

  // Approved knowledge: the general entries and those of the project(s) in focus are always given (up to a size
  // budget), so a policy the staff wrote down is found however the buyer words the question; the full-text
  // search adds matching entries beyond that (e.g. for other projects, or when the knowledge base grows large).
  const KB_BUDGET = 8000;
  const [chunks, faqs] = await Promise.all([
    db.get("ai_knowledge_chunks?approved=eq.true&select=id,project_id,title,content&order=updated_at.desc&limit=60").catch(() => []),
    db.get("ai_faqs?approved=eq.true&select=id,project_id,question,answer&order=updated_at.desc&limit=60").catch(() => []),
  ]);
  const inScope = (k) => !k.project_id || focus.ids.includes(k.project_id);
  const knowledge = [];
  let used = 0;
  for (const k of [...(faqs || []).map((f) => ({ kind: "faq", id: f.id, project_id: f.project_id, title: f.question, content: f.answer })), ...(chunks || []).map((c) => ({ kind: "chunk", ...c }))]) {
    if (!inScope(k) || used + String(k.content || "").length > KB_BUDGET) continue;
    knowledge.push(k); used += String(k.content || "").length;
  }
  const q = searchQuery([...(history || []).filter((h) => h.role !== "assistant").slice(-1).map((h) => h.text), message].join(" "));
  const found = q ? ((await db.rpc("ai_search_knowledge", { q, p_project: null, only_approved: true, max_rows: 6 }).catch(() => [])) || []) : [];
  for (const k of found) if (!knowledge.some((x) => x.id === k.id)) knowledge.push(k);

  const conversationText = [...(history || []).filter((h) => h.role !== "assistant").map((h) => h.text), message].join("\n");
  const allowed = new Set(), indicative = new Set();
  for (const p of projects) {
    p.prices.forEach((x) => (x.fresh ? allowed : indicative).add(Number(x.price_myr)));
    p.freshUnitPrices.forEach((n) => allowed.add(n));
    p.websitePrices.forEach((n) => indicative.add(n));
    if (p.maintPsfWebsite) indicative.add(p.maintPsfWebsite);
    p.layoutMaintPsf.forEach((n) => indicative.add(n));
    if (p.facts) {
      for (const k of ["booking_fee", "payment_terms", "eligibility", "restrictions", "parking_allocation"]) extractAmounts(p.facts[k]).forEach((a) => allowed.add(a.value));
      for (const k of ["maintenance_fee_psf", "sinking_fund_psf"]) if (p.facts[k] !== undefined) allowed.add(Number(p.facts[k]));
    }
  }
  for (const pr of promotions || []) extractAmounts(`${pr.title} ${pr.details} ${pr.conditions || ""}`).forEach((a) => allowed.add(a.value));
  for (const k of knowledge) extractAmounts(k.content).forEach((a) => allowed.add(a.value));
  buyerAmounts(conversationText).forEach((n) => allowed.add(n));

  const allowedUrls = new Set();
  for (const p of projects) [p.url, p.urlMs, p.brochure, p.mapUrl, p.facts?.official_url, p.facts?.showroom_map_url].filter(Boolean).forEach((u) => allowedUrls.add(u));
  if (wa) { allowedUrls.add("https://wa.me/" + wa); allowedUrls.add("wa.me/" + wa); }

  const isFirstReply = !(history || []).some((h) => h.role === "assistant");
  return {
    settings, objections: objections || [], lead, buyer, aiPaused, isFirstReply, websiteLoan, workflows, workflowOffers, clientProfile, profileMeta, businessWa: wa ? "https://wa.me/" + wa : null,
    today: now.toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }),
    projects, focus, promotions: promotions || [], knowledge,
    rules: {
      allowedAmounts: [...allowed], indicativeAmounts: [...indicative],
      hasFreshAvailability: projects.some((p) => p.freshAvailable > 0),
      hasActivePromotion: (promotions || []).length > 0,
      // a discount, rebate or free legal fees described in approved knowledge may be mentioned like a promotion
      knowledgeCoversPromotion: knowledge.some((k) => PROMOTION.test(`${k.title} ${k.content}`)),
      appointmentConfirmed: appointments.some((a) => a.status === "confirmed" && a.start_at && new Date(a.start_at) > now),
      isFirstReply, allowedUrls: [...allowedUrls], allowedHosts: ["onestopcentreproperty.com"],
      maxChars: settings.ai?.max_reply_chars || 700,
      // each layout's own prices (website "from" price and staff-checked prices), for the projects being discussed
      layoutPrices: (projects.some((p) => p.inFocus) ? projects.filter((p) => p.inFocus) : projects).map((p) => ({ project: p.name,
        layouts: (p.layouts || []).map((l) => ({ key: layoutKey(l.layout), prices: [num(l.price_from), ...p.prices.filter((x) => layoutKey(x.unit_type) === layoutKey(l.layout)).map((x) => Number(x.price_myr))].filter((n) => n >= 10000) }))
          .filter((l) => l.key) })),
    },
  };
}
