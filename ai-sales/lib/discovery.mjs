// The owner's customer-discovery order (Master Persona §3, 30 Oct 2026), worked out in code from what the CRM already
// knows, so the AI asks the next useful question (one per reply, after answering the buyer) and never one already
// answered:
//   1 name → 2 familiarity with the project's area → 3 purpose → 4 where they live and work → 5 commute →
//   6 first home → 7 marital status (optional) → 8 children / household (optional) → 9 showroom visit
// Pathways: own stay and "both" follow all nine; investment skips 4, 5, 7 and 8 and asks about budget and financing
// instead; an unknown or undecided purpose stops at step 3 until it is clear. A question about the showroom or a visit
// jumps straight to step 9. Discovery stops once the buyer is ready for a practical next step.

import { nameStatus, callName, NOT_DISCLOSED, TITLE_GENDER } from "../../sales/shared/salutation.mjs";

const has = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);
const val = (known, k) => known?.[k]?.value ?? known?.[k];

export const DISCOVERY_STEPS = [
  // a WhatsApp profile name is only a guess: the step is done once the buyer (or an advisor) gave or confirmed it, or declined
  { n: 1, key: "name", ask: "their name, so you know how to address them", done: (k, x) => ["confirmed", "declined"].includes(nameStatus(x.buyerName, val(k, "preferred_name")).status) },
  { n: 2, key: "area_familiarity", ask: "whether they know the project's area, or would like the surroundings explained", done: (k) => has(val(k, "area_familiarity")) && val(k, "area_familiarity") !== "unsure" },
  { n: 3, key: "purpose", ask: "whether it is for their own stay, investment or both", done: (k) => has(val(k, "purpose")) && val(k, "purpose") !== "undecided" },
  { n: 4, key: "living_and_work_area", ask: "which area they live in now and where they usually work (general areas only, never an address)", own: true, done: (k) => has(val(k, "residential_area")) || has(val(k, "work_area")) },
  { n: 5, key: "commute", ask: "how they usually travel to work (drive, LRT/MRT/KTM, bus, a mix)", own: true, done: (k) => has(val(k, "commute_mode")) },
  { n: 6, key: "first_home", ask: "whether this would be their first property, or they already own one", done: (k) => has(val(k, "first_home")) },
  { n: 7, key: "marital_status", ask: "whether they are single or married, to understand the household (optional: say they need not share)", own: true, done: (k) => has(val(k, "marital_status")) },
  { n: 8, key: "household", ask: "whether they have children or are planning a family, for the layout (optional: say they need not share)", own: true,
    applies: (k) => val(k, "marital_status") === "married", done: (k) => has(val(k, "occupants")) },
  { n: 9, key: "showroom", ask: "whether they have visited the showroom or show unit, or would like to arrange a visit", done: (k, x) => has(val(k, "showroom_visit")) || x.appointments > 0 },
];
// investment buyers: their own questions in place of the household ones, before the showroom
const INVESTMENT_STEP = { n: "investment", key: "investment_goals", ask: "their budget and how they plan to finance it (and whether rental or capital growth matters more)", done: (k) => has(val(k, "budget_max")) || has(val(k, "financing")) };

// the buyer asks about the showroom, a viewing or an appointment (BM, English, Manglish)
export const SHOWROOM_Q = /(show\s?room|show\s?unit|sales\s+gallery|galeri\s+jualan|\bviewing\b|\bview\b|lawat|melawat|nak\s+datang|boleh\s+datang|datang\s+(tengok|sabtu|ahad|esok|hari)|appointment|temujanji|book(ing)?\s+(a\s+)?(slot|visit|appointment)|opening\s+hours|waktu\s+(buka|operasi)|buka\s+pukul|pukul\s+berapa\s+buka|alamat\s+showroom|where\s+is\s+(the\s+)?showroom)/i;

/**
 * What to learn next. known: client_profile.known (or plain values); buyerName: the CRM contact name;
 * appointments: open appointments; readiness: qualification readiness. Returns { pathway, done, next, showroom_priority, note }.
 */
