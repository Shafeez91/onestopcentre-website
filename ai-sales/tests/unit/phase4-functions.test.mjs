// Phase 4 Netlify Functions with Supabase, WhatsApp and Google replaced by a fake fetch.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import webhook, { config as webhookConfig } from "../../../netlify/functions/sales-whatsapp-webhook.mjs";
import send, { config as sendConfig } from "../../../netlify/functions/sales-whatsapp-send.mjs";
import appointments, { config as apptConfig } from "../../../netlify/functions/sales-appointments.mjs";
import { config as workerConfig } from "../../../netlify/functions/sales-worker.mjs";
import setup, { config as setupConfig } from "../../../netlify/functions/sales-whatsapp-setup.mjs";

const realFetch = globalThis.fetch;
let calls, envBackup, routes;
const USERS = { "tok-adv": ["adv@test.local", "advisor"], "tok-view": ["view@test.local", "viewer"], "tok-own": ["own@test.local", "owner"] };
const FLAGS = { module_enabled: true, whatsapp_outbound: true };

beforeEach(() => {
  calls = []; envBackup = { ...process.env };
  Object.assign(process.env, { AI_SALES_ENABLED: "true", SUPABASE_SERVICE_ROLE_KEY: "svc", WHATSAPP_APP_SECRET: "app-secret", WHATSAPP_VERIFY_TOKEN: "verify-me",
    WHATSAPP_ACCESS_TOKEN: "wa-token", WHATSAPP_PHONE_NUMBER_ID: "PN1" });
  for (const k of ["GOOGLE_SERVICE_ACCOUNT_EMAIL", "GOOGLE_PRIVATE_KEY", "GOOGLE_CALENDAR_ID"]) delete process.env[k];
  routes = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), tok = String(init.headers?.authorization || "").replace(/^Bearer /, "");
    const body = init.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init.body;
    calls.push({ u, method: init.method || "GET", body, tok });
    if (u.endsWith("/auth/v1/user")) return USERS[tok] ? Response.json({ id: "x", email: USERS[tok][0] }) : new Response("", { status: 401 });
    if (u.endsWith("/rest/v1/rpc/ai_role")) return USERS[tok] ? Response.json(USERS[tok][1]) : new Response("", { status: 401 });
    for (const [re, fn] of routes) if (re.test(u)) return fn(u, init, body);
    if (u.includes("/rest/v1/ai_settings")) return Response.json([{ id: 1, flags: FLAGS, business: { appointments: { duration_minutes: 60, location: "Gallery" } } }]);
    if (u.includes("/rest/v1/ai_audit_logs")) return new Response(null, { status: 201 });
    throw new Error("unexpected " + (init.method || "GET") + " " + u);
  };
});
afterEach(() => { globalThis.fetch = realFetch; process.env = envBackup; });
const route = (re, fn) => routes.push([re, fn]);
const sign = (raw, secret = "app-secret") => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
const post = (path, body, headers = {}) => new Request("https://onestopcentreproperty.com" + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

test("functions: paths under /api/sales/, worker scheduled every 2 minutes", () => {
  assert.equal(webhookConfig.path, "/api/sales/whatsapp/webhook");
  assert.equal(sendConfig.path, "/api/sales/whatsapp/send");
  assert.deepEqual(apptConfig.path, ["/api/sales/appointments/slots", "/api/sales/appointments/confirm", "/api/sales/appointments/cancel"]);
  assert.equal(workerConfig.schedule, "*/2 * * * *");
});

test("webhook verification: only the configured verify token gets the challenge back", async () => {
  const get = (q) => webhook(new Request("https://onestopcentreproperty.com/api/sales/whatsapp/webhook?" + q));
  const ok = await get("hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345");
  assert.equal(ok.status, 200); assert.equal(await ok.text(), "12345");
  assert.equal((await get("hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1")).status, 403);
  delete process.env.WHATSAPP_VERIFY_TOKEN;
  assert.equal((await get("hub.mode=subscribe&hub.verify_token=&hub.challenge=1")).status, 403);
});

const event = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN1" },
  contacts: [{ wa_id: "60123456789", profile: { name: "Aina" } }], messages: [{ id: "wamid.1", from: "60123456789", timestamp: "1793156400", type: "text", text: { body: "Salam" } }],
  statuses: [{ id: "wamid.out", status: "delivered" }] } }] }] });

