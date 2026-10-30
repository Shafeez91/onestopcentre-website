// AI Sales — AI test console: runs the full AI pipeline on a buyer message and returns the draft, the
// business-rule check and the CRM changes it WOULD make. Simulation only: nothing is sent and no lead is changed.
//
// Netlify ends this request at 30 seconds (the 504s of 29 Oct were all cut at 30.4–31.3 s). One step therefore never
// does more than fits: the reply has a time budget, and a reply that wants web research continues in two more
// requests, each with its own budget — the research, then a second draft with what was found. The browser chains
// them with a signed token (continuation.mjs).
import { randomUUID } from "node:crypto";
import { json, getCaller, hasRole, moduleEnabled, disabled, userDb, serviceDb } from "../../ai-sales/lib/server.mjs";
import { callClaude, LlmError } from "../../ai-sales/lib/llm.mjs";
import { researchDeps } from "../../ai-sales/lib/live.mjs";
import { respond, logRun } from "../../ai-sales/lib/orchestrator.mjs";
import { webResearch } from "../../ai-sales/lib/research.mjs";
import { bindingOf, signContinuation, verifyContinuation } from "../../ai-sales/lib/continuation.mjs";

const MAX_HISTORY = 30;
export const BUDGET_MS = 23000;   // the reply: leaves time to log the run and answer before the 30-second cut-off
// the web research step on its own: it does nothing else, so it may use most of the 30 s. Measured 29 Oct: 21 s was
// not enough for 3 searches + 2 page reads (0 results), so the console asks for 2 searches and 1 page read
export const WEB_MS = 26000;
const WEB_LIMITS = { maxSearches: 2, maxFetches: 1 };

// one structured line per step: timings and outcome only, never the buyer's words or any key
const logLine = (o) => console.log(JSON.stringify({ evt: "ai_simulate", ...o }));
const webTrace = (w) => (w ? { question: w.question, found: !!w.found, sources: w.sources || [], searches: w.searches || 0, ...(w.error ? { error: w.error } : {}) } : null);

export default async (req, context, deps = {}) => {
  if (!moduleEnabled()) return disabled();
  const caller = await getCaller(req);
  if (!caller) return json({ error: "Sign in required" }, 401);
  if (!hasRole(caller.role, "advisor")) return json({ error: "Advisors, managers and owners only" }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const message = String(body?.message || "").trim().slice(0, 2000);
  if (!message) return json({ error: "Type a buyer message first." }, 400);
  const leadId = /^[0-9a-f-]{36}$/i.test(body?.lead_id || "") ? body.lead_id : null;
  const history = (Array.isArray(body?.history) ? body.history : []).slice(-MAX_HISTORY)
    .map((h) => ({ role: h?.role === "assistant" ? "assistant" : "user", text: String(h?.text || "").slice(0, 2000) })).filter((h) => h.text);
  const rid = randomUUID(), t0 = Date.now(), bind = bindingOf(caller, message, history);
  const llm = deps.llm || ((p) => callClaude(p));
  const research = deps.research || researchDeps(serviceDb());

  // a later step of a turn that needs web research
  let cont = null;
  if (body?.continue) {
    cont = verifyContinuation(body.continue, bind);
    if (!cont) return json({ error: "This research step has expired or does not match the message. Send the message again.", request_id: rid }, 400);
  }

  try {
    if (cont?.step === "research") {
      const web = await webResearch({ research: research?.research, webTimeoutMs: WEB_MS, ...WEB_LIMITS }, { question: cont.q, projectNames: cont.pn || [] });
      const ms = Date.now() - t0;
      logLine({ rid, step: "research", found: !!web?.found, searches: web?.searches || 0, error: web?.error ? "yes" : undefined, web_ms: ms });
      const next = web?.found ? signContinuation({ step: "redraft", bind, web }) : null;
      return json({ request_id: rid, step: "research", research: { web: webTrace(web) }, timings: { web_ms: ms, total_ms: ms },
        ...(next ? { continuation: { step: "redraft", token: next } } : { done: true }) });
    }

    const db = userDb(caller);
    // the same research tools as live WhatsApp (map results are cached with the service role; nothing is sent)
    const result = await respond({ db, llm, reserve: cont ? null : () => db.rpc("ai_reserve_ai_call", {}), leadId, message, history, mode: "simulate",
      research, budgetMs: BUDGET_MS, deferWeb: true, ...(cont?.step === "redraft" ? { _prior: { web: cont.web } } : {}),
      financingInputs: body?.financing_inputs && typeof body.financing_inputs === "object" ? body.financing_inputs : null });
    // research the draft asked for runs as the next step, if the token can be signed
    let continuation = null;
    if (result.pending_research && !cont) {
      const token = signContinuation({ step: "research", bind, q: result.pending_research.question, pn: result.pending_research.projectNames });
      if (token) continuation = { step: "research", token };
    }
    const svc = serviceDb();
    const runId = svc ? await logRun(svc, { result, leadId, channel: "simulate", input: { by: caller.email, request_id: rid, step: cont?.step || "reply" } }) : null;
    logLine({ rid, step: cont?.step || "reply", decision: result.decision, error_kind: result.errorKind || undefined, timings: result.timings, continues: !!continuation });
    return json({ ...result, run_id: runId, request_id: rid, step: cont?.step || "reply", simulated: true, ...(continuation ? { continuation } : {}) });
  } catch (e) {
    logLine({ rid, step: cont?.step || "reply", error_kind: e?.kind || "error", total_ms: Date.now() - t0 });
    if (e instanceof LlmError && e.kind === "config") return json({ error: e.message, setup_needed: "ANTHROPIC_API_KEY", request_id: rid }, 501);
    return json({ error: "The AI test could not run: " + (e?.message || e), request_id: rid }, 502);
  }
};

// Each simulated turn calls the AI model, so cap how fast the console can be used.
export const config = { path: "/api/sales/ai/simulate", method: ["POST"], rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] } };
