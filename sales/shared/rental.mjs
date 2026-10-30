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

// room rent depends on the room: master (with its own bathroom), medium, small ("bilik utama", "single room", ...)
const ROOM_KIND = { master: /^(master|utama)$/i, medium: /^(medium|middle|queen|sederhana|tengah)$/i, small: /^(small|single|kecil)$/i };
const TYPED_ROOM = new RegExp(`\\b(master|utama|medium|middle|queen|sederhana|tengah|small|single|kecil)\\b[^\\d\\n]{0,20}?RM\\s?${MONEY}(?:${DASH}${MONEY})?`, "gi");
const range = (xs) => (xs.length ? [Math.min(...xs), Math.max(...xs)] : null);

// worked examples in a reference ("Example: 1 Master Room: RM1,200 …") are not rates
function withoutExamples(text) {
  const out = [];
  let skipping = false;
  for (const line of String(text || "").split("\n")) {
    if (/^\s*(examples?|contoh)\b[^:]*:?\s*$/i.test(line) || /^\s*(examples?|contoh)\s+(using|guna)\b/i.test(line)) { skipping = true; continue; }
    if (skipping && /^\s*(⸻|\d+\.\s|[A-Z][A-Z0-9 &/—–-]{6,}$)/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

/**
 * Rent rates in a text: { psf, room, roomTypes } — psf and flat per-room ranges only from sentences about renting;
 * room rates by type (master / medium / small) from any line naming a room.
 */
export function parseRentRates(text) {
  const psf = [], room = [], kinds = { master: [], medium: [], small: [] };
  for (const sentence of withoutExamples(text).split(/(?<=[.!?])\s+|\n+/)) {
    if (/(bilik|room)/i.test(sentence)) {
      let typed = false;
      for (const m of sentence.matchAll(TYPED_ROOM)) {
        const kind = Object.keys(ROOM_KIND).find((k) => ROOM_KIND[k].test(m[1])), a = n(m[2]), b = m[3] ? n(m[3]) : a;
        if (kind && a >= 200 && b <= 5000 && a <= b) { kinds[kind].push(a, b); typed = true; }
      }
      if (typed) continue;
    }
    if (!RENT_WORD.test(sentence)) continue;
    for (const m of sentence.matchAll(PSF)) { const a = n(m[1]), b = m[2] ? n(m[2]) : a; if (a >= 0.5 && b <= 15 && a <= b) psf.push(a, b); }
    for (const re of [ROOM_AFTER, ROOM_BEFORE]) for (const m of sentence.matchAll(re)) { const a = n(m[1]), b = m[2] ? n(m[2]) : a; if (a >= 200 && b <= 5000 && a <= b) room.push(a, b); }
  }
  const roomTypes = Object.fromEntries(Object.entries(kinds).filter(([, v]) => v.length).map(([k, v]) => [k, range(v)]));
  return { psf: range(psf), room: range(room), roomTypes: Object.keys(roomTypes).length ? roomTypes : null };
}
const hasRooms = (r) => !!(r && (r.room || r.roomTypes));

const SCENARIO = /RM\s?(\d{1,2}(?:\.\d{1,2})?)\s*psf[^.\n]*(conservative|konservatif|scenario|senario|andaian|baseline|default)/i;
const RANGE = new RegExp(`RM\\s?${NUM}(?:${DASH}${NUM})?`, "i");
const cited = (content) => (String(content).match(/^\s*Source(?: reference)?\s*:\s*(.+)$/im)?.[1] || "").trim().slice(0, 120) || null;
const terms = (project) => [project?.name, ...String(project?.area || "").split(/[,/]/)].map((t) => String(t || "").toLowerCase().trim()).filter((t) => t.length >= 4);

/** The rate a general knowledge entry gives for the project's own area (a table row or line naming it). */
function areaRate(k, project) {
  const content = String(k.content || ""), psfDoc = /psf/i.test(content), ts = terms(project);
  if (!ts.length) return null;
  for (const line of content.split("\n")) {
    const low = line.toLowerCase();
    const hit = ts.find((t) => low.includes(t));
    if (!hit || /(maint|penyelenggaraan|sinking|caj|booking|harga|price)/i.test(line)) continue; // fees and prices are not rents
    const r = parseRentRates(RENT_WORD.test(line) ? line : `rent ${line}`);
    if (!r.psf && psfDoc) {
      const m = line.match(RANGE);
      if (m) { const a = n(m[1]), b = m[2] ? n(m[2]) : a; if (a >= 0.5 && b <= 15 && a <= b) r.psf = [a, b]; }
    }
    if (r.psf || hasRooms(r)) return { ...r, place: line.replace(/\|/g, " ").replace(/RM[\s\S]*$/, "").replace(/\s+/g, " ").trim().slice(0, 80) || hit };
  }
  return null;
}

/**
 * The rent rates for one project ({ id, name, area }). The whole-unit rate (psf) and the room rates are looked up
 * separately, each in this order: a knowledge entry for the project itself; a general entry's line for the project's
 * area (e.g. a market table row naming it); then, for psf, the general entry's conservative scenario rate, and for
 * rooms, a general room-rate entry ("Master room RM1,200 …"); finally web research findings.
 * Returns { psf, source, room, roomTypes, roomSource } (sources: { kind, basis, title?, place?, cited?, urls?, date? })
 * or null when neither is found.
 */
export function findRentRates({ knowledge = [], project = null, web = null } = {}) {
  const own = knowledge.filter((k) => project?.id && k.project_id === project.id), general = knowledge.filter((k) => !k.project_id);
  const kb = (k, basis, extra = {}) => ({ kind: "knowledge base", basis, title: k.title || null, cited: cited(k.content), ...extra });
  const fromWeb = web?.found && web.findings ? parseRentRates(web.findings) : null;
  const webSource = { kind: "web research", basis: "market", urls: (web?.sources || []).map((x) => x.url).filter((u) => /^https?:\/\//.test(u || "")).slice(0, 3), date: String(web?.at || "").slice(0, 10) || null };
  let psf = null, source = null, rooms = null, roomSource = null;
  for (const k of own) {
    const r = parseRentRates(`${k.title || ""}\n${k.content || ""}`);
    if (!psf && r.psf) { psf = r.psf; source = kb(k, "project"); }
    if (!rooms && hasRooms(r)) { rooms = r; roomSource = kb(k, "project"); }
  }
  for (const k of general) {
    if (psf && rooms) break;
    const r = areaRate(k, project);
    if (!r) continue;
    if (!psf && r.psf) { psf = r.psf; source = kb(k, "area", { place: r.place }); }
    if (!rooms && hasRooms(r)) { rooms = r; roomSource = kb(k, "area", { place: r.place }); }
  }
  if (!psf) for (const k of general) {
    const m = withoutExamples(k.content).match(SCENARIO);
    if (m) { const v = n(m[1]); if (v >= 0.5 && v <= 15) { psf = [v, v]; source = { kind: "knowledge base", basis: "scenario", title: k.title || null }; break; } }
  }
  if (!rooms) for (const k of general) {
    const r = parseRentRates(k.content);
    if (r.roomTypes) { rooms = { roomTypes: r.roomTypes, room: null }; roomSource = kb(k, "room_reference"); break; }
  }
  if (!psf && fromWeb?.psf) { psf = fromWeb.psf; source = webSource; }
  if (!rooms && hasRooms(fromWeb)) { rooms = fromWeb; roomSource = webSource; }
  if (!psf && !rooms) return null;
  return { psf, source: source || roomSource, room: rooms?.roomTypes ? null : rooms?.room || null, roomTypes: rooms?.roomTypes || null, roomSource };
}

/** The rooms a layout can let: 1 master, then 1 medium, the rest small; a "+1" study counts as a small room. */
export function roomMix(bedrooms) {
  const text = String(bedrooms ?? ""), beds = numOf(text), plus = (text.match(/\+\s*(\d)/) || [])[1];
  if (!beds) return [];
  const mix = ["master"];
  for (let i = 1; i < beds; i++) mix.push(i === 1 ? "medium" : "small");
  for (let i = 0; i < Number(plus || 0); i++) mix.push("small");
  return mix;
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
  if (!project || !rates || (!rates.psf && !hasRooms(rates))) return null;
  const amounts = [];
  const keep = (...xs) => { for (const x of xs) if (Number.isFinite(x)) amounts.push(Math.round(x)); };
  if (rates.psf) amounts.push(...rates.psf);
  if (rates.room) keep(...rates.room);
  for (const r of Object.values(rates.roomTypes || {})) keep(...r);
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
    const mix = roomMix(l.bedrooms);
    const typed = rates.roomTypes && mix.length && mix.every((k) => rates.roomTypes[k] || (k === "medium" && rates.roomTypes.small));
    if (typed || (rates.room && mix.length)) {
      const rate = (k) => (typed ? rates.roomTypes[k] || rates.roomTypes.small : rates.room);
      const lo = mix.reduce((t, k) => t + rate(k)[0], 0), hi = mix.reduce((t, k) => t + rate(k)[1], 0);
      row.rooms = mix.length;
      row.room_mix = typed ? mix.map((k) => `${k[0].toUpperCase() + k.slice(1)} ${span(rate(k)[0], rate(k)[1], rm)}`).join(" + ") : `${mix.length} × ${span(rates.room[0], rates.room[1], rm)}`;
      row.room_rent_total_per_month = span(lo, hi, rm) + " (all rooms let)";
      keep(lo, hi);
      if (price >= 10000) row.gross_yield_by_room = span(pct((lo * 12 * 100) / price), pct((hi * 12 * 100) / price), (x) => x + "%");
    }
    if (row.whole_unit_rent_per_month || row.room_rent_total_per_month) layouts.push(row);
  }
  if (!layouts.length) return null;
  return { project: project.name, layouts, amounts };
}

const BASIS = {
  project: "a rent rate recorded for this project",
  area: "the asking-rent range for this area in our market reference",
  scenario: "a CONSERVATIVE SCENARIO rate from our rental reference, not actual rent data for this area",
  market: "current rental listings found on the web",
  room_reference: "our general room-rate reference",
};
const sourceText = (s = {}) => s.kind === "knowledge base"
  ? `our knowledge base${s.title ? ` ("${s.title}")` : ""}${s.place ? `, row "${s.place}"` : ""}${s.cited ? `, citing ${s.cited}` : ""}`
  : `web research${s.date ? ` (${s.date})` : ""}${s.urls?.length ? `: ${s.urls.join(", ")}` : ""}`;

/** What the AI sees: per project the figures, the rate, what it is based on and the source. items: [{ estimate, rates }] */
export function renderRental(items) {
  const list = (items || []).filter((x) => x?.estimate);
  if (!list.length) return null;
  return {
    label: "ESTIMATE (not a guarantee of rent or return)",
    projects: list.map(({ estimate, rates }) => ({
      project: estimate.project,
      rate: rates.psf ? `whole unit ${span(rates.psf[0], rates.psf[1], (x) => "RM" + x.toFixed(2))} psf a month` : null,
      based_on: rates.psf ? BASIS[rates.source?.basis] || "" : null,
      source: rates.psf ? sourceText(rates.source) : null,
      room_rates: rates.roomTypes ? Object.entries(rates.roomTypes).map(([k, r]) => `${k} room ${span(r[0], r[1], rm)}`).join("; ") : rates.room ? `per room ${span(rates.room[0], rates.room[1], rm)}` : null,
      room_source: hasRooms(rates) ? sourceText(rates.roomSource) + (rates.roomSource?.basis === "room_reference" ? " (general room-rate reference, not specific to this project)" : "") : null,
      layouts: estimate.layouts,
    })),
    notes: "Gross yield = 12 months' rent ÷ the website price. Rent after maintenance leaves out sinking fund, tax, vacancy, furnishing and repairs. Asking rents are not achieved rents. Room totals assume every room is let; actual collected rent is lower when a room is empty.",
  };
}
