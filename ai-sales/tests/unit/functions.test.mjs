// Netlify Functions for the AI Sales module, with Supabase replaced by a fake fetch.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import health, { config as healthConfig } from "../../../netlify/functions/sales-health.mjs";
import invite, { config as inviteConfig } from "../../../netlify/functions/sales-team.mjs";

const realFetch = globalThis.fetch;
let calls, users, envBackup;
const USERS = { "tok-owner": ["owner@test.local", "owner"], "tok-adv": ["adv@test.local", "advisor"], "tok-mgr": ["mgr@test.local", "manager"] };

beforeEach(() => {
  calls = [];
  users = USERS;
  envBackup = { ...process.env };
  for (const k of ["AI_SALES_ENABLED", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "WHATSAPP_ACCESS_TOKEN"]) delete process.env[k];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), auth = init.headers?.authorization || "";
    calls.push({ u, init });
    const tok = auth.replace(/^Bearer /, "");
    if (u.endsWith("/auth/v1/user")) return users[tok] ? Response.json({ id: "x", email: users[tok][0] }) : new Response("bad jwt", { status: 401 });
    if (u.endsWith("/rest/v1/rpc/ai_role")) return users[tok] ? Response.json(users[tok][1]) : new Response("bad", { status: 401 });
    if (u.includes("/rest/v1/ai_settings")) return Response.json([{ id: 1 }]);
    if (u.includes("/rest/v1/ai_team_members")) return new Response(null, { status: 201 });
    if (u.endsWith("/auth/v1/invite")) return Response.json({ id: "new" });
    if (u.includes("/rest/v1/ai_audit_logs")) return new Response(null, { status: 201 });
    throw new Error("unexpected " + u);
  };
});
afterEach(() => { globalThis.fetch = realFetch; process.env = envBackup; });

const req = (path, token, init = {}) =>
  new Request("https://onestopcentreproperty.com" + path, { ...init, headers: { ...(token ? { authorization: "Bearer " + token } : {}), "content-type": "application/json" } });

test("functions live under /api/sales/ only", () => {
  assert.equal(healthConfig.path, "/api/sales/health");
  assert.equal(inviteConfig.path, "/api/sales/team/invite");
});

test("health: requires sign-in and manager role", async () => {
  assert.equal((await health(req("/api/sales/health"))).status, 401);
  assert.equal((await health(req("/api/sales/health", "tok-bad"))).status, 401);
  assert.equal((await health(req("/api/sales/health", "tok-adv"))).status, 403);
});

test("health: reports configuration as booleans only and the kill-switch state", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-secret-value";
  let r = await health(req("/api/sales/health", "tok-mgr"));
  assert.equal(r.status, 200);
  let b = await r.json();
  assert.equal(b.server_enabled, false, "off by default");
  assert.equal(b.configured.llm_anthropic, true);
  assert.equal(b.configured.whatsapp_access_token, false);
  assert.equal(b.database, "ok");
  assert.ok(!JSON.stringify(b).includes("sk-secret-value"), "secret never returned");
  assert.equal(r.headers.get("cache-control"), "no-store");
  process.env.AI_SALES_ENABLED = "true";
  b = await (await health(req("/api/sales/health", "tok-mgr"))).json();
  assert.equal(b.server_enabled, true);
});

test("invite: blocked while the kill switch is off", async () => {
  const r = await invite(req("/api/sales/team/invite", "tok-owner", { method: "POST", body: "{}" }));
  assert.equal(r.status, 503);
  assert.equal(calls.length, 0, "no database or auth calls when disabled");
});

test("invite: owner only, validates input, saves role then sends invitation", async () => {
  process.env.AI_SALES_ENABLED = "true";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-secret";
  const body = JSON.stringify({ email: "New.Advisor@Example.test", role: "advisor" });
  assert.equal((await invite(req("/api/sales/team/invite", "tok-mgr", { method: "POST", body }))).status, 403);
  assert.equal((await invite(req("/api/sales/team/invite", "tok-owner", { method: "POST", body: JSON.stringify({ email: "x", role: "advisor" }) }))).status, 400);
  assert.equal((await invite(req("/api/sales/team/invite", "tok-owner", { method: "POST", body: JSON.stringify({ email: "a@b.co", role: "god" }) }))).status, 400);
  const r = await invite(req("/api/sales/team/invite", "tok-owner", { method: "POST", body }));
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.email, "new.advisor@example.test");
  assert.equal(b.invited, true);
  const save = calls.find((c) => c.u.includes("ai_team_members"));
  assert.equal(save.init.headers.authorization, "Bearer tok-owner", "role saved under the owner's own RLS, not the service key");
  const inv = calls.find((c) => c.u.endsWith("/auth/v1/invite"));
  assert.equal(inv.init.headers.authorization, "Bearer service-secret");
});

