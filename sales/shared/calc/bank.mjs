// Bank home loan eligibility calculator — an INDICATIVE scenario, never a bank's assessment. Deterministic, exact
// decimals, separate from the LPPSA rules. The advisor chooses the DSR assumption, rate, margin and which commitments
// the selected bank would count; nothing bank-specific is assumed (no bank publishes its DSR or income rules).
//   recognised income = basic + fixed allowances + variable × v% + business income × b%
//   net income        = recognised income − statutory deductions
//   DSR               = (commitments counted + new instalment) / net income
//   max instalment    = DSR assumption × net income − commitments counted
//   financing         = price × margin % + MRTA/MLTA premium financed + other capitalised fees
import { D, add, sub, mul, div, min, max, ZERO, roundTo, floorTo, toNumber } from "./decimal.mjs";
import { instalment, principalFor, totals } from "./amortize.mjs";

export const CALC_VERSION = "bank-calc-1.0";
const H = D(100);
const pct = (a, p) => div(mul(a, D(p)), H);
const val = (v) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return !Number.isFinite(n) || n < 0 ? null : n; };

export const COMMITMENTS = [
  ["car", "Car financing"], ["personal", "Personal financing"], ["credit_card", "Credit cards (monthly)"], ["property", "Other property financing"],
  ["ptptn", "PTPTN"], ["other", "Other declared monthly debts"],
];
const STATUS = {
  within: "Within indicative eligibility", exceeds: "Potentially exceeds eligibility",
  more_info: "More information required", cannot_assess: "Cannot assess with supplied information",
};

/**
 * @param input  { age, employment_type, employment_months, basic_salary, fixed_allowances, variable_income, business_income,
 *                 statutory_deductions, commitments: { key: { amount, counted } }, credit_card_balance, property_price,
 *                 margin_pct, tenure_years, rate_pct, dsr_pct, mrta_premium, other_fees, housing_loans, bank }
 */
