// Builds the verified context for one buyer turn, plus the allow-lists the validator checks the reply against.
// `db` is a small adapter: { get(path) -> rows[], rpc(name, args) -> result } over PostgREST.
import { extractAmounts } from "../../sales/shared/validator.mjs";

const SITE = "https://onestopcentreproperty.com/";
const DAY = 864e5;
const enc = encodeURIComponent;
const clean = (v) => { v = String(v ?? "").trim(); return /^(none|null|undefined)$/i.test(v) ? "" : v; };
const num = (v) => { const n = +String(v ?? "").replace(/[^\d.]/g, ""); return n > 0 ? n : null; };
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

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

  let lead = null, buyer = null, interests = [], appointments = [], aiPaused = false;
  if (leadId) {
    const rows = await db.get(`ai_leads?id=eq.${enc(leadId)}&select=*,contact:ai_contacts(full_name,salutation,preferred_language,phone_e164)`);
    const l = rows[0];
    if (l) {
      interests = (await db.get(`ai_lead_interests?lead_id=eq.${enc(leadId)}&select=project_id,interest`)) || [];
      appointments = (await db.get(`ai_appointments?lead_id=eq.${enc(leadId)}&status=in.(pending_confirmation,confirmed,rescheduled)&select=id,kind,status,start_at,preferred_text,project_id`)) || [];
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
  const projects = (projectRows || []).map((r) => {
    const d = r.data || {}, f = factsBy[r.id];
    const pr = (prices || []).filter((x) => x.project_id === r.id).map((x) => ({ ...x, fresh: !!x.verified_at && now - new Date(x.verified_at) <= priceMaxMs }));
    const us = (units || []).filter((u) => u.project_id === r.id);
    const freshAvail = us.filter((u) => u.status === "available" && u.status_verified_at && now - new Date(u.status_verified_at) <= invMaxMs);
    const factFields = f ? Object.fromEntries(["title_type", "booking_fee", "payment_terms", "maintenance_fee_psf", "sinking_fund_psf", "parking_allocation", "completion_date", "eligibility", "restrictions", "showroom_address", "showroom_hours", "showroom_map_url", "official_url", "notes"]
      .filter((k) => k !== "notes" && f[k] !== null && f[k] !== "").map((k) => [k, f[k]])) : null;
    return {
      id: r.id, name: clean(d.n), area: clean(d.l), developer: clean(d.d), type: clean(d.t) || clean(d.c), status: clean(d.s), tenure: clean(d.tenure),
      completion: f?.completion_date || clean(d.year) || null, completionVerified: !!f?.completion_date,
      url: SITE + "property/" + r.slug + "/", urlMs: SITE + "ms/property/" + r.slug + "/", brochure: /^https?:/.test(d.brochure || "") ? d.brochure : null, mapUrl: /^https?:/.test(d.mapUrl || "") ? d.mapUrl : null,
      layouts: arr(d.types).filter((t) => t && t.name).map((t) => ({ layout: clean(t.name), size_sqft: clean(t.size), bedrooms: clean(t.beds), bathrooms: clean(t.baths), price_from: clean(t.price) || null })),
      websitePrices: [...arr(d.types).map((t) => t && t.price), d.p].map(num).filter((n) => n && n >= 10000),
      maintPsfWebsite: num(d.maintPsf),
      facilities: arr(d.facilities).filter((x) => typeof x === "string" && x).slice(0, 15),
      nearby: Object.fromEntries(Object.entries(obj(d.near)).map(([k, v]) => [k, arr(v).filter((x) => x && x.n).slice(0, 5).map((x) => [x.n, x.d].filter(Boolean).join(" "))]).filter(([, v]) => v.length)),
      facts: factFields, factsFresh: !!f?.verified_at && now - new Date(f.verified_at) <= priceMaxMs,
      prices: pr,
      availability: us.length
        ? { recently_checked_available_units: freshAvail.length, units_on_record: us.length, by_layout: [...new Set(freshAvail.map((u) => u.unit_type).filter(Boolean))], label: freshAvail.length ? "VERIFIED" : "STALE" }
        : { note: "No unit inventory on record — availability must be confirmed by an advisor.", label: "UNKNOWN" },
      freshAvailable: freshAvail.length,
      freshUnitPrices: freshAvail.map((u) => num(u.list_price)).filter(Boolean),
    };
  });

  const q = searchQuery(message);
  const knowledge = q ? ((await db.rpc("ai_search_knowledge", { q, p_project: null, only_approved: true, max_rows: 6 }).catch(() => [])) || []) : [];

  const conversationText = [...(history || []).filter((h) => h.role !== "assistant").map((h) => h.text), message].join("\n");
  const allowed = new Set(), indicative = new Set();
  for (const p of projects) {
    p.prices.forEach((x) => (x.fresh ? allowed : indicative).add(Number(x.price_myr)));
    p.freshUnitPrices.forEach((n) => allowed.add(n));
    p.websitePrices.forEach((n) => indicative.add(n));
    if (p.maintPsfWebsite) indicative.add(p.maintPsfWebsite);
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
    settings, objections: objections || [], lead, buyer, aiPaused, isFirstReply, businessWa: wa ? "https://wa.me/" + wa : null,
    today: now.toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }),
    projects, promotions: promotions || [], knowledge,
    rules: {
      allowedAmounts: [...allowed], indicativeAmounts: [...indicative],
      hasFreshAvailability: projects.some((p) => p.freshAvailable > 0),
      hasActivePromotion: (promotions || []).length > 0,
      appointmentConfirmed: appointments.some((a) => a.status === "confirmed" && a.start_at && new Date(a.start_at) > now),
      isFirstReply, allowedUrls: [...allowedUrls], allowedHosts: ["onestopcentreproperty.com"],
      maxChars: settings.ai?.max_reply_chars || 700,
    },
  };
}
