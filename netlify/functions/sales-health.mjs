// AI Sales — health and configuration check for the /sales/ dashboard.
// Reports which integrations are configured (true/false only — never the values).
import { env, json, getCaller, hasRole, moduleEnabled, asUser } from "../../ai-sales/lib/server.mjs";

const CONFIG_KEYS = {
  supabase_service_role: "SUPABASE_SERVICE_ROLE_KEY",
  llm_anthropic: "ANTHROPIC_API_KEY",
  whatsapp_access_token: "WHATSAPP_ACCESS_TOKEN",
  whatsapp_phone_number_id: "WHATSAPP_PHONE_NUMBER_ID",
  whatsapp_app_secret: "WHATSAPP_APP_SECRET",
  whatsapp_verify_token: "WHATSAPP_VERIFY_TOKEN",
  google_calendar_id: "GOOGLE_CALENDAR_ID",
  google_service_account: "GOOGLE_SERVICE_ACCOUNT_EMAIL",
};

export default async (req) => {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "Sign in required" }, 401);
  if (!hasRole(caller.role, "manager")) return json({ error: "Managers and owners only" }, 403);

  let database = "unreachable";
  try {
    const r = await asUser(caller, "ai_settings?select=id&id=eq.1");
    database = r.ok ? "ok" : "error " + r.status;
  } catch { /* stays unreachable */ }

  const configured = Object.fromEntries(Object.entries(CONFIG_KEYS).map(([k, v]) => [k, Boolean(env(v))]));
  return json({
    server_enabled: moduleEnabled(),
    database,
    configured,
    caller: { email: caller.email, role: caller.role },
    checked_at: new Date().toISOString(),
  });
};

export const config = { path: "/api/sales/health", method: ["GET"] };