export function calcBank(input = {}, rules, now = new Date()) {
  const warnings = [], reasons = [], missing = [];
  const out = { calculator: "bank", version: CALC_VERSION, ruleset: rules.version, label: rules.label, calculated_at: now.toISOString(), bank: input.bank || "", reasons, warnings, missing };
  const age = val(input.age), basic = val(input.basic_salary) ?? 0, business = val(input.business_income) ?? 0;
  if (age === null) missing.push("age");
  if (!basic && !business) missing.push("income");
  if (val(input.statutory_deductions) === null) missing.push("statutory_deductions");
  const rate = val(input.rate_pct) ?? rules.default_rate_pct, dsrPct = val(input.dsr_pct) ?? rules.default_dsr_pct;
  if (dsrPct <= 0 || dsrPct > 100) { missing.push("dsr_pct"); }
  if (missing.length) return done(out, "more_info", input, rules, rate, null);

  // income: what the scenario recognises
  const vPct = val(input.variable_income_pct) ?? rules.variable_income_pct, bPct = val(input.business_income_pct) ?? rules.self_employed_income_pct;
  const gross = add(add(D(basic), D(val(input.fixed_allowances) ?? 0)), add(pct(D(val(input.variable_income) ?? 0), vPct), pct(D(business), bPct)));
  const net = sub(gross, D(val(input.statutory_deductions)));
  if (net <= ZERO) { reasons.push("Statutory deductions are not below the recognised income."); return done(out, "cannot_assess", input, rules, rate, null); }
  if (input.employment_type === "self_employed" || input.employment_type === "business_owner") warnings.push(`Business income counted at ${bPct}% (an assumption): banks usually ask for 2 years of tax returns (Borang B / BE) and bank statements.`);
  if (val(input.employment_months) !== null && val(input.employment_months) < 6) warnings.push("Less than 6 months in the current job: many banks ask for a confirmed position first.");

  // commitments (each marked counted or not by the advisor for the selected bank)
  const items = [];
  let counted = ZERO, declared = ZERO;
  for (const [k, label] of COMMITMENTS) {
    const c = input.commitments?.[k];
    let amount = val(c?.amount) ?? 0;
    if (k === "credit_card" && !amount && val(input.credit_card_balance)) { amount = toNumber(pct(D(val(input.credit_card_balance)), rules.credit_card_pct)); warnings.push(`Credit cards counted at ${rules.credit_card_pct}% of the RM${val(input.credit_card_balance).toLocaleString("en-MY")} balance a month (an assumption).`); }
    if (!amount) continue;
    const isCounted = c?.counted !== false;
    declared = add(declared, D(amount));
    if (isCounted) counted = add(counted, D(amount));
    items.push({ key: k, label, amount, counted: isCounted });
  }

  // tenure
  const ageCap = rules.max_age - age;
  const maxYears = Math.max(0, Math.min(rules.max_tenure_years, ageCap));
  const asked = val(input.tenure_years);
  const years = asked ? Math.min(Math.floor(asked), maxYears) : maxYears;
  if (asked && asked > maxYears) warnings.push(`Tenure limited to ${maxYears} years (${rules.max_tenure_years}-year maximum, repaid by age ${rules.max_age} — an assumption).`);
  out.income = { recognised_gross: toNumber(gross), statutory_deductions: val(input.statutory_deductions), net: toNumber(net),
    commitments_counted: toNumber(counted), commitments_declared: toNumber(declared), current_dsr_pct: toNumber(div(mul(counted, H), net), 2) };
  out.commitments = items;
  if (years <= 0) { reasons.push(`No tenure left before age ${rules.max_age}.`); return done(out, "cannot_assess", input, rules, rate, 0); }
  const n = years * 12;
  out.tenure_years = years; out.max_tenure_years = maxYears; out.months = n;

  // indicative maximum
  const maxInst = floorTo(max(ZERO, sub(pct(net, dsrPct), counted)), 2);
  const maxLoan = floorTo(principalFor(maxInst, rate, n), 0);
  out.dsr_pct = dsrPct; out.rate_pct = rate;
  out.eligibility = { max_instalment: toNumber(maxInst), max_financing: toNumber(maxLoan) };
  if (maxInst <= ZERO) reasons.push(`Commitments counted (RM${fmt(toNumber(counted))}) already reach ${dsrPct}% of net income.`);

  // the purchase
  const price = val(input.property_price);
  if (!price) { reasons.push("Enter the property price to check a purchase. The indicative maximum above stands on its own."); return done(out, maxInst <= ZERO ? "cannot_assess" : "more_info", input, rules, rate, years); }
  let margin = val(input.margin_pct) ?? 90;
  const loans = val(input.housing_loans) ?? 1;
  if (loans >= 3 && margin > rules.third_loan_max_margin_pct) { warnings.push(`Third or later housing loan: margin capped at ${rules.third_loan_max_margin_pct}% (Bank Negara Malaysia).`); margin = rules.third_loan_max_margin_pct; }
  if (margin > 90) warnings.push(`${margin}% financing is only offered on selected products and to applicants who qualify (e.g. first-home schemes); it is not available to everyone.`);
  const propertyLoan = floorTo(pct(D(price), margin), 2);
  const mrta = D(val(input.mrta_premium) ?? 0), fees = D(val(input.other_fees) ?? 0);
  const loan = add(add(propertyLoan, mrta), fees);
  const inst = roundTo(instalment(loan, rate, n), 2);
  const { interest } = totals(loan, inst, n);
  const dsrAfter = div(mul(add(counted, inst), H), net);
  const down = sub(D(price), propertyLoan);
  out.requested = {
    property_price: price, margin_pct: margin, property_loan: toNumber(propertyLoan), mrta_premium: toNumber(mrta), other_fees: toNumber(fees),
    financing: toNumber(loan), down_payment: toNumber(down), instalment: toNumber(inst), total_interest: toNumber(interest),
    dsr_after_pct: toNumber(dsrAfter, 2), remaining_income: toNumber(sub(sub(net, D(toNumber(declared))), inst)),
  };
  const fits = inst <= maxInst;
  if (!fits) reasons.push(`The instalment RM${fmt(toNumber(inst))} is above the RM${fmt(toNumber(maxInst))} that a ${dsrPct}% DSR allows (DSR after: ${toNumber(dsrAfter, 1)}%).`);
  if (!mrta) warnings.push("MRTA / MLTA premium not included: enter it if it will be financed.");
  return done(out, maxInst <= ZERO ? "cannot_assess" : fits ? "within" : "exceeds", input, rules, rate, years);
}

const fmt = (n) => Number(n).toLocaleString("en-MY", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function done(out, status, input, rules, rate, years) {
  out.status = status; out.status_label = STATUS[status];
  out.audit = { calculated_at: out.calculated_at, calculator: "bank", version: CALC_VERSION, ruleset: rules.version, sources: rules.sources,
    inputs: JSON.parse(JSON.stringify(input)), rate_pct: rate, dsr_pct: out.dsr_pct ?? null, tenure_years: years, status, warnings: out.warnings.slice() };
  return out;
}
