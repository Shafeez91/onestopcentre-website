// Financing documents (30 Oct 2026): staff upload a payslip, CCRIS report or bank statement; the AI reads the
// figures; staff check them before they reach the calculator. Supabase, Storage and the AI are fakes here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanExtraction, suggestInputs, maskNumbers, DOC_MAX_BYTES } from "../../../sales/shared/finance-docs.mjs";
import { readDocument, purgeDocuments, EXTRACT_SCHEMA, EXTRACT_SYSTEM, docStorage } from "../../lib/documents.mjs";
import handler, { config } from "../../../netlify/functions/sales-financing-docs.mjs";
import { assess } from "../../../sales/shared/finance.mjs";
import { runWorker } from "../../lib/worker.mjs";

const blank = { payslip: {}, ccris: {}, bank_statement: {} };
const payslip = (p = {}, extra = {}) => cleanExtraction({ readable: true, document_kind: "payslip", period: "2026-09", confidence: "high", ...blank, payslip: {
  employer_sector: "government", basic_salary: 4200, fixed_allowances: [{ name: "ITKA", amount: 300 }, { name: "COLA", amount: 350 }],
  variable_income: [], statutory_deductions: [{ name: "PCB", amount: 120 }, { name: "PERKESO", amount: 20 }],
  loan_deductions: [{ name: "Koperasi", amount: 450 }], other_deductions: [{ name: "Zakat", amount: 50 }], gross_pay: 4850, net_pay: 4210,
  birth_year: 1990, appointment_date: "2015-03-01", service_status: "permanent_confirmed", ...p }, ...extra });
const ccris = (facilities, extra = {}) => cleanExtraction({ readable: true, document_kind: "ccris", period: "2026-10", confidence: "high", ...blank, ccris: { report_date: "2026-10-20", facilities, special_attention: false, ...extra } });

test("masking: IC numbers and long account or card numbers never survive, short figures do", () => {
  assert.equal(maskNumbers("IC 900101-14-5678 and 900101145678"), "IC [IC hidden] and [IC hidden]");
  assert.equal(maskNumbers("Acc 1234 5678 9012 3456"), "Acc ••••3456");
  assert.equal(maskNumbers("Koperasi 450 / 2026-09"), "Koperasi 450 / 2026-09");
  const x = cleanExtraction({ readable: true, document_kind: "payslip", confidence: "high", ...blank,
    payslip: { loan_deductions: [{ name: "ANGKASA ref 8812345678901", amount: 300 }], other_deductions: [{ name: "x", amount: -5 }], birth_year: 1850 },
    warnings: ["Name AHMAD, IC 900101-14-5678"] });
  assert.equal(x.payslip.loan_deductions[0].name, "ANGKASA ref ••••8901");
  assert.deepEqual(x.payslip.other_deductions, [], "negative amounts are dropped");
  assert.equal(x.payslip.birth_year, null, "an impossible birth year is dropped");
  assert.doesNotMatch(JSON.stringify(x), /900101/);
  assert.equal(cleanExtraction({ document_kind: "passport" }).document_kind, "other");
  assert.equal(cleanExtraction({}).readable, false);
});

test("payslip → calculator figures, with where each came from; route and price are never filled", () => {
  const s = suggestInputs([payslip()], { year: 2026 });
  assert.deepEqual(s.inputs, { basic_salary: 4200, fixed_allowances: 650, mandatory_deductions: 140, age: 36, confirmed_service: "yes", service_years: 11, commitments_monthly: 450 });
  assert.match(s.sources.fixed_allowances, /ITKA, COLA/);
  assert.ok(s.checks.some((c) => /LPPSA may apply/.test(c)));
  assert.ok(s.checks.some((c) => /No CCRIS report/.test(c)));
  for (const k of ["route", "property_price", "down_payment"]) assert.equal(k in s.inputs, false, k);
  // the engine accepts the figures as they are
  const r = assess({ ...s.inputs, route: "lppsa", property_price: 450000 });
  assert.ok(r.max_financing > 0 && r.outcome);
  // private sector: no LPPSA hint, no service fields
  const p = suggestInputs([payslip({ employer_sector: "private", variable_income: [{ name: "OT", amount: 600 }] })], { year: 2026 });
  assert.equal(p.inputs.variable_income, 600);
  assert.equal("confirmed_service" in p.inputs, false);
  assert.ok(p.checks.some((c) => /one payslip only/.test(c)));
});