export function nextDiscovery({ known = {}, buyerName = null, appointments = 0, message = "", readiness = null, aiReplies = 0, projectInFocus = false } = {}) {
  const purpose = val(known, "purpose");
  const pathway = purpose === "own_stay" || purpose === "both" ? purpose : purpose === "investment" ? "investment" : "unknown";
  const x = { buyerName, appointments };
  const done = DISCOVERY_STEPS.filter((s) => s.done(known, x)).map((s) => s.key);
  const showroom = SHOWROOM_Q.test(String(message || ""));
  if (showroom) {
    return { pathway, done, next: { step: 9, key: "showroom", ask: "help with the showroom question and booking now" }, showroom_priority: true,
      note: "The buyer asked about the showroom or a visit: answer it and help book now; ask no other discovery question first." };
  }
  if (readiness === "ready") return { pathway, done, next: null, showroom_priority: false, note: "The buyer is ready for a practical next step: no more discovery questions." };
  let order;
  if (pathway === "investment") order = [...DISCOVERY_STEPS.filter((s) => !s.own && s.n !== 9), INVESTMENT_STEP, DISCOVERY_STEPS[8]];
  else if (pathway === "unknown") order = DISCOVERY_STEPS.slice(0, 3); // clarify the purpose before going further
  else order = DISCOVERY_STEPS;
  const next = order.find((s) => (!s.applies || s.applies(known)) && !s.done(known, x));
  let ask = next?.ask, askNow = false;
  if (next?.key === "name") {
    const ns = nameStatus(buyerName, val(known, "preferred_name"));
    ask = ns.status === "to_confirm"
      ? `whether you may call them "${ns.name}" (their WhatsApp name, not yet confirmed), e.g. "Blh sy panggil ${ns.name} ya?" / "May I call you ${ns.name}?"`
      : "their name, so you know how to address them properly (their WhatsApp name is not a usable name)";
    askNow = aiReplies >= 1; // by the AI's second reply at the latest
  }
  if (next?.key === "area_familiarity") askNow = !!projectInFocus; // as soon as a project is being discussed
  return { pathway, done, next: next ? { step: next.n, key: next.key, ask, ...(askNow ? { ask_now: true } : {}) } : null, showroom_priority: false,
    note: next ? null : pathway === "unknown" ? "Help the buyer clarify own stay or investment before other questions." : "Discovery complete: no more discovery questions needed." };
}