test("webhook events: signature required, switched-off module refused, messages and statuses stored", async () => {
  const path = "/api/sales/whatsapp/webhook";
  assert.equal((await webhook(post(path, event, { "x-hub-signature-256": sign(event, "wrong") }))).status, 401);
  assert.equal((await webhook(post(path, event))).status, 401, "unsigned");
  assert.equal(calls.length, 0, "nothing stored for bad signatures");
  process.env.AI_SALES_ENABLED = "false";
  assert.equal((await webhook(post(path, event, { "x-hub-signature-256": sign(event) }))).status, 503);
  process.env.AI_SALES_ENABLED = "true";

  route(/rpc\/ai_wa_inbound$/, () => Response.json({ duplicate: true }));
  route(/rpc\/ai_wa_status$/, () => Response.json(true));
  const r = await webhook(post(path, event, { "x-hub-signature-256": sign(event) }), {});
  assert.equal(r.status, 200);
  const inbound = calls.find((c) => c.u.endsWith("/rpc/ai_wa_inbound"));
  assert.deepEqual(inbound.body, { p_wa_id: "60123456789", p_name: "Aina", p_wamid: "wamid.1", p_type: "text", p_body: "Salam", p_sent_at: new Date(1793156400e3).toISOString() });
  assert.equal(inbound.tok, "svc", "stored with the server key");
  assert.deepEqual(calls.find((c) => c.u.endsWith("/rpc/ai_wa_status")).body, { p_wamid: "wamid.out", p_status: "delivered", p_error: null });
  assert.ok(!calls.some((c) => c.u.endsWith("/rpc/ai_claim_jobs")), "a redelivered message starts no work");
});

test("webhook: replies sent from the phone app are stored as echoes", async () => {
  const echo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "smb_message_echoes", value: { metadata: { phone_number_id: "PN1" },
    message_echoes: [{ from: "60187636796", to: "60123456789", id: "wamid.E1", timestamp: "1793156400", type: "text", text: { body: "Saya call petang ni" } }] } }] }] });
  route(/rpc\/ai_wa_echo$/, () => Response.json({ duplicate: false }));
  const r = await webhook(post("/api/sales/whatsapp/webhook", echo, { "x-hub-signature-256": sign(echo) }), {});
  assert.equal(r.status, 200);
  assert.deepEqual(calls.find((c) => c.u.endsWith("/rpc/ai_wa_echo")).body, { p_wa_id: "60123456789", p_wamid: "wamid.E1", p_type: "text", p_body: "Saya call petang ni", p_sent_at: new Date(1793156400e3).toISOString() });
  assert.ok(!calls.some((c) => c.u.endsWith("/rpc/ai_claim_jobs")), "an echo starts no AI work");
});

test("webhook: a click-to-WhatsApp ad about RMK puts the buyer in the RMK pipeline; other ads and redeliveries do not", async () => {
  const adEvent = (headline, wamid) => JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN1" },
    contacts: [{ wa_id: "60123456789", profile: { name: "Aina" } }],
    messages: [{ id: wamid, from: "60123456789", timestamp: "1793156400", type: "text", text: { body: "Saya berminat" },
      referral: { source_url: "https://www.instagram.com/p/abc", source_type: "ad", source_id: "1", headline, body: "Dari RM300k" } }] } }] }] });
  const send = (b) => webhook(post("/api/sales/whatsapp/webhook", b, { "x-hub-signature-256": sign(b) }), {});
  let dup = false;
  route(/rpc\/ai_wa_inbound$/, () => Response.json({ duplicate: dup, lead_id: "L9" }));
  route(/rpc\/ai_rmk_enroll$/, () => Response.json(true));
  calls.length = 0;
  assert.equal((await send(adEvent("RMK — Residensi Metropolitan Kepong", "wamid.ad1"))).status, 200);
  assert.deepEqual(calls.find((c) => c.u.endsWith("/rpc/ai_rmk_enroll")).body, { p_lead: "L9", p_source: "instagram", p_by: "ad" });
  calls.length = 0;
  await send(adEvent("M MIRA Wangsa Maju", "wamid.ad2"));
  assert.ok(!calls.some((c) => c.u.endsWith("/rpc/ai_rmk_enroll")), "an ad for another project");
  dup = true;
  calls.length = 0;
  await send(adEvent("RMK — Residensi Metropolitan Kepong", "wamid.ad1"));
  assert.ok(!calls.some((c) => c.u.endsWith("/rpc/ai_rmk_enroll")), "a redelivered message");
});

