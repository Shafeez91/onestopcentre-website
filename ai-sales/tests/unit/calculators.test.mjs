// Financing tools (30 Oct 2026): LPPSA and bank calculators. Reference figures marked "ref" were computed separately
// with Python's decimal module (60-digit precision), not with the code under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { D, add, toNumber, roundTo, floorTo } from "../../../sales/shared/calc/decimal.mjs";
import { instalment, principalFor } from "../../../sales/shared/calc/amortize.mjs";
import { lppsaRuleset, bankRuleset, SOURCES } from "../../../sales/shared/calc/rules.mjs";
import { calcLppsa, weightedRate, legalFee, packageFor } from "../../../sales/shared/calc/lppsa.mjs";
import { calcBank } from "../../../sales/shared/calc/bank.mjs";
import { whatsappSummary, compareScenarios } from "../../../sales/shared/calc/summary.mjs";
import { assess } from "../../../sales/shared/finance.mjs";

const LR = lppsaRuleset({}), BR = bankRuleset({});
const inst = (P, r, n) => toNumber(instalment(D(P), r, n));
const NOW = new Date("2026-10-30T09:00:00Z");

/* ---------- mathematics ---------- */
test("decimals: exact sums, half-up rounding to the sen, floor", () => {
  assert.equal(add(D("0.1"), D("0.2")), D("0.3"), "no floating-point drift");
  assert.equal(toNumber(D("2.005")), 2.01);
  assert.equal(toNumber(D("2.004999")), 2);
  assert.equal(toNumber(roundTo(D("-1.005"))), -1.01);
  assert.equal(toNumber(floorTo(D("609790.88"), 0), 0), 609790);
  assert.throws(() => D("abc"));
});

test("amortisation matches independent reference values (ref)", () => {
  assert.equal(inst(450000, 4, 420), 1992.49);
  assert.equal(inst(450000, 4.2, 420), 2046.83);
  assert.equal(inst(750000, 4, 420), 3320.81);
  assert.equal(inst(300000, 4, 360), 1432.25);
  assert.equal(inst(1000, 12, 1), 1010.00, "one month: principal plus one month's interest");
  assert.equal(inst(120000, 0, 240), 500.00, "zero rate handled separately");
  assert.equal(toNumber(principalFor(D(2700), 4, 420)), 609790.88);
  assert.equal(toNumber(principalFor(D(2320), 4.2, 420)), 510057.73);
  assert.equal(toNumber(principalFor(D(500), 0, 240)), 120000);
  // round trip
  assert.equal(toNumber(instalment(principalFor(D(2700), 4, 420), 4, 420)), 2700);
  assert.throws(() => instalment(D(1), 4, 0));
  assert.throws(() => instalment(D(1), -1, 12));
});

test("LPPSA weighted-average rate and legal fee (ref)", () => {
  const t = LR.rate_tiers;
  assert.equal(toNumber(weightedRate(D(500000), t), 4), 4);
  assert.equal(toNumber(weightedRate(D(800000), t), 5), 4.03125);
  assert.equal(toNumber(weightedRate(D(1000000), t), 4), 4.125);
  assert.equal(inst(1000000, 4.125, 420), 4503.04);
  assert.equal(inst(800000, 4.03125, 420), 3557.21);
  assert.equal(toNumber(legalFee(D(456158), LR.legal)), 6158.13);
  assert.equal(toNumber(legalFee(D(10000), LR.legal)), 540, "minimum RM500 + SST");
  const p = packageFor(D(450000), { mrtt: D(12000), other: D(0), financeLegal: true, legalOverride: null }, LR.legal);
  assert.equal(toNumber(p.legal), 6322.35);
  assert.equal(toNumber(p.total), 468322.35);
});

/* ---------- LPPSA ---------- */
const base = { employment: "permanent_confirmed", retirement_scheme: "pension", age: 30, basic_salary: 4000, allowances: { itka: 500, cola: 500 }, mandatory_deductions: 500, financing_deductions: 800 };
const L = (o = {}) => calcLppsa({ ...base, ...o }, LR, NOW);

