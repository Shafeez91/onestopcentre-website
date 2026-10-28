// Property loan eligibility & affordability engine — deterministic arithmetic, no AI. Shared by the dashboard
// (lead page calculator) and the server (WhatsApp AI). Every result is a preliminary estimate, never an approval:
// LPPSA and the banks decide on their own full assessment.
//
// Inputs are flat and nullable (null = not known yet). Monthly figures are in RM.
//   route                 "lppsa" | "bank"
//   age                   years
//   basic_salary          monthly basic pay (gross)
//   fixed_allowances      monthly fixed allowances (LPPSA: e.g. COLA/ITKA/housing; bank: fixed allowances on the payslip)
//   variable_income       monthly average overtime / commission / bonus (bank only, recognised in part)
//   self_employed_income  monthly average business income (bank only, recognised in part)
//   mandatory_deductions  monthly statutory deductions: income tax (PCB), EPF/KWSP, SOCSO/PERKESO, EIS
//   commitments_monthly   monthly instalments on existing loans/financing (car, personal, housing, PTPTN, koperasi …)
//   credit_card_balance   total outstanding credit-card balance (bank: counted at a % per month)
//   confirmed_service     LPPSA: "yes" if permanent and confirmed in service, "no" otherwise
//   service_years         LPPSA: years in service
//   second_financing      LPPSA: true if this is the applicant's second LPPSA financing
//   property_price, valuation, requested_amount, down_payment
//   property_count        bank: how many housing loans including this one (1, 2, 3+)
//   co_age, co_income, co_mandatory_deductions, co_commitments_monthly   bank joint applicant (fixed monthly income)

export const ENGINE_VERSION = "1.0";

export const DEFAULT_FINANCING = {
  lppsa: {
    rules_version: "LPPSA-2026-10-draft",
    verified: false,
    verified_on: "",
    source: "Secondary sources (loanstreet.com.my, fareezlaw.com, rumahhq.com, ecentral.my, freemalaysiatoday.com); official LPPSA FAQ myfinancing.lppsa.gov.my not yet checked",
    repayment_pct_first: 60,     // instalment ≤ 60% of (basic + fixed allowances)
    repayment_pct_second: 50,    // ≤ 50% for a second financing
    dsr_pct: 80,                 // all deductions incl. the new instalment ≤ 80% of net income
    min_net_pct: 20,             // pay left after all deductions ≥ 20% of (basic + fixed allowances)
    rate_tiers: [{ up_to: 750000, rate_pct: 4 }, { up_to: null, rate_pct: 4.5 }],
    max_financing: 1000000,
    margin_pct: 100,
    max_tenure_years: 35,
    max_age: 90,
    min_service_years: 1,
  },
  bank: {
    label: "Illustrative bank assumptions — not any bank's offer or policy",
    rate_pct: 4.2,
    max_tenure_years: 35,
    max_age: 70,
    margin_pct_first: 90,        // 1st and 2nd housing loan
    margin_pct_third: 70,        // 3rd housing loan onwards (BNM)
    variable_income_pct: 50,     // share of overtime / commission counted
    self_employed_income_pct: 60,
    credit_card_pct: 5,          // % of the outstanding card balance counted as a monthly commitment
    scenarios: [
      { key: "conservative", label: "Conservative", dsr_pct: 60 },
      { key: "moderate", label: "Moderate", dsr_pct: 70 },
      { key: "flexible", label: "Flexible", dsr_pct: 80 },
    ],
  },
  costs: {
    mot_tiers: [{ up_to: 100000, pct: 1 }, { up_to: 500000, pct: 2 }, { up_to: 1000000, pct: 3 }, { up_to: null, pct: 4 }],
    loan_stamp_pct: 0.5,
    legal_tiers: [{ up_to: 500000, pct: 1.25 }, { up_to: 7500000, pct: 1 }],
    legal_min: 500,
    legal_sst_pct: 8,
  },
  outcome: { adjust_band_pct: 20 },
};