test("webhook: a new message is answered straight away in the background (waitUntil)", async () => {
  route(/rpc\/ai_wa_inbound$/, () => Response.json({ duplicate: false, job_id: "J1" }));
  route(/rpc\/ai_wa_status$/, () => Response.json(true));
  route(/rpc\/ai_claim_jobs$/, () => Response.json([]));
  const waits = [];
  const r = await webhook(post("/api/sales/whatsapp/webhook", event, { "x-hub-signature-256": sign(event) }), { waitUntil: (p) => waits.push(p) });
  assert.equal(r.status, 200);
  assert.equal(waits.length, 1);
  await waits[0];
  assert.ok(calls.some((c) => c.u.endsWith("/rpc/ai_claim_jobs")));
});

test("webhook: a storage failure returns 500 so Meta retries (storing is idempotent)", async () => {
  route(/rpc\/ai_wa_inbound$/, () => new Response("db down", { status: 503 }));
  const r = await webhook(post("/api/sales/whatsapp/webhook", event, { "x-hub-signature-256": sign(event) }), {});
  assert.equal(r.status, 500);
});

const CONV = (o = {}) => ({ id: "11111111-1111-1111-1111-111111111111", mode: "ai", last_inbound_at: new Date(Date.now() - 3600e3).toISOString(),
  contact: { id: "C1", full_name: "Aina", wa_id: "60123456789" }, lead: { id: "L1", primary_project_id: null }, ...o });
function sendRoutes({ conv = CONV(), consent = [], graph = () => Response.json({ messages: [{ id: "wamid.H1" }] }) } = {}) {
  route(/\/rest\/v1\/ai_conversations\?id=eq/, (u, i) => (i.method === "PATCH" ? new Response(null, { status: 204 }) : Response.json(conv ? [conv] : [])));
  route(/\/rest\/v1\/ai_conversations/, () => new Response(null, { status: 204 }));
  route(/\/rest\/v1\/ai_leads/, () => new Response(null, { status: 204 }));
  route(/\/rest\/v1\/ai_consent_current/, () => Response.json(consent));
  route(/\/rest\/v1\/ai_messages/, (u, i, b) => (i.method === "POST" ? Response.json([{ id: "MSG1", ...b }], { status: 201 }) : new Response(null, { status: 204 })));
  route(/graph\.facebook\.com/, graph);
}

test("staff send: advisors only; free text inside the window; WhatsApp and the switch must be on", async () => {
  const body = { conversation_id: CONV().id, text: "Boleh, saya hubungi tuan/puan petang ini.", take_over: true };
  const auth = (t) => ({ authorization: "Bearer " + t });
  assert.equal((await send(post("/api/sales/whatsapp/send", body))).status, 401);
  assert.equal((await send(post("/api/sales/whatsapp/send", body, auth("tok-view")))).status, 403);
  sendRoutes();
  const r = await send(post("/api/sales/whatsapp/send", body, auth("tok-adv")));
  assert.equal(r.status, 200, await r.clone().text());
  const g = calls.find((c) => c.u.includes("graph.facebook.com"));
  assert.deepEqual([g.u, g.body.to, g.body.text.body], ["https://graph.facebook.com/v23.0/PN1/messages", "60123456789", body.text]);
  const row = calls.find((c) => c.u.includes("/rest/v1/ai_messages") && c.method === "POST").body;
  assert.deepEqual([row.sender_type, row.sender_email, row.purpose], ["human", "adv@test.local", "reply"]);
  assert.ok(calls.some((c) => c.u.includes("/rest/v1/ai_conversations?id=eq") && c.method === "PATCH" && c.body.mode === "human" && c.tok === "tok-adv"), "take-over recorded as the staff member");
  assert.ok(calls.some((c) => c.u.includes("/rest/v1/ai_leads") && c.body.ai_paused === true));

  delete process.env.WHATSAPP_ACCESS_TOKEN;
  assert.equal((await send(post("/api/sales/whatsapp/send", body, auth("tok-adv")))).status, 501);
});

test("staff send: outside the 24-hour window needs a template; opted-out buyers cannot be messaged first", async () => {
  sendRoutes({ conv: CONV({ last_inbound_at: new Date(Date.now() - 30 * 3600e3).toISOString() }) });
  let r = await send(post("/api/sales/whatsapp/send", { conversation_id: CONV().id, text: "Hai" }, { authorization: "Bearer tok-adv" }));
  assert.equal(r.status, 409); assert.equal((await r.json()).needs_template, true);

  routes = [];
  sendRoutes({ consent: [{ channel: "whatsapp", purpose: "service", status: "withdrawn", recorded_at: new Date().toISOString() }] });
  r = await send(post("/api/sales/whatsapp/send", { conversation_id: CONV().id, text: "Hai" }, { authorization: "Bearer tok-adv" }));
  assert.equal(r.status, 409); assert.match((await r.json()).error, /opted out/);
  assert.ok(!calls.some((c) => c.u.includes("graph.facebook.com")), "nothing sent");
});