test("LPPSA 1 · basic salary only: the 60% test binds", () => {
  const r = L({ allowances: {}, basic_salary: 3000, mandatory_deductions: 300, financing_deductions: 0 });
  assert.equal(r.income.gross, 3000);
  assert.deepEqual(r.limits.map((l) => l.max_instalment), [1800, 2160, 2100]); // 60%×3000; 80%×2700; 2700 − 20%×3000
  assert.equal(r.binding_test, "instalment_limit");
  assert.equal(r.max_instalment, 1800);
});

test("LPPSA 2 · eligible fixed allowances count; anything else does not", () => {
  const r = L({ allowances: { itka: 500, cola: 500, overtime: 2000 } });
  assert.equal(r.income.gross, 5000, "overtime is not an eligible fixed allowance");
  assert.equal(L({ allowances: { itp: 100, itka: 100, itk: 100, itkt: 100, itju: 100, epw: 100, acting: 100, cola: 100, biw: 100, bism: 100, biss: 100 } }).income.gross, 5100);
});

test("LPPSA 3 + 4 · mandatory deductions lower net income; other deductions only the 20% test; each test independent", () => {
  const r = L();
  assert.equal(r.income.net, 4500);
  assert.deepEqual(r.limits.map((l) => l.max_instalment), [3000, 2800, 2700]);
  const o = L({ other_deductions: 1000 });
  assert.deepEqual(o.limits.map((l) => l.max_instalment), [3000, 2800, 1700], "other deductions: 20% test only");
  assert.equal(o.binding_test, "net_pay_left");
  // a purchase that passes the 60% and 80% tests but fails the 20% test
  const f = L({ other_deductions: 1000, property_price: 450000, mrtt_premium: 0 });
  assert.deepEqual(f.tests.map((t) => t.pass), [true, true, false]);
  assert.equal(f.status, "exceeds");
  assert.ok(f.reasons.some((x) => /Fails "Pay left ≥ 20% of gross income"/.test(x)));
});

test("LPPSA 5 + 6 · retirement scheme, retirement age and requested tenure", () => {
  assert.equal(L({ age: 60 }).tenure_years, 30, "pension: up to age 90");
  assert.equal(L({ age: 40, retirement_scheme: "kwsp", retirement_age: 60 }).tenure_years, 20, "KWSP: until retirement");
  assert.equal(L({ age: 40, retirement_scheme: "kwsp" }).tenure_years, 20, "retirement age 60 by default");
  assert.equal(L({ tenure_years: 25 }).tenure_years, 25);
  const long = L({ tenure_years: 50 });
  assert.equal(long.tenure_years, 35);
  assert.ok(long.warnings.some((w) => /Tenure limited to 35 years/.test(w)));
  assert.equal(L({ age: 28, scheme: "sppm" }).tenure_years, 40, "SPPM: 40 years at 30 and below");
  const old = L({ age: 31, scheme: "sppm" });
  assert.equal(old.tenure_years, 35);
  assert.ok(old.warnings.some((w) => /SPPM is for applicants aged 30/.test(w)));
  const none = L({ age: 60, retirement_scheme: "kwsp", retirement_age: 60 });
  assert.equal(none.status, "cannot_assess");
  assert.ok(none.reasons.some((x) => /No tenure left before retirement/.test(x)));
});

test("LPPSA 7 + 8 · existing LPPSA financing: second financing uses 50% and counts the existing instalment", () => {
  const r = L({ financing_no: "second", existing_lppsa_instalment: 600 });
  assert.match(r.limits[0].label, /50%/);
  assert.equal(r.limits[0].max_instalment, 2500);
  assert.equal(r.income.financing_deductions, 1400);
  assert.equal(r.limits[1].max_instalment, 2200); // 3600 − 1400
  assert.ok(L({ financing_no: "second" }).warnings.some((w) => /existing LPPSA instalment/.test(w)));
});