/** Defaults overlaid with the owner's saved settings (ai_settings.financing). Arrays are replaced, not merged. */
export function financingRules(saved = {}) {
  const out = structuredClone(DEFAULT_FINANCING);
  for (const k of Object.keys(out)) {
    const s = saved && typeof saved[k] === "object" && saved[k] ? saved[k] : {};
    for (const [f, v] of Object.entries(s)) if (v !== null && v !== undefined && v !== "") out[k][f] = v;
  }
  return out;
}

export const OUTCOMES = {
  potentially_affordable: { en: "Potentially affordable", ms: "Berpotensi mampu milik" },
  may_be_affordable_with_adjustments: { en: "May be affordable with adjustments", ms: "Mungkin mampu milik dengan pelarasan" },
  potentially_challenging: { en: "Potentially challenging", ms: "Berpotensi mencabar" },
  insufficient_information: { en: "Insufficient information", ms: "Maklumat belum mencukupi" },
};

export const DISCLAIMER = {
  en: "Preliminary estimate only, based on the information given and the assumptions shown. It is not a loan or financing approval or offer; the final decision is made by LPPSA or the bank.",
  ms: "Anggaran awal sahaja, berdasarkan maklumat yang diberi dan andaian yang dinyatakan. Ini bukan kelulusan atau tawaran pinjaman/pembiayaan; keputusan muktamad dibuat oleh LPPSA atau pihak bank.",
};

// the order the AI asks for missing information (1–2 at a time), with the question it can use
export const FIELDS = {
  route: { en: "LPPSA (government servant) or bank loan?", ms: "Guna LPPSA (penjawat awam) atau pinjaman bank?" },
  property_price: { en: "price of the property you are considering", ms: "harga rumah yang Tuan/Puan minat" },
  age: { en: "your age", ms: "umur Tuan/Puan" },
  confirmed_service: { en: "are you permanent and confirmed in service?", ms: "Tuan/Puan sudah tetap dan disahkan dalam perkhidmatan?" },
  service_years: { en: "years in service", ms: "berapa tahun dalam perkhidmatan" },
  basic_salary: { en: "monthly basic salary", ms: "gaji pokok sebulan" },
  fixed_allowances: { en: "total fixed monthly allowances", ms: "jumlah elaun tetap sebulan" },
  self_employed_income: { en: "average monthly business income", ms: "purata pendapatan perniagaan sebulan" },
  mandatory_deductions: { en: "monthly statutory deductions (tax, EPF, SOCSO)", ms: "potongan wajib sebulan (cukai, KWSP, PERKESO)" },
  commitments_monthly: { en: "total monthly loan instalments now (car, personal, PTPTN …); 0 if none", ms: "jumlah ansuran hutang bulanan sekarang (kereta, peribadi, PTPTN …); 0 jika tiada" },
  credit_card_balance: { en: "total credit card balance; 0 if none", ms: "jumlah baki kad kredit; 0 jika tiada" },
};

const RANK = ["potentially_affordable", "may_be_affordable_with_adjustments", "potentially_challenging"];
const known = (v) => v !== null && v !== undefined && v !== "" && !(typeof v === "number" && !isFinite(v));
const n0 = (v) => (known(v) ? Number(v) : 0);
const pos = (v) => (known(v) && Number(v) > 0 ? Number(v) : null);
const floorTo = (x, step) => Math.floor(x / step) * step;
const round = (x) => Math.round(x);

/* ---------- formulas ---------- */

/** Monthly instalment on reducing balance: P·r·(1+r)^n / ((1+r)^n − 1), r = annual % / 12 / 100. Zero rate: P / n. */
export function instalment(principal, ratePct, months) {
  const P = Number(principal), n = Number(months), rate = Number(ratePct);
  if (!(P >= 0) || !(n > 0) || !Number.isInteger(n) || !(rate >= 0)) throw new RangeError("instalment: principal ≥ 0, whole months > 0 and rate ≥ 0 are required");
  if (P === 0) return 0;
  const r = rate / 1200;
  if (r === 0) return P / n;
  const f = (1 + r) ** n;
  return (P * r * f) / (f - 1);
}

