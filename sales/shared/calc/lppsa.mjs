// LPPSA financing eligibility calculator: deterministic, exact decimals, rules from rules.mjs (lppsaRuleset).
// Eligibility rules are applied here; repayment mathematics lives in amortize.mjs.
//
// The three LPPSA tests (FAQ 4), each checked on its own:
//   1. instalment ≤ 60% (second financing: 50%) of gross, gross = basic salary + eligible fixed allowances
//   2. existing financing deductions + instalment ≤ 80% of net income, net = gross − mandatory deductions
//   3. pay left after every deduction (mandatory, financing, other, instalment) ≥ 20% of gross
// Profit: one weighted-average rate on the whole amount (4.00% up to RM750,000, 4.50% above).
// The financing covers the property part (≤ 100% of the lower of price and valuation) plus the MRTT/MRTA premium,
// other financed costs and the financing legal fee; the total is capped at the LPPSA maximum and the applicant's
// eligibility. Results are estimates, never an approval.
import { D, add, sub, mul, div, min, max, ZERO, roundTo, floorTo, toNumber } from "./decimal.mjs";
import { instalment, principalFor, totals } from "./amortize.mjs";
import { LPPSA_ALLOWANCES } from "./rules.mjs";

export const CALC_VERSION = "lppsa-calc-1.0";
const H = D(100);
const pct = (a, p) => div(mul(a, D(p)), H);
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const val = (v) => { const n = num(v); return n === null || !Number.isFinite(n) || n < 0 ? null : n; };

/** Weighted-average profit rate % for a financing amount (tiers: [{ up_to, rate_pct }], last up_to null). */
export function weightedRate(amount, tiers) {
  if (amount <= ZERO) return D(tiers[0].rate_pct);
  let left = amount, prev = ZERO, sum = ZERO;
  for (const t of tiers) {
    if (left <= ZERO) break;
    const cap = t.up_to === null || t.up_to === undefined ? left : sub(D(t.up_to), prev);
    const part = min(left, cap);
    sum = add(sum, mul(part, D(t.rate_pct)));
    left = sub(left, part); prev = add(prev, part);
  }
  return div(sum, amount);
}
const lppsaInstalment = (P, tiers, n) => instalment(P, weightedRate(P, tiers), n);

/** Legal fee (SRO scale + SST) on a financing amount. */
export function legalFee(amount, legal) {
  if (amount <= ZERO) return ZERO;
  let left = amount, prev = ZERO, fee = ZERO;
  for (const t of legal.tiers) {
    if (left <= ZERO) break;
    const cap = t.up_to === null || t.up_to === undefined ? left : sub(D(t.up_to), prev);
    const part = min(left, cap);
    fee = add(fee, pct(part, t.pct));
    left = sub(left, part); prev = add(prev, part);
  }
  fee = max(fee, D(legal.min));
  return roundTo(add(fee, pct(fee, legal.sst_pct)), 2);
}

/** Property part + MRTT + other costs + legal fee (charged on the whole amount, so solved by iteration). */
export function packageFor(property, { mrtt = ZERO, other = ZERO, financeLegal = true, legalOverride = null }, legal) {
  let fee = ZERO;
  if (legalOverride !== null) fee = legalOverride;
  else if (financeLegal && property > ZERO) {
    for (let i = 0; i < 30; i++) { const next = legalFee(add(add(add(property, mrtt), other), fee), legal); if (next === fee) break; fee = next; }
  }
  if (!financeLegal) fee = ZERO;
  return { property, mrtt, other, legal: fee, total: add(add(add(property, mrtt), other), fee) };
}

/** The largest property part whose package fits within `limit` (to the sen). */
function propertyWithin(limit, costs, legal) {
  if (limit <= ZERO) return ZERO;
  let lo = ZERO, hi = limit;
  for (let i = 0; i < 80 && sub(hi, lo) > D("0.01"); i++) {
    const mid = div(add(lo, hi), D(2));
    if (packageFor(mid, costs, legal).total <= limit) lo = mid; else hi = mid;
  }
  return floorTo(lo, 2);
}

