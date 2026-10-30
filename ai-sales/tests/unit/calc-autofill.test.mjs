// Financing tools: auto-fill the LPPSA and bank calculators from documents the AI read, and the read-only "extract"
// action (the file and the figures are not stored).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanExtraction } from "../../../sales/shared/finance-docs.mjs";
import { lppsaFromDocs, bankFromDocs } from "../../../sales/shared/calc/autofill.mjs";
import { calcLppsa } from "../../../sales/shared/calc/lppsa.mjs";
import { calcBank } from "../../../sales/shared/calc/bank.mjs";
import { lppsaRuleset, bankRuleset } from "../../../sales/shared/calc/rules.mjs";
import handler from "../../../netlify/functions/sales-financing-docs.mjs";

const blank = { payslip: {}, ccris: {}, bank_statement: {} };
const govSlip = cleanExtraction({ readable: true, document_kind: "payslip", period: "2026-09", confidence: "high", ...blank, payslip: {
  employer_sector: "government", basic_salary: 4000,
  fixed_allowances: [{ name: "ITKA", amount: 300 }, { name: "Bantuan Sara Hidup", amount: 350 }, { name: "ITP", amount: 200 }, { name: "Elaun Pakaian", amount: 50 }],
  variable_income: [{ name: "Lebih Masa", amount: 400 }],
  statutory_deductions: [{ name: "PCB", amount: 120 }, { name: "PERKESO", amount: 20 }, { name: "SIP", amount: 8 }],
  loan_deductions: [{ name: "Koperasi Guru", amount: 450 }, { name: "LPPSA", amount: 900 }], other_deductions: [{ name: "Zakat", amount: 50 }],
  gross_pay: 5300, net_pay: 3700, birth_year: 1990, appointment_date: "2015-03-01", service_status: "permanent_confirmed" } });
const ccris = cleanExtraction({ readable: true, document_kind: "ccris", period: "2026-10", confidence: "high", ...blank, ccris: { report_date: "2026-10-20", special_attention: false, facilities: [
  { facility: "Hire Purchase", monthly_instalment: 780, outstanding: 40000, in_arrears: false, is_credit_card: false },
  { facility: "Personal Financing-i", monthly_instalment: 450, outstanding: 20000, in_arrears: false, is_credit_card: false },
  { facility: "PTPTN", monthly_instalment: null, outstanding: 9000, in_arrears: false, is_credit_card: false },
  { facility: "Credit Card", monthly_instalment: null, outstanding: 3200, in_arrears: false, is_credit_card: true }] } });

test("LPPSA from a government payslip: eligible allowances by code, deductions itemised, existing LPPSA found", () => {
  const { values, sources, checks } = lppsaFromDocs([govSlip], { year: 2026 });
  assert.equal(values.basic_salary, 4000);
  assert.equal(values["allowances.itka"], 300);
  assert.equal(values["allowances.cola"], 350, "Bantuan Sara Hidup is COLA");
  assert.equal(values["allowances.itp"], 200);
  assert.ok(checks.some((c) => /Not counted by LPPSA.*Elaun Pakaian RM50/.test(c)));
  assert.deepEqual([values["mandatory.tax"], values["mandatory.kwsp"], values["mandatory.perkeso"], values["mandatory.eis"]], [120, 0, 20, 8]);
  assert.equal(values.financing_no, "second");
  assert.equal(values.existing_lppsa_instalment, 900);
  assert.equal(values.financing_deductions, 450);
  assert.equal(values.other_deductions, 50);
  assert.equal(values.age, 36);
  assert.equal(values.employment, "permanent_confirmed");
  assert.equal(values.retirement_scheme, undefined, "no KWSP contribution: pension stays");
  assert.match(sources["allowances.cola"], /payslip 2026-09/);
  // the calculator runs on exactly these values
  const r = calcLppsa({ ...Object.fromEntries(Object.entries(values).filter(([k]) => !k.includes("."))),
    allowances: { itka: 300, cola: 350, itp: 200 }, mandatory_deductions: 148 }, lppsaRuleset({}));
  assert.equal(r.income.gross, 4850);
  assert.match(r.limits[0].label, /50%/, "second financing");
  assert.equal(r.income.financing_deductions, 1350);
});

