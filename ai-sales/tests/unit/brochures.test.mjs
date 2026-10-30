// Brochures (30 Oct 2026): the AI sends files staff marked "AI may send this file to buyers" on WhatsApp, and
// "Read with AI" turns brochure pages without selectable text into draft knowledge entries. Fakes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { respond } from "../../lib/orchestrator.mjs";
import { normalizeReply, REPLY_SCHEMA } from "../../lib/prompt.mjs";
import { sendWhatsApp } from "../../lib/whatsapp.mjs";
import { sendFiles } from "../../lib/worker.mjs";
import readPages, { config, PAGES_SCHEMA, PAGES_SYSTEM } from "../../../netlify/functions/sales-knowledge-read.mjs";

const NOW = new Date("2026-10-30T08:00:00Z");
const DOCS = [
  { id: "d-aurora", title: "M Aurora E-Pamphlet.pdf", kind: "brochure", project_id: "aur", mime_type: "application/pdf", size_bytes: 6e6 },
  { id: "d-plan", title: "M Aurora floor plan.png", kind: "floor_plan", project_id: "aur", mime_type: "image/png", size_bytes: 9e5 },
  { id: "d-video", title: "Walkthrough.mp4", kind: "video", project_id: "aur", mime_type: "video/mp4", size_bytes: 9e6 },
  { id: "d-big", title: "Huge photo.jpg", kind: "image", project_id: "aur", mime_type: "image/jpeg", size_bytes: 8e6 },
  { id: "d-mira", title: "M Mira brochure.pdf", kind: "brochure", project_id: "mira", mime_type: "application/pdf", size_bytes: 2e6 },
  { id: "d-gen", title: "How to buy with LPPSA.pdf", kind: "other", project_id: null, mime_type: "application/pdf", size_bytes: 1e6 },
];
function db(extra = {}) {
  const t = {
    ai_settings: [{ id: 1, persona: { name: "Hafiz_Ai" }, ai: { confidence_threshold: 0.7 }, business: {}, scoring: {}, compliance: {} }],
    projects: [{ id: "aur", slug: "m-aurora", data: { n: "M AURORA", l: "Sungai Besi", types: [{ name: "Type A", price: "RM420,000" }] } },
      { id: "mira", slug: "m-mira", data: { n: "M MIRA", l: "Wangsa Maju", types: [{ name: "Type B", price: "RM476,000" }] } }],
    ai_documents: DOCS, ai_leads: [], ...extra,
  };
  return { get: async (p) => { const name = p.split("?")[0]; if (name === "ai_documents" && !/share_with_customers=eq\.true/.test(p)) return []; return structuredClone(t[name] || []); },
    rpc: async () => [], post: async () => [{ id: "run" }], patch: async () => null };
}
const reply = (o = {}) => ({ messages: ["Saya Hafiz_Ai, pembantu AI. Boleh, saya hantar e-pamphlet M AURORA sekarang."], language: "ms", intent: "project_info", agent: "knowledge", confidence: 0.9,
  facts_used: ["file:d-aurora"], qualification_updates: {}, appointment_request: { wanted: false }, handover: { needed: false }, objection_key: "", workflow: {}, ...o });
const llmWith = (data) => { const calls = []; const f = async (p) => { calls.push(p); return { data, model: "m", usage: {} }; }; f.calls = calls; return f; };
const ctxOf = (call) => JSON.parse(call.messages.at(-1).content.match(/<verified_context>\s*([\s\S]*?)\s*<\/verified_context>/)[1]);

test("the AI is offered only sendable files (PDF, JPG, PNG within WhatsApp's limits) for the project being discussed", async () => {
  const llm = llmWith(reply());
  await respond({ db: db(), llm, message: "Boleh share brochure M Aurora?", now: NOW, mode: "simulate" });
  const files = ctxOf(llm.calls[0]).files;
  assert.deepEqual(files.map((f) => f.id), ["d-aurora", "d-plan", "d-gen"], "no video, no 8 MB photo, no other project's brochure");
  assert.equal(files.find((f) => f.id === "d-gen").project_id, "all");
  assert.match(llm.calls[0].system, /add "file:<its id>" to facts_used/);
  // no project named yet: every shareable file is offered, so the buyer can pick
  const any = llmWith(reply({ facts_used: [] }));
  await respond({ db: db(), llm: any, message: "Ada brochure?", now: NOW, mode: "simulate" });
  assert.ok(ctxOf(any.calls[0]).files.some((f) => f.id === "d-mira"));
  // nothing marked shareable: no files key at all
  const none = llmWith(reply({ facts_used: [] }));
  await respond({ db: db({ ai_documents: [] }), llm: none, message: "brochure?", now: NOW, mode: "simulate" });
  assert.equal(ctxOf(none.calls[0]).files, undefined);
});