test("CCRIS wins for commitments (cards counted as a balance), and the payslip deductions are flagged for a check", () => {
  const s = suggestInputs([payslip(), ccris([
    { facility: "Hire purchase", monthly_instalment: 780, outstanding: 40000, in_arrears: false, is_credit_card: false },
    { facility: "Personal financing", monthly_instalment: 450, outstanding: 20000, in_arrears: false, is_credit_card: false },
    { facility: "Credit card", monthly_instalment: null, outstanding: 3200, in_arrears: false, is_credit_card: true }])], { year: 2026 });
  assert.equal(s.inputs.commitments_monthly, 1230);
  assert.equal(s.inputs.credit_card_balance, 3200);
  assert.ok(s.checks.some((c) => /koperasi and ANGKASA/.test(c)));
  const bad = suggestInputs([ccris([{ facility: "Car", monthly_instalment: 500, outstanding: 1, in_arrears: true, is_credit_card: false }])]);
  assert.ok(bad.checks.some((c) => /arrears/.test(c)));
});

test("bank statement: compared with the payslip; alone it never stands in for basic salary", () => {
  const stmt = (b) => cleanExtraction({ readable: true, document_kind: "bank_statement", confidence: "medium", ...blank, bank_statement: { months_covered: 3, average_salary_credit: 3000, regular_loan_payments: [{ name: "Car loan", amount: 700 }], average_month_end_balance: 900, returned_payments: true, ...b } });
  const both = suggestInputs([payslip(), stmt()], { year: 2026 });
  assert.ok(both.checks.some((c) => /differs from the payslip net pay/.test(c)));
  assert.ok(both.checks.some((c) => /add any that are not already deducted/.test(c)));
  assert.ok(both.checks.some((c) => /returned or bounced/.test(c)));
  assert.equal(both.inputs.commitments_monthly, 450, "payslip deductions stay; the statement's loans are a check");
  const alone = suggestInputs([stmt()]);
  assert.equal("basic_salary" in alone.inputs, false);
  assert.equal(alone.inputs.commitments_monthly, 700);
  assert.ok(alone.checks.some((c) => /net pay, not basic salary/.test(c)));
  // unreadable documents are ignored
  assert.deepEqual(suggestInputs([cleanExtraction({ readable: false, document_kind: "payslip" })]).inputs, {});
});

test("the AI call: the file as a document or image block, the strict schema, no identity details asked for", async () => {
  const seen = [];
  const llm = async (p) => { seen.push(p); return { data: { readable: true, document_kind: "payslip", period: "2026-09", confidence: "high", ...blank, payslip: { basic_salary: 3000 }, warnings: ["IC 900101-14-5678 visible"] }, model: "m" }; };
  const r = await readDocument({ llm, file: { bytes: Buffer.from("%PDF-1"), mime: "application/pdf", kind: "payslip" }, deadline: Date.now() + 20000 });
  assert.equal(seen[0].messages[0].content[0].type, "document");
  assert.equal(seen[0].messages[0].content[0].source.data, Buffer.from("%PDF-1").toString("base64"));
  assert.equal(seen[0].schema, EXTRACT_SCHEMA);
  assert.ok(seen[0].deadline);
  assert.match(EXTRACT_SYSTEM, /Never output names, IC \/ MyKad numbers/);
  assert.equal(r.extraction.payslip.basic_salary, 3000);
  assert.doesNotMatch(JSON.stringify(r.extraction), /900101/, "masked even when the AI copies it");
  await readDocument({ llm, file: { bytes: Buffer.from([1, 2]), mime: "image/jpeg", kind: "ccris" } });
  assert.equal(seen[1].messages[0].content[0].type, "image");
  assert.equal(seen[1].messages[0].content[0].source.media_type, "image/jpeg");
  // every object in the schema is closed and lists all its fields (structured outputs)
  const walk = (s) => { if (s?.type === "object") { assert.equal(s.additionalProperties, false); assert.deepEqual(s.required, Object.keys(s.properties)); Object.values(s.properties).forEach(walk); } if (s?.items) walk(s.items); (s?.anyOf || []).forEach(walk); };
  walk(EXTRACT_SCHEMA);
});

