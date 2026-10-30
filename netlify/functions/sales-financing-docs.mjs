// AI Sales — financing documents on the lead page (advisors and above): upload a payslip, CCRIS report or bank
// statement, have the AI read its figures, view the file, confirm the figures, or delete it. The files live in a
// private bucket only this function can reach and are deleted after the retention period (30 days by default).
// Nothing here is sent to the buyer, and nothing is calculated until a staff member saves the calculator.
import { randomUUID } from "node:crypto";
import { json, getCaller, hasRole, moduleEnabled, disabled, userDb, serviceDb, audit } from "../../ai-sales/lib/server.mjs";
import { callClaude, LlmError } from "../../ai-sales/lib/llm.mjs";
import { docStorage, readDocument } from "../../ai-sales/lib/documents.mjs";
import { DOC_KINDS, DOC_MIME, DOC_MAX_BYTES } from "../../sales/shared/finance-docs.mjs";

export const READ_MS = 25000;   // the AI reading: leaves time to store it before Netlify's 30-second cut-off
const UUID = /^[0-9a-f-]{36}$/i;
const EXT = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const logLine = (o) => console.log(JSON.stringify({ evt: "ai_financing_doc", ...o })); // never figures or file contents
const ROW = "id,lead_id,kind,file_name,mime,size_bytes,status,extracted,error,model,uploaded_by,read_at,confirmed_by,confirmed_at,created_at,expires_at";