/** A package whose total is exactly `total`: the costs on that total first, the property part takes the rest. */
function capPackage(total, costs, legal) {
  const fee = costs.legalOverride !== null ? costs.legalOverride : costs.financeLegal ? legalFee(total, legal) : ZERO;
  const property = max(ZERO, sub(sub(sub(total, costs.mrtt), costs.other), fee));
  return { property, mrtt: costs.mrtt, other: costs.other, legal: fee, total: add(add(add(property, costs.mrtt), costs.other), fee) };
}

/** The largest amount whose weighted-rate instalment over n months is within maxInst (to the sen). */
function amountFor(maxInst, tiers, n, cap) {
  if (maxInst <= ZERO) return ZERO;
  if (lppsaInstalment(cap, tiers, n) <= maxInst) return cap;
  let lo = ZERO, hi = min(cap, principalFor(maxInst, Math.min(...tiers.map((t) => t.rate_pct)), n));
  for (let i = 0; i < 80 && sub(hi, lo) > D("0.01"); i++) {
    const mid = div(add(lo, hi), D(2));
    if (lppsaInstalment(mid, tiers, n) <= maxInst) lo = mid; else hi = mid;
  }
  return floorTo(lo, 2);
}

const STATUS = {
  within: "Within indicative eligibility", exceeds: "Potentially exceeds eligibility",
  more_info: "More information required", cannot_assess: "Cannot assess with supplied information",
};

/**
 * @param input  plain values (numbers or numeric strings); see the calculator page for the fields
 * @param rules  lppsaRuleset(...)
 * @param now    Date (for the audit trail)
 */