test("file:<id> in facts_used becomes a send_file action, only for files offered and only on a normal reply", async () => {
  assert.deepEqual(normalizeReply({ messages: ["x"], facts_used: ["kb:1", "file:a", "file:a", "file:b", "file:c"] }).send_files, ["a", "b"], "at most 2, no repeats");
  assert.ok(!("send_files" in REPLY_SCHEMA.properties), "the reply schema does not grow");
  const r = await respond({ db: db(), llm: llmWith(reply({ facts_used: ["file:d-aurora", "file:d-video", "file:made-up"] })), message: "Boleh share brochure M Aurora?", now: NOW, mode: "simulate" });
  assert.deepEqual(r.actions.filter((a) => a.type === "send_file").map((a) => a.document_id), ["d-aurora"]);
  const h = await respond({ db: db(), llm: llmWith(reply({ handover: { needed: true, reason: "customer_request", summary: "s", next_action: "n" } })), message: "Boleh share brochure M Aurora?", now: NOW, mode: "simulate" });
  assert.equal(h.actions.some((a) => a.type === "send_file"), false, "a hand-over sends no file");
});

test("WhatsApp: a PDF goes as a document with its file name, a photo as an image; both by link", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return Response.json({ messages: [{ id: "wamid.F" }] }); };
  const cfg = { token: "t", phoneNumberId: "PN", version: "v21.0" };
  assert.equal(await sendWhatsApp(cfg, "60123456789", { file: { kind: "document", link: "https://x/s.pdf?token=1", filename: "M Aurora.pdf", caption: "M Aurora" } }, { fetchImpl }), "wamid.F");
  assert.deepEqual(sent[0].document, { link: "https://x/s.pdf?token=1", filename: "M Aurora.pdf", caption: "M Aurora" });
  assert.equal(sent[0].type, "document");
  await sendWhatsApp(cfg, "MY.123", { file: { kind: "image", link: "https://x/p.png", caption: "Plan" } }, { fetchImpl });
  assert.deepEqual(sent[1].image, { link: "https://x/p.png", caption: "Plan" });
  assert.equal(sent[1].recipient, "MY.123");
  await assert.rejects(sendWhatsApp(cfg, "601", { file: { kind: "document", link: "" } }, { fetchImpl }));
});

function workerDeps({ docs = DOCS.map((d) => ({ ...d, storage_path: `docs/${d.id}/f` })), mode = "ai", recent = [] } = {}) {
  const rows = [], sent = [], signed = [];
  const d = {
    db: {
      get: async (p) => {
        if (p.startsWith("ai_documents")) { const id = p.match(/id=eq\.([^&]+)/)[1]; return docs.filter((x) => x.id === id && /share_with_customers=eq\.true/.test(p)); }
        if (p.startsWith("ai_messages?conversation_id")) return /media=cs\./.test(p) && recent.some((id) => decodeURIComponent(p).includes(id)) ? [{ id: "m" }] : [];
        if (p.startsWith("ai_messages?source_job_id")) return [];
        if (p.startsWith("ai_conversations")) return [{ mode, status: "open", lead: { ai_paused: false, closed_at: null } }];
        return [];
      },
      post: async (p, b) => { const r = { id: "row" + rows.length, ...b }; rows.push(r); return [r]; },
      patch: async (p, b) => { const id = p.match(/id=eq\.([^&]+)/)?.[1]; const r = rows.find((x) => x.id === id); if (r) Object.assign(r, b); },
    },
    wa: { send: async (to, msg) => { sent.push({ to, msg }); return "wamid." + sent.length; } },
    knowledgeFiles: { sign: async (path, s) => { signed.push([path, s]); return `https://sb/storage/v1/object/sign/ai-docs/${path}?token=t`; } },
    now: () => NOW,
  };
  return { d, rows, sent, signed };
}
const conv = { id: "C1" };

test("worker: the chosen file is sent after the reply by a 1-hour signed link, recorded with its document id", async () => {
  const { d, rows, sent, signed } = workerDeps();
  const r = await sendFiles(d, { conversation: conv, to: "60123456789", files: [{ document_id: "d-aurora" }, { document_id: "d-plan" }], jobId: "11111111-1111-4111-8111-111111111111" });
  assert.deepEqual(r.map((x) => x.sent), [true, true]);
  assert.deepEqual(sent[0].msg.file, { kind: "document", link: "https://sb/storage/v1/object/sign/ai-docs/docs/d-aurora/f?token=t", filename: "M Aurora E-Pamphlet.pdf", caption: "M Aurora E-Pamphlet" });
  assert.equal(sent[1].msg.file.kind, "image");
  assert.deepEqual(signed[0], ["docs/d-aurora/f", 3600]);
  assert.equal(rows[0].body, "[document] M Aurora E-Pamphlet.pdf");
  assert.deepEqual(rows[0].media, [{ type: "document", document_id: "d-aurora", title: "M Aurora E-Pamphlet.pdf" }]);
  assert.equal(rows[0].status, "sent");
  assert.match(rows[0].source_job_id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "one fixed key per job and file");
  assert.notEqual(rows[0].source_job_id, rows[1].source_job_id);
});