/** The loan a monthly payment can carry (inverse of instalment). */
export function principalFor(payment, ratePct, months) {
  const A = Number(payment), n = Number(months), rate = Number(ratePct);
  if (!(n > 0) || !Number.isInteger(n) || !(rate >= 0)) throw new RangeError("principalFor: whole months > 0 and rate ≥ 0 are required");
  if (!(A > 0)) return 0;
  const r = rate / 1200;
  if (r === 0) return A * n;
  const f = (1 + r) ** n;
  return (A * (f - 1)) / (r * f);
}

/** Tiered rates (e.g. LPPSA 4% up to RM750k, 4.5% on the rest): each band is repaid as its own reducing balance over the same term. */
export function tieredInstalment(principal, tiers, months) {
  let left = Number(principal), prev = 0, total = 0;
  for (const t of tiers) {
    if (left <= 0) break;
    const cap = t.up_to === null || t.up_to === undefined ? Infinity : t.up_to - prev;
    const part = Math.min(left, cap);
    total += instalment(part, t.rate_pct, months);
    left -= part; prev = t.up_to ?? prev;
  }
  return total;
}
export function tieredPrincipalFor(payment, tiers, months) {
  let left = Number(payment), prev = 0, total = 0;
  for (const t of tiers) {
    if (!(left > 0)) break;
    const cap = t.up_to === null || t.up_to === undefined ? Infinity : t.up_to - prev;
    const full = cap === Infinity ? Infinity : instalment(cap, t.rate_pct, months);
    if (left >= full) { total += cap; left -= full; } else { total += principalFor(left, t.rate_pct, months); left = 0; }
    prev = t.up_to ?? prev;
  }
  return total;
}
/** Single rate that gives the same instalment as the tiers for this amount (for display). */
export function effectiveRate(principal, tiers, months) {
  const target = tieredInstalment(principal, tiers, months);
  let lo = 0, hi = 30;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (instalment(principal, mid, months) < target) lo = mid; else hi = mid; }
  return Math.round(((lo + hi) / 2) * 1000) / 1000;
}

/** Whole years left before the maximum age, capped at the maximum tenure. null if the age is unknown. */
export function tenureYears(age, maxYears, maxAge) {
  if (!known(age)) return null;
  return Math.max(0, Math.min(maxYears, Math.floor(maxAge - Number(age))));
}

const banded = (amount, tiers) => {
  let prev = 0, total = 0;
  for (const t of tiers) {
    const top = t.up_to === null || t.up_to === undefined ? Infinity : t.up_to;
    if (amount > prev) total += (Math.min(amount, top) - prev) * t.pct / 100;
    prev = top;
  }
  return total;
};

/** Upfront costs estimate: down payment, stamp duty (transfer + loan) and legal fees (SRO 2023 scale + SST). */
export function upfrontCosts(price, loan, costs = DEFAULT_FINANCING.costs) {
  const P = pos(price);
  if (!P) return null;
  const L = Math.min(P, Math.max(0, n0(loan)));
  const legal = (x) => (x > 0 ? Math.max(costs.legal_min, banded(x, costs.legal_tiers)) * (1 + costs.legal_sst_pct / 100) : 0);
  const items = [
    { key: "down_payment", en: "Down payment", ms: "Bayaran muka", amount: round(P - L) },
    { key: "mot_stamp_duty", en: "Stamp duty on the transfer (MOT)", ms: "Duti setem pindah milik (MOT)", amount: round(banded(P, costs.mot_tiers)) },
    { key: "loan_stamp_duty", en: "Stamp duty on the loan agreement", ms: "Duti setem perjanjian pinjaman", amount: round(L * costs.loan_stamp_pct / 100) },
    { key: "legal_spa", en: "Legal fee, sale & purchase agreement (incl. SST)", ms: "Yuran guaman SPA (termasuk SST)", amount: round(legal(P)) },
    { key: "legal_loan", en: "Legal fee, loan agreement (incl. SST)", ms: "Yuran guaman perjanjian pinjaman (termasuk SST)", amount: round(legal(L)) },
  ];
  return {
    items, total: items.reduce((s, i) => s + i.amount, 0),
    notes: [
      "Estimates only; disbursements, valuation, MRTA/MLTA and developer packages are not included.",
      "First-home stamp duty exemptions may apply (e.g. for homes up to RM500,000) — an advisor will confirm. New projects may absorb legal fees.",
    ],
  };
}