test("storage: private bucket paths, signed links for viewing, batch delete", async () => {
  const calls = [];
  const call = async (path, init = {}) => { calls.push({ path, ...init }); return path.includes("/sign/") ? Response.json({ signedURL: "/object/sign/ai-financing-docs/L/x.pdf?token=t" }) : new Response("ok"); };
  const st = docStorage(call);
  await st.put("L/x.pdf", Buffer.from("a"), "application/pdf");
  assert.equal(calls[0].path, "/storage/v1/object/ai-financing-docs/L/x.pdf");
  assert.equal(calls[0].headers["content-type"], "application/pdf");
  assert.match(await st.sign("L/x.pdf"), /^https:\/\/deethrwnmyezwsohmhzl\.supabase\.co\/storage\/v1\/object\/sign\/ai-financing-docs\/L\/x\.pdf\?token=t$/);
  await st.remove(["a", "b"]);
  assert.deepEqual(JSON.parse(calls.at(-1).body), { prefixes: ["a", "b"] });
});

/* ---------- the endpoint ---------- */
const LEAD = "11111111-1111-1111-1111-111111111111";
function fakes({ role = "advisor", flags = { financing_documents: true }, leadVisible = true, llm, cap = { allowed: true } } = {}) {
  const rows = {}, files = {}, log = [];
  const db = {
    get: async (p) => {
      if (p.startsWith("ai_settings")) return [{ flags }];
      const id = p.match(/id=eq\.([0-9a-f-]+)/)?.[1];
      if (p.startsWith("ai_financing_documents")) { if (!rows[id]) return []; const r = structuredClone(rows[id]); if (!/storage_path/.test(p)) delete r.storage_path; return [r]; }
      return [];
    },
    post: async (p, b) => { rows[b.id] = { status: "uploaded", ...b }; log.push(["post", p]); },
    patch: async (p, b) => { const id = p.match(/id=eq\.([0-9a-f-]+)/)[1]; Object.assign(rows[id], b); log.push(["patch", b.status]); },
    rpc: async (n, a) => { log.push(["rpc", n]); if (n === "ai_financing_docs_purged") { a.p_ids.forEach((i) => delete rows[i]); return a.p_ids.length; } return null; },
  };
  const udb = { get: async (p) => (leadVisible && p.startsWith("ai_leads") ? [{ id: LEAD }] : []), rpc: async () => cap };
  const storage = { put: async (p, b) => { files[p] = b; }, get: async (p) => files[p], sign: async (p) => "https://signed/" + p, remove: async (ps) => ps.forEach((p) => delete files[p]) };
  const deps = { db, userDb: udb, storage, getCaller: async () => (role ? { email: "adv@test.local", role } : null),
    llm: llm || (async () => ({ data: { readable: true, document_kind: "payslip", period: "2026-09", confidence: "high", ...blank, payslip: { basic_salary: 4000, employer_sector: "private" } }, model: "m" })) };
  return { deps, rows, files, log };
}
const call = (deps, body) => handler(new Request("https://x/api/sales/financing/documents", { method: "POST", body: JSON.stringify(body) }), {}, deps);
const withEnv = async (fn) => { const b = { ...process.env }; Object.assign(process.env, { AI_SALES_ENABLED: "true", SUPABASE_SERVICE_ROLE_KEY: "svc" }); try { await fn(); } finally { process.env = b; } };

