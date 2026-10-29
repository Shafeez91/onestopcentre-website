// Business-rule validator for AI replies. It is deliberately independent of the model: whatever the AI writes,
// a reply that states an unverified price, availability, promotion, guarantee or confirmation is blocked.
//
// ctx (built by the context loader):
//   allowedAmounts      numbers (RM) verified as exact: current fresh prices, booking fees, promotion figures, customer's own figures
//   indicativeAmounts   numbers (RM) the website shows (indicative only)
//   hasFreshAvailability  true if some unit's status was verified within the freshness window
//   hasActivePromotion  true if an approved, in-date promotion exists for the projects in scope
//   knowledgeCoversPromotion  true if approved knowledge in the context describes a discount, rebate or free fees
//   appointmentConfirmed  true only when the calendar has confirmed a slot
//   isFirstReply        the AI's first message in this conversation (must disclose it is an AI)
//   allowedUrls         exact URLs the AI may share; allowedHosts hostnames always allowed
//   maxChars            reply length limit
//   strictAmounts       true when the loan engine is on: instalment / loan figures must come from the engine
//                       (they are in allowedAmounts), so the free-form "estimate with assumptions" allowance is off

const HEDGE = /(anggaran|anggarkan|indicative|indikatif|dari\s+rm|from\s+rm|bermula|starting|sekitar|around|lebih kurang|approx|approximately|tertakluk|subject to|kira-kira|lebih\s+kurang|estimate|estimated|mungkin)/i;
const ASSUMPTION = /(faedah|interest|kadar|rate|tempoh|tenure|tahun|years|margin|pinjaman|loan|financing|pembiayaan)/i;
const NEGATION_BEFORE = /(not|no|cannot|can't|cant|never|tidak|tak|bukan|tiada|takkan|belum|not yet|unable to|tidak dapat|tak boleh)\W+(\w+\W+){0,3}$/i;

const RM = /\bRM\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k|mil|million|juta|ribu)?\b/gi;

/** Extracts RM amounts from text, e.g. "RM450,000", "RM 450k", "RM1.2 juta", "RM0.35 psf". */
export function extractAmounts(text) {
  const out = [];
  for (const m of String(text || "").matchAll(RM)) {
    let n = Number(m[1].replace(/,/g, ""));
    const unit = (m[2] || "").toLowerCase();
    if (unit === "k" || unit === "ribu") n *= 1e3;
    if (unit === "mil" || unit === "million" || unit === "juta") n *= 1e6;
    if (isFinite(n)) out.push({ value: n, raw: m[0], index: m.index });
  }
  return out;
}

const near = (a, list) => list.some((b) => Math.abs(a - b) <= Math.max(1, b * 0.001));
const negated = (text, index) => NEGATION_BEFORE.test(text.slice(Math.max(0, index - 40), index));

function findAll(re, text) {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of text.matchAll(g)) out.push(m);
  return out;
}

