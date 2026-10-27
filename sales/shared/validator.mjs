// Business-rule validator for AI replies. It is deliberately independent of the model: whatever the AI writes,
// a reply that states an unverified price, availability, promotion, guarantee or confirmation is blocked.
//
// ctx (built by the context loader):
//   allowedAmounts      numbers (RM) verified as exact: current fresh prices, booking fees, promotion figures, customer's own figures
//   indicativeAmounts   numbers (RM) the website shows (indicative only)
//   hasFreshAvailability  true if some unit's status was verified within the freshness window
//   hasActivePromotion  true if an approved, in-date promotion exists for the projects in scope
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
const PROMOTION = /(cashback|cash back|rebate|rebat|diskaun|discount|percuma|free\s+(legal|spa|furniture|gift|hadiah|aircond|kitchen)|promo(tion|si)?|potongan harga|early bird)/i;
const PROMO_HEDGE = /(tertakluk|subject to|semak|check|sahkan|confirm with|perlu (di)?sahkan|need to confirm|tiada promosi|no (current |active )?promotion|not able to confirm|belum dapat sahkan|tidak dapat sahkan|syarat|terms)/i;
const APPT_CONFIRM = /((appointment|temujanji|janji temu|booking|tempahan|slot|lawatan|visit|viewing)[^.?!\n]{0,40}(confirmed|disahkan|sudah (di)?sahkan|telah ditempah|dah book|berjaya ditempah|is booked|has been booked|telah dibuat)|\b(confirmed|disahkan)\b[^.?!\n]{0,30}(appointment|temujanji|slot|visit|lawatan|viewing))/i;
const IMPERSONATION = /((i am|i'm|im)\s+(a\s+)?(human|real person|real agent|not (a |an )?(bot|ai|robot))|saya\s+(manusia|orang sebenar|bukan\s+(bot|ai|robot))|(saya|i)\s+(dah|sudah|telah|have|has|had)\s+(pernah\s+)?(lawat|melawat|visited|been to|pergi ke|tengok sendiri|seen)\s+((the|that|this|our|your|ke)\s+)?(showroom|projek|project|site|unit|tapak))/i;
const AI_DISCLOSURE = /(\bAI\b|pembantu\s+AI|AI\s+assistant|assistant\s+AI|pembantu\s+maya|virtual\s+assistant|pembantu\s+digital|digital\s+assistant)/i;
const CHECKING = /(semak|check|confirm|sahkan|sama ada|whether|if any|kalau ada|akan maklumkan|will let you know|perlu (di)?sahkan|need to confirm)/i;
const PENDING = /(belum|not yet|pending|menunggu|akan (di)?sahkan|will confirm|to be confirmed|akan confirm|perlu (di)?sahkan)/i;
const CONFIRM_WORD = /(confirmed|disahkan|sudah (di)?sahkan|telah ditempah|dah book|berjaya ditempah|is booked|has been booked|telah dibuat)/i;
const sentenceAt = (text, index) => { const s = text.lastIndexOf(".", index) + 1, e = text.slice(index).search(/[.!?\n]/); return text.slice(s, e < 0 ? undefined : index + e); };
const LINK = /\bhttps?:\/\/[^\s)>\]]+|\bwa\.me\/\d+[^\s)]*/gi;

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

  // 2) guarantees (negated phrases such as "tidak dapat dijamin" / "cannot guarantee" are fine)
  for (const m of findAll(GUARANTEE, text)) if (!negated(text, m.index)) add("guarantee_language", `"${m[0]}" promises an outcome that cannot be guaranteed.`);

  // 3) availability claims need fresh inventory
  if (!ctx.hasFreshAvailability) for (const m of findAll(AVAILABILITY, text)) if (!negated(text, m.index) && !CHECKING.test(sentenceAt(text, m.index))) add("unverified_availability", `"${m[0].trim()}" claims availability, but no unit status was verified recently.`);

  // 4) promotions need an approved, in-date promotion (or the reply must clearly say it needs confirming)
  if (!ctx.hasActivePromotion && PROMOTION.test(text) && !PROMO_HEDGE.test(text)) add("unverified_promotion", "The reply mentions a promotion, but no approved, in-date promotion is on record.");

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
