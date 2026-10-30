// Rental estimates (31 Oct 2026): a buyer asks about rent, yield or "which layout gives the better margin". The AI never
// makes up a rent rate or does the arithmetic itself. The rate comes from a source — the knowledge base first
// (staff-written, e.g. "Sewa M Aurora: RM2.30–2.80 psf, bilik RM700–900 (iProperty, Okt 2026)"), otherwise web
// research on current listings — and the figures per layout are worked out here: monthly rent, gross yield, rent
// after maintenance, and per-room rent when the source gives room rates. Everything is labelled as an estimate.

import { numOf } from "./listing.mjs";

// the buyer is asking about renting the unit out or the return on it (BM, English, Manglish)
export const RENTAL_Q = /(sewa|sewaan|sewakan|rent|rental|yield|pulangan|\broi\b|return on|margin|untung|profit|tenant|penyewa|airbnb|homestay|short[-\s]?stay|cash\s?flow)/i;
const RENT_WORD = /(sewa|rent|rental|tenant|penyewa|listing)/i;
const NUM = "(\\d{1,2}(?:\\.\\d{1,2})?)";
const MONEY = "([\\d,]{3,6})";
const DASH = "\\s*(?:-|–|—|to|hingga|sehingga|ke)\\s*(?:RM\\s?)?";
const PSF = new RegExp(`RM\\s?${NUM}(?:${DASH}${NUM})?\\s*(?:psf|per\\s*sq\\.?\\s*ft|\\/\\s*sq\\.?\\s*ft|per\\s*square\\s*foot|kaki\\s*persegi|ksp)`, "gi");
const ROOM_AFTER = new RegExp(`RM\\s?${MONEY}(?:${DASH}${MONEY})?\\s*(?:\\/|per|untuk|utk|for|a|setiap|each)?\\s*(?:bilik|room)`, "gi");
const ROOM_BEFORE = new RegExp(`(?:bilik|room)s?[^.\\n\\d]{0,25}RM\\s?${MONEY}(?:${DASH}${MONEY})?`, "gi");
const n = (s) => Number(String(s).replace(/,/g, ""));

/** Rent rates in a text, only from sentences about renting: { psf: [min, max] | null, room: [min, max] | null }. */
export function parseRentRates(text) {
  const psf = [], room = [];
  for (const sentence of String(text || "").split(/(?<=[.!?])\s+|\n+/)) {
    if (!RENT_WORD.test(sentence)) continue;
    for (const m of sentence.matchAll(PSF)) { const a = n(m[1]), b = m[2] ? n(m[2]) : a; if (a >= 0.5 && b <= 15 && a <= b) psf.push(a, b); }
    for (const re of [ROOM_AFTER, ROOM_BEFORE]) for (const m of sentence.matchAll(re)) { const a = n(m[1]), b = m[2] ? n(m[2]) : a; if (a >= 200 && b <= 5000 && a <= b) room.push(a, b); }
  }
  const range = (xs) => (xs.length ? [Math.min(...xs), Math.max(...xs)] : null);
  return { psf: range(psf), room: range(room) };
}

/**
 * Where the rent rate comes from: the first knowledge entry (for the projects in focus, then general ones) that states
 * one, otherwise the web research findings. Returns { psf, room, source: { kind, title?, urls?, date? } } or null.
 */