/* ---------- assessments ---------- */

function outcomeFor({ missing, blocked, needed, maxLoan, bandPct }) {
  if (missing.length) return "insufficient_information";
  if (blocked) return "potentially_challenging";
  if (!known(needed)) return "insufficient_information";
  if (needed <= maxLoan) return "potentially_affordable";
  if (needed <= maxLoan * (1 + bandPct / 100)) return "may_be_affordable_with_adjustments";
  return "potentially_challenging";
}

/** LPPSA preliminary check: three salary tests, tenure, financing limit. */
export function assessLppsa(input = {}, rules = DEFAULT_FINANCING) {
  const R = rules.lppsa, band = rules.outcome?.adjust_band_pct ?? 20;
  const missing = ["age", "basic_salary", "fixed_allowances", "mandatory_deductions", "commitments_monthly"].filter((k) => !known(input[k]));
  const notes = [], escalate = [];
  if (input.confirmed_service === "no") { notes.push("LPPSA is for permanent, confirmed public servants; the applicant said they are not yet confirmed."); escalate.push("not_confirmed_in_service"); }
  else if (!known(input.confirmed_service)) missing.push("confirmed_service");
  if (known(input.service_years) && Number(input.service_years) < R.min_service_years) { notes.push(`Less than ${R.min_service_years} year(s) in service.`); escalate.push("short_service"); }
  if (input.second_financing) escalate.push("second_lppsa_financing");
  const price = pos(input.property_price), valuation = pos(input.valuation);
  const base = {
    route: "lppsa", engine_version: ENGINE_VERSION, rules_version: R.rules_version, rules_verified: !!R.verified, rules_verified_on: R.verified_on || null,
    missing, notes, escalate,
  };
  if (missing.some((k) => k !== "confirmed_service")) return finalize({ ...base, outcome: "insufficient_information" }, input, rules);

  const gross = n0(input.basic_salary) + n0(input.fixed_allowances);
  const net = gross - n0(input.mandatory_deductions);
  const commit = n0(input.commitments_monthly);
  const repayPct = input.second_financing ? R.repayment_pct_second : R.repayment_pct_first;
  const tests = [
    { key: "repayment_limit", en: `Instalment ≤ ${repayPct}% of basic + fixed allowances`, ms: `Ansuran ≤ ${repayPct}% gaji pokok + elaun tetap`, limit: (repayPct / 100) * gross },
    { key: "total_deductions", en: `All deductions ≤ ${R.dsr_pct}% of net income`, ms: `Jumlah potongan ≤ ${R.dsr_pct}% pendapatan bersih`, limit: (R.dsr_pct / 100) * net - commit },
    { key: "net_pay_left", en: `Pay left ≥ ${R.min_net_pct}% of basic + fixed allowances`, ms: `Baki gaji ≥ ${R.min_net_pct}% gaji pokok + elaun tetap`, limit: net - commit - (R.min_net_pct / 100) * gross },
  ];
  const years = tenureYears(input.age, R.max_tenure_years, R.max_age), months = years * 12;
  const maxInst = Math.max(0, Math.min(...tests.map((t) => t.limit)));
  const binding = tests.reduce((a, b) => (b.limit < a.limit ? b : a)).key;
  const byIncome = months > 0 ? tieredPrincipalFor(maxInst, R.rate_tiers, months) : 0;
  const propertyLimit = price ? Math.min(price, valuation || price) * R.margin_pct / 100 : null;
  const otherLimit = Math.min(R.max_financing, propertyLimit ?? Infinity);
  const maxLoan = Math.min(byIncome, otherLimit);
  const limitedBy = byIncome <= otherLimit ? "income" : R.max_financing <= (propertyLimit ?? Infinity) ? "lppsa_cap" : "property_value";
  const needed = pos(input.requested_amount) ?? (price ? Math.max(0, price - n0(input.down_payment)) : null);
  const financeable = needed ? Math.min(needed, otherLimit) : null; // what LPPSA could finance at most, before income
  const topUp = needed ? needed - financeable : 0;
  if (months <= 0) { notes.push("No tenure is left before the maximum age."); escalate.push("no_tenure"); }
  if (topUp > 0) notes.push(`About RM${round(topUp).toLocaleString("en-MY")} is above the LPPSA limit (maximum RM${R.max_financing.toLocaleString("en-MY")}, ${R.margin_pct}% of price/value) and would be paid by the buyer.`);
  if (!known(input.confirmed_service)) notes.push("Assumes the applicant is permanent and confirmed in service.");

  const instNeeded = financeable && months > 0 ? tieredInstalment(financeable, R.rate_tiers, months) : null;
  const res = {
    ...base,
    income: { gross_fixed: round(gross), net: round(net), commitments: round(commit) },
    tests: tests.map((t) => ({ key: t.key, en: t.en, ms: t.ms, max_instalment: round(Math.max(0, t.limit)), pass: instNeeded === null ? null : instNeeded <= t.limit + 0.5 })),
    binding_test: binding,
    tenure_years: years,
    rate: { tiers: R.rate_tiers, effective_pct: financeable && months > 0 ? effectiveRate(financeable, R.rate_tiers, months) : null },
    max_instalment: round(maxInst),
    max_financing: floorTo(maxLoan, 1000),
    max_by_income: floorTo(Math.min(byIncome, R.max_financing), 1000), // ignoring this property's price/value
    limited_by: limitedBy,
    financing_needed: needed ? round(needed) : null,
    financeable: financeable ? round(financeable) : null,
    instalment_for_needed: instNeeded ? round(instNeeded) : null,
    shortfall: financeable && financeable > byIncome ? round(financeable - byIncome) : 0,
    buyer_top_up: round(topUp),
  };
  res.outcome = outcomeFor({ missing, blocked: input.confirmed_service === "no" || months <= 0 || maxInst <= 0, needed: financeable, maxLoan: byIncome, bandPct: band });
  if (res.outcome === "potentially_affordable" && topUp > 0) res.outcome = "may_be_affordable_with_adjustments";
  if (res.outcome === "potentially_challenging") escalate.push("challenging_outcome");
  return finalize(res, input, rules);
}

