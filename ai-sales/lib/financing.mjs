// Server glue between the AI conversation and the loan engine (sales/shared/finance.mjs).
// The AI only collects the buyer's figures (financing_updates); every number it may say comes from the engine,
// and the reply checker allows exactly those numbers.
import { assess, financingRules, resultAmounts, priceExamples, recommendProjects, advisorSummary } from "../../sales/shared/finance.mjs";

export const FIN_FIELDS = ["route", "age", "basic_salary", "fixed_allowances", "variable_income", "self_employed_income", "mandatory_deductions",
  "commitments_monthly", "credit_card_balance", "confirmed_service", "service_years", "second_financing", "property_price", "valuation",
  "requested_amount", "down_payment", "property_count", "co_age", "co_income", "co_mandatory_deductions", "co_commitments_monthly"];

/**
 * Merges what the buyer just said into the figures collected so far. The schema uses 0 / "" for "not mentioned"
 * and -1 for "none / zero"; a yes/no field arrives as "yes" / "no".
 */
export function mergeFinancing(current = {}, updates = {}) {
  const inputs = { ...current }, changed = [];
  for (const k of FIN_FIELDS) {
    let v = updates?.[k];
    if (v === undefined || v === null || v === "" || v === 0) continue;
    if (v === -1) v = 0;
    if (k === "second_financing") v = v === "yes" || v === true;
    if (typeof v === "number" && (!isFinite(v) || v < 0)) continue;
    if (inputs[k] !== v) { inputs[k] = v; changed.push(k); }
  }
  return { inputs, changed };
}

/** Keeps only known fields with sensible values (inputs sent back by the test console, or read from the database). */
export function cleanInputs(raw = {}) {
  const out = {};
  for (const k of FIN_FIELDS) {
    const v = raw?.[k];
    if (k === "route" ? ["lppsa", "bank"].includes(v) : k === "confirmed_service" ? ["yes", "no"].includes(v) : k === "second_financing" ? typeof v === "boolean" : typeof v === "number" && isFinite(v) && v >= 0 && v < 1e9) out[k] = v;
  }
  return out;
}

/** Builds the financing part of the context and adds the engine's figures to the reply checker's allow-list. */
export function attachFinancing(ctx, { inputs = {}, saved = null, recalculated = false } = {}) {
  const rules = financingRules(ctx.settings?.financing);
  const result = Object.keys(inputs).length ? assess(inputs, rules) : null;
  const examples = ctx.projects.map((p) => {
    const verified = [...p.prices.filter((x) => x.fresh).map((x) => Number(x.price_myr)), ...p.freshUnitPrices];
    const from = verified.length ? Math.min(...verified) : p.websitePrices.length ? Math.min(...p.websitePrices) : null;
    const ex = priceExamples(from, rules);
    return ex && { project_id: p.id, price_label: verified.length ? "VERIFIED" : "INDICATIVE", ...ex };
  }).filter(Boolean);
  // the highest price the figures support (financing + planned down payment), else the buyer's stated budget
  const byIncome = result?.max_by_income > 0 ? result.max_by_income : null;
  const affordable = byIncome && (result.route === "lppsa" ? byIncome + (Number(inputs.down_payment) || 0) : Math.floor(byIncome / (rules.bank.margin_pct_first / 100)));
  const budget = affordable || ctx.lead?.qualification_known?.budget_max || null;
  const recommendations = recommendProjects(ctx.projects, { max_price: budget, bedrooms: ctx.lead?.qualification_known?.bedrooms });
  ctx.financing = { rules, inputs, result, examples, recommendations, affordable: affordable || null, saved, recalculated };
  const allowed = new Set(ctx.rules.allowedAmounts);
  if (result) resultAmounts(result).forEach((n) => allowed.add(n));
  for (const e of examples) [e.loan, e.monthly].forEach((n) => allowed.add(n));
  if (affordable) allowed.add(affordable);
  ctx.rules.allowedAmounts = [...allowed];
  ctx.rules.strictAmounts = true; // no free-form instalment estimates: only the engine's figures
  return ctx.financing;
}

/** Compact view of the engine for the model (what it may say, and what to ask next). */
export function renderFinancing(fin) {
  if (!fin) return undefined;
  const r = fin.result;
  return {
    note: "Figures here are calculated by the agency's loan engine. Quote only these figures; never calculate or estimate others yourself.",
    recalculated_this_turn: !!fin.recalculated,
    figures_known: fin.inputs,
    assessment: r && {
      route: r.route, outcome: r.outcome, outcome_label: r.outcome_label, missing: r.missing, ask_next: r.next_questions,
      max_financing: r.max_financing, max_instalment: r.max_instalment, tenure_years: r.tenure_years,
      financing_needed: r.financing_needed, instalment_for_needed: r.instalment_for_needed, dsr_pct_for_needed: r.dsr_pct_for_needed,
      shortfall: r.shortfall, buyer_top_up: r.buyer_top_up, extra_down_payment: r.extra_down_payment, limited_by: r.limited_by,
      tests: r.tests?.map((t) => ({ test: t.en, max_instalment: t.max_instalment, pass: t.pass })),
      bank_scenarios: r.scenarios, rules_verified: r.rules_verified, notes: r.notes, needs_advisor: r.escalate,
      upfront_costs_estimate: r.upfront && { total: r.upfront.total, items: r.upfront.items.map((i) => ({ item: i.en, amount: i.amount })) },
      assumptions: r.assumptions, disclaimer: r.disclaimer,
    },
    instalment_examples_bank_assumptions: fin.examples,
    projects_within_budget: fin.recommendations,
    affordable_price_estimate: fin.affordable || null,
  };
}

/** Is this result worth recording as a new assessment (complete and different from the last one)? */
export function isNewAssessment(result, previous) {
  if (!result || (result.outcome === "insufficient_information" && result.max_financing === undefined)) return false;
  if (!previous) return true;
  const key = (r) => JSON.stringify([r.route, r.outcome, r.max_financing, r.financing_needed, r.instalment_for_needed]);
  return key(result) !== key(previous);
}

export { advisorSummary };