const GUARANTEE = /(guarantee[ds]?|guaranteeing|dijamin|jaminan|menjamin|jamin|pasti\s+(lulus|untung|naik|dapat|approve)|confirm(ed)?\s+(lulus|approve[d]?|untung|naik)|sure\s+(get|to get|approve[d]?|lulus|profit)|definitely\s+(approved|get|increase|rise|profit)|100\s?%\s+(lulus|approved?|safe|selamat|untung|profit|dapat)|risk[-\s]?free|tanpa\s+risiko|confirm\s+boleh\s+dapat\s+loan)/i;
const AVAILABILITY = /((unit|units|bilik|type|jenis|layout|pelan)[^.?!\n]{0,30}(masih ada|ada lagi|masih available|still available|available now|are available|is available|tersedia|belum habis)|\b(still|masih)\s+(available|ada unit|ada kosong)|\bunits? (left|remaining)\b|tinggal\s+\d+\s+unit)/i;
export const PROMOTION = /(cashback|cash back|rebate|rebat|diskaun|discount|percuma|free\s+(legal|spa|furniture|gift|hadiah|aircond|kitchen)|promo(tion|si)?|potongan harga|early bird)/i;
const PROMO_HEDGE = /(tertakluk|subject to|semak|check|sahkan|confirm with|perlu (di)?sahkan|need to confirm|tiada promosi|no (current |active )?promotion|not able to confirm|belum dapat sahkan|tidak dapat sahkan|syarat|terms)/i;
const APPT_CONFIRM = /((appointment|temujanji|janji temu|booking|tempahan|slot|lawatan|visit|viewing)[^.?!\n]{0,40}(confirmed|disahkan|sudah (di)?sahkan|telah ditempah|dah book|berjaya ditempah|is booked|has been booked|telah dibuat)|\b(confirmed|disahkan)\b[^.?!\n]{0,30}(appointment|temujanji|slot|visit|lawatan|viewing))/i;
const IMPERSONATION = /((i am|i'm|im)\s+(a\s+)?(human|real person|real agent|not (a |an )?(bot|ai|robot))|saya\s+(manusia|orang sebenar|bukan\s+(bot|ai|robot))|(saya|i)\s+(dah|sudah|telah|have|has|had)\s+(pernah\s+)?(lawat|melawat|visited|been to|pergi ke|tengok sendiri|seen)\s+((the|that|this|our|your|ke)\s+)?(showroom|projek|project|site|unit|tapak))/i;
const AI_DISCLOSURE = /(\bAI\b|pembantu\s+AI|AI\s+assistant|assistant\s+AI|pembantu\s+maya|virtual\s+assistant|pembantu\s+digital|digital\s+assistant)/i;
const CHECKING = /(semak|check|confirm|sahkan|sama ada|whether|if any|kalau ada|akan maklumkan|will let you know|perlu (di)?sahkan|need to confirm)/i;
const PENDING = /(belum|not yet|pending|menunggu|akan (di)?sahkan|will confirm|to be confirmed|akan confirm|perlu (di)?sahkan)/i;
const CONFIRM_WORD = /(confirmed|disahkan|sudah (di)?sahkan|telah ditempah|dah book|berjaya ditempah|is booked|has been booked|telah dibuat)/i;
const sentenceAt = (text, index) => { const s = text.lastIndexOf(".", index) + 1, e = text.slice(index).search(/[.!?\n]/); return text.slice(s, e < 0 ? undefined : index + e); };
const LINK = /\bhttps?:\/\/[^\s)>\]]+|\bwa\.me\/\d+[^\s)]*/gi;

// distances ("650m", "2.4 km", "~1.2km") and travel times ("7 min", "10 minit") in a text
const DIST = /(\d+(?:[.,]\d+)?)\s?(km|kilometers?|kilometres?|m|meters?|metres?|meter)\b/gi;
const MINS = /(\d+(?:[.,]\d+)?)\s?(min|mins|minit|minutes?|jam|hours?|hrs?)\b/gi;
const numIn = (s) => parseFloat(/,\d{3}$/.test(s) ? s.replace(",", "") : s.replace(",", ".")); // "1,500" = 1500, "1,2" = 1.2
/** Distances in metres found in a text. */
export function extractDistances(text) {
  return [...String(text || "").matchAll(DIST)].map((m) => ({ value: numIn(m[1]) * (/^k/i.test(m[2]) ? 1000 : 1), raw: m[0], index: m.index }));
}
/** Travel times in minutes found in a text. */
export function extractMinutes(text) {
  return [...String(text || "").matchAll(MINS)].map((m) => ({ value: numIn(m[1]) * (/^(jam|h)/i.test(m[2]) ? 60 : 1), raw: m[0], index: m.index }));
}
const nearDist = (a, list) => list.some((b) => Math.abs(a - b) <= Math.max(100, b * 0.15));
const nearMin = (a, list) => list.some((b) => Math.abs(a - b) <= Math.max(2, b * 0.2));
const CHECK_CLAIM = /\b(saya|i|i've|kami|we|we've)\s+(dah\s+|sudah\s+|telah\s+|have\s+|has\s+|just\s+)?(semak|check(ed)?|cari|search(ed)?|look(ed)?\s+up|tengok|verify|verified)\b[^.!?\n]{0,25}\b(google\s*maps?|maps|waze|internet|online|web|google)\b/i;

