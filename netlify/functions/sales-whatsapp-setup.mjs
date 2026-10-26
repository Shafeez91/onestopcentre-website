// AI Sales — WhatsApp connection check and repair (owners only).
// check: token works, the phone number as Meta sees it, and whether the WhatsApp Business Account is linked
//        ("subscribed") to this app — Meta only forwards messages to the webhook of subscribed apps.
// subscribe: links the WhatsApp Business Account to the app that owns the token.
// The account id is optional: when it is missing, wrong or not reachable with the token, the account that holds
// WHATSAPP_PHONE_NUMBER_ID is looked up among the accounts the token was granted (Meta's debug_token).
import { env, json, getCaller, hasRole, moduleEnabled, disabled, serviceDb, audit } from "../../ai-sales/lib/server.mjs";
import { waConfig, graph } from "../../ai-sales/lib/whatsapp.mjs";

const attempt = async (fn) => { try { return { ok: true, data: await fn() }; } catch (e) { return { ok: false, error: e.message }; } };
const holdsPhone = (res, phoneNumberId) => res.ok && (res.data?.data || []).some((n) => String(n.id) === String(phoneNumberId));

/**
 * The WhatsApp Business Account ids the token was granted, and the one that holds the phone number (or null).
 * `tried` and `scopes` explain a failed search on the Integrations page (ids and permission names only, no secrets).
 */
async function findWaba(cfg) {
  const dbg = await attempt(() => graph(cfg, "GET", `debug_token?input_token=${encodeURIComponent(cfg.token)}`));
  if (!dbg.ok) return { waba: null, candidates: [], tried: [], scopes: null, error: dbg.error };
  const granted = dbg.data?.data?.granular_scopes || [];
  const candidates = [...new Set(granted.filter((s) => /^whatsapp_business_/.test(s.scope || ""))
    .flatMap((s) => s.target_ids || []).map(String))];
  const tried = [];
  for (const id of candidates) {
    const res = await attempt(() => graph(cfg, "GET", `${id}/phone_numbers?fields=id,display_phone_number`));
    if (holdsPhone(res, cfg.phoneNumberId)) return { waba: id, candidates, tried };
    tried.push({ id, numbers: res.ok ? (res.data?.data || []).map((n) => `${n.display_phone_number || "?"} (${n.id})`) : null, error: res.ok ? null : res.error });
  }
  return { waba: null, candidates, tried, scopes: (dbg.data?.data?.scopes || granted.map((s) => s.scope)).filter(Boolean) };
}

/** Plain-language reason the account was not found, listing what the token can see. */
function notFoundReason(cfg, entered, first, d) {
  const parts = [];
  if (entered && first && !first.ok) parts.push(`ID ${entered}: ${first.error}`);
  else if (entered && first) parts.push(`ID ${entered} does not hold phone number ID ${cfg.phoneNumberId}`);
  if (d.error) parts.push(`token check failed: ${d.error}`);
  else {
    if (d.scopes) parts.push(`token permissions: ${d.scopes.join(", ") || "none"}`);
    parts.push(d.tried.length ? "WhatsApp accounts the token can reach: " + d.tried.map((t) => `${t.id} → ${t.error || (t.numbers.length ? t.numbers.join(", ") : "no numbers")}`).join("; ")
      : "the token is not linked to any WhatsApp account (generate it with whatsapp_business_management after assigning the account to the system user)");
  }
  return `The WhatsApp account holding phone number ID ${cfg.phoneNumberId} was not found with this access token. ` + parts.join(". ") + ".";
}

export default async (req) => {
  if (!moduleEnabled()) return disabled();
  const caller = await getCaller(req);
  if (!caller) return json({ error: "Sign in required" }, 401);
  if (!hasRole(caller.role, "owner")) return json({ error: "Owners only" }, 403);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const cfg = waConfig(env);
  if (!cfg) return json({ error: "WhatsApp is not configured (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID)." }, 501);
  const entered = String(body?.waba_id || env("WHATSAPP_BUSINESS_ACCOUNT_ID") || "").trim();
  if (entered && !/^\d{5,25}$/.test(entered)) return json({ error: "The WhatsApp Business Account ID is numbers only (Meta → API Setup). Leave it empty to find it automatically." }, 400);

  // use the entered account when it holds the number; otherwise look for the right one
  let waba = entered, detected = null;
  const first = entered ? await attempt(() => graph(cfg, "GET", `${entered}/phone_numbers?fields=id`)) : null;
  if (!first || !holdsPhone(first, cfg.phoneNumberId)) {
    detected = await findWaba(cfg);
    if (detected.waba) waba = detected.waba;
  }
  // not found: explain why, unless the token could not even be inspected and an ID was entered (then the full check reports it)
  if (detected && !detected.waba && !(detected.error && entered)) {
    const error = notFoundReason(cfg, entered, first, detected);
    console.log("whatsapp setup:", error);
    return json({ error, candidates: detected.candidates, tried: detected.tried }, 404);
  }

  let linked = null;
  if (body?.action === "subscribe") {
    linked = await attempt(() => graph(cfg, "POST", `${waba}/subscribed_apps`));
    await audit(caller, "whatsapp_subscribe_app", { waba, ok: linked.ok, error: linked.error || null });
  }
  const [phone, numbers, apps] = await Promise.all([
    attempt(() => graph(cfg, "GET", `${encodeURIComponent(cfg.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,platform_type,status,code_verification_status,name_status`)),
    attempt(() => graph(cfg, "GET", `${waba}/phone_numbers?fields=id,display_phone_number`)),
    attempt(() => graph(cfg, "GET", `${waba}/subscribed_apps`)),
  ]);
  const subscribed = apps.ok ? (apps.data?.data || []).map((a) => ({ id: a.whatsapp_business_api_data?.id || a.id || null, name: a.whatsapp_business_api_data?.name || a.name || null })) : null;
  const phoneInAccount = numbers.ok ? (numbers.data?.data || []).some((n) => String(n.id) === String(cfg.phoneNumberId)) : null;
  const healthy = phone.ok && phoneInAccount === true && Array.isArray(subscribed) && subscribed.length > 0;

  // remember the account id and the outcome (non-secret) for the Integrations page
  const db = serviceDb();
  if (db) {
    try {
      await db.patch("ai_integration_accounts?provider=eq.whatsapp_cloud", { status: healthy ? "healthy" : "error", last_checked_at: new Date().toISOString(),
        last_error: healthy ? null : (phone.error || apps.error || numbers.error || (phoneInAccount === false ? "phone number is not in this WhatsApp Business Account" : "no app linked to the WhatsApp Business Account")),
        config: { waba_id: waba, phone_number_id: cfg.phoneNumberId, display_phone_number: phone.data?.display_phone_number || null } });
    } catch { /* the check result is still returned */ }
  }
  return json({
    healthy, waba_id: waba, entered_waba_id: entered || null, detected: !!(detected?.waba && detected.waba !== entered),
    candidates: detected ? detected.candidates : undefined, detect_error: detected?.error || undefined,
    phone: phone.ok ? phone.data : { error: phone.error },
    phone_in_account: phoneInAccount, numbers_error: numbers.ok ? null : numbers.error,
    subscribed_apps: subscribed, subscribed_error: apps.ok ? null : apps.error,
    linked: linked ? (linked.ok ? { ok: true } : { ok: false, error: linked.error }) : undefined,
  });
};

export const config = { path: "/api/sales/whatsapp/setup", method: ["POST"], rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] } };