test("appointment confirm without a calendar: confirmed manually by the advisor, past times refused", async () => {
  const appt = { id: "A1", lead_id: "L1", kind: "showroom_visit", status: "pending_confirmation", reminders: [], lead: { id: "L1", contact_id: "C1", lead_code: "OSC-1", contact: { full_name: "Aina", wa_id: "60123456789" } } };
  route(/\/rest\/v1\/ai_appointments/, (u, i) => (i.method === "PATCH" ? new Response(null, { status: 204 }) : Response.json([appt])));
  const auth = { authorization: "Bearer tok-adv" };
  let r = await appointments(post("/api/sales/appointments/confirm", { appointment_id: "A1", start_at: "2020-01-01T03:00:00Z" }, auth));
  assert.equal(r.status, 400);
  const start = new Date(Date.now() + 48 * 3600e3).toISOString();
  r = await appointments(post("/api/sales/appointments/confirm", { appointment_id: "A1", start_at: start, notify_buyer: false }, auth));
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { ok: true, calendar: false, buyer_notified: false, note: null });
  const p = calls.find((c) => c.u.includes("/rest/v1/ai_appointments") && c.method === "PATCH");
  assert.deepEqual([p.body.status, p.body.calendar_provider, p.body.start_at, p.body.location, p.tok], ["confirmed", "manual", start, "Gallery", "tok-adv"]);
  assert.equal(p.body.reminders[0].type, "confirmation");
  // slots need a calendar
  r = await appointments(new Request("https://onestopcentreproperty.com/api/sales/appointments/slots", { headers: auth }));
  assert.equal(r.status, 501);
  // a visit for a project with a recorded showroom goes there (an empty location field means "the usual place")
  appt.project_id = "t1";
  route(/\/rest\/v1\/ai_project_facts/, () => Response.json([{ showroom_address: "M Mira Sales Gallery", showroom_map_url: "https://maps.app.goo.gl/abc" }]));
  calls.length = 0;
  r = await appointments(post("/api/sales/appointments/confirm", { appointment_id: "A1", start_at: start, location: "", notify_buyer: false }, auth));
  assert.equal(r.status, 200);
  assert.equal(calls.find((c) => c.u.includes("/rest/v1/ai_appointments") && c.method === "PATCH").body.location, "M Mira Sales Gallery");
});

test("appointment cancel: marks it cancelled as the advisor; a calendar event needs the calendar; closed ones refused", async () => {
  const appt = { id: "A1", lead_id: "L1", kind: "showroom_visit", status: "confirmed", reminders: [], lead: { id: "L1", contact_id: "C1", contact: {} } };
  route(/\/rest\/v1\/ai_appointments/, (u, i) => (i.method === "PATCH" ? new Response(null, { status: 204 }) : Response.json([appt])));
  const auth = { authorization: "Bearer tok-adv" };
  calls.length = 0;
  let r = await appointments(post("/api/sales/appointments/cancel", { appointment_id: "A1" }, auth));
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(await r.json(), { ok: true, calendar: false });
  const p = calls.find((c) => c.u.includes("/rest/v1/ai_appointments") && c.method === "PATCH");
  assert.deepEqual([p.body.status, p.body.reminders.at(-1).type, p.tok], ["cancelled", "cancelled", "tok-adv"]);
  // on Google Calendar but the calendar is not connected here: nothing changes, the advisor is told what to do
  Object.assign(appt, { calendar_provider: "google", calendar_event_id: "EV1" });
  calls.length = 0;
  r = await appointments(post("/api/sales/appointments/cancel", { appointment_id: "A1" }, auth));
  assert.equal(r.status, 501); assert.match((await r.json()).error, /Delete the event in Google Calendar/);
  assert.ok(!calls.some((c) => c.method === "PATCH"), "not marked cancelled while the event remains");
  appt.status = "cancelled";
  assert.equal((await appointments(post("/api/sales/appointments/cancel", { appointment_id: "A1" }, auth))).status, 409);
  assert.equal((await appointments(post("/api/sales/appointments/cancel", { appointment_id: "A1" }, { authorization: "Bearer tok-view" }))).status, 403);
});

