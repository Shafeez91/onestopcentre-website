// AI Sales — Knowledge → Documents → "Read with AI" (managers and owners): reads brochure pages that have no
// selectable text (designed or scanned PDFs, photos) and returns knowledge entries for staff to review. The browser
// renders the pages to images and sends a few per request, so every request fits Netlify's 30-second limit. The
// entries are saved as drafts; the AI uses nothing from them until a person approves them.
import { json, getCaller, hasRole, moduleEnabled, disabled, userDb } from "../../ai-sales/lib/server.mjs";
import { callClaude, LlmError } from "../../ai-sales/lib/llm.mjs";
import { maskNumbers } from "../../sales/shared/finance-docs.mjs";

export const READ_MS = 25000;
export const MAX_PAGES_PER_CALL = 3;
const MAX_PAGE_BYTES = 1.5 * 1048576;
const UUID = /^[0-9a-f-]{36}$/i;
const logLine = (o) => console.log(JSON.stringify({ evt: "ai_knowledge_read", ...o }));

const obj = (props) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });
export const PAGES_SCHEMA = obj({
  readable: { type: "boolean" },
  entries: { type: "array", items: obj({ page: { type: "integer" }, title: { type: "string" }, content: { type: "string" } }) },
  warnings: { type: "array", items: { type: "string" } },
});

export const PAGES_SYSTEM = `You read pages of a Malaysian property brochure, e-pamphlet, price list or floor plan for a sales team's
knowledge base. Staff review every entry before the sales AI may use it.

Write knowledge entries from what the pages show:
- One entry per topic: project overview (name, developer, location, tenure, title, total units, towers, completion);
  each unit type or layout (built-up size, bedrooms, bathrooms, car parks, price as printed); facilities; location and
  nearby places with the distances or times printed; maintenance fee, booking fee, payment and sales packages;
  promotions with their conditions and dates; contact or showroom details printed for the project.
- Copy names, figures, units (sq ft, RM, km, minutes) and dates exactly as printed. Never estimate, convert, round or
  add anything that is not on the page. If a figure is unclear, leave it out and say so in warnings.
- Plain text, short lines, in the language printed (keep Malay as Malay). Title: a few words naming the topic and the
  project. content ends with "Source: <file name>, page N".
- page: the page number given with each image.
- Skip decoration, slogans and legal fine print, except disclaimers that change a figure (e.g. "prices subject to change").
- Never copy personal details (names or phone numbers of individuals, IC numbers). A company hotline or showroom number may stay.
- readable false and no entries when the pages are not a property document or cannot be read.`;

export default async (req, context, deps = {}) => {
  if (!moduleEnabled()) return disabled();
  const caller = await (deps.getCaller || getCaller)(req);
  if (!caller) return json({ error: "Sign in required" }, 401);
  if (!hasRole(caller.role, "manager")) return json({ error: "Managers and owners only" }, 403);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const docId = UUID.test(body?.document_id || "") ? body.document_id : null;
  const pages = (Array.isArray(body?.pages) ? body.pages : []).filter((p) => Number.isInteger(p?.n) && p.n > 0 && typeof p.data === "string" && /^image\/(jpeg|png)$/.test(p.mime || "image/jpeg"));
  if (!docId) return json({ error: "document_id is required" }, 400);
  if (!pages.length || pages.length > MAX_PAGES_PER_CALL) return json({ error: `Send 1 to ${MAX_PAGES_PER_CALL} pages per request.` }, 400);
  for (const p of pages) if (Buffer.byteLength(p.data, "base64") > MAX_PAGE_BYTES) return json({ error: `Page ${p.n} is too large.` }, 413);

  const udb = deps.userDb || userDb(caller);
  const doc = (await udb.get(`ai_documents?id=eq.${docId}&select=id,title,project_id`))?.[0];
  if (!doc) return json({ error: "Document not found." }, 404);
  const llm = deps.llm || ((p) => callClaude(p));
  const t0 = Date.now();
  try {
    const cap = await udb.rpc("ai_reserve_ai_call", {});
    if (cap && cap.allowed === false) return json({ error: `The AI daily limit (${cap.cap}) is reached. Try again tomorrow or raise it in Settings.` }, 429);
    const content = [];
    for (const p of pages) {
      content.push({ type: "text", text: `Page ${p.n}:` });
      content.push({ type: "image", source: { type: "base64", media_type: p.mime || "image/jpeg", data: p.data } });
    }
    content.push({ type: "text", text: `File name: ${String(doc.title).slice(0, 200)}. Write the knowledge entries for these pages.` });
    const r = await llm({ system: PAGES_SYSTEM, messages: [{ role: "user", content }], schema: PAGES_SCHEMA, maxTokens: 6000, effort: "low", retries: 1, deadline: t0 + READ_MS });
    const nums = new Set(pages.map((p) => p.n));
    const entries = (r.data?.entries || []).map((e) => ({
      page: nums.has(e.page) ? e.page : pages[0].n,
      title: maskNumbers(String(e.title || "").trim()).slice(0, 200),
      content: maskNumbers(String(e.content || "").trim()).slice(0, 8000),
    })).filter((e) => e.title && e.content).slice(0, 40);
    const warnings = (r.data?.warnings || []).map((w) => maskNumbers(String(w)).slice(0, 300)).slice(0, 10);
    logLine({ pages: pages.length, entries: entries.length, readable: !!r.data?.readable, ms: Date.now() - t0 });
    return json({ readable: !!r.data?.readable, entries, warnings });
  } catch (e) {
    const kind = e instanceof LlmError ? e.kind : "error";
    logLine({ pages: pages.length, error_kind: kind, ms: Date.now() - t0 });
    if (kind === "config") return json({ error: e.message, setup_needed: "ANTHROPIC_API_KEY" }, 501);
    return json({ error: kind === "timeout" ? "The AI took too long on these pages. Try again." : "The AI could not read these pages: " + (e?.message || e) }, 502);
  }
};

// each request calls the AI model
export const config = { path: "/api/sales/knowledge/read", method: ["POST"], rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] } };