/** Bank DSR check across the configured scenarios (illustrative). */
export function assessBank(input = {}, rules = DEFAULT_FINANCING) {
  const B = rules.bank, band = rules.outcome?.adjust_band_pct ?? 20;
  const hasIncome = known(input.basic_salary) || known(input.self_employed_income);
  const missing = [...(hasIncome ? [] : ["basic_salary"]), ...["age", "mandatory_deductions", "commitments_monthly"].filter((k) => !known(input[k]))];
  if (!known(input.credit_card_balance)) missing.push("credit_card_balance");
  const notes = [], escalate = [];
  const joint = pos(input.co_income) !== null;
  if (joint) escalate.push("joint_application");
  if (pos(input.self_employed_income)) escalate.push("self_employed_income");
  const price = pos(input.property_price), valuation = pos(input.valuation);
  const base = { route: "bank", engine_version: ENGINE_VERSION, rules_version: "bank-" + B.rate_pct + "%-" + B.scenarios.map((s) => s.dsr_pct).join("/"), illustrative: true, label: B.label, missing, notes, escalate };
  if (missing.length) return finalize({ ...base, outcome: "insufficient_information" }, input, rules);

  const recognised = n0(input.basic_salary) + n0(input.fixed_allowances) + n0(input.variable_income) * B.variable_income_pct / 100
    + n0(input.self_employed_income) * B.self_employed_income_pct / 100 + n0(input.co_income);
  const net = recognised - n0(input.mandatory_deductions) - n0(input.co_mandatory_deductions);
  const commit = n0(input.commitments_monthly) + n0(input.credit_card_balance) * B.credit_card_pct / 100 + n0(input.co_commitments_monthly);
  const ages = [input.age, joint ? input.co_age : null].filter(known).map(Number);
  const years = tenureYears(Math.max(...ages), B.max_tenure_years, B.max_age), months = years * 12;
  if (joint && !known(input.co_age)) notes.push("Joint applicant's age not given; tenure uses the main applicant's age.");
  const marginPct = Number(input.property_count) >= 3 ? B.margin_pct_third : B.margin_pct_first;
  const propertyLimit = price ? Math.min(price, valuation || price) * marginPct / 100 : null;
  const asked = pos(input.requested_amount) ?? (price ? (known(input.down_payment) ? Math.max(0, price - n0(input.down_payment)) : propertyLimit) : null);
  const needed = asked !== null && propertyLimit !== null ? Math.min(asked, propertyLimit) : asked;
  const extraDown = asked !== null && propertyLimit !== null && asked > propertyLimit ? round(asked - propertyLimit) : 0;
  if (extraDown) notes.push(`A ${marginPct}% margin of finance means about RM${extraDown.toLocaleString("en-MY")} more down payment than planned.`);
  if (months <= 0) { notes.push("No tenure is left before the maximum age."); escalate.push("no_tenure"); }

  const scenarios = B.scenarios.map((s) => {
    const rate = known(s.rate_pct) ? Number(s.rate_pct) : B.rate_pct;
    const maxInst = Math.max(0, (s.dsr_pct / 100) * net - commit);
    const byIncome = months > 0 ? principalFor(maxInst, rate, months) : 0;
    const maxLoan = Math.min(byIncome, propertyLimit ?? Infinity);
    const inst = needed && months > 0 ? instalment(needed, rate, months) : null;
    return { key: s.key, label: s.label, dsr_pct: s.dsr_pct, rate_pct: rate, max_instalment: round(maxInst), max_loan: floorTo(maxLoan, 1000), instalment_for_needed: inst ? round(inst) : null, pass: needed ? needed <= maxLoan : null, _max: maxLoan };
  });
  const inst = needed && months > 0 ? instalment(needed, B.rate_pct, months) : null;
  const dsr = inst !== null && net > 0 ? ((commit + inst) / net) * 100 : null;
  const strict = scenarios.reduce((a, b) => (b.dsr_pct < a.dsr_pct ? b : a));
  const loose = scenarios.reduce((a, b) => (b.dsr_pct > a.dsr_pct ? b : a));
  let outcome;
  if (net <= 0 || months <= 0) outcome = "potentially_challenging";
  else if (!needed) outcome = "insufficient_information";
  else if (strict.pass && !extraDown) outcome = "potentially_affordable";
  else if (loose.pass || needed <= strict._max * (1 + band / 100)) outcome = "may_be_affordable_with_adjustments";
  else outcome = "potentially_challenging";
  if (outcome === "potentially_affordable" && extraDown) outcome = "may_be_affordable_with_adjustments";
  if (outcome === "potentially_challenging") escalate.push("challenging_outcome");
  const res = {
    ...base, outcome,
    income: { recognised: round(recognised), net: round(net), commitments: round(commit) },
    tenure_years: years, rate_pct: B.rate_pct, margin_pct: marginPct,
    max_loan_by_margin: propertyLimit ? floorTo(propertyLimit, 1000) : null,
    financing_needed: needed ? round(needed) : null, extra_down_payment: extraDown,
    instalment_for_needed: inst ? round(inst) : null, dsr_pct_for_needed: dsr !== null ? Math.round(dsr * 10) / 10 : null,
    scenarios: scenarios.map(({ _max, ...s }) => s),
    max_financing: floorTo(Math.min(strict._max, propertyLimit ?? Infinity), 1000),
    max_by_income: floorTo(months > 0 ? principalFor(Math.max(0, (strict.dsr_pct / 100) * net - commit), strict.rate_pct, months) : 0, 1000),
  };
  return finalize(res, input, rules);
}

