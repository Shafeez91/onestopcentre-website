// AI Sales — health and configuration check for the /sales/ dashboard.
// Reports which integrations are configured (true/false only — never the values), and refreshes the account
// statuses on the Integrations page from what actually happened (the latest AI call), so they are never stale.
import { env, json, getCaller, hasRole, moduleEnabled, asUser, serviceDb } from "../../ai-sales/lib/server.mjs";
import { mapsService } from "../../ai-sales/lib/maps.mjs";
import { renderLookup } from "../../ai-sales/lib/research.mjs";

const CONFIG_KEYS = {
  supabase_service_role: "SUPABASE_SERVICE_ROLE_KEY",
  llm_anthropic: "ANTHROPIC_API_KEY",
  whatsapp_access_token: "WHATSAPP_ACCESS_TOKEN",
  whatsapp_phone_number_id: "WHATSAPP_PHONE_NUMBER_ID",
  whatsapp_app_secret: "WHATSAPP_APP_SECRET",
  whatsapp_verify_token: "WHATSAPP_VERIFY_TOKEN",
  google_calendar_id: "GOOGLE_CALENDAR_ID",
  google_service_account: "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  google_private_key: "GOOGLE_PRIVATE_KEY",
  google_maps: "GOOGLE_MAPS_API_KEY",
};

/**
 * Anthropic: healthy/error from the latest run that called the model (runs answered by the safety rules alone have
 * no model), "configured" while there is none yet. Google Calendar: configured once its settings exist (the
 * private key may be in Supabase Vault instead of Netlify). WhatsApp keeps the result of its own connection check.
 */
export async function syncAccounts(db, configured) {
  const set = (provider, rec) => db.patch(`ai_integration_accounts?provider=eq.${provider}`, rec);
  if (!configured.llm_anthropic) await set("anthropic", { status: "not_configured", last_error: null });
  else {
    const run = (await db.get("ai_agent_runs?select=created_at,error&or=(model.not.is.null,error.not.is.null)&order=created_at.desc&limit=1"))?.[0];
    await set("anthropic", run ? { status: run.error ? "error" : "healthy", last_checked_at: run.created_at, last_error: run.error ? String(run.error).slice(0, 300) : null }
      : { status: "configured", last_error: null });
  }
  if (!configured.google_calendar_id || !configured.google_service_account) await set("google_calendar", { status: "not_configured" });
  else await db.patch("ai_integration_accounts?provider=eq.google_calendar&status=eq.not_configured", { status: "configured" });
}

export default async (req) => {
  const caller = await getCaller(req);
  if (!caller) return json({ error: "Sign in required" }, 401);
  if (!hasRole(caller.role, "manager")) return json({ error: "Managers and owners only" }, 403);

  // "Test Google Maps" on the Integrations page: one real lookup through the production code (no customer data)
  const u = new URL(req.url);
  if (u.searchParams.get("maps_test") === "1") {
    const key = env("GOOGLE_MAPS_API_KEY");
    if (!key) return json({ ok: false, error: "GOOGLE_MAPS_API_KEY is not set in Netlify (Functions scope)." });
    const rows = (await asUser(caller, "projects?select=id,slug,data&published=eq.true").then((r) => r.json()).catch(() => [])) || [];
    const pick = rows.find((r) => /mira/i.test(r.data?.n || "")) || rows[0];
    if (!pick) return json({ ok: false, error: "No published project to test with." });
    const d = pick.data || {};
    const dest = String(u.searchParams.get("to") || (/mira/i.test(d.n || "") ? "LRT Sri Rampai station" : "KLCC")).slice(0, 120);
    try {
      const l = await mapsService({ key, db: serviceDb() }).lookup({ project: { id: pick.id, name: String(d.n || "").trim(), area: d.l, latlng: d.latlng, map_url: d.mapUrl }, destination: dest, modes: ["walk", "drive"] });
      return json({ ok: l.routes.length > 0, lookup: renderLookup(l) });
    } catch (e) { return json({ ok: false, error: `${e.kind || "error"}: ${e.message}` }); }
  }

  let database = "unreachable";
  try {
    const r = await asUser(caller, "ai_settings?select=id&id=eq.1");
    database = r.ok ? "ok" : "error " + r.status;
  } catch { /* stays unreachable */ }

  const configured = Object.fromEntries(Object.entries(CONFIG_KEYS).map(([k, v]) => [k, Boolean(env(v))]));
  const db = serviceDb();
  if (db && moduleEnabled()) { try { await syncAccounts(db, configured); } catch { /* the page still shows the configuration */ } }
  return json({
    server_enabled: moduleEnabled(),
    database,
    configured,
    caller: { email: caller.email, role: caller.role },
    checked_at: new Date().toISOString(),
  });
};

export const config = { path: "/api/sales/health", method: ["GET"] };
