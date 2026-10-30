// Financing documents (payslip, CCRIS report, bank statement): what staff may upload, how the figures the AI read
// are cleaned, and how they map onto the loan calculator's inputs (finance.mjs). Shared by the dashboard and the
// server. The AI only suggests figures: a staff member checks them and fills the calculator; nothing is calculated
// for the buyer from a document until then.

export const DOC_KINDS = {
  payslip: { en: "Payslip", hint: "latest month; 3 months is better for variable pay" },
  ccris: { en: "CCRIS report", hint: "from BNM eCCRIS, shows existing loans and card balances" },
  bank_statement: { en: "Bank statement", hint: "salary account, 3–6 months" },
};
export const DOC_MIME = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
// a Netlify function request is at most 6 MB and the file travels base64-encoded (+33%)
export const DOC_MAX_BYTES = 4 * 1024 * 1024;
export const DOC_RETENTION_DAYS = 30;

// IC numbers (YYMMDD-PB-####, with or without dashes) and long account / card numbers are masked in everything the
// AI returns, even though it is told never to copy them
const IC = /\b\d{6}[- ]?\d{2}[- ]?\d{4}\b/g;
const LONG_NUMBER = /\b\d(?:[ -]?\d){9,}\b/g;
export const maskNumbers = (s) => String(s ?? "").replace(IC, "[IC hidden]").replace(LONG_NUMBER, (m) => "••••" + m.replace(/\D/g, "").slice(-4));

const num = (v) => (typeof v === "number" && isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null);
const items = (a) => (Array.isArray(a) ? a : []).map((x) => ({ name: maskNumbers(x?.name).slice(0, 80), amount: num(x?.amount) })).filter((x) => x.name && x.amount !== null).slice(0, 30);
const text = (v, n = 120) => (typeof v === "string" && v.trim() ? maskNumbers(v.trim()).slice(0, n) : null);
const bool = (v) => (typeof v === "boolean" ? v : null);
const pick = (v, list) => (list.includes(v) ? v : null);

/** The AI's reading, cleaned: numbers checked, free text masked and shortened, unknown values dropped. */
export function cleanExtraction(x = {}) {
  const p = x.payslip || {}, c = x.ccris || {}, b = x.bank_statement || {};
  const birth = Number.isInteger(p.birth_year) && p.birth_year > 1930 && p.birth_year < 2015 ? p.birth_year : null;
  return {
    readable: x.readable === true,
    document_kind: pick(x.document_kind, ["payslip", "ccris", "bank_statement", "other"]) || "other",
    period: text(x.period, 40),
    confidence: pick(x.confidence, ["high", "medium", "low"]) || "low",
    payslip: {
      employer_sector: pick(p.employer_sector, ["government", "statutory_body", "private", "unknown"]) || "unknown",
      basic_salary: num(p.basic_salary),
      fixed_allowances: items(p.fixed_allowances),
      variable_income: items(p.variable_income),
      statutory_deductions: items(p.statutory_deductions),
      loan_deductions: items(p.loan_deductions),
      other_deductions: items(p.other_deductions),
      gross_pay: num(p.gross_pay),
      net_pay: num(p.net_pay),
      birth_year: birth,
      appointment_date: text(p.appointment_date, 20),
      service_status: pick(p.service_status, ["permanent_confirmed", "permanent_not_confirmed", "contract", "unknown"]) || "unknown",
    },
    ccris: {
      report_date: text(c.report_date, 20),
      facilities: (Array.isArray(c.facilities) ? c.facilities : []).map((f) => ({
        facility: text(f?.facility, 60) || "Facility", monthly_instalment: num(f?.monthly_instalment), outstanding: num(f?.outstanding),
        in_arrears: bool(f?.in_arrears), is_credit_card: f?.is_credit_card === true,
      })).slice(0, 30),
      special_attention: bool(c.special_attention),
    },
    bank_statement: {
      months_covered: Number.isInteger(b.months_covered) && b.months_covered > 0 ? Math.min(b.months_covered, 24) : null,
      average_salary_credit: num(b.average_salary_credit),
      regular_loan_payments: items(b.regular_loan_payments),
      average_month_end_balance: num(b.average_month_end_balance),
      returned_payments: bool(b.returned_payments),
    },
    warnings: (Array.isArray(x.warnings) ? x.warnings : []).map((w) => text(w, 200)).filter(Boolean).slice(0, 10),
  };
}

const sum = (list) => Math.round(list.reduce((t, i) => t + (i.amount || 0), 0) * 100) / 100;
const avg = (vals) => (vals.length ? Math.round((vals.reduce((t, v) => t + v, 0) / vals.length) * 100) / 100 : null);
const latest = (docs) => docs.slice().sort((a, b) => String(b.period || "").localeCompare(String(a.period || "")))[0];

/**
 * Calculator figures suggested from the documents read so far (each an extraction from cleanExtraction).
 * Returns { inputs, sources: { field: "where the figure came from" }, checks: ["what staff should look at"] }.
 * Never fills route, property price or down payment: those come from the buyer and the project.
 */
