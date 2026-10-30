// Financing documents: the private file store (Supabase Storage, service role only) and the AI reading of a payslip,
// CCRIS report or bank statement. The AI returns figures, never identity details; whatever it returns is cleaned
// and masked (finance-docs.mjs) before it is stored or shown. A staff member checks the figures before use.
import { asService, sbUrl } from "./server.mjs";
import { cleanExtraction, DOC_KINDS } from "../../sales/shared/finance-docs.mjs";

export const BUCKET = "ai-financing-docs";
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

/** Storage REST calls with the service role. Never exposed to the browser: a short signed link is used to view. */
export function docStorage(call = asService, bucket = BUCKET) {
  const ok = async (r, what) => { if (!r.ok) throw new Error(`Storage ${what} failed (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`); return r; };
  return {
    put: async (path, bytes, mime) => ok(await call(`/storage/v1/object/${bucket}/${enc(path)}`, { method: "POST", headers: { "content-type": mime, "x-upsert": "false" }, body: bytes }), "upload"),
    get: async (path) => Buffer.from(await (await ok(await call(`/storage/v1/object/${bucket}/${enc(path)}`, { method: "GET" }), "download")).arrayBuffer()),
    sign: async (path, seconds = 60) => {
      const r = await ok(await call(`/storage/v1/object/sign/${bucket}/${enc(path)}`, { method: "POST", body: JSON.stringify({ expiresIn: seconds }) }), "link");
      const j = await r.json();
      return sbUrl() + "/storage/v1" + (j.signedURL || j.signedUrl);
    },
    remove: async (paths) => (paths.length ? ok(await call(`/storage/v1/object/${bucket}`, { method: "DELETE", body: JSON.stringify({ prefixes: paths }) }), "delete") : null),
  };
}

const n = { anyOf: [{ type: "number" }, { type: "null" }] };
const s = { anyOf: [{ type: "string" }, { type: "null" }] };
const b = { anyOf: [{ type: "boolean" }, { type: "null" }] };
const i = { anyOf: [{ type: "integer" }, { type: "null" }] };
const obj = (props) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });
const lines = { type: "array", items: obj({ name: { type: "string" }, amount: { type: "number" } }) };

export const EXTRACT_SCHEMA = obj({
  readable: { type: "boolean" },
  document_kind: { type: "string", enum: ["payslip", "ccris", "bank_statement", "other"] },
  period: s,
  confidence: { type: "string", enum: ["high", "medium", "low"] },
  payslip: obj({
    employer_sector: { type: "string", enum: ["government", "statutory_body", "private", "unknown"] },
    basic_salary: n, fixed_allowances: lines, variable_income: lines, statutory_deductions: lines, loan_deductions: lines, other_deductions: lines,
    gross_pay: n, net_pay: n, birth_year: i, appointment_date: s,
    service_status: { type: "string", enum: ["permanent_confirmed", "permanent_not_confirmed", "contract", "unknown"] },
  }),
  ccris: obj({
    report_date: s,
    facilities: { type: "array", items: obj({ facility: { type: "string" }, monthly_instalment: n, outstanding: n, in_arrears: b, is_credit_card: { type: "boolean" } }) },
    special_attention: b,
  }),
  bank_statement: obj({ months_covered: i, average_salary_credit: n, regular_loan_payments: lines, average_month_end_balance: n, returned_payments: b }),
  warnings: { type: "array", items: { type: "string" } },
});

export const EXTRACT_SYSTEM = `You read one Malaysian financing document for a property sales team: a payslip (slip gaji, including government
pay slips with ANGKASA / BPA / koperasi deductions), a CCRIS report from Bank Negara Malaysia, or a bank statement.
Your output fills a loan calculator after a staff member checks it.

Rules:
- Copy figures exactly as printed, in RM per month, as plain numbers. Never estimate or invent a figure; use null or an empty list when it is not shown.
- Never output names, IC / MyKad numbers, addresses, account, card or employee numbers, or reference numbers, in any field or warning.
  You may give the birth year (from the date of birth or the first two digits of the IC number) and nothing else about identity.
- payslip: basic_salary is basic pay (gaji pokok). fixed_allowances are allowances paid every month (e.g. ITKA, ITP, COLA, housing, fixed
  travel, and on government pay slips ITP, ITKA, ITK, ITKT, ITJU, EPW, acting allowance, COLA / Bantuan Sara Hidup,
  BIW, BISM, BISS; not bonus, overtime or one-off claims). Keep each allowance's name as printed. variable_income is overtime, commission, claims or bonus this month. statutory_deductions are income tax (PCB / cukai),
  EPF / KWSP, SOCSO / PERKESO and EIS / SIP. loan_deductions are repayments of financing deducted from pay: LPPSA housing, personal or koperasi
  financing, ANGKASA or BPA loan deductions, car financing. other_deductions are everything else (zakat, insurance, union, savings, CP38).
  employer_sector: government for federal or state government servants, statutory_body for badan berkanun. appointment_date: the
  date of appointment (tarikh lantikan) if printed. service_status from the printed status (tetap / disahkan, kontrak) or unknown.
- ccris: one facility per loan or card line with its monthly instalment and outstanding balance as shown; in_arrears true when the
  conduct shows any month in arrears (a number above 0 in the 12-month record); is_credit_card for credit card and charge card lines;
  special_attention true if the report lists a Special Attention Account.
- bank_statement: months_covered, the average monthly salary credit, regular loan or financing payments with their monthly amount,
  the average month-end balance, and whether any payment was returned or bounced.
- Fill only the section that matches the document; leave the others with nulls and empty lists.
- period: the pay month or statement / report date as printed (e.g. "2026-09").
- readable false and confidence low when the document is too blurred, cropped or not one of these documents (document_kind other).
- warnings: anything the staff member should check (a figure partly hidden, totals that do not add up, more than one person's details,
  a document older than 3 months). No personal details in warnings either.`;

/**
 * Reads one document with the AI. file: { bytes (Buffer), mime, kind }. Returns the cleaned extraction.
 * deadline: epoch ms by which the call must be over (the request ends at 30 s).
 */
export async function readDocument({ llm, file, deadline }) {
  const data = Buffer.from(file.bytes).toString("base64");
  const block = file.mime === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
    : { type: "image", source: { type: "base64", media_type: file.mime, data } };
  const label = DOC_KINDS[file.kind]?.en || "document";
  const r = await llm({
    system: EXTRACT_SYSTEM,
    messages: [{ role: "user", content: [block, { type: "text", text: `Staff uploaded this as a ${label}. Read it under the rules.` }] }],
    schema: EXTRACT_SCHEMA, maxTokens: 4000, effort: "low", retries: 1, deadline,
  });
  return { extraction: cleanExtraction(r.data), model: r.model || null };
}

/** Retention: deletes expired files, files of deleted leads, and stray files; then their rows. */
export async function purgeDocuments({ db, storage }, { max = 50 } = {}) {
  const due = (await db.rpc("ai_financing_docs_due", { p_limit: max })) || [];
  if (!due.length) return { files: 0, rows: 0 };
  await storage.remove(due.map((d) => d.storage_path));
  const rows = await db.rpc("ai_financing_docs_purged", { p_ids: due.map((d) => d.id).filter(Boolean) });
  return { files: due.length, rows: rows || 0 };
}
