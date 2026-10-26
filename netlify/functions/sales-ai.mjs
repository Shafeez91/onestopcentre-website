// AI Sales — AI test console: runs the full AI pipeline on a buyer message and returns the draft, the
// business-rule check and the CRM changes it WOULD make. Simulation only: nothing is sent and no lead is changed.
import { json, getCaller, hasRole, moduleEnabled, disabled, userDb, serviceDb } from "../../ai-sales/lib/server.mjs";
import { callClaude, LlmError } from "../../ai-sales/lib/llm.mjs";
import { respond, logRun } from "../../ai-sales/lib/orchestrator.mjs";

const MAX_HISTORY = 30;

export default async (req) => {
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

  try {
    const db = userDb(caller);
    const result = await respond({ db, llm: (p) => callClaude(p), reserve: () => db.rpc("ai_reserve_ai_call", {}), leadId, message, history, mode: "simulate" });
    const svc = serviceDb();
    const runId = svc ? await logRun(svc, { result, leadId, channel: "simulate", input: { by: caller.email } }) : null;
    return json({ ...result, run_id: runId, simulated: true });
  } catch (e) {
    if (e instanceof LlmError && e.kind === "config") return json({ error: e.message, setup_needed: "ANTHROPIC_API_KEY" }, 501);
    return json({ error: "The AI test could not run: " + (e?.message || e) }, 502);
  }
};

// Each simulated turn calls the AI model, so cap how fast the console can be used.
export const config = { path: "/api/sales/ai/simulate", method: ["POST"], rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] } };