test("calendar key from Supabase Vault when GOOGLE_PRIVATE_KEY is not in Netlify", async () => {
  const { calendarService } = await import("../../lib/live.mjs");
  const { _resetTokenCache } = await import("../../lib/calendar.mjs");
  const { generateKeyPairSync } = await import("node:crypto");
  _resetTokenCache();
  Object.assign(process.env, { GOOGLE_SERVICE_ACCOUNT_EMAIL: "bot@p.iam.gserviceaccount.com", GOOGLE_CALENDAR_ID: "cal@group" });
  assert.equal(calendarService(null), null, "no key anywhere and no database → not configured");
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  const rpcs = [];
  const db = { rpc: async (n, a) => { rpcs.push([n, a]); return pem.replace(/\n/g, "\\n"); } };
  route(/oauth2\.googleapis\.com/, () => Response.json({ access_token: "AT", expires_in: 3600 }));
  route(/freeBusy$/, () => Response.json({ calendars: { "cal@group": { busy: [] } } }));
  const cal = calendarService(db);
  const hours = { mon: ["09:00", "18:00"], tue: ["09:00", "18:00"], wed: ["09:00", "18:00"], thu: ["09:00", "18:00"], fri: ["09:00", "18:00"], sat: ["10:00", "17:00"], sun: null };
  const slots = await cal.slots({ business: { hours, appointments: { days_ahead: 3 } } }, new Date("2026-10-28T03:00:00Z"));
  assert.ok(slots.length > 0);
  await cal.slots({ business: { hours } }, new Date("2026-10-28T03:00:00Z"));
  assert.deepEqual(rpcs, [["ai_vault_secret", { p_name: "google_private_key" }]], "read once");
});

test("WhatsApp connection check: owners only; finds an unlinked account and links it", async () => {
  assert.equal(setupConfig.path, "/api/sales/whatsapp/setup");
  const auth = (t) => ({ authorization: "Bearer " + t });
  assert.equal((await setup(post("/api/sales/whatsapp/setup", { action: "check", waba_id: "850701657747469" }, auth("tok-adv")))).status, 403);
  assert.equal((await setup(post("/api/sales/whatsapp/setup", { action: "check", waba_id: "abc" }, auth("tok-own")))).status, 400);
  let linked = false;
  route(/graph\.facebook\.com\/v23\.0\/PN1\?/, () => Response.json({ display_phone_number: "+60 18-763 6796", verified_name: "Hafizan Hanis", status: "CONNECTED", platform_type: "CLOUD_API" }));
  route(/850701657747469\/phone_numbers/, () => Response.json({ data: [{ id: "PN1", display_phone_number: "+60 18-763 6796" }] }));
  route(/850701657747469\/subscribed_apps/, (u, i) => { if (i.method === "POST") { linked = true; return Response.json({ success: true }); }
    return Response.json({ data: linked ? [{ whatsapp_business_api_data: { id: "1678920390495985", name: "OneStopCentre Sales" } }] : [] }); });
  route(/\/rest\/v1\/ai_integration_accounts/, () => new Response(null, { status: 204 }));
  let r = await (await setup(post("/api/sales/whatsapp/setup", { action: "check", waba_id: "850701657747469" }, auth("tok-own")))).json();
  assert.deepEqual([r.healthy, r.phone_in_account, r.subscribed_apps.length, r.phone.status], [false, true, 0, "CONNECTED"]);
  const saved = calls.find((c) => c.u.includes("ai_integration_accounts") && c.method === "PATCH").body;
  assert.deepEqual([saved.status, saved.config.waba_id], ["error", "850701657747469"]);
  r = await (await setup(post("/api/sales/whatsapp/setup", { action: "subscribe", waba_id: "850701657747469" }, auth("tok-own")))).json();
  assert.deepEqual([r.healthy, r.linked.ok, r.subscribed_apps[0].name], [true, true, "OneStopCentre Sales"]);
  assert.ok(calls.some((c) => c.u.endsWith("850701657747469/subscribed_apps") && c.method === "POST" && c.tok === "wa-token"));
  // an expired token is reported, not hidden
  routes = [];
  route(/graph\.facebook\.com/, () => Response.json({ error: { code: 190, message: "Error validating access token" } }, { status: 401 }));
  route(/\/rest\/v1\/ai_integration_accounts/, () => new Response(null, { status: 204 }));
  r = await (await setup(post("/api/sales/whatsapp/setup", { action: "check", waba_id: "850701657747469" }, auth("tok-own")))).json();
  assert.equal(r.healthy, false);
  assert.match(r.phone.error, /Error validating access token \(401, code 190\)/);
});

