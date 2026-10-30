// Fills the LPPSA and bank calculators from what the AI read in a payslip, CCRIS report or bank statement
// (cleanExtraction shape, finance-docs.mjs). Returns form values keyed by the calculator's field names, where each
// figure came from, and what the advisor must check. Never fills the property price, rate or anything not printed.

const sum = (list) => Math.round((list || []).reduce((t, i) => t + (Number(i.amount) || 0), 0) * 100) / 100;
const readable = (docs, kind) => (docs || []).filter((d) => d?.readable && d.document_kind === kind);
const latest = (docs) => docs.slice().sort((a, b) => String(b.period || "").localeCompare(String(a.period || "")))[0];
const names = (list) => (list || []).map((i) => i.name).join(", ");

// payslip allowance names → the LPPSA allowance fields (only these count for LPPSA)
const LPPSA_ALLOWANCE = [
  ["itka", /\bITKA\b|khidmat\s+awam/i], ["itkt", /\bITKT\b/i], ["itju", /\bITJU\b/i], ["itp", /\bITP\b|tetap\s+perumahan/i], ["itk", /\bITK\b|keraian/i],
  ["epw", /\bEPW\b|perumahan\s+wilayah/i], ["acting", /memangku|acting|\bTMK\b/i], ["cola", /\bCOLA\b|sara\s+hidup|\bBSH\b/i],
  ["biw", /\bBIW\b|insentif\s+wilayah/i], ["bism", /\bBISM\b/i], ["biss", /\bBISS\b/i],
];
const STATUTORY = [["tax", /\bPCB\b|cukai|income\s+tax|\bMTD\b|\btax\b/i], ["kwsp", /\bKWSP\b|\bEPF\b/i], ["perkeso", /PERKESO|SOCSO|\bPKS\b/i], ["eis", /\bEIS\b|\bSIP\b|insurans\s+pekerjaan/i]];
const LPPSA_DEDUCTION = /\bLPPSA\b|pembiayaan\s+perumahan\s+(sektor\s+)?awam|\bBPP\b/i;
const COMMITMENT = [["credit_card", /credit\s*card|kad\s+kredit|charge\s*card/i], ["car", /hire\s*purchase|\bHP\b|kereta|vehicle|car|auto/i],
  ["ptptn", /PTPTN/i], ["property", /housing|perumahan|property|mortgage|home|LPPSA/i], ["personal", /personal|peribadi|koperasi|ANGKASA|\bBPA\b|cash\s*line|overdraft/i]];
const kindOf = (name, table) => (table.find(([, re]) => re.test(name || "")) || [null])[0];

function common(docs, year) {
  const slips = readable(docs, "payslip"), ccris = readable(docs, "ccris"), stmts = readable(docs, "bank_statement");
  return { slips, ccris, stmts, slip: slips.length ? latest(slips) : null, report: ccris.length ? latest(ccris) : null, stmt: stmts.length ? latest(stmts) : null, year };
}
function lowConfidence(docs, checks) {
  if ((docs || []).some((d) => d?.readable && d.confidence === "low")) checks.push("A document was hard to read (low confidence): check every highlighted figure against it.");
  for (const d of docs || []) if (d && !d.readable) checks.push("A file could not be read as a payslip, CCRIS report or bank statement: nothing was taken from it.");
}

