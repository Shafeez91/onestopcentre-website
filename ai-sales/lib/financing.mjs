// Server glue between the AI conversation and the loan engine (sales/shared/finance.mjs).
// The AI only collects the buyer's figures (financing_updates); every number it may say comes from the engine,
// and the reply checker allows exactly those numbers.
import { assess, financingRules, resultAmounts, instalmentIllustration, recommendProjects, advisorSummary } from "../../sales/shared/finance.mjs";
import { numOf } from "../../sales/shared/listing.mjs";

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
  // the website calculator's own settings, so the AI quotes the same monthly figure the project page shows
  const calc = ctx.websiteLoan || { margin_pct: rules.bank.margin_pct_first, rate_pct: rules.bank.rate_pct, tenure_years: rules.bank.max_tenure_years };
  const examples = ctx.projects.flatMap((p) => {
    const freshBy = Object.fromEntries(p.prices.filter((x) => x.fresh).map((x) => [String(x.unit_type || "").toLowerCase(), Number(x.price_myr)]));
    const verified = [...Object.values(freshBy), ...p.freshUnitPrices];
    // every priced layout of the project(s) being discussed; the lowest price of the others
    const rows = p.inFocus ? p.layouts.filter((l) => numOf(l.price_from) >= 10000 || freshBy[l.layout.toLowerCase()]).map((l) => {
      const v = freshBy[l.layout.toLowerCase()];
      return { layout: l.layout, price: v || numOf(l.price_from), label: v ? "VERIFIED" : "INDICATIVE", size: numOf(l.size_sqft), psf: numOf(l.maintenance_fee_psf) || p.maintPsfWebsite };
    }) : [];
    if (!rows.length) {
      const from = verified.length ? Math.min(...verified) : p.websitePrices.length ? Math.min(...p.websitePrices) : null;
      if (from) rows.push({ layout: "lowest price", price: from, label: verified.length ? "VERIFIED" : "INDICATIVE" });
    }
    return rows.map((r) => {
      const ex = instalmentIllustration(r.price, calc, rules.lppsa);
      const maint = r.size && r.psf ? Math.round(r.size * r.psf) : null;
      return ex && { project_id: p.id, project: p.name, layout: r.layout, price_label: r.label, ...ex,
        ...(maint ? { maintenance_monthly: maint, bank_monthly_with_maintenance: ex.bank.monthly + maint } : {}) };
    }).filter(Boolean);
  });
  // the highest price the figures support (financing + planned down payment), else the buyer's stated budget
  const byIncome = result?.max_by_income > 0 ? result.max_by_income : null;
  const affordable = byIncome && (result.route === "lppsa" ? byIncome + (Number(inputs.down_payment) || 0) : Math.floor(byIncome / (rules.bank.margin_pct_first / 100)));
  const budget = affordable || ctx.lead?.qualification_known?.budget_max || null;
  const recommendations = recommendProjects(ctx.projects, { max_price: budget, bedrooms: ctx.lead?.qualification_known?.bedrooms });
  ctx.financing = { rules, inputs, result, examples, recommendations, affordable: affordable || null, saved, recalculated };
  const allowed = new Set(ctx.rules.allowedAmounts);
  if (result) resultAmounts(result).forEach((n) => allowed.add(n));
  for (const e of examples) [e.price, e.bank.loan, e.bank.monthly, e.lppsa?.loan, e.lppsa?.monthly, e.maintenance_monthly, e.bank_monthly_with_maintenance].filter(Boolean).forEach((n) => allowed.add(n));
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
      // LPPSA: what the financing is made of (property + MRTT premium + financing legal fee) and the most the property may cost
      ...(r.package ? { financing_breakdown: r.package } : {}), ...(r.max_package ? { max_property_price_no_down_payment: r.max_package } : {}),
      shortfall: r.shortfall, buyer_top_up: r.buyer_top_up, extra_down_payment: r.extra_down_payment, limited_by: r.limited_by,
      tests: r.tests?.map((t) => ({ test: t.en, max_instalment: t.max_instalment, pass: t.pass })),
      bank_scenarios: r.scenarios, rules_verified: r.rules_verified, notes: r.notes, needs_advisor: r.escalate,
      upfront_costs_estimate: r.upfront && { total: r.upfront.total, items: r.upfront.items.map((i) => ({ item: i.en, amount: i.amount })) },
      assumptions: r.assumptions, disclaimer: r.disclaimer,
    },
    instalment_examples: { note: "Monthly figures per project/layout, calculated the same way as the loan calculator on the website (bank: its financing %, rate and years; lppsa: the LPPSA rules). Illustrations, not loan offers.", rows: fin.examples },
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