test("LPPSA 9 · a price within eligibility; 10 · above it: shortfall, reasons and the buyer's share", () => {
  const ok = L({ property_price: 450000, mrtt_premium: 12000 });
  assert.equal(ok.status, "within");
  assert.equal(ok.status_label, "Within indicative eligibility");
  assert.equal(ok.eligibility.max_financing, 609790);                 // ref: 2,700 at 4% over 420 months
  assert.equal(ok.approved_estimate.total, 468322.35);
  assert.equal(ok.approved_estimate.instalment, 2073.61);
  assert.equal(ok.remaining_income, 1626.39);                          // 5000 − 500 − 800 − 2073.61
  assert.equal(ok.approved_estimate.total_profit, 402593.85);          // 2073.61 × 420 − 468,322.35
  const hi = L({ property_price: 700000, mrtt_premium: 12000 });
  assert.equal(hi.status, "exceeds");
  assert.equal(hi.approved_estimate.total, 609790, "approvable = the applicant's eligibility");
  assert.equal(hi.approved_estimate.limited_by, "eligibility");
  assert.ok(hi.approved_estimate.shortfall > 0);
  assert.ok(hi.approved_estimate.buyer_pays_for_property > 0);
  assert.ok(hi.reasons.some((x) => /above the applicant's eligibility/.test(x)));
  assert.ok(hi.approved_estimate.instalment <= hi.max_instalment);
});

test("LPPSA 11 · above RM750,000 the weighted-average rate applies; the RM1M maximum caps the total", () => {
  const rich = { basic_salary: 15000, allowances: { itka: 2000 }, mandatory_deductions: 2000, financing_deductions: 0 };
  const r = L({ ...rich, property_price: 900000, mrtt_premium: 0, finance_legal_fees: "no" });
  assert.equal(r.approved_estimate.total, 900000);
  assert.equal(r.approved_estimate.rate_pct, 4.0833);                  // (750k×4 + 150k×4.5) / 900k
  assert.equal(r.approved_estimate.instalment, inst(900000, toNumber(weightedRate(D(900000), LR.rate_tiers), 10), 420));
  const cap = L({ ...rich, property_price: 1200000, mrtt_premium: 0 });
  assert.equal(cap.eligibility.max_financing, 1000000);
  assert.equal(cap.eligibility.limited_by, "lppsa_maximum");
  assert.equal(cap.approved_estimate.total, 1000000);
  assert.equal(cap.approved_estimate.instalment, 4503.04);             // ref
  assert.ok(cap.reasons.some((x) => /above the LPPSA maximum/.test(x)));
});

test("LPPSA 12 + 13 · legal fee financed or paid in cash, a quoted legal fee, MRTT and other financed costs", () => {
  assert.equal(L({ property_price: 450000, mrtt_premium: 12000 }).requested.legal_fee, 6322.35);
  const cash = L({ property_price: 450000, mrtt_premium: 12000, finance_legal_fees: "no" });
  assert.equal(cash.requested.legal_fee, 0);
  assert.equal(cash.requested.total, 462000);
  const quoted = L({ property_price: 450000, mrtt_premium: 12000, legal_fee: 5000, other_costs: 1500 });
  assert.equal(quoted.requested.total, 468500);
  assert.ok(L({ property_price: 450000 }).warnings.some((w) => /MRTT \/ MRTA premium not entered/.test(w)));
  // the costs lower the highest property price
  const e = L({ mrtt_premium: 12000 }).eligibility;
  assert.equal(e.max_property_price_no_costs, 609790);
  assert.ok(e.max_property_price_with_costs < 609790 - 12000);
});

test("LPPSA 14 · incomplete, invalid and ineligible inputs; valuation below price", () => {
  const m = calcLppsa({ basic_salary: 4000 }, LR, NOW);
  assert.equal(m.status, "more_info");
  assert.deepEqual(m.missing, ["age", "mandatory_deductions"]);
  assert.equal(m.eligibility, undefined, "no figures without the essentials");
  assert.deepEqual(calcLppsa({ ...base, basic_salary: -100 }, LR, NOW).missing, ["basic_salary"], "negative salary is not used");
  const noPrice = L();
  assert.equal(noPrice.status, "more_info");
  assert.ok(noPrice.eligibility.max_financing > 0, "eligibility still shown");
  const contract = L({ employment: "contract", property_price: 300000 });
  assert.equal(contract.status, "cannot_assess");
  const val = L({ property_price: 500000, valuation: 480000, mrtt_premium: 0 });
  assert.equal(val.requested.basis_price, 480000);
  assert.equal(val.requested.property_part, 480000);
  assert.equal(val.approved_estimate.buyer_pays_for_property, 20000);
  assert.ok(val.warnings.some((w) => /Valuation is RM20,000 below the price/.test(w)));
  const req = L({ property_price: 500000, requested_amount: 400000, mrtt_premium: 0 });
  assert.equal(req.requested.property_part, 400000);
});

test("LPPSA audit trail: time, rules version, sources, inputs, rate, tenure and warnings", () => {
  const r = L({ property_price: 450000, tenure_years: 50 });
  assert.equal(r.audit.calculated_at, "2026-10-30T09:00:00.000Z");
  assert.equal(r.audit.calculator, "lppsa");
  assert.match(r.audit.ruleset, /^CALC-LPPSA-1 \/ LPPSA-/);
  assert.equal(r.audit.rate_pct, 4);
  assert.equal(r.audit.tenure_years, 35);
  assert.equal(r.audit.inputs.property_price, 450000);
  assert.ok(r.audit.warnings.length >= 1);
  for (const k of r.audit.sources) assert.ok(SOURCES[k]?.rule && SOURCES[k]?.status, k);
});

test("LPPSA: the calculator and the lead-page engine agree on the same buyer", () => {
  const x = { age: 30, basic_salary: 4000, fixed_allowances: 1000, mandatory_deductions: 500, commitments_monthly: 800, confirmed_service: "yes", property_price: 450000, mrtt_premium: 12000 };
  const old = assess({ route: "lppsa", ...x });
  const neu = L({ property_price: 450000, mrtt_premium: 12000 });
  assert.equal(neu.max_instalment, old.max_instalment);
  assert.equal(Math.round(neu.approved_estimate.total), old.package.total);
  assert.equal(Math.round(neu.approved_estimate.instalment), old.package.instalment);
  assert.equal(Math.floor(neu.eligibility.max_financing / 1000) * 1000, old.max_by_income);
});

/* ---------- bank ---------- */
const bb = { age: 35, employment_type: "private", basic_salary: 6000, statutory_deductions: 900, commitments: { car: { amount: 1000 }, credit_card: { amount: 250 } }, rate_pct: 4.2, dsr_pct: 70 };
const Bk = (o = {}) => calcBank({ ...bb, ...o }, BR, NOW);

test("bank 1 · single applicant: DSR, indicative maximum, instalment, down payment (ref)", () => {
  const r = Bk({ property_price: 500000, margin_pct: 90 });
  assert.equal(r.income.net, 5100);
  assert.equal(r.income.current_dsr_pct, 24.51);
  assert.equal(r.eligibility.max_instalment, 2320);                    // 70% × 5100 − 1250
  assert.equal(r.eligibility.max_financing, 510057);                   // ref
  assert.equal(r.requested.financing, 450000);
  assert.equal(r.requested.down_payment, 50000);
  assert.equal(r.requested.instalment, 2046.83);                       // ref
  assert.equal(r.requested.dsr_after_pct, 64.64);
  assert.equal(r.requested.remaining_income, 1803.17);
  assert.equal(r.status, "within");
  assert.equal(r.label, "Indicative scenario — not any bank's eligibility assessment");
});

test("bank 2 + 3 · employment categories and income levels: variable and business income recognised in part", () => {
  const se = Bk({ employment_type: "self_employed", basic_salary: 0, business_income: 10000 });
  assert.equal(se.income.recognised_gross, 6000, "60% of business income (assumption)");
  assert.ok(se.warnings.some((w) => /Borang B/.test(w)));
  assert.equal(Bk({ variable_income: 2000 }).income.recognised_gross, 7000, "50% of variable income");
  assert.equal(Bk({ variable_income: 2000, variable_income_pct: 100 }).income.recognised_gross, 8000);
  assert.ok(Bk({ basic_salary: 12000 }).eligibility.max_financing > Bk().eligibility.max_financing);
  assert.ok(Bk({ employment_months: 3 }).warnings.some((w) => /6 months/.test(w)));
});

test("bank 4 · several commitments; ones the bank does not count stay in remaining income only", () => {
  const r = Bk({ commitments: { car: { amount: 1000 }, personal: { amount: 500 }, ptptn: { amount: 200, counted: false } }, property_price: 400000 });
  assert.equal(r.income.commitments_counted, 1500);
  assert.equal(r.income.commitments_declared, 1700);
  assert.equal(r.eligibility.max_instalment, 2070);                    // 3570 − 1500
  assert.equal(r.requested.remaining_income, Math.round((5100 - 1700 - r.requested.instalment) * 100) / 100);
  const cc = Bk({ commitments: {}, credit_card_balance: 10000 });
  assert.equal(cc.income.commitments_counted, 500, "5% of the balance a month (assumption)");
});

test("bank 5 · DSR assumptions; 6 · margins (3rd loan capped at 70%, >90% flagged); 7 · rates; 8 · tenures; 9 · prices", () => {
  assert.ok(Bk({ dsr_pct: 60 }).eligibility.max_financing < Bk({ dsr_pct: 80 }).eligibility.max_financing);
  assert.equal(Bk({ dsr_pct: 60 }).eligibility.max_instalment, 1810);
  const third = Bk({ property_price: 500000, margin_pct: 90, housing_loans: 3 });
  assert.equal(third.requested.margin_pct, 70);
  assert.ok(third.warnings.some((w) => /Third or later housing loan/.test(w)));
  assert.ok(Bk({ property_price: 500000, margin_pct: 100 }).warnings.some((w) => /not available to everyone/.test(w)));
  assert.equal(Bk({ property_price: 500000, margin_pct: 100 }).requested.down_payment, 0);
  assert.ok(Bk({ property_price: 500000, rate_pct: 3.8 }).requested.instalment < Bk({ property_price: 500000, rate_pct: 4.5 }).requested.instalment);
  assert.equal(Bk({ age: 60 }).tenure_years, 10, "repaid by age 70 (assumption)");
  assert.equal(Bk({ tenure_years: 25 }).tenure_years, 25);
  assert.ok(Bk({ tenure_years: 40 }).warnings.some((w) => /Tenure limited to 35 years/.test(w)));
  assert.equal(Bk({ property_price: 300000 }).requested.financing, 270000);
});

test("bank 10 · insufficient income; 11 · zero rate; 12 · capitalised costs", () => {
  const hi = Bk({ property_price: 900000 });
  assert.equal(hi.status, "exceeds");
  assert.ok(hi.reasons.some((x) => /above the RM2,320 that a 70% DSR allows/.test(x)));
  const over = Bk({ commitments: { car: { amount: 4000 } } });
  assert.equal(over.eligibility.max_instalment, 0);
  assert.equal(over.status, "cannot_assess");
  assert.equal(Bk({ property_price: 500000, rate_pct: 0 }).requested.instalment, 1071.43); // 450,000 / 420
  const cap = Bk({ property_price: 500000, mrta_premium: 15000, other_fees: 5000 });
  assert.equal(cap.requested.financing, 470000);
  assert.equal(cap.requested.instalment, inst(470000, 4.2, 420));
  assert.equal(Bk({ age: null }).status, "more_info");
  assert.equal(calcBank({ age: 30 }, BR, NOW).status, "more_info");
});

/* ---------- summaries ---------- */
test("WhatsApp summary and LPPSA vs bank comparison use only calculator figures and never claim approval", () => {
  const l = L({ property_price: 450000, mrtt_premium: 12000 }), b = Bk({ property_price: 450000 });
  const s = whatsappSummary(l);
  assert.match(s, /\*Anggaran Pembiayaan LPPSA\*/);
  assert.match(s, /RM468,322\.35/);
  assert.match(s, /RM2,073\.61/);
  assert.match(s, /bukan kelulusan/);
  assert.match(whatsappSummary(b, "en"), /not a financing approval/);
  const c = compareScenarios(l, b);
  const row = (k) => c.rows.find((x) => x.label === k);
  assert.equal(row("Financing amount").lppsa, 468322.35);
  assert.equal(row("Financing amount").bank, 405000);
  assert.equal(row("Upfront cash for the property").bank, 45000);
  assert.match(c.note, /not like-for-like/);
  assert.ok(c.differences.some((d) => /Monthly instalment: LPPSA RM2,073\.61 vs bank/.test(d)));
  assert.equal(compareScenarios(null, b).rows[1].lppsa, null);
});
