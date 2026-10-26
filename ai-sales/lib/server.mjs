// Shared server-side helpers for the AI Sales Netlify Functions. Zero dependencies.
// Secrets are read from Netlify environment variables only and never returned to the browser.

// Public by design (same values the website already ships); override with env if the project moves.
const DEFAULT_SB_URL = "https://deethrwnmyezwsohmhzl.supabase.co";
const DEFAULT_SB_ANON = "sb_publishable_gaiT2UF6vtI42BbYH1egKg_T_yLT83g";

export const env = (k) => {
  const v = globalThis.Netlify?.env?.get?.(k) ?? globalThis.process?.env?.[k];
  return v === undefined || v === "" ? undefined : v;
};
export const sbUrl = () => (env("SUPABASE_URL") || DEFAULT_SB_URL).replace(/\/+$/, "");
export const sbAnon = () => env("SUPABASE_ANON_KEY") || DEFAULT_SB_ANON;

/** Server kill switch. Anything other than "true" keeps every AI Sales function inert. */
export const moduleEnabled = () => String(env("AI_SALES_ENABLED") || "").toLowerCase() === "true";

const ROLE_RANK = { viewer: 1, advisor: 2, manager: 3, owner: 4 };
export const hasRole = (role, min) => (ROLE_RANK[role] || 0) >= (ROLE_RANK[min] || 99);

export const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...extra },
  });

export const disabled = () => json({ error: "AI Sales server functions are switched off (AI_SALES_ENABLED is not \"true\")." }, 503);

/**
 * Identifies the signed-in staff member from their Supabase access token.
 * The token is validated by Supabase Auth; the role comes from public.ai_role() under that user's RLS.
 */
export async function getCaller(req) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const token = m[1];
  const headers = { apikey: sbAnon(), authorization: "Bearer " + token };
  try {
    const [u, r] = await Promise.all([
      fetch(sbUrl() + "/auth/v1/user", { headers }),
      fetch(sbUrl() + "/rest/v1/rpc/ai_role", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" }),
    ]);
    if (!u.ok || !r.ok) return null;
    const user = await u.json();
    const role = await r.json();
    if (!user?.email || !ROLE_RANK[role]) return null;
    return { email: String(user.email).toLowerCase(), id: user.id, role, token };
  } catch {
    return null;
  }
}

/** PostgREST call as the signed-in user (RLS applies). */
export async function asUser(caller, path, init = {}) {
  return fetch(sbUrl() + "/rest/v1/" + path, {
    ...init,
    headers: { apikey: sbAnon(), authorization: "Bearer " + caller.token, "content-type": "application/json", ...(init.headers || {}) },
  });
}

/** Service-role call (bypasses RLS). Only for server work that has already checked permissions. */
export async function asService(path, init = {}) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new ConfigError("SUPABASE_SERVICE_ROLE_KEY is not set in Netlify environment variables (Functions scope).");
  return fetch(sbUrl() + path, {
    ...init,
    headers: { apikey: key, authorization: "Bearer " + key, "content-type": "application/json", ...(init.headers || {}) },
  });
}

export class ConfigError extends Error {}

/** Writes a custom action to the audit trail as the signed-in user. Never throws. */
export async function audit(caller, action, details = {}) {
  try {
    await asService("/rest/v1/ai_audit_logs", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ actor: caller?.email || "system", action, table_name: details.table || null, record_id: details.id || null, changes: details }),
    });
  } catch { /* audit must not break the request */ }
}

export const isEmail = (s) => typeof s === "string" && s.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/** Minimal PostgREST adapter used by the AI orchestrator: { get, post, patch, rpc }. */
function dbAdapter(request) {
  const call = async (path, init = {}) => {
    const r = await request(path, init);
    if (!r.ok) throw new Error(`Database error ${r.status} on ${path.split("?")[0]}: ${(await r.text()).slice(0, 200)}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };
  return {
    get: (path) => call("/rest/v1/" + path),
    post: (path, body, { prefer = "return=minimal" } = {}) => call("/rest/v1/" + path, { method: "POST", headers: { prefer }, body: JSON.stringify(body) }),
    patch: (path, body) => call("/rest/v1/" + path, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify(body) }),
    rpc: (name, args) => call("/rest/v1/rpc/" + name, { method: "POST", body: JSON.stringify(args || {}) }),
  };
}
/** Reads and writes as the signed-in staff member (RLS applies). */
export const userDb = (caller) => dbAdapter((path, init) => fetch(sbUrl() + path, { ...init, headers: { apikey: sbAnon(), authorization: "Bearer " + caller.token, "content-type": "application/json", ...(init.headers || {}) } }));
/** Service-role access; only after the caller's permission has been checked. Returns null when the key is not configured. */
export const serviceDb = () => (env("SUPABASE_SERVICE_ROLE_KEY") ? dbAdapter((path, init) => asService(path, init)) : null);
