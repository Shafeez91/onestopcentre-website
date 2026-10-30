// The owner's customer-discovery order (Master Persona §3, 30 Oct 2026), worked out in code from what the CRM already
// knows, so the AI asks the next useful question (one per reply, after answering the buyer) and never one already
// answered:
//   1 name → 2 familiarity with the project's area → 3 purpose → 4 where they live and work → 5 commute →
//   6 first home → 7 marital status (optional) → 8 children / household (optional) → 9 showroom visit
// Pathways: own stay and "both" follow all nine; investment skips 4, 5, 7 and 8 and asks about budget and financing
// instead; an unknown or undecided purpose stops at step 3 until it is clear. A question about the showroom or a visit
// jumps straight to step 9. Discovery stops once the buyer is ready for a practical next step.

const has = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);
const val = (known, k) => known?.[k]?.value ?? known?.[k];

export const DISCOVERY_STEPS = [
  { n: 1, key: "name", ask: "their name, so you know how to address them", done: (k, x) => has(x.buyerName) || has(val(k, "preferred_name")) },
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
export function nextDiscovery({ known = {}, buyerName = null, appointments = 0, message = "", readiness = null } = {}) {
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
  return { pathway, done, next: next ? { step: next.n, key: next.key, ask: next.ask } : null, showroom_priority: false,
    note: next ? null : pathway === "unknown" ? "Help the buyer clarify own stay or investment before other questions." : "Discovery complete: no more discovery questions needed." };
}
