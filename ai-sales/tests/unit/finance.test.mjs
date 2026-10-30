// Loan eligibility & affordability engine. Expected values were computed independently (Python, closed-form
// annuity formula and hand arithmetic), not by running this code.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  instalment, principalFor, tieredInstalment, tieredPrincipalFor, tenureYears, upfrontCosts, assess, assessLppsa, assessBank,
  financingRules, resultAmounts, recommendProjects, priceExamples, advisorSummary, DEFAULT_FINANCING,
} from "../../../sales/shared/finance.mjs";
import { mergeFinancing, cleanInputs, isNewAssessment } from "../../lib/financing.mjs";
import { validateReply } from "../../../sales/shared/validator.mjs";

const close = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);
const R = DEFAULT_FINANCING;

test("instalment formula P·r·(1+r)^n/((1+r)^n−1) matches independent values", () => {
  close(instalment(500000, 4, 420), 2213.87);
  close(instalment(450000, 4.2, 420), 2046.83);
  close(instalment(300000, 3.9, 360), 1415.0);
  close(instalment(400000, 4.5, 300), 2223.33);
  close(instalment(100000, 0, 120), 833.33);   // zero rate: P / n
  assert.equal(instalment(0, 4, 360), 0);
  for (const bad of [[-1, 4, 360], [1000, 4, 0], [1000, -1, 360], [1000, 4, 12.5], [NaN, 4, 360]]) assert.throws(() => instalment(...bad), RangeError);
});

test("loan a payment can carry (inverse) and round trip", () => {
  close(principalFor(2000, 4, 420), 451696.95);
  close(principalFor(2700, 4.2, 420), 593601.67);
  close(principalFor(1000, 0, 120), 120000);
  assert.equal(principalFor(0, 4, 420), 0);
  assert.equal(principalFor(-5, 4, 420), 0);
  close(instalment(principalFor(1234.56, 4.1, 300), 4.1, 300), 1234.56);
});

test("LPPSA tiered profit: one weighted-average rate on the whole amount (4% up to RM750k, 4.5% above)", () => {
  const tiers = R.lppsa.rate_tiers;
  // RM1,000,000 → (750,000 × 4% + 250,000 × 4.5%) / 1,000,000 = 4.125%, 35 years (reference: Python Decimal)
  close(tieredInstalment(1000000, tiers, 420), 4503.04, 0.01);
  close(tieredInstalment(500000, tiers, 420), 2213.87, 0.01); // all in the first band
  close(tieredPrincipalFor(2700, tiers, 420), 609790.88, 0.05);
  close(tieredPrincipalFor(tieredInstalment(900000, tiers, 420), tiers, 420), 900000, 0.05);
});

test("tenure: maximum years, capped by the maximum age", () => {
  assert.equal(tenureYears(30, 35, 90), 35);
  assert.equal(tenureYears(60, 35, 90), 30);
  assert.equal(tenureYears(50, 35, 70), 20);
  assert.equal(tenureYears(72, 35, 70), 0);
  assert.equal(tenureYears(null, 35, 70), null);
});

test("upfront costs: MOT stamp duty tiers, loan stamp duty 0.5%, legal fees SRO 2023 + 8% SST", () => {
  const c = upfrontCosts(500000, 450000);
  const by = Object.fromEntries(c.items.map((i) => [i.key, i.amount]));
  assert.deepEqual(by, { down_payment: 50000, mot_stamp_duty: 9000, loan_stamp_duty: 2250, legal_spa: 6750, legal_loan: 6075 });
  assert.equal(c.total, 74075);
  assert.equal(upfrontCosts(1200000, 0).items.find((i) => i.key === "mot_stamp_duty").amount, 32000);
  assert.equal(upfrontCosts(30000, 27000).items.find((i) => i.key === "legal_spa").amount, 540, "minimum legal fee RM500 + SST");
  assert.equal(upfrontCosts(null, 1), null);
});

const LPPSA_A = { route: "lppsa", age: 30, basic_salary: 4000, fixed_allowances: 1000, mandatory_deductions: 500, commitments_monthly: 800, confirmed_service: "yes", property_price: 450000 };