/** "Type C", "type c", "Jenis C", "C" → "c"; "Type A1" → "a1". The key used to match a layout named in a reply. */
export const layoutKey = (s) => String(s || "").toLowerCase().replace(/\b(type|jenis|tipe|layout)\b/g, "").replace(/[^a-z0-9]/g, "");
const LAYOUT_REF = /\b(?:type|jenis|tipe)\s*([a-z]\d{0,2}|\d{1,2}[a-z]?)\b/gi;

/**
 * A price given for a layout must be that layout's price. Looks at each line and sentence that names layouts and
 * gives RM figures of property-price size: a figure that is the price of a DIFFERENT layout of the projects being
 * discussed (and not of the named one) is a mix-up, e.g. "Type C from RM480,000" when RM480,000 is Type B.
 * ctx.layoutPrices: [{ project, layouts: [{ key, prices: [n] }] }]
 */
export function layoutPriceMixups(text, layoutPrices = []) {
  const out = [];
  if (!layoutPrices.length) return out;
  for (const seg of String(text || "").split(/\n+|(?<=[.!?])\s+(?=[A-Z•*-])/)) {
    const named = [...new Set([...seg.matchAll(LAYOUT_REF)].map((m) => m[1].toLowerCase()))];
    if (!named.length) continue;
    const amounts = extractAmounts(seg).filter((a) => a.value >= 50000);
    if (!amounts.length) continue;
    const low = seg.toLowerCase();
    const mentioned = layoutPrices.filter((p) => low.includes(String(p.project || "").toLowerCase()));
    const scope = mentioned.length ? mentioned : layoutPrices;
    const ofNamed = scope.flatMap((p) => p.layouts.filter((l) => named.includes(l.key)).flatMap((l) => l.prices));
    if (!ofNamed.length) continue; // a layout we have no price for: the other rules decide
    const ofOthers = scope.flatMap((p) => p.layouts.filter((l) => !named.includes(l.key)).flatMap((l) => l.prices));
    for (const a of amounts) if (!near(a.value, ofNamed) && near(a.value, ofOthers)) out.push(`${a.raw} is the price of another layout, not of Type ${named.map((n) => n.toUpperCase()).join("/")}`);
  }
  return out;
}

/**
 * @returns {{ ok: boolean, violations: {code: string, detail: string}[] }}
 */