test("endpoint: advisors only; upload stores the row before the file; read, confirm, view and delete", () => withEnv(async () => {
  assert.equal(config.path, "/api/sales/financing/documents");
  assert.equal((await call(fakes({ role: null }).deps, {})).status, 401);
  assert.equal((await call(fakes({ role: "viewer" }).deps, {})).status, 403);
  assert.equal((await call(fakes({ flags: { financing_documents: false } }).deps, { action: "upload" })).status, 403, "switched off in Settings");

  const f = fakes();
  const data = Buffer.from("%PDF-1.4 test").toString("base64");
  assert.equal((await call(f.deps, { action: "upload", lead_id: LEAD, kind: "payslip", mime: "application/zip", data })).status, 400);
  assert.equal((await call(f.deps, { action: "upload", lead_id: LEAD, kind: "passport", mime: "application/pdf", data })).status, 400);
  assert.equal((await call(f.deps, { action: "upload", lead_id: LEAD, kind: "payslip", mime: "application/pdf", data: Buffer.alloc(DOC_MAX_BYTES + 1).toString("base64") })).status, 413);
  assert.equal((await call(fakes({ leadVisible: false }).deps, { action: "upload", lead_id: LEAD, kind: "payslip", mime: "application/pdf", data })).status, 404);

  const up = await call(f.deps, { action: "upload", lead_id: LEAD, kind: "payslip", mime: "application/pdf", file_name: "slip/../x.pdf", data });
  assert.equal(up.status, 200);
  const doc = (await up.json()).document;
  assert.equal(doc.status, "uploaded");
  assert.equal(doc.storage_path, undefined, "the storage path is never sent to the browser");
  assert.equal(f.rows[doc.id].file_name, "slip_.._x.pdf");
  assert.equal(Object.keys(f.files)[0], `${LEAD}/${doc.id}.pdf`);
  assert.deepEqual(f.log[0], ["post", "ai_financing_documents"], "the row first");

  assert.equal((await call(f.deps, { action: "confirm", id: doc.id })).status, 409, "nothing to confirm before the AI read it");
  const read = await (await call(f.deps, { action: "read", id: doc.id })).json();
  assert.equal(read.document.status, "read");
  assert.equal(read.document.extracted.payslip.basic_salary, 4000);
  assert.equal((await call(f.deps, { action: "confirm", id: doc.id })).status, 200);
  assert.equal(f.rows[doc.id].confirmed_by, "adv@test.local");
  assert.equal((await (await call(f.deps, { action: "view", id: doc.id })).json()).url, `https://signed/${LEAD}/${doc.id}.pdf`);
  assert.equal((await call(f.deps, { action: "delete", id: doc.id })).status, 200);
  assert.deepEqual(f.files, {}); assert.deepEqual(f.rows, {});
  assert.equal((await call(f.deps, { action: "read", id: doc.id })).status, 404);
}));

test("endpoint: a failed or slow read is recorded and explained; the daily AI limit applies; a non-document is 'unreadable'", () => withEnv(async () => {
  const data = Buffer.from("img").toString("base64");
  const slow = fakes({ llm: async () => { const { LlmError } = await import("../../lib/llm.mjs"); throw new LlmError("t", { kind: "timeout" }); } });
  const d = (await (await call(slow.deps, { action: "upload", lead_id: LEAD, kind: "ccris", mime: "image/png", data })).json()).document;
  const r = await call(slow.deps, { action: "read", id: d.id });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /took too long/);
  assert.equal(slow.rows[d.id].status, "failed");

  const capped = fakes({ cap: { allowed: false, cap: 200 } });
  const d2 = (await (await call(capped.deps, { action: "upload", lead_id: LEAD, kind: "ccris", mime: "image/png", data })).json()).document;
  assert.equal((await call(capped.deps, { action: "read", id: d2.id })).status, 429);

  const other = fakes({ llm: async () => ({ data: { readable: true, document_kind: "other", confidence: "low", ...blank, warnings: ["This is a utility bill"] }, model: "m" }) });
  const d3 = (await (await call(other.deps, { action: "upload", lead_id: LEAD, kind: "payslip", mime: "image/png", data })).json()).document;
  assert.equal((await (await call(other.deps, { action: "read", id: d3.id })).json()).document.status, "unreadable");
}));

test("retention: the purge deletes due files then their rows; the worker runs it hourly", async () => {
  const removed = [], rpcs = [];
  const db = { rpc: async (n, a) => { rpcs.push([n, a]); return n === "ai_financing_docs_due" ? [{ id: "d1", storage_path: "L/d1.pdf" }, { id: null, storage_path: "stray.pdf" }] : 1; } };
  const r = await purgeDocuments({ db, storage: { remove: async (p) => removed.push(...p) } });
  assert.deepEqual(removed, ["L/d1.pdf", "stray.pdf"]);
  assert.deepEqual(rpcs[1], ["ai_financing_docs_purged", { p_ids: ["d1"] }]);
  assert.deepEqual(r, { files: 2, rows: 1 });

  const seen = [];
  const wdb = { get: async (p) => (p.startsWith("ai_settings") ? [{ id: 1, flags: {}, ai: {}, business: {}, compliance: {} }] : []), rpc: async (n) => { seen.push(n); return []; }, post: async () => [], patch: async () => null };
  await runWorker({ db: wdb, storage: { remove: async () => {} }, now: () => new Date("2026-10-30T05:00:30Z") }, { budgetMs: 26000 });
  assert.ok(seen.includes("ai_financing_docs_due"), "on the hour");
  seen.length = 0;
  await runWorker({ db: wdb, storage: { remove: async () => {} }, now: () => new Date("2026-10-30T05:30:00Z") }, { budgetMs: 26000 });
  assert.ok(!seen.includes("ai_financing_docs_due"), "not every run");
});