test("worker: no file once sharing is switched off, none twice within 10 minutes, none after a person takes over", async () => {
  const off = workerDeps({ docs: [] });
  assert.deepEqual((await sendFiles(off.d, { conversation: conv, to: "6012", files: [{ document_id: "d-aurora" }], jobId: "j" })).map((x) => x.reason), ["no longer shareable"]);
  assert.equal(off.sent.length, 0);
  const again = workerDeps({ recent: ["d-aurora"] });
  assert.deepEqual((await sendFiles(again.d, { conversation: conv, to: "6012", files: [{ document_id: "d-aurora" }], jobId: "j" })).map((x) => x.reason), ["just sent"]);
  const human = workerDeps({ mode: "human" });
  const r = await sendFiles(human.d, { conversation: conv, to: "6012", files: [{ document_id: "d-aurora" }, { document_id: "d-plan" }], jobId: "j" });
  assert.equal(human.sent.length, 0);
  assert.equal(r.length, 1, "stops at the first blocked file");
  assert.equal(human.rows[0].status, "skipped");
  assert.equal(human.signed.length, 0, "no link is even made");
  const noStore = workerDeps(); delete noStore.d.knowledgeFiles;
  assert.deepEqual(await sendFiles(noStore.d, { conversation: conv, to: "6012", files: [{ document_id: "d-aurora" }], jobId: "j" }), []);
});

/* ---------- Read with AI ---------- */
const DOC = "22222222-2222-2222-2222-222222222222";
const call = (deps, body) => readPages(new Request("https://x/api/sales/knowledge/read", { method: "POST", body: JSON.stringify(body) }), {}, deps);
const page = (n) => ({ n, mime: "image/jpeg", data: Buffer.from("jpeg" + n).toString("base64") });
function readDeps({ role = "manager", cap = { allowed: true }, data } = {}) {
  const llm = llmWith(data || { readable: true, warnings: ["Price on page 2 partly hidden"], entries: [
    { page: 1, title: "M AURORA overview", content: "Developer: Mah Sing. Freehold. Contact Encik Ali 900101-14-5678.\nSource: M Aurora E-Pamphlet.pdf, page 1" },
    { page: 9, title: "Type A", content: "850 sq ft, 3 bedrooms. Source: page 2" }, { page: 2, title: "", content: "x" }] });
  return { llm, deps: { getCaller: async () => (role ? { email: "m@x", role } : null), llm, userDb: { get: async (p) => (p.startsWith("ai_documents") && p.includes(DOC) ? [{ id: DOC, title: "M Aurora E-Pamphlet.pdf", project_id: "aur" }] : []), rpc: async () => cap } } };
}
const withEnv = async (fn) => { const b = { ...process.env }; process.env.AI_SALES_ENABLED = "true"; try { await fn(); } finally { process.env = b; } };

test("Read with AI: managers only; 1–3 page images per request; entries returned for staff to approve", () => withEnv(async () => {
  assert.equal(config.path, "/api/sales/knowledge/read");
  assert.equal((await call(readDeps({ role: null }).deps, {})).status, 401);
  assert.equal((await call(readDeps({ role: "advisor" }).deps, { document_id: DOC, pages: [page(1)] })).status, 403);
  const { deps, llm } = readDeps();
  assert.equal((await call(deps, { document_id: DOC, pages: [] })).status, 400);
  assert.equal((await call(deps, { document_id: DOC, pages: [page(1), page(2), page(3), page(4)] })).status, 400);
  assert.equal((await call(deps, { document_id: "33333333-3333-3333-3333-333333333333", pages: [page(1)] })).status, 404);
  assert.equal((await call(deps, { document_id: DOC, pages: [{ n: 1, mime: "image/jpeg", data: Buffer.alloc(1.6 * 1048576).toString("base64") }] })).status, 413);

  const r = await (await call(deps, { document_id: DOC, pages: [page(1), page(2)] })).json();
  const content = llm.calls[0].messages[0].content;
  assert.deepEqual(content.map((c) => c.type), ["text", "image", "text", "image", "text"]);
  assert.equal(content[0].text, "Page 1:");
  assert.equal(content[1].source.media_type, "image/jpeg");
  assert.match(content.at(-1).text, /M Aurora E-Pamphlet\.pdf/);
  assert.equal(llm.calls[0].schema, PAGES_SCHEMA);
  assert.match(PAGES_SYSTEM, /Copy names, figures, units .* exactly as printed/);
  assert.equal(r.entries.length, 2, "an entry without a title is dropped");
  assert.equal(r.entries[1].page, 1, "a page number not sent falls back to the first page");
  assert.doesNotMatch(r.entries[0].content, /900101/, "IC numbers masked");
  assert.deepEqual(r.warnings, ["Price on page 2 partly hidden"]);
}));

test("Read with AI: the daily AI limit applies; an unreadable page returns no entries", () => withEnv(async () => {
  assert.equal((await call(readDeps({ cap: { allowed: false, cap: 200 } }).deps, { document_id: DOC, pages: [page(1)] })).status, 429);
  const r = await (await call(readDeps({ data: { readable: false, entries: [], warnings: ["Not a property document"] } }).deps, { document_id: DOC, pages: [page(1)] })).json();
  assert.equal(r.readable, false);
  assert.deepEqual(r.entries, []);
}));