export function validateReply(reply, ctx = {}) {
  const text = String(reply || "");
  const v = [];
  const add = (code, detail) => v.push({ code, detail });
  if (!text.trim()) add("empty_reply", "The reply is empty.");

  // 1) prices — every RM figure must be verified, or indicative and clearly labelled, or an estimate with assumptions
  const allowed = ctx.allowedAmounts || [], indicative = ctx.indicativeAmounts || [];
  const hedged = HEDGE.test(text), assumptions = ASSUMPTION.test(text);
  for (const a of extractAmounts(text)) {
    if (near(a.value, allowed)) continue;
    if (near(a.value, indicative) && hedged) continue;
    if (a.value < 20000 && hedged && assumptions && !ctx.strictAmounts) continue; // monthly instalment estimate with stated assumptions
    if (near(a.value, indicative)) add("unlabelled_indicative_price", `${a.raw} is a website (indicative) price but the reply does not say it is indicative.`);
    else if (ctx.strictAmounts && a.value < 20000 && assumptions) add("uncalculated_amount", `${a.raw} is not a figure from the loan engine; quote only financing_engine figures.`);
    else add("unverified_price", `${a.raw} does not match any verified price, fee or promotion on record.`);
  }

  // 1b) a layout's price must be that layout's (not a neighbouring layout's)
  for (const d of layoutPriceMixups(text, ctx.layoutPrices)) add("wrong_layout_price", d + ". Use the price listed for the layout named.");

  // 1c) distances and travel times must come from the context (Google Maps lookups, the listing, web research, the
  //     buyer's own words); rounding is fine. Applies once the context lists what is known (allowedDistances set).
  if (ctx.allowedDistances) {
    for (const d of extractDistances(text)) if (!nearDist(d.value, ctx.allowedDistances)) add("unverified_distance", `${d.raw.trim()} is not a distance from the project information or a map lookup.`);
    for (const d of extractMinutes(text)) if (!nearMin(d.value, ctx.allowedMinutes || [])) add("unverified_distance", `${d.raw.trim()} is not a travel time from a map lookup or the project information.`);
  }
  // 1d) never claim a check that did not happen
  const claim = text.match(CHECK_CLAIM);
  if (claim) {
    const what = /maps|waze/i.test(claim[0]) ? "maps" : "web";
    if ((what === "maps" && !ctx.usedMaps) || (what === "web" && !ctx.usedWeb)) add("unverified_check", `"${claim[0].trim()}" claims a ${what === "maps" ? "map" : "web"} check that was not done for this reply.`);
  }

  // 2) guarantees (negated phrases such as "tidak dapat dijamin" / "cannot guarantee" are fine)
  for (const m of findAll(GUARANTEE, text)) if (!negated(text, m.index)) add("guarantee_language", `"${m[0]}" promises an outcome that cannot be guaranteed.`);

  // 3) availability claims need fresh inventory
  if (!ctx.hasFreshAvailability) for (const m of findAll(AVAILABILITY, text)) if (!negated(text, m.index) && !CHECKING.test(sentenceAt(text, m.index))) add("unverified_availability", `"${m[0].trim()}" claims availability, but no unit status was verified recently.`);

  // 4) promotions need an approved, in-date promotion (or the reply must clearly say it needs confirming)
  if (!ctx.hasActivePromotion && !ctx.knowledgeCoversPromotion && PROMOTION.test(text) && !PROMO_HEDGE.test(text)) add("unverified_promotion", "The reply mentions a promotion, but no approved, in-date promotion is on record.");

  // 5) appointments are only "confirmed" after the calendar confirms
  if (!ctx.appointmentConfirmed) for (const m of findAll(APPT_CONFIRM, text)) {
    const at = m.index + Math.max(0, m[0].search(CONFIRM_WORD));
    if (!negated(text, at) && !PENDING.test(sentenceAt(text, m.index))) add("unconfirmed_appointment", `"${m[0].trim()}" says the appointment is confirmed, but no calendar booking exists.`);
  }

  // 6) never pretend to be human or to have visited a place
  for (const m of findAll(IMPERSONATION, text)) if (!negated(text, m.index)) add("impersonation", `"${m[0].trim()}" — the assistant must not claim to be human or to have visited a property.`);

  // 7) disclose AI on the first reply
  if (ctx.isFirstReply && !AI_DISCLOSURE.test(text)) add("missing_ai_disclosure", "The first reply must say it is an AI assistant.");

  // 8) length
  if (ctx.maxChars && text.length > ctx.maxChars) add("too_long", `Reply is ${text.length} characters; the limit is ${ctx.maxChars}.`);

  // 9) links must come from verified data
  const urls = new Set(ctx.allowedUrls || []), hosts = ctx.allowedHosts || [];
  for (const m of text.matchAll(LINK)) {
    const u = m[0].replace(/[.,!?]+$/, "");
    let host = "";
    try { host = new URL(u.startsWith("http") ? u : "https://" + u).hostname; } catch { /* unparseable */ }
    if (urls.has(u) || hosts.some((h) => host === h || host.endsWith("." + h))) continue;
    add("unknown_link", `${u} is not a link from the verified project data.`);
  }

  // one entry per rule, so the same mistake twice is reported once with every example
  const merged = [];
  for (const x of v) { const m = merged.find((y) => y.code === x.code); if (m) m.detail += " " + x.detail; else merged.push({ ...x }); }
  return { ok: merged.length === 0, violations: merged };
}
