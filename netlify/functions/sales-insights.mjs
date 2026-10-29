// AI Sales — "Refresh summary" on the lead workspace: reads the lead's WhatsApp conversation and updates its client
// profile, summary and next best action through the same rules as live replies (nothing is sent to the buyer).
import { json, getCaller, hasRole, moduleEnabled, disabled, serviceDb } from "../../ai-sales/lib/server.mjs";
import { callClaude, LlmError } from "../../ai-sales/lib/llm.mjs";
import { summarizeLead } from "../../ai-sales/lib/insights.mjs";

export default async (req) => {
  if (!moduleEnabled()) return disabled();
  const caller = await getCaller(req);
  if (!caller) return json({ error: "Sign in required" }, 401);
  if (!hasRole(caller.role, "advisor")) return json({ error: "Advisors, managers and owners only" }, 403);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const leadId = /^[0-9a-f-]{36}$/i.test(body?.lead_id || "") ? body.lead_id : null;
  if (!leadId) return json({ error: "lead_id is required" }, 400);
  const db = serviceDb();
  if (!db) return json({ error: "SUPABASE_SERVICE_ROLE_KEY is not set" }, 500);
  try {
    const r = await summarizeLead({ db, llm: (p) => callClaude(p), now: () => new Date() }, leadId, { force: true, reserve: () => db.rpc("ai_reserve_ai_call", {}) });
    if (r.skipped) return json({ ok: false, note: r.skipped });
    return json({ ok: true, applied: r.applied });
  } catch (e) {
    if (e instanceof LlmError && e.kind === "config") return json({ error: e.message, setup_needed: "ANTHROPIC_API_KEY" }, 501);
    return json({ error: "The summary could not be refreshed: " + (e?.message || e) }, 502);
  }
};

// each refresh calls the AI model
export const config = { path: "/api/sales/ai/summary", method: ["POST"], rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] } };