/** Runs the route's assessment. Unknown route → insufficient information, asking which route. */
export function assess(input = {}, rules = DEFAULT_FINANCING) {
  if (input.route === "lppsa") return assessLppsa(input, rules);
  if (input.route === "bank") return assessBank(input, rules);
  return finalize({ route: null, engine_version: ENGINE_VERSION, outcome: "insufficient_information", missing: ["route"], notes: [], escalate: [] }, input, rules);
}

function finalize(res, input, rules) {
  const price = pos(input.property_price);
  if (!price && res.route && !res.missing.includes("property_price")) res.missing.push("property_price");
  res.outcome_label = OUTCOMES[res.outcome];
  const loan = res.route === "lppsa" ? Math.min(res.financeable || 0, res.max_financing || 0) : res.financing_needed;
  res.upfront = price && res.outcome !== "insufficient_information" ? upfrontCosts(price, loan, rules.costs) : null;
  res.assumptions = assumptions(res, rules);
  res.disclaimer = DISCLAIMER;
  res.next_questions = res.missing.filter((k) => FIELDS[k]).slice(0, 2).map((k) => ({ field: k, ...FIELDS[k] }));
  res.escalate = [...new Set(res.escalate)];
  return res;
}

function assumptions(res, rules) {
  if (res.route === "lppsa") {
    const R = rules.lppsa;
    return [
      `LPPSA rules ${R.rules_version}${R.verified ? ` (verified ${R.verified_on})` : " (not yet verified against the official LPPSA source)"}.`,
      `Profit ${R.rate_tiers.map((t) => `${t.rate_pct}%${t.up_to ? ` up to RM${t.up_to.toLocaleString("en-MY")}` : " above"}`).join(", ")}, reducing balance, monthly.`,
      `Tenure up to ${R.max_tenure_years} years or age ${R.max_age}, whichever is earlier; financing up to RM${R.max_financing.toLocaleString("en-MY")}.`,
      "Income and deductions as stated by the buyer, not checked against a payslip.",
    ];
  }
  if (res.route === "bank") {
    const B = rules.bank;
    return [
      `${B.label}.`,
      `Interest ${B.rate_pct}% a year, reducing balance, monthly; tenure up to ${B.max_tenure_years} years or age ${B.max_age}.`,
      `Margin of finance ${B.margin_pct_first}% (${B.margin_pct_third}% from the 3rd housing loan); DSR on net income at ${B.scenarios.map((s) => s.dsr_pct + "%").join(" / ")}.`,
      `Counted: ${B.variable_income_pct}% of variable income, ${B.self_employed_income_pct}% of self-employed income, ${B.credit_card_pct}% of credit-card balance a month.`,
      "Income and commitments as stated by the buyer; CCRIS/CTOS and bank policies are not checked.",
    ];
  }
  return [];
}