export function calcLppsa(input = {}, rules, now = new Date()) {
  const warnings = [], reasons = [], missing = [];
  const age = val(input.age), basic = val(input.basic_salary);
  const allowances = Object.fromEntries(LPPSA_ALLOWANCES.map(([k]) => [k, val(input.allowances?.[k]) || 0]));
  const mandatory = val(input.mandatory_deductions), debts = val(input.financing_deductions) ?? 0, existing = val(input.existing_lppsa_instalment) ?? 0;
  const other = val(input.other_deductions) ?? 0, second = input.financing_no === "second";
  const scheme = input.retirement_scheme === "kwsp" ? "kwsp" : "pension", retireAge = val(input.retirement_age) ?? 60;
  if (age === null) missing.push("age");
  if (basic === null || basic === 0) missing.push("basic_salary");
  if (mandatory === null) missing.push("mandatory_deductions");
  if (second && !existing) warnings.push("Second financing: enter the existing LPPSA instalment so it is counted as a deduction.");
  if (input.employment && input.employment !== "permanent_confirmed") {
    reasons.push("LPPSA financing is for permanent public servants confirmed in service: an advisor must check this applicant's position.");
  }

  const out = {
    calculator: "lppsa", version: CALC_VERSION, ruleset: rules.version, rules_owner_verified: rules.owner_verified, calculated_at: now.toISOString(),
    status: null, status_label: null, reasons, warnings, missing,
  };
  if (missing.length) {
    out.status = "more_info"; out.status_label = STATUS.more_info;
    out.audit = audit(out, input, rules, null, null);
    return out;
  }

  // income
  const gross = add(D(basic), Object.values(allowances).reduce((s, v) => add(s, D(v)), ZERO));
  const net = sub(gross, D(mandatory));
  const debtTotal = add(D(debts), D(existing));
  const instPct = second ? rules.instalment_pct.second : rules.instalment_pct.first;
  const limits = [
    { key: "instalment_limit", label: `Instalment ≤ ${instPct}% of basic salary + eligible fixed allowances`, max_instalment: pct(gross, instPct) },
    { key: "debt_limit", label: `Financing deductions + instalment ≤ ${rules.debt_pct_of_net}% of net income`, max_instalment: sub(pct(net, rules.debt_pct_of_net), debtTotal) },
    { key: "net_pay_left", label: `Pay left ≥ ${rules.min_net_pct_of_gross}% of gross income`, max_instalment: sub(sub(sub(sub(gross, D(mandatory)), debtTotal), D(other)), pct(gross, rules.min_net_pct_of_gross)) },
  ];
  const maxInst = floorTo(max(ZERO, min(...limits.map((l) => l.max_instalment))), 2);
  const binding = limits.reduce((a, b) => (b.max_instalment < a.max_instalment ? b : a)).key;
  if (maxInst <= ZERO) reasons.push("No instalment fits: the deductions already use the whole allowance under the " + limits.find((l) => l.key === binding).label.toLowerCase() + " test.");

  // tenure
  const T = rules.tenure, sppm = input.scheme === "sppm";
  if (sppm && age > T.sppm_max_age) warnings.push(`SPPM is for applicants aged ${T.sppm_max_age} and below: normal tenure used.`);
  const yearsCap = sppm && age <= T.sppm_max_age ? T.sppm_years : T.normal_years;
  const ageCap = scheme === "pension" ? T.pension_max_age - age : retireAge - age;
  const maxYears = Math.max(0, Math.min(yearsCap, ageCap));
  const asked = val(input.tenure_years);
  const years = asked ? Math.min(Math.floor(asked), maxYears) : maxYears;
  if (asked && asked > maxYears) warnings.push(`Tenure limited to ${maxYears} years (${scheme === "pension" ? `age ${T.pension_max_age}, pension scheme` : `retirement at ${retireAge}, KWSP scheme`}${yearsCap < ageCap ? `; ${yearsCap}-year maximum` : ""}).`);
  if (years <= 0) {
    reasons.push(scheme === "pension" ? `No tenure left before age ${T.pension_max_age}.` : `No tenure left before retirement at ${retireAge}.`);
    out.status = "cannot_assess"; out.status_label = STATUS.cannot_assess;
    Object.assign(out, incomeView(gross, net, mandatory, debtTotal, other, limits, maxInst, binding));
    out.audit = audit(out, input, rules, null, 0);
    return out;
  }
  const n = years * 12;

  // eligibility (what the income carries, within the LPPSA maximum)
  const cap = D(rules.max_financing);
  const eligible = floorTo(amountFor(maxInst, rules.rate_tiers, n, cap), 0);
  const eligRate = weightedRate(eligible, rules.rate_tiers);
  const costs = { mrtt: D(val(input.mrtt_premium) ?? 0), other: D(val(input.other_costs) ?? 0), financeLegal: input.finance_legal_fees !== "no",
    legalOverride: val(input.legal_fee) === null ? null : D(val(input.legal_fee)) };
  const maxPropertyPlain = floorTo(div(mul(eligible, H), D(rules.margin_pct)), 0);              // no financed costs
  const maxPropertyWithCosts = floorTo(div(mul(propertyWithin(eligible, costs, rules.legal), H), D(rules.margin_pct)), 0);

  Object.assign(out, incomeView(gross, net, mandatory, debtTotal, other, limits, maxInst, binding), {
    tenure_years: years, max_tenure_years: maxYears, months: n,
    eligibility: { max_financing: toNumber(eligible), rate_pct: toNumber(eligRate, 4), instalment: toNumber(lppsaInstalment(eligible, rules.rate_tiers, n)),
      limited_by: eligible >= cap ? "lppsa_maximum" : "income",
      max_property_price_no_costs: toNumber(D(maxPropertyPlain), 0), max_property_price_with_costs: toNumber(D(maxPropertyWithCosts), 0) },
  });

  // the purchase being considered
  const price = val(input.property_price), valuation = val(input.valuation), requested = val(input.requested_amount);
  if (!price) {
    out.status = "more_info"; out.status_label = STATUS.more_info;
    reasons.push("Enter the property price to check a purchase. The eligibility above stands on its own.");
    out.audit = audit(out, input, rules, eligRate, years);
    return out;
  }
  const basis = valuation ? Math.min(price, valuation) : price;
  if (valuation && valuation < price) warnings.push(`Valuation is RM${fmt(price - valuation)} below the price: LPPSA finances on the lower figure, the difference is paid by the buyer.`);
  let propertyPart = pct(D(basis), rules.margin_pct);
  if (requested) propertyPart = min(propertyPart, D(requested));
  const pkg = packageFor(propertyPart, costs, rules.legal);
  const approved = min(pkg.total, eligible, cap);
  // what the approved amount covers: the costs first take their share, the property part is what is left
  // (the legal fee is charged on the capped total), so the parts add up exactly to the approvable amount
  const approvedPkg = approved < pkg.total ? capPackage(approved, costs, rules.legal) : pkg;
  const rate = weightedRate(approvedPkg.total, rules.rate_tiers);
  const inst = roundTo(instalment(approvedPkg.total, rate, n), 2);
  const instRequested = roundTo(lppsaInstalment(pkg.total, rules.rate_tiers, n), 2);
  const { interest } = totals(approvedPkg.total, inst, n);
  const cashForProperty = sub(D(price), approvedPkg.property);
  const shortfall = max(ZERO, sub(pkg.total, approved));
  out.requested = {
    property_price: price, valuation, basis_price: basis, property_part: toNumber(pkg.property), mrtt: toNumber(pkg.mrtt), other_costs: toNumber(pkg.other),
    legal_fee: toNumber(pkg.legal), legal_financed: costs.financeLegal, total: toNumber(pkg.total), instalment: toNumber(instRequested),
  };
  out.approved_estimate = {
    total: toNumber(approvedPkg.total), property_part: toNumber(approvedPkg.property), mrtt: toNumber(approvedPkg.mrtt), other_costs: toNumber(approvedPkg.other),
    legal_fee: toNumber(approvedPkg.legal), rate_pct: toNumber(rate, 4), instalment: toNumber(inst), total_profit: toNumber(interest),
    buyer_pays_for_property: toNumber(cashForProperty), shortfall: toNumber(shortfall),
    limited_by: approved === pkg.total ? "requested" : eligible >= cap ? "lppsa_maximum" : "eligibility",
  };
  out.tests = limits.map((l) => ({ key: l.key, label: l.label, max_instalment: toNumber(max(ZERO, l.max_instalment)), instalment: toNumber(instRequested), pass: instRequested <= l.max_instalment }));
  out.remaining_income = toNumber(sub(sub(sub(sub(gross, D(mandatory)), debtTotal), D(other)), inst));
  if (shortfall > ZERO) reasons.push(`The financing asked for (RM${fmt(toNumber(pkg.total))}) is RM${fmt(toNumber(shortfall))} above the ${eligible >= cap ? `LPPSA maximum of RM${fmt(rules.max_financing)}` : "applicant's eligibility"}; the buyer would pay the difference.`);
  for (const t of out.tests) if (!t.pass) reasons.push(`Fails "${t.label}": RM${fmt(t.instalment)} against a maximum of RM${fmt(t.max_instalment)}.`);
  if (!costs.mrtt && input.mrtt_premium === undefined) warnings.push("MRTT / MRTA premium not entered: it is financed in the same amount and lowers the property price you can afford.");
  const blocked = reasons.some((r) => /permanent public servants|No instalment fits/.test(r));
  out.status = blocked ? "cannot_assess" : shortfall > ZERO || out.tests.some((t) => !t.pass) ? "exceeds" : "within";
  out.status_label = STATUS[out.status];
  out.audit = audit(out, input, rules, rate, years);
  return out;
}

const fmt = (n) => Number(n).toLocaleString("en-MY", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function incomeView(gross, net, mandatory, debtTotal, other, limits, maxInst, binding) {
  return {
    income: { gross: toNumber(gross), mandatory_deductions: mandatory, net: toNumber(net), financing_deductions: toNumber(debtTotal), other_deductions: other },
    max_instalment: toNumber(maxInst), binding_test: binding,
    limits: limits.map((l) => ({ key: l.key, label: l.label, max_instalment: toNumber(max(ZERO, l.max_instalment)) })),
  };
}

function audit(out, input, rules, rate, years) {
  return { calculated_at: out.calculated_at, calculator: "lppsa", version: CALC_VERSION, ruleset: rules.version, sources: rules.sources,
    inputs: JSON.parse(JSON.stringify(input)), rate_pct: rate === null ? null : toNumber(rate, 4), tenure_years: years, status: out.status, warnings: out.warnings.slice() };
}