export default async (req, context, deps = {}) => {
  if (!moduleEnabled()) return disabled();
  const caller = await (deps.getCaller || getCaller)(req);
  if (!caller) return json({ error: "Sign in required" }, 401);
  if (!hasRole(caller.role, "advisor")) return json({ error: "Advisors, managers and owners only" }, 403);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON (is the file larger than 4 MB?)" }, 400); }
  const db = deps.db || serviceDb(), udb = deps.userDb || userDb(caller), storage = deps.storage || docStorage();
  if (!db) return json({ error: "SUPABASE_SERVICE_ROLE_KEY is not set" }, 500);
  const settings = (await db.get("ai_settings?id=eq.1&select=flags"))?.[0] || {};
  if (settings.flags?.financing_documents === false) return json({ error: "Financing documents are switched off in Settings." }, 403);
  const llm = deps.llm || ((p) => callClaude(p));
  const action = String(body?.action || "");
  const t0 = Date.now();

  // the document must exist; the lead must be one the caller can see
  const loadDoc = async () => {
    if (!UUID.test(body?.id || "")) return null;
    return (await db.get(`ai_financing_documents?id=eq.${body.id}&select=${ROW},storage_path`))?.[0] || null;
  };

  try {
    if (action === "upload") {
      const leadId = UUID.test(body?.lead_id || "") ? body.lead_id : null;
      const kind = DOC_KINDS[body?.kind] ? body.kind : null;
      const mime = DOC_MIME.includes(body?.mime) ? body.mime : null;
      if (!leadId || !kind) return json({ error: "Choose the document type." }, 400);
      if (!mime) return json({ error: "Only PDF, JPG, PNG or WEBP files." }, 400);
      const bytes = Buffer.from(String(body?.data || ""), "base64");
      if (!bytes.length) return json({ error: "The file is empty." }, 400);
      if (bytes.length > DOC_MAX_BYTES) return json({ error: "The file is larger than 4 MB. Upload a smaller scan or a photo." }, 413);
      if (!(await udb.get(`ai_leads?id=eq.${leadId}&select=id`))?.length) return json({ error: "Lead not found." }, 404);
      const id = randomUUID(), path = `${leadId}/${id}.${EXT[mime]}`;
      const fileName = String(body?.file_name || "document").replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 200) || "document";
      // the row first, so a stored file always has one (and is purged with it)
      await db.post("ai_financing_documents", { id, lead_id: leadId, kind, file_name: fileName, mime, size_bytes: bytes.length, storage_path: path, uploaded_by: caller.email });
      try { await storage.put(path, bytes, mime); }
      catch (e) { await db.rpc("ai_financing_docs_purged", { p_ids: [id] }).catch(() => {}); throw e; }
      await audit(caller, "financing_doc_upload", { table: "ai_financing_documents", id, lead_id: leadId, kind });
      logLine({ action, kind, mime, bytes: bytes.length, ms: Date.now() - t0 });
      return json({ document: (await db.get(`ai_financing_documents?id=eq.${id}&select=${ROW}`))?.[0] });
    }

    const doc = await loadDoc();
    if (!doc || !doc.lead_id || !(await udb.get(`ai_leads?id=eq.${doc.lead_id}&select=id`))?.length) return json({ error: "Document not found (it may have expired)." }, 404);

    if (action === "read") {
      const cap = await udb.rpc("ai_reserve_ai_call", {});
      if (cap && cap.allowed === false) return json({ error: `The AI daily limit (${cap.cap}) is reached. Try again tomorrow or raise it in Settings.` }, 429);
      const bytes = await storage.get(doc.storage_path);
      let out;
      try { out = await readDocument({ llm, file: { bytes, mime: doc.mime, kind: doc.kind }, deadline: t0 + READ_MS }); }
      catch (e) {
        const kind = e instanceof LlmError ? e.kind : "error";
        await db.patch(`ai_financing_documents?id=eq.${doc.id}`, { status: "failed", error: String(e?.message || e).slice(0, 300) });
        logLine({ action, kind: doc.kind, error_kind: kind, ms: Date.now() - t0 });
        if (kind === "config") return json({ error: e.message, setup_needed: "ANTHROPIC_API_KEY" }, 501);
        return json({ error: kind === "timeout" ? "The AI took too long to read this file. Try again, or upload a clearer photo of one page." : "The AI could not read this file: " + (e?.message || e) }, 502);
      }
      const ex = out.extraction;
      const status = ex.readable && ex.document_kind !== "other" ? "read" : "unreadable";
      await db.patch(`ai_financing_documents?id=eq.${doc.id}`, { status, extracted: ex, error: null, model: out.model, read_at: new Date().toISOString() });
      await audit(caller, "financing_doc_read", { table: "ai_financing_documents", id: doc.id, lead_id: doc.lead_id, status });
      logLine({ action, kind: doc.kind, read_as: ex.document_kind, status, confidence: ex.confidence, ms: Date.now() - t0 });
      return json({ document: (await db.get(`ai_financing_documents?id=eq.${doc.id}&select=${ROW}`))?.[0] });
    }

    if (action === "view") {
      const url = await storage.sign(doc.storage_path, 60);
      await audit(caller, "financing_doc_view", { table: "ai_financing_documents", id: doc.id, lead_id: doc.lead_id });
      return json({ url, expires_in: 60 });
    }

    if (action === "confirm") {
      if (doc.status !== "read" && doc.status !== "confirmed") return json({ error: "Only a document the AI has read can be confirmed." }, 409);
      await db.patch(`ai_financing_documents?id=eq.${doc.id}`, { status: "confirmed", confirmed_by: caller.email, confirmed_at: new Date().toISOString() });
      await audit(caller, "financing_doc_confirm", { table: "ai_financing_documents", id: doc.id, lead_id: doc.lead_id });
      return json({ ok: true });
    }

    if (action === "delete") {
      await storage.remove([doc.storage_path]);
      await db.rpc("ai_financing_docs_purged", { p_ids: [doc.id] });
      await audit(caller, "financing_doc_delete", { table: "ai_financing_documents", id: doc.id, lead_id: doc.lead_id });
      return json({ ok: true });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    logLine({ action, error_kind: "error", ms: Date.now() - t0 });
    return json({ error: "The document could not be processed: " + (e?.message || e) }, 502);
  }
};

// each "read" calls the AI model
export const config = { path: "/api/sales/financing/documents", method: ["POST"], rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] } };