export function suggestInputs(docs = [], { year = new Date().getFullYear() } = {}) {
  const slips = docs.filter((d) => d?.readable && d.document_kind === "payslip");
  const ccris = docs.filter((d) => d?.readable && d.document_kind === "ccris");
  const stmts = docs.filter((d) => d?.readable && d.document_kind === "bank_statement");
  const inputs = {}, sources = {}, checks = [];
  const set = (k, v, src) => { if (v !== null && v !== undefined) { inputs[k] = v; sources[k] = src; } };

  if (slips.length) {
    const p = latest(slips).payslip, n = slips.length, from = n > 1 ? `${n} payslips` : "payslip";
    set("basic_salary", p.basic_salary, `payslip${latest(slips).period ? " " + latest(slips).period : ""}: basic pay`);
    set("fixed_allowances", sum(p.fixed_allowances), "payslip: fixed allowances (" + (p.fixed_allowances.map((i) => i.name).join(", ") || "none") + ")");
    set("mandatory_deductions", sum(p.statutory_deductions), "payslip: " + (p.statutory_deductions.map((i) => i.name).join(", ") || "no statutory deductions"));
    const variable = avg(slips.map((s) => sum(s.payslip.variable_income)));
    if (variable) set("variable_income", variable, `${from}: average overtime / commission`);
    if (p.birth_year) set("age", year - p.birth_year, "payslip: date of birth");
    if (p.employer_sector === "government" || p.employer_sector === "statutory_body") {
      checks.push("Government / statutory employer: LPPSA may apply. Choose the route with the buyer.");
      if (p.service_status === "permanent_confirmed") set("confirmed_service", "yes", "payslip: service status");
      else if (p.service_status === "permanent_not_confirmed" || p.service_status === "contract") set("confirmed_service", "no", "payslip: service status");
      const y = Number(String(p.appointment_date || "").match(/(19|20)\d{2}/)?.[0]);
      if (y && y <= year) set("service_years", year - y, "payslip: appointment date");
    }
    if (n === 1 && sum(p.variable_income) > 0) checks.push("Variable pay seen on one payslip only: banks usually average 3–6 months.");
  }

  const slipLoans = slips.length ? sum(latest(slips).payslip.loan_deductions) : 0;
  if (ccris.length) {
    const c = latest(ccris).ccris, loans = c.facilities.filter((f) => !f.is_credit_card), cards = c.facilities.filter((f) => f.is_credit_card);
    set("commitments_monthly", Math.round(loans.reduce((t, f) => t + (f.monthly_instalment || 0), 0) * 100) / 100, `CCRIS${c.report_date ? " " + c.report_date : ""}: ${loans.length} loan(s), monthly instalments`);
    if (cards.length) set("credit_card_balance", Math.round(cards.reduce((t, f) => t + (f.outstanding || 0), 0) * 100) / 100, "CCRIS: credit card balances");
    if (loans.some((f) => f.monthly_instalment === null)) checks.push("CCRIS: some facilities show no monthly instalment. Ask the buyer for it.");
    if (slipLoans > 0) checks.push(`Payslip loan deductions total RM${slipLoans}: check none is missing from CCRIS (koperasi and ANGKASA deductions often are).`);
    if (c.facilities.some((f) => f.in_arrears) || c.special_attention) checks.push("CCRIS shows arrears or a special attention account: an advisor must review before any estimate is shared.");
  } else if (slips.length) {
    set("commitments_monthly", slipLoans, "payslip: loan deductions (" + (latest(slips).payslip.loan_deductions.map((i) => i.name).join(", ") || "none") + ")");
    checks.push("No CCRIS report: loans paid outside the payslip (car, credit card, PTPTN) are not counted yet.");
  }

  if (stmts.length) {
    const s = latest(stmts).bank_statement;
    if (s.average_salary_credit && inputs.basic_salary && slips.length) {
      const net = latest(slips).payslip.net_pay;
      if (net && Math.abs(s.average_salary_credit - net) / net > 0.15) checks.push(`Bank statement salary credit (avg RM${s.average_salary_credit}) differs from the payslip net pay (RM${net}) by more than 15%.`);
    }
    if (!slips.length && s.average_salary_credit) checks.push(`Bank statement only: average salary credit RM${s.average_salary_credit} is net pay, not basic salary. Ask for a payslip.`);
    if (!ccris.length && s.regular_loan_payments.length) {
      if (!slips.length) set("commitments_monthly", sum(s.regular_loan_payments), "bank statement: regular loan payments");
      else checks.push(`Bank statement shows loan payments of RM${sum(s.regular_loan_payments)} a month (${s.regular_loan_payments.map((i) => i.name).join(", ")}): add any that are not already deducted on the payslip.`);
    }
    if (s.returned_payments) checks.push("Bank statement shows returned or bounced payments.");
  }

  for (const d of docs) if (d?.readable && d.confidence === "low") { checks.push("One document was hard to read (low confidence): check every figure against it."); break; }
  return { inputs, sources, checks };
}
