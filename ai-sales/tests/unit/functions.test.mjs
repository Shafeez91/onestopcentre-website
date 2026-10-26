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