test("invite: without the service key the role is still saved and the owner is told what to do", async () => {
  process.env.AI_SALES_ENABLED = "true";
  const r = await invite(req("/api/sales/team/invite", "tok-owner", { method: "POST", body: JSON.stringify({ email: "v@example.test", role: "viewer" }) }));
  const b = await r.json();
  assert.equal(b.ok, true);
  assert.equal(b.invited, false);
  assert.match(b.note, /SUPABASE_SERVICE_ROLE_KEY/);
});

test("health: account labels follow what actually happened (latest AI call, calendar settings)", async () => {
  const { syncAccounts } = await import("../../../netlify/functions/sales-health.mjs");
  const run = (runs) => { const patches = []; const db = { get: async () => runs, patch: async (path, body) => { patches.push([path, body]); } }; return { db, patches }; };
  const on = { llm_anthropic: true, google_calendar_id: false, google_service_account: false };
  let t = run([{ created_at: "2026-10-27T01:36:19Z", error: null }]);
  await syncAccounts(t.db, on);
  assert.deepEqual(t.patches[0], ["ai_integration_accounts?provider=eq.anthropic", { status: "healthy", last_checked_at: "2026-10-27T01:36:19Z", last_error: null }]);
  assert.deepEqual(t.patches[1], ["ai_integration_accounts?provider=eq.google_calendar", { status: "not_configured" }]);
  t = run([{ created_at: "2026-10-27T02:00:00Z", error: "Anthropic API 401: invalid x-api-key" }]);
  await syncAccounts(t.db, on);
  assert.equal(t.patches[0][1].status, "error");
  assert.match(t.patches[0][1].last_error, /invalid x-api-key/);
  t = run([]);
  await syncAccounts(t.db, { ...on, google_calendar_id: true, google_service_account: true });
  assert.equal(t.patches[0][1].status, "configured", "key set but no AI call yet");
  assert.deepEqual(t.patches[1], ["ai_integration_accounts?provider=eq.google_calendar&status=eq.not_configured", { status: "configured" }], "never overwrites a real calendar result");
  t = run([]);
  await syncAccounts(t.db, { ...on, llm_anthropic: false });
  assert.equal(t.patches[0][1].status, "not_configured");
});

test("version endpoint: only the deploy id, never cached, no sign-in needed", async () => {
  const { default: version, config } = await import("../../../netlify/functions/sales-version.mjs");
  const res = await version(new Request("https://x/api/sales/version"), { deploy: { id: "d123" } });
  assert.deepEqual(await res.json(), { deploy: "d123" });
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual([config.path, config.method], ["/api/sales/version", ["GET"]]);
});

test("health: 'Test Google Maps' runs one lookup with the server key (never returned) and reports a missing key plainly", async () => {
  let b = await (await health(req("/api/sales/health?maps_test=1", "tok-mgr"))).json();
  assert.deepEqual(b, { ok: false, error: "GOOGLE_MAPS_API_KEY is not set in Netlify (Functions scope)." });
  assert.equal((await health(req("/api/sales/health?maps_test=1", "tok-adv"))).status, 403, "managers and owners only");
  process.env.GOOGLE_MAPS_API_KEY = "maps-secret-key";
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/rest/v1/projects")) return Response.json([{ id: "mm", slug: "m-mira", data: { n: "M MIRA", l: "Wangsa Maju", latlng: "3.19899, 101.73702" } }]);
    if (u.includes("places:searchText")) { assert.equal(init.headers["x-goog-api-key"], "maps-secret-key"); return Response.json({ places: [{ id: "P1", displayName: { text: "Sri Rampai LRT Station" }, formattedAddress: "KL", location: { latitude: 3.1993, longitude: 101.7373 }, types: ["subway_station"] }] }); }
    if (u.includes("computeRoutes")) return Response.json({ routes: [{ distanceMeters: 2350, duration: "1860s" }] });
    return inner(url, init);
  };
  b = await (await health(req("/api/sales/health?maps_test=1", "tok-mgr"))).json();
  assert.equal(b.ok, true);
  assert.equal(b.lookup.to, "Sri Rampai LRT Station (KL)");
  assert.equal(b.lookup.routes[0].distance, "2.4 km");
  assert.ok(!JSON.stringify(b).includes("maps-secret-key"), "the key is never returned");
});