// ---- reading the buyer's answer to the name / area question the AI just asked, so it is saved at once ----
const NOT_NAME_WORD = /^(ok|okay|ya|yes|yup|yep|boleh|blh|sure|can|no|tak|x|tidak|hi|hai|hello|helo|salam|assalamualaikum|thanks|thank|tq|terima|nak|mahu|mau|want|interested|looking|tanya|nk|ada|apa|berapa|brp|harga|price|rumah|unit|projek|project|lppsa|loan|dari|from|kat|dekat|di|in|at|the|and|dan|untuk|utk|saya|sy|aku|i|im|my|is|sorry|maaf|baik|alright|noted|nope|haha|hehe|lol|tu|ni|itu|ini|nama|name|nanti|esok|lusa|later|tomorrow|today|now|sekarang|balik|back|semula|lagi|je|sahaja|please|pls)$/i;
const YES = /^\s*(ya+|yes+|yup|yep|boleh+|blh|ok(ay)?|sure|betul|correct|can|bole|yaa|ye+|yea+h?|okey|ok je|boleh je|blh je)\b/i;
const DECLINE = /((tak|x|tiada|takde|xde|tkde|tak\s+ada|x\s+ada)\s*nama|no\s+name|don'?t\s+have\s+a\s+name|tak\s*(nak|mahu|perlu|payah)|x\s*(nak|payah|perlu)|tak payah|rather not|prefer not|no need|not comfortable|private|rahsia|tak (mahu|nak) (bagi|beritahu|share))/i;
const ASKED_NAME = /(nama|name)/i;
const ASKED_CALL = /(panggil|call you|address you)/i;
const ASKED_AREA = /(familiar|biasa\s+(dengan|dgn)|tahu\s+(kawasan|area|lokasi)|kenal\s+(kawasan|area)|pernah\s+(ke|pergi|datang|sampai)|area\s+sekitar|kawasan\s+sekitar|surroundings)/i;

function nameFrom(text) {
  const t = String(text || "").replace(/[!?.,;:]+/g, " ").trim();
  // "nama saya …", "my name is …", "call me …" are clear anywhere; "saya …" / "I'm …" only right after the AI asked
  const strong = t.match(/\b(?:nama\s+(?:saya|sy|aku)(?:\s+(?:ialah|adalah|is))?|my\s+name\s+is|my\s+name'?s|name\s+is|panggil(?:\s+(?:saya|sy))?|call\s+me)\s+(.+)$/i);
  const weak = strong ? null : t.match(/^(?:i'?m|i\s+am|saya|sy|it'?s)\s+(.+)$/i);
  const part = (strong || weak ? (strong || weak)[1] : t).split(/\s+/);
  const out = [];
  for (const w of part) {
    if (!/^[A-Za-zÀ-ÖØ-öø-ÿ'’\-]{2,20}$/.test(w) || NOT_NAME_WORD.test(w)) break;
    out.push(w);
    if (out.length === 3) break;
  }
  // a title ("Encik Ali") is the salutation, saved separately: the name is what follows it
  while (out.length > 1 && Object.prototype.hasOwnProperty.call(TITLE_GENDER, out[0].toLowerCase().replace(/\.$/, ""))) out.shift();
  return { name: out.length ? out.join(" ") : null, strong: !!strong, weak: !!weak };
}

/**
 * What the buyer's message answers, given the AI's previous message. Returns profile changes for ai_lead_profile_set
 * ([{ field, value, status: "confirmed" }]) — only for a question the AI actually asked (a clear "nama saya …" /
 * "call me …" counts any time), and never for one already known.
 */
export function readDiscoveryAnswer({ message = "", lastAiText = "", buyerName = null, known = {} } = {}) {
  const msg = String(message || "").trim(), last = String(lastAiText || "");
  const out = [];
  if (!msg) return out;
  const asked = last.includes("?");
  const ns = nameStatus(buyerName, val(known, "preferred_name"));
  if (!["confirmed", "declined"].includes(ns.status)) {
    const n = nameFrom(msg), short = msg.split(/\s+/).length;
    const askedName = asked && ASKED_NAME.test(last);
    const first = ns.name ? ns.name.split(" ")[0].toLowerCase() : null;
    const askedCall = asked && ASKED_CALL.test(last) && !!first && last.toLowerCase().includes(first);
    let v = null;
    if (n.strong && n.name) v = callName(null, n.name);
    else if ((askedName || askedCall) && DECLINE.test(msg)) v = NOT_DISCLOSED;
    else if (askedCall && YES.test(msg) && short <= 6) v = ns.name;
    else if (askedName && n.name && (n.weak || short <= 3)) v = callName(null, n.name);
    if (v) out.push({ field: "preferred_name", value: v, status: "confirmed" });
  }
  if (asked && ASKED_AREA.test(last) && !(has(val(known, "area_familiarity")) && val(known, "area_familiarity") !== "unsure")) {
    const v = familiarityFrom(msg);
    if (v) out.push({ field: "area_familiarity", value: v, status: "confirmed" });
  }
  return out;
}

export function familiarityFrom(text) {
  const t = ` ${String(text || "").toLowerCase()} `;
  if (/\b(duduk|tinggal|stay(ing)?|live|living|kerja|work(ing)?|rumah)\s+(kat|dekat|dkt|di|kt|near|nearby|around|in|situ|sana|area|kawasan)\b/.test(t) || /\b(dekat|dkt|near)\s+(rumah|ofis|office|tempat kerja)\b/.test(t)) return "very_familiar";
  if (/first time|pertama kali|\b(tak|x|tidak|belum|never)\s+pernah\b|\bnever been\b/.test(t)) return "not_familiar";
  if (/\b(tak|x|tidak|not)\s+(biasa|familiar)\s+(sangat|sgt|sangatlah)\b|\bnot\s+(very|that|so)\s+familiar\b/.test(t)) return "somewhat";
  if (/\b(sikit|sikit2|sedikit|a bit|bit|somewhat|kind of|agak|bolehlah|lebih kurang|tak (berapa|sangat)|x (berapa|sangat)|kurang)\b/.test(t)) return "somewhat";
  if (/\b(tak|x|tidak|tk|belum|not|never|no|nope)\b\s*(\w+\s+){0,2}?(biasa|familiar|tahu|tau|pernah|kenal|sure)\b|first time|pertama kali|^\s*(no|nope|tak|x|tidak|belum)\b/.test(t)) return "not_familiar";
  if (/^\s*(ya+|yes|yup|yep|ok|biasa|familiar|tahu|tau|kenal|pernah|selalu|of course|mestilah|sure)\b|\b(biasa|familiar|selalu lalu|selalu pergi|kenal)\b/.test(t)) return "familiar";
  return null;
}
