// Transparent, configurable lead scoring. A score is an indication of intent only — never a
// prediction of purchase or of financing approval. Unknown information scores 0 and is listed as unknown.
export const DEFAULT_SCORING = {
  weights: { readiness: 25, budget: 20, suitability: 15, timeline: 15, engagement: 15, financing: 10 },
  thresholds: { hot: 70, warm: 45, nurture: 20 },
};

const READINESS = { ready: 1, considering: 0.6, researching: 0.2 };
const FIT = { strong: 1, partial: 0.5, poor: 0 };
const FINANCING = { cash: 1, preapproved: 1, lppsa: 0.7, bank: 0.6, undecided: 0.3 };

const LABEL = {
  readiness: "Purchase readiness", budget: "Budget alignment", suitability: "Project suitability",
  timeline: "Purchase timeline", engagement: "Engagement / appointment intent", financing: "Financing readiness",
};

function budgetFit(q) {
  if (FIT[q.budget_fit] !== undefined) return [FIT[q.budget_fit], `stated as ${q.budget_fit}`];
  const max = Number(q.budget_max), price = Number(q.project_price_from);
  if (!(max > 0) || !(price > 0)) return [null, "budget or project price not known"];
  if (price <= max) return [1, `from-price RM${price.toLocaleString("en-MY")} within budget RM${max.toLocaleString("en-MY")}`];
  if (price <= max * 1.1) return [0.5, "from-price up to 10% above budget"];
  return [0, "from-price more than 10% above budget"];
}

function timelineFit(q) {
  const m = Number(q.timeline_months);
  if (q.timeline_months === undefined || q.timeline_months === null || q.timeline_months === "" || !(m >= 0)) return [null, "timeline not known"];
  if (m <= 3) return [1, `within ${m} month(s)`];
  if (m <= 6) return [0.7, "3–6 months"];
  if (m <= 12) return [0.4, "6–12 months"];
  return [0.1, "more than 12 months"];
}

function engagementFit(s = {}) {
  if (s.appointment_confirmed) return [1, "appointment confirmed"];
  if (s.appointment_requested) return [0.9, "asked for an appointment"];
  const parts = [];
  let v = 0;
  const replies = Math.max(0, Number(s.replies) || 0);
  if (replies) { v += Math.min(0.6, replies * 0.15); parts.push(`${replies} replies`); }
  if (s.asked_price) { v += 0.2; parts.push("asked about price"); }
  if (s.requested_brochure) { v += 0.2; parts.push("requested brochure/price list"); }
  return parts.length ? [Math.min(1, v), parts.join(", ")] : [null, "no engagement recorded yet"];
}

/**
 * @param {object} q qualification: readiness, budget_fit | (budget_max + project_price_from), project_fit,
 *   timeline_months, financing, unsuitable, unsuitable_reason
 * @param {object} signals engagement: replies, asked_price, requested_brochure, appointment_requested, appointment_confirmed
 * @param {object} config { weights, thresholds } from ai_settings.scoring
 */
export function scoreLead(q = {}, signals = {}, config = DEFAULT_SCORING) {
  const weights = { ...DEFAULT_SCORING.weights, ...(config?.weights || {}) };
  const thresholds = { ...DEFAULT_SCORING.thresholds, ...(config?.thresholds || {}) };
  const parts = {
    readiness: READINESS[q.readiness] !== undefined ? [READINESS[q.readiness], q.readiness] : [null, "not yet known"],
    budget: budgetFit(q),
    suitability: FIT[q.project_fit] !== undefined ? [FIT[q.project_fit], `${q.project_fit} match`] : [null, "not yet assessed"],
    timeline: timelineFit(q),
    engagement: engagementFit(signals),
    financing: FINANCING[q.financing] !== undefined ? [FINANCING[q.financing], q.financing] : [null, "not shared (optional)"],
  };
  const total = Object.values(weights).reduce((a, b) => a + Math.max(0, Number(b) || 0), 0) || 1;
  let sum = 0;
  const rationale = [];
  for (const [k, [v, why]] of Object.entries(parts)) {
    const w = Math.max(0, Number(weights[k]) || 0);
    const pts = v === null ? 0 : (v * w * 100) / total;
    sum += pts;
    rationale.push({ factor: k, label: LABEL[k], points: Math.round(pts * 10) / 10, max: Math.round((w * 1000) / total) / 10, known: v !== null, detail: why });
  }
  const score = Math.max(0, Math.min(100, Math.round(sum)));
  let temperature;
  if (q.unsuitable) temperature = "unqualified";
  else if (score >= thresholds.hot) temperature = "hot";
  else if (score >= thresholds.warm) temperature = "warm";
  else temperature = "nurture";
  if (q.unsuitable) rationale.push({ factor: "unsuitable", label: "Marked unsuitable", points: 0, max: 0, known: true, detail: q.unsuitable_reason || "marked by advisor" });
  return { score, temperature, rationale };
}
