// Client profile fields (ai_leads.profile, migration 16): one definition for the dashboard forms, the AI's
// extraction schema and the server's validation. Qualification fields (purpose, first home, budget…) stay in
// ai_leads.qualification and are listed in QUAL_FIELDS so the AI can update them by the same rules.
// Nothing here is required: buyers are never asked for personal details just to fill a field.

export const PROFILE_GROUPS = [
  ["basic", "Basic information"],
  ["location", "Location & daily commute"],
  ["preferences", "Property & lifestyle preferences"],
  ["intent", "Purchase intent"],
  ["notes", "Important client notes"],
];

const o = (...pairs) => Object.fromEntries(pairs);

/** type: text | number | select (one option) | multi (several options) | textarea */
export const PROFILE_FIELDS = [
  { key: "preferred_name", group: "basic", label: "Preferred name / how to address", type: "text", hint: "as the buyer gave it; \"not_disclosed\" if they prefer not to say" },
  { key: "age_range", group: "basic", label: "Age or age range", type: "text", hint: "only if the buyer said" },
  { key: "marital_status", group: "basic", label: "Marital status", type: "select", options: o(["single", "Single"], ["married", "Married"], ["other", "Other"], ["not_disclosed", "Not disclosed"]), hint: "only if the buyer volunteered it" },
  { key: "occupants", group: "basic", label: "Intended occupants", type: "text", hint: "e.g. 4 (couple + 2 children)" },
  { key: "occupation", group: "basic", label: "Occupation / sector", type: "text", hint: "only if disclosed" },

  { key: "residential_area", group: "location", label: "Current residential area", type: "text", hint: "neighbourhood, town or postcode — never a full address" },
  { key: "work_area", group: "location", label: "Work location", type: "text", hint: "workplace area or business district" },
  { key: "commute_mode", group: "location", label: "Daily commute & transportation", type: "multi", options: o(
    ["own_car", "Own car"], ["motorcycle", "Motorcycle"], ["rail", "LRT / MRT / Monorail"], ["ktm_erl", "KTM / ERL"], ["bus", "Bus"],
    ["e_hailing", "E-hailing"], ["walk_cycle", "Walk / Bicycle"], ["company_transport", "Company transport"], ["other", "Other"]) },
  { key: "commute_route", group: "location", label: "Main commute route", type: "text" },
  { key: "nearest_station", group: "location", label: "Nearest station / stop", type: "text" },
  { key: "commute_minutes", group: "location", label: "One-way commute (minutes)", type: "number" },
  { key: "transport_needs", group: "location", label: "Transport requirements", type: "text", hint: "e.g. must be walking distance to MRT" },
  { key: "area_familiarity", group: "location", label: "Familiarity with the project location", type: "select", options: o(
    ["very_familiar", "Very familiar — lives or works nearby"], ["familiar", "Familiar — visits regularly"], ["somewhat", "Somewhat familiar — knows the surroundings"],
    ["not_familiar", "Not familiar — needs an area introduction"], ["unsure", "Unsure / not discussed"]) },
  { key: "area_info_needed", group: "location", label: "Area information wanted", type: "multi", options: o(
    ["transport", "Transport & connectivity"], ["schools", "Nearby schools"], ["healthcare", "Hospitals & healthcare"], ["shopping", "Shopping & daily amenities"],
    ["traffic", "Traffic & commute"], ["rental", "Rental demand"], ["infrastructure", "Future infrastructure"], ["neighbourhood", "Neighbourhood overview"], ["other", "Other"]) },

  { key: "preferred_location", group: "preferences", label: "Preferred location / area", type: "text" },
  { key: "facilities", group: "preferences", label: "Preferred facilities", type: "text" },
  { key: "parking", group: "preferences", label: "Parking requirement", type: "text", hint: "e.g. 2 car parks" },
  { key: "proximity", group: "preferences", label: "Must be close to", type: "multi", options: o(["transit", "Public transport"], ["workplace", "Workplace"], ["family", "Family"], ["schools", "Schools"], ["amenities", "Shops & amenities"]) },
  { key: "pets", group: "preferences", label: "Pets", type: "text" },
  { key: "recreation", group: "preferences", label: "Lifestyle & recreational interests", type: "text", hint: "only when relevant or volunteered" },
  { key: "other_requirements", group: "preferences", label: "Other requirements", type: "text" },
  { key: "max_monthly_instalment", group: "preferences", label: "Comfortable monthly instalment (RM)", type: "number", hint: "only if the buyer said" },
  { key: "financial_notes", group: "preferences", label: "Other financial constraints", type: "text", hint: "only what the buyer chose to share" },

  { key: "showroom_visit", group: "intent", label: "Showroom visit", type: "select", options: o(
    ["visited", "Already visited"], ["not_visited", "Not visited yet"], ["booked", "Appointment booked"], ["wants_visit", "Wants to arrange a visit"], ["not_yet", "Not interested yet"]) },
  { key: "motivation", group: "intent", label: "Main buying motivation", type: "text" },
  { key: "decision_makers", group: "intent", label: "Others involved in the decision", type: "text", hint: "e.g. spouse, parents" },
  { key: "documents_pending", group: "intent", label: "Documents or actions pending", type: "text" },

  { key: "client_notes", group: "notes", label: "Important client notes", type: "textarea", hint: "e.g. prefers weekend appointments; compares two projects" },
];