export function findRentRates({ knowledge = [], projectIds = [], web = null } = {}) {
  const ordered = [...knowledge.filter((k) => k.project_id && projectIds.includes(k.project_id)), ...knowledge.filter((k) => !k.project_id)];
  for (const k of ordered) {
    const r = parseRentRates(`${k.title || ""}\n${k.content || ""}`);
    if (r.psf || r.room) return { ...r, source: { kind: "knowledge base", title: k.title || null, key: k.id ? `kb:${k.id}` : null } };
  }
  if (web?.found && web.findings) {
    const r = parseRentRates(web.findings);
    if (r.psf || r.room) return { ...r, source: { kind: "web research", urls: (web.sources || []).map((s) => s.url).filter((u) => /^https?:\/\//.test(u || "")).slice(0, 3), date: String(web.at || "").slice(0, 10) || null } };
  }
  return null;
}

const round10 = (x) => Math.round(x / 10) * 10;
const pct = (x) => Math.round(x * 10) / 10;
const rm = (x) => "RM" + Math.round(x).toLocaleString("en-MY");
const span = (a, b, f) => (a === b ? f(a) : `${f(a)}–${f(b)}`);

/**
 * The estimate for one project's layouts. project: { name, layouts: [{ layout, size_sqft, bedrooms, price_from,
 * maintenance_fee_psf }], maintPsf }. Returns { project, layouts: [...], amounts: [every RM figure it states] }.
 */
export function rentalEstimate(project, rates) {
  if (!project || !rates || (!rates.psf && !rates.room)) return null;
  const amounts = [];
  const keep = (...xs) => { for (const x of xs) if (Number.isFinite(x)) amounts.push(Math.round(x)); };
  if (rates.psf) amounts.push(...rates.psf);
  if (rates.room) keep(...rates.room);
  const layouts = [];
  for (const l of project.layouts || []) {
    const size = numOf(l.size_sqft), price = numOf(l.price_from), beds = numOf(l.bedrooms);
    const maintPsf = numOf(l.maintenance_fee_psf) || Number(project.maintPsf) || 0;
    const row = { layout: l.layout || "", size_sqft: size || null, price_from: price >= 10000 ? rm(price) : null };
    if (rates.psf && size) {
      const lo = round10(rates.psf[0] * size), hi = round10(rates.psf[1] * size);
      row.whole_unit_rent_per_month = span(lo, hi, rm);
      keep(lo, hi);
      if (price >= 10000) row.gross_yield = span(pct((lo * 12 * 100) / price), pct((hi * 12 * 100) / price), (x) => x + "%");
      if (maintPsf) {
        const m = round10(maintPsf * size);
        row.maintenance_per_month = rm(m);
        row.rent_after_maintenance = span(lo - m, hi - m, rm);
        keep(m, lo - m, hi - m);
      }
    }
    if (rates.room && beds) {
      const lo = rates.room[0] * beds, hi = rates.room[1] * beds;
      row.rooms = beds;
      row.room_rent_total_per_month = span(lo, hi, rm);
      keep(lo, hi);
      if (price >= 10000) row.gross_yield_by_room = span(pct((lo * 12 * 100) / price), pct((hi * 12 * 100) / price), (x) => x + "%");
    }
    if (row.whole_unit_rent_per_month || row.room_rent_total_per_month) layouts.push(row);
  }
  if (!layouts.length) return null;
  return { project: project.name, layouts, amounts };
}

/** What the AI sees: the figures, the rate, the source and the labels. */
export function renderRental(estimates, rates) {
  if (!estimates?.length) return null;
  const s = rates.source || {};
  return {
    label: "ESTIMATE (not a guarantee of rent or return)",
    rate: [rates.psf ? `whole unit ${span(rates.psf[0], rates.psf[1], (x) => "RM" + x.toFixed(2))} psf a month` : "", rates.room ? `per room ${span(rates.room[0], rates.room[1], rm)} a month` : ""].filter(Boolean).join("; "),
    source: s.kind === "knowledge base" ? `our knowledge base${s.title ? `: "${s.title}"` : ""}` : `web research${s.date ? ` (${s.date})` : ""}${s.urls?.length ? `: ${s.urls.join(", ")}` : ""}`,
    projects: estimates.map((e) => ({ project: e.project, layouts: e.layouts })),
    notes: "Gross yield = 12 months' rent ÷ the website price. Rent after maintenance leaves out sinking fund, tax, vacancy, furnishing and repairs.",
  };
}