test("LPPSA: three salary tests, binding test, limits and outcome", () => {
  const r = assess(LPPSA_A);
  // gross 5,000; net 4,500; tests: 60%×5000 = 3,000; 80%×4500 − 800 = 2,800; 4500 − 800 − 20%×5000 = 2,700
  assert.deepEqual(r.tests.map((t) => t.max_instalment), [3000, 2800, 2700]);
  assert.equal(r.binding_test, "net_pay_left");
  assert.equal(r.max_instalment, 2700);
  assert.equal(r.tenure_years, 35);
  assert.equal(r.max_by_income, 609000);
  // LPPSA finances the property (100% of RM450,000) plus the financing agreement's legal fee on the whole amount:
  // 1.25% × RM456,158 = RM5,702 + 8% SST = RM6,158 (Garis Panduan Bil. 1/2024; SRO scale)
  assert.equal(r.max_financing, 456158);
  assert.equal(r.limited_by, "property_value");
  assert.deepEqual(r.package, { property: 450000, mrtt: 0, legal: 6158, total: 456158, legal_financed: true, instalment: 2020, mrtt_monthly: 0, legal_monthly: 27 });
  assert.equal(r.instalment_for_needed, 2020);
  assert.equal(r.outcome, "potentially_affordable");
  assert.ok(r.tests.every((t) => t.pass));
  assert.equal(r.rules_verified, false);
  assert.match(r.assumptions[0], /not yet verified/);
  assert.match(r.disclaimer.ms, /bukan kelulusan/);
});

test("LPPSA: second financing uses 50%, the RM1M cap leaves a top-up → adjustments + advisor", () => {
  const r = assess({ route: "lppsa", age: 30, basic_salary: 15000, fixed_allowances: 2000, mandatory_deductions: 3000, commitments_monthly: 0, confirmed_service: "yes", second_financing: true, property_price: 1200000 });
  assert.equal(r.max_instalment, 8500);          // 50% × 17,000
  assert.equal(r.max_financing, 1000000);        // income would carry ~RM1.84M
  assert.equal(r.limited_by, "lppsa_cap");
  // the RM1M maximum covers the legal fee too: RM987,850 property + RM12,150 legal fee
  assert.equal(r.buyer_top_up, 212150);
  assert.equal(r.package.property, 987850);
  assert.equal(r.package.total, 1000000);
  assert.equal(r.instalment_for_needed, 4503);   // RM1M at the weighted 4.125%, 35 years (RM4,503.04)
  assert.equal(r.outcome, "may_be_affordable_with_adjustments");
  assert.ok(r.escalate.includes("second_lppsa_financing"));
});

test("LPPSA: older applicant gets a shorter tenure; shortfall bands", () => {
  const base = { route: "lppsa", age: 60, basic_salary: 4000, fixed_allowances: 1000, mandatory_deductions: 500, commitments_monthly: 800, confirmed_service: "yes" };
  const ok = assess({ ...base, property_price: 300000 });
  assert.equal(ok.tenure_years, 30);
  assert.equal(ok.instalment_for_needed, 1452);   // RM300,000 + RM4,094 legal fee, 30 years
  assert.equal(ok.max_by_income, 565000);
  assert.equal(ok.outcome, "potentially_affordable");
  assert.equal(assess({ ...base, property_price: 640000 }).outcome, "may_be_affordable_with_adjustments"); // ≤ 20% above RM565,545
  const hard = assess({ ...base, property_price: 700000 });
  assert.equal(hard.outcome, "potentially_challenging");
  assert.ok(hard.escalate.includes("challenging_outcome"));
});

test("LPPSA: not confirmed in service → challenging and escalated; unknown → insufficient", () => {
  const r = assess({ ...LPPSA_A, confirmed_service: "no" });
  assert.equal(r.outcome, "potentially_challenging");
  assert.ok(r.escalate.includes("not_confirmed_in_service"));
  const u = assess({ ...LPPSA_A, confirmed_service: null });
  assert.equal(u.outcome, "insufficient_information");
  assert.equal(u.max_financing, 456158, "figures still shown");
  assert.deepEqual(u.missing, ["confirmed_service"]);
});