/** Qualification fields the AI may also update through the same rules (stored in ai_leads.qualification). */
export const QUAL_FIELDS = [
  { key: "purpose", label: "Purchase purpose", type: "select", options: o(["own_stay", "Own stay"], ["investment", "Investment"], ["both", "Own stay and investment"], ["undecided", "Undecided"]) },
  { key: "first_home", label: "First home", type: "select", options: o(["yes", "First home"], ["no", "Owns another property"], ["previously", "Previously owned property"], ["not_disclosed", "Not disclosed"]) },
  { key: "bedrooms", label: "Bedrooms", type: "text" },
  { key: "size_sqft", label: "Built-up (sqft)", type: "text" },
  { key: "budget_min", label: "Budget from (RM)", type: "number" },
  { key: "budget_max", label: "Budget up to (RM)", type: "number" },
  { key: "employment", label: "Employment", type: "select", options: o(["government", "Government servant"], ["private", "Private sector"], ["self_employed", "Self-employed"]) },
  { key: "financing", label: "Financing", type: "select", options: o(["lppsa", "LPPSA"], ["bank", "Bank loan"], ["cash", "Cash"], ["preapproved", "Pre-approved (stated)"], ["undecided", "Undecided"]) },
  { key: "timeline_months", label: "Timeline (months)", type: "number" },
  { key: "readiness", label: "Readiness", type: "select", options: o(["ready", "Ready for next step"], ["considering", "Considering options"], ["researching", "Early research"]) },
  { key: "concerns", label: "Main concerns", type: "text" },
];

export const ALL_FIELDS = [...PROFILE_FIELDS, ...QUAL_FIELDS];
export const FIELD = Object.fromEntries(ALL_FIELDS.map((f) => [f.key, f]));
export const fieldLabel = (k) => FIELD[k]?.label || String(k || "").replace(/_/g, " ");

export const FIELD_STATUS = { confirmed: "Confirmed by client", inferred: "Inferred — needs confirmation", conflict: "Conflicting information", missing: "Not provided" };

/** A field's status for display: conflict wins, then the stored status, else missing. */
export function statusOf(value, meta) {
  if (meta?.conflict) return "conflict";
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return "missing";
  return meta?.status === "inferred" ? "inferred" : "confirmed";
}

/** A stored value in words (option labels for select / multi). */
export function showValue(key, v) {
  const f = FIELD[key];
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return "";
  if (f?.options) return (Array.isArray(v) ? v : [v]).map((x) => f.options[x] || x).join(", ");
  if (f?.type === "number" && /instalment|budget/.test(key)) return "RM" + Number(v).toLocaleString("en-MY");
  return String(v);
}

/**
 * Cleans what the AI proposed: known fields only, option values only for select / multi, numbers for number fields,
 * short text. Returns [{field, value, status}] ready for ai_lead_profile_set.
 */
export function cleanUpdates(list) {
  const out = [];
  for (const u of Array.isArray(list) ? list : []) {
    const f = FIELD[u?.field];
    if (!f) continue;
    const status = u.status === "confirmed" ? "confirmed" : "inferred";
    const raw = typeof u.value === "string" ? u.value.trim() : u.value;
    if (raw === null || raw === undefined || raw === "") continue;
    let value;
    if (f.type === "number") { value = Number(String(raw).replace(/[^\d.]/g, "")); if (!isFinite(value) || value <= 0) continue; }
    else if (f.type === "select") { value = String(raw).trim().toLowerCase(); if (!f.options[value]) continue; }
    else if (f.type === "multi") { value = [...new Set(String(raw).split(/[,;|]/).map((x) => x.trim().toLowerCase()).filter((x) => f.options[x]))]; if (!value.length) continue; }
    else value = String(raw).slice(0, 300);
    out.push({ field: f.key, value, status });
  }
  return out;
}