/** LPPSA calculator fields from the documents. */
export function lppsaFromDocs(docs = [], { year = new Date().getFullYear() } = {}) {
  const { slip, ccris, stmt } = common(docs, year), values = {}, sources = {}, checks = [];
  const set = (k, v, src) => { if (v !== null && v !== undefined && v !== "") { values[k] = v; sources[k] = src; } };
  if (slip) {
    const p = slip.payslip, from = `payslip${slip.period ? " " + slip.period : ""}`;
    set("basic_salary", p.basic_salary, `${from}: basic pay`);
    const counted = {}, notCounted = [];
    for (const a of p.fixed_allowances || []) {
      const k = kindOf(a.name, LPPSA_ALLOWANCE);
      if (k) counted[k] = Math.round(((counted[k] || 0) + a.amount) * 100) / 100; else notCounted.push(a);
    }
    for (const [k, v] of Object.entries(counted)) set("allowances." + k, v, `${from}: ${k.toUpperCase()}`);
    if (notCounted.length) checks.push(`Not counted by LPPSA (not in its eligible fixed allowances): ${notCounted.map((a) => `${a.name} RM${a.amount}`).join(", ")}. Add one only if it is an eligible allowance under another name.`);
    const stat = {}, otherStat = [];
    for (const d of p.statutory_deductions || []) { const k = kindOf(d.name, STATUTORY); if (k) stat[k] = Math.round(((stat[k] || 0) + d.amount) * 100) / 100; else otherStat.push(d); }
    for (const k of ["tax", "kwsp", "perkeso", "eis"]) set("mandatory." + k, stat[k] ?? 0, `${from}: ${stat[k] !== undefined ? k.toUpperCase() : "none on the payslip"}`);
    if (otherStat.length) set("mandatory.other", sum(otherStat), `${from}: ${names(otherStat)}`);
    // financing deducted from pay: an LPPSA deduction means existing LPPSA financing
    const lppsa = (p.loan_deductions || []).filter((d) => LPPSA_DEDUCTION.test(d.name)), others = (p.loan_deductions || []).filter((d) => !LPPSA_DEDUCTION.test(d.name));
    if (lppsa.length) { set("financing_no", "second", `${from}: LPPSA deduction`); set("existing_lppsa_instalment", sum(lppsa), `${from}: ${names(lppsa)}`); }
    set("financing_deductions", sum(others), `${from}: ${names(others) || "no financing deductions"}`);
    set("other_deductions", sum(p.other_deductions), `${from}: ${names(p.other_deductions) || "no other deductions"}`);
    if (p.birth_year) set("age", year - p.birth_year, `${from}: date of birth`);
    if (p.service_status === "permanent_confirmed") set("employment", "permanent_confirmed", `${from}: service status`);
    else if (p.service_status === "permanent_not_confirmed") set("employment", "permanent_probation", `${from}: service status`);
    else if (p.service_status === "contract") set("employment", "contract", `${from}: service status`);
    if (stat.kwsp) set("retirement_scheme", "kwsp", `${from}: KWSP contribution`);
    if (p.employer_sector === "private") checks.push("The payslip looks like a private-sector employer: LPPSA is for public servants. Use the bank calculator.");
    if (!lppsa.length && others.length) checks.push("Check that none of the financing deductions is an existing LPPSA financing (it would make this a second financing).");
  } else checks.push("No payslip read: LPPSA works from the payslip (basic salary, allowances and deductions).");
  if (ccris.length) {
    const outside = readable(docs, "ccris").flatMap((d) => d.ccris.facilities).filter((f) => !f.is_credit_card && f.monthly_instalment);
    if (outside.length) checks.push(`CCRIS lists ${outside.length} financing facilit${outside.length === 1 ? "y" : "ies"} (RM${Math.round(outside.reduce((t, f) => t + f.monthly_instalment, 0))} a month): LPPSA counts the deductions on the payslip; make sure any not on the payslip are known to the advisor.`);
    if (readable(docs, "ccris").some((d) => d.ccris.facilities.some((f) => f.in_arrears) || d.ccris.special_attention)) checks.push("CCRIS shows arrears or a special attention account: an advisor must review before any estimate is shared.");
  }
  if (stmt && slip?.payslip.net_pay && stmt.bank_statement.average_salary_credit) {
    const net = slip.payslip.net_pay, cr = stmt.bank_statement.average_salary_credit;
    if (Math.abs(cr - net) / net > 0.15) checks.push(`Bank statement salary credit (avg RM${cr}) differs from the payslip net pay (RM${net}) by more than 15%.`);
  }
  lowConfidence(docs, checks);
  return { values, sources, checks };
}