/** Every RM figure in a result, so the reply checker can allow exactly these and nothing else. */
export function resultAmounts(res) {
  const out = [];
  const walk = (v, k = "") => {
    if (typeof v === "number" && isFinite(v) && v > 0 && !/pct|years|version|rate|up_to/.test(k)) out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, k));
    else if (v && typeof v === "object") for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
  };
  walk({ ...res, assumptions: undefined, disclaimer: undefined, next_questions: undefined, rate: undefined });
  return [...new Set(out)];
}

/** Illustrative instalments for a property price at the bank assumptions (no income needed). */
export function priceExamples(price, rules = DEFAULT_FINANCING) {
  const P = pos(price);
  if (!P) return null;
  const B = rules.bank, loan = round(P * B.margin_pct_first / 100);
  return { price: P, loan, margin_pct: B.margin_pct_first, rate_pct: B.rate_pct, tenure_years: B.max_tenure_years, monthly: round(instalment(loan, B.rate_pct, B.max_tenure_years * 12)) };
}

/**
 * Monthly figures for one price the way the website's loan calculator shows them (its own financing %, rate and
 * years, set in the website admin), plus the LPPSA equivalent from the LPPSA rules. Illustrations, not offers.
 * @param calc { margin_pct, rate_pct, tenure_years } — the website calculator settings
 */