test("LPPSA: the MRTT premium and legal fee are financed with the property, with their share of the instalment", () => {
  const r = assess({ ...LPPSA_A, mrtt_premium: 12000 });
  assert.deepEqual(r.package, { property: 450000, mrtt: 12000, legal: 6322, total: 468322, legal_financed: true, instalment: 2074, mrtt_monthly: 53, legal_monthly: 28 });
  assert.equal(r.financing_needed, 468322);
  assert.equal(r.outcome, "potentially_affordable");
  // the most the property may cost (no down payment) once MRTT and legal fee are financed too: RM609,000 total
  assert.deepEqual(r.max_package, { property: 589000, mrtt: 12000, legal: 7927, total: 609000, legal_financed: true });
  // the financed legal fee is not a cash cost
  const legal = r.upfront.items.find((i) => i.key === "legal_loan");
  assert.equal(legal.amount, 0);
  assert.match(legal.en, /financed by LPPSA/);
  // the buyer pays the legal fee in cash instead
  const cash = assess({ ...LPPSA_A, mrtt_premium: 12000, finance_legal_fees: "no" });
  assert.equal(cash.package.legal, 0);
  assert.equal(cash.package.total, 462000);
  assert.ok(cash.upfront.items.find((i) => i.key === "legal_loan").amount > 0);
  // no premium entered yet: said plainly, never guessed
  assert.ok(assess(LPPSA_A).notes.some((n) => /MRTT \/ MRTA premium not included yet/.test(n)));
  assert.ok(!r.notes.some((n) => /MRTT/.test(n)));
});

test("missing information: insufficient, no numbers, the next 1–2 questions in order", () => {
  const r = assess({ route: "lppsa", property_price: 400000, basic_salary: 3000 });
  assert.equal(r.outcome, "insufficient_information");
  assert.equal(r.max_financing, undefined);
  assert.deepEqual(r.next_questions.map((q) => q.field), ["age", "fixed_allowances"]);
  assert.match(r.next_questions[0].ms, /umur/);
  const n = assess({});
  assert.deepEqual(n.missing, ["route"]);
  assert.equal(n.outcome_label.ms, "Maklumat belum mencukupi");
  const noPrice = assess({ ...LPPSA_A, property_price: null });
  assert.equal(noPrice.outcome, "insufficient_information");
  assert.ok(noPrice.missing.includes("property_price"));
  assert.equal(noPrice.max_financing, 609000, "max financing from income is still given");
});

const BANK_A = { route: "bank", age: 35, basic_salary: 6000, fixed_allowances: 0, mandatory_deductions: 900, commitments_monthly: 1000, credit_card_balance: 5000, property_price: 500000 };

test("bank: DSR scenarios, credit card 5%, margin 90%", () => {
  const r = assess(BANK_A);
  assert.equal(r.illustrative, true);
  assert.deepEqual(r.income, { recognised: 6000, net: 5100, commitments: 1250 });
  assert.equal(r.financing_needed, 450000);
  assert.equal(r.instalment_for_needed, 2047);
  assert.equal(r.dsr_pct_for_needed, 64.6);
  assert.deepEqual(r.scenarios.map((s) => [s.dsr_pct, s.max_instalment, s.max_loan, s.pass]), [[60, 1810, 397000, false], [70, 2320, 450000, true], [80, 2830, 450000, true]]);
  assert.equal(r.max_by_income, 397000);
  assert.equal(r.outcome, "may_be_affordable_with_adjustments");
});

test("bank: 3rd housing loan 70% margin, age-70 tenure, extra down payment", () => {
  const r = assess({ route: "bank", age: 50, basic_salary: 10000, fixed_allowances: 0, mandatory_deductions: 1500, commitments_monthly: 2000, credit_card_balance: 0, property_count: 3, property_price: 600000, requested_amount: 540000 });
  assert.equal(r.margin_pct, 70);
  assert.equal(r.tenure_years, 20);
  assert.equal(r.max_loan_by_margin, 420000);
  assert.equal(r.financing_needed, 420000);
  assert.equal(r.extra_down_payment, 120000);
  assert.equal(r.instalment_for_needed, 2590);
  assert.equal(r.dsr_pct_for_needed, 54);
  assert.equal(r.outcome, "may_be_affordable_with_adjustments", "affordable, but only with the bigger down payment");
});

test("bank: variable and self-employed income counted in part; joint applicant; escalation", () => {
  const r = assess({ route: "bank", age: 40, basic_salary: 0, self_employed_income: 10000, variable_income: 2000, mandatory_deductions: 1000, commitments_monthly: 500, credit_card_balance: 0, co_income: 4000, co_age: 45, property_price: 800000 });
  assert.equal(r.income.recognised, 0 + 6000 + 1000 + 4000);   // 60% of 10k, 50% of 2k, joint 4k
  assert.equal(r.tenure_years, 25, "older applicant (45) to age 70");
  assert.ok(r.escalate.includes("joint_application") && r.escalate.includes("self_employed_income"));
  assert.equal(assess({ ...BANK_A, mandatory_deductions: 7000 }).outcome, "potentially_challenging", "no net income left");
});