test("WhatsApp connection check: a wrong or empty account ID is replaced by the account that holds the number", async () => {
  const auth = { authorization: "Bearer tok-own" };
  route(/debug_token\?input_token=wa-token/, () => Response.json({ data: { granular_scopes: [
    { scope: "business_management", target_ids: ["999"] },
    { scope: "whatsapp_business_management", target_ids: ["1110000001", "2220000002"] }, { scope: "whatsapp_business_messaging", target_ids: ["2220000002"] }] } }));
  route(/850701657747469\/phone_numbers/, () => Response.json({ error: { code: 100, message: "Unsupported get request." } }, { status: 400 }));
  route(/\/1110000001\/phone_numbers/, () => Response.json({ data: [{ id: "OTHER" }] }));
  route(/\/2220000002\/phone_numbers/, () => Response.json({ data: [{ id: "PN1", display_phone_number: "+60 18-763 6796" }] }));
  route(/\/2220000002\/subscribed_apps/, () => Response.json({ data: [{ whatsapp_business_api_data: { id: "1678920390495985", name: "OneStopCentre Sales" } }] }));
  route(/graph\.facebook\.com\/v23\.0\/PN1\?/, () => Response.json({ display_phone_number: "+60 18-763 6796", status: "CONNECTED" }));
  route(/\/rest\/v1\/ai_integration_accounts/, () => new Response(null, { status: 204 }));
  let r = await (await setup(post("/api/sales/whatsapp/setup", { action: "check", waba_id: "850701657747469" }, auth))).json();
  assert.deepEqual([r.healthy, r.waba_id, r.detected, r.entered_waba_id, r.candidates], [true, "2220000002", true, "850701657747469", ["1110000001", "2220000002"]]);
  const saved = calls.filter((c) => c.u.includes("ai_integration_accounts") && c.method === "PATCH").at(-1).body;
  assert.deepEqual([saved.status, saved.config.waba_id], ["healthy", "2220000002"]);
  r = await (await setup(post("/api/sales/whatsapp/setup", { action: "check" }, auth))).json();
  assert.deepEqual([r.healthy, r.waba_id, r.detected], [true, "2220000002", true]);
  // the right ID entered: no lookup needed
  const before = calls.filter((c) => c.u.includes("debug_token")).length;
  r = await (await setup(post("/api/sales/whatsapp/setup", { action: "check", waba_id: "2220000002" }, auth))).json();
  assert.deepEqual([r.healthy, r.detected, calls.filter((c) => c.u.includes("debug_token")).length], [true, false, before]);
  // nothing reachable: a clear 404
  routes = [];
  route(/debug_token/, () => Response.json({ data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["1110000001"] }] } }));
  route(/\/1110000001\/phone_numbers/, () => Response.json({ data: [] }));
  const res = await setup(post("/api/sales/whatsapp/setup", { action: "check" }, auth));
  assert.equal(res.status, 404);
  const nf = await res.json();
  assert.deepEqual(nf.candidates, ["1110000001"]);
  assert.match(nf.error, /phone number ID PN1 was not found/);
  assert.match(nf.error, /WhatsApp accounts the token can reach: 1110000001 → no numbers/);
  // the reason names the token's permissions and what Meta said about each account
  routes = [];
  route(/debug_token/, () => Response.json({ data: { scopes: ["whatsapp_business_messaging"], granular_scopes: [{ scope: "whatsapp_business_messaging", target_ids: ["3330000003"] }] } }));
  route(/\/3330000003\/phone_numbers/, () => Response.json({ error: { code: 100, message: "Unsupported get request." } }, { status: 400 }));
  route(/\/9990000009\/phone_numbers/, () => Response.json({ error: { code: 100, message: "Unsupported get request." } }, { status: 400 }));
  const e2 = (await (await setup(post("/api/sales/whatsapp/setup", { action: "check", waba_id: "9990000009" }, auth))).json());
  assert.match(e2.error, /ID 9990000009: Unsupported get request\. \(400, code 100\)/);
  assert.match(e2.error, /token permissions: whatsapp_business_messaging/);
  assert.match(e2.error, /3330000003 → Unsupported get request/);
});