export function instalmentIllustration(price, calc = {}, lppsa = null) {
  const P = pos(price);
  if (!P) return null;
  const m = pos(calc.margin_pct) || 90, r = known(calc.rate_pct) && Number(calc.rate_pct) >= 0 ? Number(calc.rate_pct) : 4.5, y = pos(calc.tenure_years) || 35;
  const loan = round(P * m / 100);
  const out = { price: P, bank: { financing_pct: m, rate_pct: r, tenure_years: y, loan, monthly: round(instalment(loan, r, y * 12)) } };
  if (lppsa?.rate_tiers?.length) {
    const ly = Math.min(y, pos(lppsa.max_tenure_years) || 35), ll = Math.min(round(P * (pos(lppsa.margin_pct) || 100) / 100), pos(lppsa.max_financing) || Infinity);
    out.lppsa = { financing_pct: pos(lppsa.margin_pct) || 100, tenure_years: ly, loan: ll, monthly: round(tieredInstalment(ll, lppsa.rate_tiers, ly * 12)),
      rates: lppsa.rate_tiers.map((t) => `${t.rate_pct}%${t.up_to ? ` up to RM${t.up_to.toLocaleString("en-MY")}` : " above"}`).join(", "), rules_verified: !!lppsa.verified };
  }
  return out;
}

/**
 * Projects that fit a budget, from the most reliable price on record: VERIFIED (fresh staff-checked price or unit)
 * before INDICATIVE (website listing). `projects` is the context shape (prices, freshUnitPrices, websitePrices, layouts).
 */
export function recommendProjects(projects = [], { max_price = null, bedrooms = null, limit = 3 } = {}) {
  const cap = pos(max_price);
  if (!cap) return [];
  const beds = known(bedrooms) ? String(bedrooms).match(/\d+/)?.[0] : null;
  const rows = [];
  for (const p of projects) {
    const verified = [...(p.prices || []).filter((x) => x.fresh).map((x) => Number(x.price_myr)), ...(p.freshUnitPrices || [])].filter((x) => x > 0);
    const website = (p.websitePrices || []).filter((x) => x > 0);
    const from = verified.length ? Math.min(...verified) : website.length ? Math.min(...website) : null;
    if (!from) continue;
    const bedMatch = beds ? (p.layouts || []).some((l) => String(l.bedrooms || "").match(/\d+/)?.[0] === beds) : null;
    if (beds && bedMatch === false && (p.layouts || []).length) continue;
    const fit = from <= cap ? "within_budget" : from <= cap * 1.1 ? "slightly_above" : null;
    if (!fit) continue;
    rows.push({ id: p.id, name: p.name, area: p.area, price_from: from, price_label: verified.length ? "VERIFIED" : "INDICATIVE", fit, bedrooms_match: bedMatch });
  }
  return rows.sort((a, b) => (a.fit === b.fit ? 0 : a.fit === "within_budget" ? -1 : 1) || (b.bedrooms_match === true) - (a.bedrooms_match === true) || b.price_from - a.price_from).slice(0, limit);
}

/** A plain-text summary for the advisor (CRM handover / notes). */
export function advisorSummary(res, input = {}) {
  const rm = (n) => (known(n) ? "RM" + Math.round(n).toLocaleString("en-MY") : "—");
  const lines = [`Financing check (${res.route ? res.route.toUpperCase() : "route unknown"}): ${res.outcome_label?.en || res.outcome}.`];
  if (input.property_price) lines.push(`Property ${rm(input.property_price)}; financing needed ${rm(res.financing_needed)}.`);
  if (res.max_financing !== undefined) lines.push(`Estimated max financing ${rm(res.max_financing)}; max instalment ${rm(res.max_instalment ?? res.scenarios?.[0]?.max_instalment)}; tenure ${res.tenure_years ?? "—"} yrs.`);
  if (res.instalment_for_needed) lines.push(`Instalment for the amount needed about ${rm(res.instalment_for_needed)}/month${res.dsr_pct_for_needed ? ` (DSR ${res.dsr_pct_for_needed}%)` : ""}.`);
  if (res.missing?.length) lines.push(`Still missing: ${res.missing.join(", ")}.`);
  if (res.notes?.length) lines.push(...res.notes);
  if (res.escalate?.length) lines.push(`Needs an advisor: ${res.escalate.join(", ")}.`);
  lines.push("Preliminary estimate from stated figures — not an approval.");
  return lines.join("\n");
}