/** Bank calculator fields from the documents. */
export function bankFromDocs(docs = [], { year = new Date().getFullYear() } = {}) {
  const { slips, slip, report, stmt } = common(docs, year), values = {}, sources = {}, checks = [];
  const set = (k, v, src) => { if (v !== null && v !== undefined && v !== "") { values[k] = v; sources[k] = src; } };
  if (slip) {
    const p = slip.payslip, from = `payslip${slip.period ? " " + slip.period : ""}`;
    set("basic_salary", p.basic_salary, `${from}: basic pay`);
    set("fixed_allowances", sum(p.fixed_allowances), `${from}: ${names(p.fixed_allowances) || "no fixed allowances"}`);
    const variable = slips.map((s) => sum(s.payslip.variable_income));
    if (variable.some((v) => v > 0)) set("variable_income", Math.round((variable.reduce((t, v) => t + v, 0) / variable.length) * 100) / 100, `${slips.length > 1 ? slips.length + " payslips" : from}: average overtime / commission`);
    if (slips.length === 1 && variable[0] > 0) checks.push("Variable pay seen on one payslip only: banks usually average 3–6 months.");
    set("statutory_deductions", sum(p.statutory_deductions), `${from}: ${names(p.statutory_deductions) || "no statutory deductions"}`);
    if (p.birth_year) set("age", year - p.birth_year, `${from}: date of birth`);
    if (p.employer_sector === "government" || p.employer_sector === "statutory_body") { set("employment_type", "government", `${from}: employer`); checks.push("Government / statutory employer: LPPSA may suit this buyer better. Try the LPPSA calculator."); }
    else if (p.employer_sector === "private") set("employment_type", "private", `${from}: employer`);
  } else checks.push("No payslip read: enter the income yourself (a bank statement shows net credits, not basic salary).");

  // commitments: CCRIS when read (the bank checks it), otherwise the payslip's financing deductions
  const add = (key, amount, src) => { if (!amount) return; const k = `commitments.${key}.amount`; values[k] = Math.round(((values[k] || 0) + amount) * 100) / 100; sources[k] = sources[k] ? sources[k] + "; " + src : src; };
  if (report) {
    const from = `CCRIS${report.ccris.report_date ? " " + report.ccris.report_date : ""}`;
    let cards = 0;
    for (const f of report.ccris.facilities) {
      const k = kindOf(f.facility, COMMITMENT) || "other";
      if (f.is_credit_card || k === "credit_card") { cards += f.outstanding || 0; continue; }
      if (f.monthly_instalment === null) checks.push(`CCRIS: "${f.facility}" shows no monthly instalment. Ask the buyer for it.`);
      add(k, f.monthly_instalment || 0, `${from}: ${f.facility}`);
    }
    if (cards) set("credit_card_balance", Math.round(cards * 100) / 100, `${from}: credit card balances`);
    if (report.ccris.facilities.some((f) => f.in_arrears) || report.ccris.special_attention) checks.push("CCRIS shows arrears or a special attention account: an advisor must review before any estimate is shared.");
    if (slip && (slip.payslip.loan_deductions || []).length) checks.push(`Payslip financing deductions (${names(slip.payslip.loan_deductions)}): check none is missing from CCRIS (koperasi and ANGKASA often are).`);
  } else if (slip) {
    for (const d of slip.payslip.loan_deductions || []) add(kindOf(d.name, COMMITMENT) || "other", d.amount, `payslip: ${d.name}`);
    checks.push("No CCRIS report: loans paid outside the payslip (car, credit card, PTPTN) are not counted yet.");
  } else if (stmt) {
    for (const d of stmt.bank_statement.regular_loan_payments || []) add(kindOf(d.name, COMMITMENT) || "other", d.amount, `bank statement: ${d.name}`);
  }
  if (stmt) {
    const s = stmt.bank_statement;
    if (s.returned_payments) checks.push("Bank statement shows returned or bounced payments.");
    if (slip?.payslip.net_pay && s.average_salary_credit && Math.abs(s.average_salary_credit - slip.payslip.net_pay) / slip.payslip.net_pay > 0.15) checks.push(`Bank statement salary credit (avg RM${s.average_salary_credit}) differs from the payslip net pay (RM${slip.payslip.net_pay}) by more than 15%.`);
    if (report && s.regular_loan_payments?.length) checks.push(`Bank statement loan payments (${names(s.regular_loan_payments)}): check each is in CCRIS.`);
  }
  lowConfidence(docs, checks);
  return { values, sources, checks };
}