test("owner-edited assumptions override the defaults", () => {
  const rules = financingRules({ bank: { rate_pct: 3.9, scenarios: [{ key: "x", label: "X", dsr_pct: 50 }] }, lppsa: { max_financing: 750000, verified: true, verified_on: "2026-11-01" } });
  assert.equal(rules.bank.margin_pct_first, 90, "unset fields keep the default");
  const b = assessBank(BANK_A, rules);
  assert.equal(b.scenarios.length, 1);
  assert.equal(b.instalment_for_needed, 1966);   // 450,000 at 3.9% over 35 years = 1,965.58
  const l = assessLppsa({ ...LPPSA_A, property_price: 900000 }, rules);
  assert.equal(l.rules_verified, true);
  assert.match(l.assumptions[0], /verified 2026-11-01/);
  assert.ok(l.max_financing <= 750000);
});

test("figures for the reply checker, examples, recommendations, advisor summary", () => {
  const r = assess(BANK_A);
  const nums = resultAmounts(r);
  for (const n of [450000, 2047, 397000, 1810, 74075]) assert.ok(nums.includes(n), n);
  assert.ok(!nums.includes(60) && !nums.includes(4.2), "percentages and rates are not RM figures");
  assert.deepEqual(priceExamples(500000), { price: 500000, loan: 450000, margin_pct: 90, rate_pct: 4.2, tenure_years: 35, monthly: 2047 });
  const projects = [
    { id: "a", name: "A", prices: [{ price_myr: 465000, fresh: true }], freshUnitPrices: [], websitePrices: [450000], layouts: [{ bedrooms: "3" }] },
    { id: "b", name: "B", prices: [], freshUnitPrices: [], websitePrices: [380000], layouts: [{ bedrooms: "2" }] },
    { id: "c", name: "C", prices: [], freshUnitPrices: [], websitePrices: [900000], layouts: [] },
  ];
  assert.deepEqual(recommendProjects(projects, { max_price: 440000 }).map((x) => [x.id, x.fit, x.price_label]), [["b", "within_budget", "INDICATIVE"], ["a", "slightly_above", "VERIFIED"]]);
  assert.deepEqual(recommendProjects(projects, { max_price: 500000, bedrooms: "3 bilik" }).map((x) => x.id), ["a"]);
  assert.deepEqual(recommendProjects(projects, {}), []);
  assert.match(advisorSummary(r, BANK_A), /May be affordable with adjustments[\s\S]*RM397,000[\s\S]*not an approval/);
});

test("AI field merging: 0/\"\" = not mentioned, -1 = none; inputs from outside are cleaned", () => {
  const m = mergeFinancing({ age: 30 }, { route: "lppsa", age: 0, basic_salary: 4000, commitments_monthly: -1, confirmed_service: "", second_financing: "no", property_price: 0 });
  assert.deepEqual(m.inputs, { age: 30, route: "lppsa", basic_salary: 4000, commitments_monthly: 0, second_financing: false });
  assert.deepEqual(m.changed, ["route", "basic_salary", "commitments_monthly", "second_financing"]);
  assert.deepEqual(mergeFinancing(m.inputs, { basic_salary: 4000 }).changed, []);
  assert.deepEqual(cleanInputs({ route: "cash", age: "30", basic_salary: 5000, evil: 1, commitments_monthly: -3, confirmed_service: "yes" }), { basic_salary: 5000, confirmed_service: "yes" });
  const r = assess(LPPSA_A);
  assert.equal(isNewAssessment(r, null), true);
  assert.equal(isNewAssessment(r, r), false);
  assert.equal(isNewAssessment(assess({ route: "lppsa" }), null), false);
});

test("reply checker: with the engine on, only engine figures pass (no free-form instalment estimates)", () => {
  const reply = "Anggaran ansuran RM2,500 sebulan, kadar 4.2%, tempoh 35 tahun — anggaran awal, bukan kelulusan.";
  assert.equal(validateReply(reply, {}).ok, true, "engine off: the old estimate allowance still applies");
  const v = validateReply(reply, { strictAmounts: true, allowedAmounts: [2047] });
  assert.equal(v.violations[0].code, "uncalculated_amount");
  assert.equal(validateReply(reply.replace("RM2,500", "RM2,047"), { strictAmounts: true, allowedAmounts: [2047] }).ok, true);
});