test("LPPSA: KWSP payslip, private employer and CCRIS facilities give the right checks", () => {
  const kwsp = cleanExtraction({ ...govSlip, payslip: { ...govSlip.payslip, statutory_deductions: [{ name: "KWSP", amount: 440 }], loan_deductions: [] } });
  const a = lppsaFromDocs([kwsp, ccris], { year: 2026 });
  assert.equal(a.values.retirement_scheme, "kwsp");
  assert.equal(a.values["mandatory.kwsp"], 440);
  assert.ok(a.checks.some((c) => /CCRIS lists 2 financing facilities/.test(c)));
  const priv = cleanExtraction({ ...govSlip, payslip: { ...govSlip.payslip, employer_sector: "private" } });
  assert.ok(lppsaFromDocs([priv]).checks.some((c) => /Use the bank calculator/.test(c)));
  assert.ok(lppsaFromDocs([]).checks.some((c) => /No payslip read/.test(c)));
});

test("bank from payslip + CCRIS: income, statutory total, commitments by type, card balance, checks", () => {
  const { values, checks } = bankFromDocs([govSlip, ccris], { year: 2026 });
  assert.equal(values.basic_salary, 4000);
  assert.equal(values.fixed_allowances, 900);
  assert.equal(values.variable_income, 400);
  assert.equal(values.statutory_deductions, 148);
  assert.equal(values["commitments.car.amount"], 780);
  assert.equal(values["commitments.personal.amount"], 450);
  assert.equal(values["commitments.ptptn.amount"], undefined, "no instalment shown: asked, not invented");
  assert.equal(values.credit_card_balance, 3200);
  assert.equal(values.employment_type, "government");
  assert.ok(checks.some((c) => /"PTPTN" shows no monthly instalment/.test(c)));
  assert.ok(checks.some((c) => /koperasi and ANGKASA often are/.test(c)));
  assert.ok(checks.some((c) => /LPPSA may suit this buyer better/.test(c)));
  const r = calcBank({ age: values.age, basic_salary: values.basic_salary, fixed_allowances: values.fixed_allowances, variable_income: values.variable_income, statutory_deductions: values.statutory_deductions,
    commitments: { car: { amount: 780 }, personal: { amount: 450 } }, credit_card_balance: values.credit_card_balance, rate_pct: 4.2, dsr_pct: 70 }, bankRuleset({}));
  assert.equal(r.income.recognised_gross, 5100);
  assert.equal(r.income.commitments_counted, 1390);  // 780 + 450 + 5% × 3,200
  // without CCRIS, the payslip's financing deductions are used
  const p = bankFromDocs([govSlip], { year: 2026 });
  assert.equal(p.values["commitments.personal.amount"], 450);
  assert.equal(p.values["commitments.property.amount"], 900);
  assert.ok(p.checks.some((c) => /No CCRIS report/.test(c)));
});

test("unreadable or low-confidence documents fill nothing from them and say so", () => {
  const bad = cleanExtraction({ readable: false, document_kind: "other", confidence: "low" });
  const r = lppsaFromDocs([bad]);
  assert.deepEqual(r.values, {});
  assert.ok(r.checks.some((c) => /could not be read/.test(c)));
  const low = cleanExtraction({ ...govSlip, confidence: "low" });
  assert.ok(bankFromDocs([low]).checks.some((c) => /low confidence/.test(c)));
});

const call = (deps, body) => handler(new Request("https://x/api/sales/financing/documents", { method: "POST", body: JSON.stringify(body) }), {}, deps);
test("extract: advisors only; the file is read and returned, nothing stored; daily limit applies", async () => {
  const b = { ...process.env }; process.env.AI_SALES_ENABLED = "true";
  try {
    const writes = [];
    const deps = (role = "advisor", cap = { allowed: true }) => ({ getCaller: async () => ({ email: "a@x", role }),
      db: { get: async () => [{ flags: {} }], post: async (p) => writes.push(p), patch: async (p) => writes.push(p), rpc: async (n) => writes.push(n) },
      userDb: { get: async () => [], rpc: async () => cap }, storage: { put: async () => writes.push("put") },
      llm: async () => ({ data: { readable: true, document_kind: "payslip", period: "2026-09", confidence: "high", ...blank, payslip: { basic_salary: 4000, employer_sector: "government" } }, model: "m" }) });
    const data = Buffer.from("%PDF-1.4").toString("base64");
    assert.equal((await call(deps("viewer"), { action: "extract", kind: "payslip", mime: "application/pdf", data })).status, 403);
    assert.equal((await call(deps(), { action: "extract", kind: "payslip", mime: "text/plain", data })).status, 400);
    assert.equal((await call(deps("advisor", { allowed: false, cap: 200 }), { action: "extract", kind: "payslip", mime: "application/pdf", data })).status, 429);
    const r = await call(deps(), { action: "extract", kind: "payslip", mime: "application/pdf", data });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.stored, false);
    assert.equal(j.extraction.payslip.basic_salary, 4000);
    assert.deepEqual(writes, [], "no row, no file");
  } finally { process.env = b; }
});
