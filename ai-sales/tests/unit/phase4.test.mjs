// Phase 4: WhatsApp adapter, follow-up rules, Google Calendar adapter and the live worker (with an in-memory database).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, createVerify } from "node:crypto";
import { verifySignature, parseWebhook, inWindow, sendWhatsApp, textOf, WhatsAppError } from "../../lib/whatsapp.mjs";
import { isOpen, nextOpening, decideFollowUp, consentState, renderTemplate, templateParams } from "../../lib/followups.mjs";
import { freeSlots, signAssertion, bookSlot, cancelEvent, calConfig, confirmationText, formatWhen, _resetTokenCache } from "../../lib/calendar.mjs";
import { runWorker, sendTurn } from "../../lib/worker.mjs";
import { memdb } from "./helpers/memdb.mjs";

// Wednesday 28 Oct 2026, 11:00 in Malaysia (03:00 UTC)
const NOW = new Date("2026-10-28T03:00:00Z");
const ago = (min) => new Date(NOW.getTime() - min * 60e3).toISOString();
const HOURS = { mon: ["09:00", "18:00"], tue: ["09:00", "18:00"], wed: ["09:00", "18:00"], thu: ["09:00", "18:00"], fri: ["09:00", "18:00"], sat: ["10:00", "17:00"], sun: null };

/* ================================================================ WhatsApp adapter */
test("webhook signature: valid HMAC accepted; wrong, missing or malformed rejected", () => {
  const body = JSON.stringify({ a: 1 }), sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.equal(verifySignature(body, sig, "s3cret"), true);
  assert.equal(verifySignature(body + " ", sig, "s3cret"), false, "body changed");
  assert.equal(verifySignature(body, sig, "other"), false, "wrong secret");
  assert.equal(verifySignature(body, null, "s3cret"), false);
  assert.equal(verifySignature(body, "sha256=zz", "s3cret"), false);
  assert.equal(verifySignature(body, sig, ""), false, "no secret configured → reject");
});

const payload = (pnid = "PN1") => ({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: {
  metadata: { phone_number_id: pnid }, contacts: [{ wa_id: "60123456789", profile: { name: "Aina" } }],
  messages: [
    { id: "wamid.1", from: "60123456789", timestamp: "1793156400", type: "text", text: { body: "Salam, info M Mira?" } },
    { id: "wamid.2", from: "60123456789", type: "image", image: { caption: "ini unit?" } },
    { id: "wamid.3", from: "60123456789", type: "interactive", interactive: { button_reply: { title: "Ya" } } },
    { id: "wamid.4", from: "60123456789", type: "audio", audio: {} },
  ],
  statuses: [{ id: "wamid.out", status: "failed", errors: [{ code: 131047, title: "Re-engagement message" }] }],
} }] }] });

test("webhook parsing: text, captions, buttons, media, statuses; other numbers and objects ignored", () => {
  const { messages, statuses } = parseWebhook(payload(), "PN1");
  assert.deepEqual(messages.map((m) => [m.wamid, m.type, m.text, m.readable]), [
    ["wamid.1", "text", "Salam, info M Mira?", true], ["wamid.2", "image", "[image] ini unit?", false],
    ["wamid.3", "interactive", "Ya", true], ["wamid.4", "audio", "[audio]", false]]);
  assert.equal(messages[0].name, "Aina");
  assert.equal(messages[0].sent_at, new Date(1793156400 * 1000).toISOString());
  assert.deepEqual(statuses.map((s) => [s.wamid, s.status, s.error]), [["wamid.out", "failed", "131047 Re-engagement message"]]);
  assert.equal(parseWebhook(payload("OTHER"), "PN1").messages.length, 0, "events for another number are ignored");
  assert.equal(parseWebhook({ object: "page" }).messages.length, 0);
  assert.equal(textOf({ type: "button", button: { text: "Book" } }), "Book");
});

test("webhook parsing: replies sent from the WhatsApp Business app (coexistence echoes)", () => {
  const p = { object: "whatsapp_business_account", entry: [{ changes: [
    { field: "smb_message_echoes", value: { metadata: { phone_number_id: "PN1" }, message_echoes: [
      { from: "60187636796", to: "60123456789", id: "wamid.E1", timestamp: "1793156400", type: "text", text: { body: "Boleh, saya call petang ni" } },
      { from: "60187636796", to: "60123456789", id: "wamid.E2", type: "image", image: {} }] } },
    { field: "smb_message_echoes", value: { metadata: { phone_number_id: "OTHER" }, message_echoes: [{ to: "601", id: "wamid.X", type: "text", text: { body: "x" } }] } }] }] };
  const { echoes, messages } = parseWebhook(p, "PN1");
  assert.equal(messages.length, 0);
  assert.deepEqual(echoes.map((e) => [e.wa_id, e.wamid, e.type, e.text]), [["60123456789", "wamid.E1", "text", "Boleh, saya call petang ni"], ["60123456789", "wamid.E2", "image", "[image]"]]);
  assert.equal(echoes[0].sent_at, new Date(1793156400e3).toISOString());
});

test("24-hour window: open just inside, closed after (with a safety margin)", () => {
  assert.equal(inWindow(ago(60), NOW), true);
  assert.equal(inWindow(ago(24 * 60 - 2), NOW), true);
  assert.equal(inWindow(ago(24 * 60), NOW), false);
  assert.equal(inWindow(null, NOW), false);
});

test("sending: documented Cloud API shapes for text and template; errors classified", async () => {
  const cfg = { token: "T", phoneNumberId: "PN1", version: "v23.0" }, sent = [];
  const ok = async (u, i) => { sent.push({ u, i, b: JSON.parse(i.body) }); return Response.json({ messages: [{ id: "wamid.X" }] }); };
  assert.equal(await sendWhatsApp(cfg, "+60 12-345 6789", { text: "Hai" }, { fetchImpl: ok }), "wamid.X");
  assert.equal(sent[0].u, "https://graph.facebook.com/v23.0/PN1/messages");
  assert.equal(sent[0].i.headers.authorization, "Bearer T");
  assert.deepEqual(sent[0].b, { messaging_product: "whatsapp", recipient_type: "individual", to: "60123456789", type: "text", text: { body: "Hai", preview_url: false } });
  await sendWhatsApp(cfg, "60123456789", { template: { name: "appointment_reminder", lang: "ms", params: ["Aina", "Sab 31 Okt"] } }, { fetchImpl: ok });
  assert.deepEqual(sent[1].b.template, { name: "appointment_reminder", language: { code: "ms" }, components: [{ type: "body", parameters: [{ type: "text", text: "Aina" }, { type: "text", text: "Sab 31 Okt" }] }] });
  const fail = (code, status = 400) => async () => Response.json({ error: { code, message: "x" } }, { status });
  await assert.rejects(sendWhatsApp(cfg, "601", { text: "x" }, { fetchImpl: fail(131047) }), (e) => e instanceof WhatsAppError && e.kind === "window");
  await assert.rejects(sendWhatsApp(cfg, "601", { text: "x" }, { fetchImpl: fail(190, 401) }), (e) => e.kind === "config");
  await assert.rejects(sendWhatsApp(cfg, "601", { text: "x" }, { fetchImpl: fail(131026) }), (e) => e.kind === "rejected");
  await assert.rejects(sendWhatsApp(null, "601", { text: "x" }), (e) => e.kind === "config");
});

/* ================================================================ follow-up rules */
test("business hours in Malaysia time: open/closed and next opening", () => {
  assert.equal(isOpen(HOURS, NOW), true); // Wed 11:00
  assert.equal(isOpen(HOURS, new Date("2026-10-28T11:00:00Z")), false); // Wed 19:00
  assert.equal(nextOpening(HOURS, new Date("2026-10-28T11:00:00Z")).toISOString(), "2026-10-29T01:00:00.000Z"); // Thu 09:00
  assert.equal(nextOpening(HOURS, new Date("2026-10-31T10:00:00Z")).toISOString(), "2026-11-02T01:00:00.000Z"); // Sat 18:00 → Mon 09:00 (Sunday closed)
  assert.equal(nextOpening({}, NOW), null);
});

test("follow-up decisions: stop conditions, consent, weekly cap, hours, window and templates", () => {
  const base = { step: { purpose: "service", instruction: "check in" }, lead: { id: "L" }, consent: { service: null, marketing: null }, now: NOW,
    conversation: { mode: "ai", last_inbound_at: ago(120), contact: { wa_id: "601" } }, settings: { business: { hours: HOURS, max_marketing_messages_per_week: 2 } } };
  const d = (o) => decideFollowUp({ ...base, ...o });
  assert.equal(d({}).action, "send_ai");
  assert.deepEqual(d({ lead: { closed_at: ago(1) } }), { action: "cancel", reason: "lead closed" });
  assert.equal(d({ consent: { service: "withdrawn" } }).reason, "buyer opted out");
  assert.equal(d({ lead: { ai_paused: true } }).reason, "a human is handling this buyer");
  assert.equal(d({ conversation: { ...base.conversation, mode: "human" } }).action, "cancel");
  assert.equal(d({ step: { purpose: "marketing" } }).reason, "no marketing consent");
  assert.match(d({ step: { purpose: "marketing" }, consent: { marketing: "granted" }, marketingSentThisWeek: 2 }).reason, /weekly marketing limit \(2\)/);
  const late = d({ now: new Date("2026-10-28T11:00:00Z") });
  assert.equal(late.action, "defer"); assert.equal(late.runAt.toISOString(), "2026-10-29T01:00:00.000Z");
  const out = { conversation: { ...base.conversation, last_inbound_at: ago(26 * 60), contact: { wa_id: "601", preferred_language: "en" } } };
  assert.match(d(out).reason, /no approved template/);
  const tpls = [{ name: "check_in", lang: "ms", active: true, wa_status: "approved", wa_template_name: "check_in_ms" }, { name: "check_in", lang: "en", active: true, wa_status: "approved", wa_template_name: "check_in_en" }];
  assert.equal(d({ ...out, step: { purpose: "service", template: "check_in" }, templates: tpls }).template.wa_template_name, "check_in_en", "buyer's language preferred");
  assert.match(d({ ...out, step: { purpose: "service", template: "check_in" }, templates: [{ ...tpls[0], wa_status: "pending" }] }).reason, /not approved/);
});

test("consent state and template helpers", () => {
  assert.deepEqual(consentState([{ channel: "any", purpose: "marketing", status: "granted" }, { channel: "whatsapp", purpose: "marketing", status: "withdrawn" }]), { service: null, marketing: "withdrawn" });
  assert.equal(renderTemplate("Hi {{1}}, about {{2}}", ["Aina", "M Mira"]), "Hi Aina, about M Mira");
  assert.deepEqual(templateParams({ lang: "ms", variables: ["name", "project"] }, {}), ["tuan/puan", "projek kami"]);
  const appt = { lang: "en", variables: ["name", "appointment", "location"] };
  assert.deepEqual(templateParams(appt, { name: "Aina", appointment: "Sat, 1 Nov, 11:00 am", location: "M Mira Sales Gallery https://maps.app.goo.gl/abc" }),
    ["Aina", "Sat, 1 Nov, 11:00 am", "M Mira Sales Gallery https://maps.app.goo.gl/abc"]);
  assert.equal(templateParams(appt, { name: "Aina", appointment: "x" })[2], "the place our advisor will confirm", "never an empty variable (Meta rejects those)");
});

/* ================================================================ Google Calendar */
test("free slots: business hours, minimum notice, busy times, closed days, at most 2 a day", () => {
  const busy = [{ start: new Date("2026-10-28T06:00:00Z"), end: new Date("2026-10-28T07:00:00Z") }]; // Wed 14:00–15:00
  const s = freeSlots({ hours: HOURS, appointments: { duration_minutes: 60, min_notice_hours: 3, days_ahead: 5, max_slots_offered: 6 }, busy, now: NOW });
  assert.equal(s[0].id, "2026-10-28T15:00", "first slot after 3h notice, skipping the busy 14:00"); // Wed 11:00 + 3h = 14:00 busy → 15:00
  assert.ok(s.every((x) => !x.id.startsWith("2026-11-01")), "Sunday is closed");
  const perDay = s.reduce((m, x) => ({ ...m, [x.id.slice(0, 10)]: (m[x.id.slice(0, 10)] || 0) + 1 }), {});
  assert.ok(Object.values(perDay).every((n) => n <= 2));
  assert.equal(s.length, 6);
  assert.match(s[0].label_en, /Wed/);
  assert.equal(new Date(s[0].end) - new Date(s[0].start), 3600e3);
});

test("service-account sign-in: RS256 assertion verifiable with the public key; booking re-checks the slot", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const cfg = calConfig((k) => ({ GOOGLE_SERVICE_ACCOUNT_EMAIL: "bot@p.iam.gserviceaccount.com", GOOGLE_PRIVATE_KEY: pem.replace(/\n/g, "\\n"), GOOGLE_CALENDAR_ID: "cal@group" })[k]);
  const jwt = signAssertion(cfg, 1000);
  const [h, c, sig] = jwt.split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url")));
  assert.equal(JSON.parse(Buffer.from(c, "base64url")).scope, "https://www.googleapis.com/auth/calendar");

  _resetTokenCache();
  let busyNow = true; const calls = [];
  const fetchImpl = async (u, i) => {
    calls.push(u);
    if (u.includes("oauth2")) return Response.json({ access_token: "AT", expires_in: 3600 });
    if (u.endsWith("/freeBusy")) return Response.json({ calendars: { "cal@group": { busy: busyNow ? [{ start: "2026-10-29T03:00:00Z", end: "2026-10-29T04:00:00Z" }] : [] } } });
    if (u.includes("/events")) { assert.equal(i.headers.authorization, "Bearer AT"); return Response.json({ id: "EV1" }); }
    throw new Error(u);
  };
  const slot = { start: "2026-10-29T03:00:00Z", end: "2026-10-29T04:00:00Z", summary: "Showroom visit" };
  await assert.rejects(bookSlot(cfg, slot, { fetchImpl }), (e) => e.kind === "taken");
  busyNow = false;
  assert.equal(await bookSlot(cfg, slot, { fetchImpl }), "EV1");
  assert.equal(calls.filter((u) => u.includes("oauth2")).length, 1, "token reused");
  assert.equal(calConfig(() => undefined), null);
  assert.match(confirmationText({ kind: "showroom_visit", start: "2026-10-29T03:00:00Z", location: "M Mira Gallery", lang: "ms" }), /^✅ Temujanji anda telah disahkan: Lawatan showroom pada .*11:00.* di M Mira Gallery/);
});

/* ================================================================ live worker */
const SETTINGS = {
  id: 1, flags: { module_enabled: true, ai_auto_reply: true, whatsapp_outbound: true, follow_ups: true, calendar_booking: false },
  // client insights run as their own job after a reply; switched off here so other tests count only reply calls
  persona: { name: "OSC Property Assistant" }, ai: { confidence_threshold: 0.7, max_reply_chars: 700, auto_insights: false },
  business: { hours: HOURS, max_marketing_messages_per_week: 2, price_max_age_days: 30, inventory_max_age_hours: 72, appointments: { duration_minutes: 60, location: "M Mira Gallery" } },
  scoring: {}, compliance: {}, notifications: { whatsapp_alerts: true },
};
function world(o = {}) {
  return {
    ai_settings: [structuredClone(SETTINGS)], ai_objections: [], settings: [{ id: 1, data: { wa: "60300000000" } }],
    projects: [{ id: "p1", slug: "m-mira", published: true, data: { n: "M MIRA", l: "Wangsa Maju", types: [{ name: "Type A", price: "RM476,000" }] } }],
    ai_contacts: [{ id: "C1", full_name: "Aina", wa_id: "60123456789", phone_e164: "60123456789", preferred_language: "ms" }],
    ai_leads: [{ id: "L1", contact_id: "C1", lead_code: "OSC-000001", ai_paused: false, closed_at: null, qualification: {}, primary_project_id: "p1" }],
    ai_conversations: [{ id: "V1", contact_id: "C1", lead_id: "L1", channel: "whatsapp", mode: "ai", status: "open", last_inbound_at: ago(1), unread_count: 1 }],
    ai_messages: [{ id: "M1", conversation_id: "V1", direction: "inbound", sender_type: "customer", body: "Salam, boleh info M Mira?", created_at: ago(1), status: "received" }],
    ai_jobs: [{ id: "J1", kind: "wa_reply", payload: { conversation_id: "V1", message_id: "M1" }, status: "queued", attempts: 0, max_attempts: 5 }],
    ai_appointments: [], ai_lead_interests: [], ai_consent_records: [], ai_follow_up_jobs: [], ai_follow_up_sequences: [], ai_message_templates: [],
    ai_project_facts: [], ai_project_prices: [], ai_project_units: [], ai_agent_runs: [], ai_handover_events: [],
    __now: NOW.toISOString(),
    ...o,
  };
}
const flags = (db, f) => Object.assign(db.t.ai_settings[0].flags, f);
const draft = (o = {}) => ({
  reply: "Hai! Saya pembantu AI One Stop Centre. M MIRA di Wangsa Maju ada 3 jenis unit. Tuan/puan cari untuk didiami atau pelaburan?",
  language: "ms", intent: "project_info", agent: "knowledge", confidence: 0.9, facts_used: [],
  qualification_updates: { purpose: "", first_home: "", bedrooms: "", size_sqft: "", budget_min: 0, budget_max: 0, employment: "", financing: "", timeline_months: 0, readiness: "", concerns: "", preferred_project_id: "p1", asked_price: false, requested_brochure: false },
  appointment_request: { wanted: false, kind: "", preferred_text: "", project_id: "", slot_id: "" },
  handover: { needed: false, reason: "", summary: "", next_action: "" }, objection_key: "", ...o,
});
function llmOf(...replies) {
  const calls = [];
  const fn = async (p) => { calls.push(p); return { data: replies[Math.min(calls.length - 1, replies.length - 1)], model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5 } }; };
  fn.calls = calls; return fn;
}
function waOf({ failFirst = null } = {}) {
  const sent = [];
  return { sent, send: async (to, msg) => { if (failFirst) { const e = failFirst; failFirst = null; throw e; } sent.push({ to, msg }); return "wamid.out" + sent.length; } };
}
const deps = (db, o = {}) => ({ db, llm: o.llm || llmOf(draft()), wa: o.wa === undefined ? waOf() : o.wa, cal: o.cal || null, now: () => NOW });

test("live reply: AI answers on WhatsApp, records the message, updates the CRM and starts follow-ups", async () => {
  const db = memdb(world()), d = deps(db);
  const r = await runWorker(d);
  assert.equal(r.replies, 1);
  assert.equal(d.wa.sent.length, 1);
  assert.equal(d.wa.sent[0].to, "60123456789");
  assert.match(d.wa.sent[0].msg.text, /pembantu AI/);
  const out = db.t.ai_messages.find((m) => m.direction === "outbound");
  assert.deepEqual([out.status, out.provider_message_id, out.purpose, out.sender_type, out.source_job_id], ["sent", "wamid.out1", "reply", "ai", "J1"]);
  assert.equal(db.t.ai_jobs[0].status, "done");
  assert.equal(db.t.ai_conversations[0].unread_count, 0);
  assert.ok(db.t.ai_leads[0].first_response_at);
  assert.equal(db.t.ai_agent_runs.length, 1);
  assert.deepEqual(db.t.started, [{ p_lead: "L1", p_lead_type: "new_enquiry" }]);
  // the job runs again (e.g. redelivered): nothing is sent twice and the AI is not called again
  db.t.ai_jobs[0].status = "queued";
  await runWorker(d);
  assert.equal(d.wa.sent.length, 1);
  assert.equal(d.llm.calls.length, 1);
});

test("live reply: a failed send is retried with the same text, without a second AI call", async () => {
  const db = memdb(world()), d = deps(db, { wa: waOf({ failFirst: Object.assign(new Error("timeout"), { kind: "network" }) }) });
  const r1 = await runWorker(d);
  assert.equal(r1.errors.length, 1);
  assert.equal(db.t.ai_jobs[0].status, "failed");
  assert.equal(db.t.ai_messages.find((m) => m.direction === "outbound").status, "failed");
  db.t.ai_jobs[0].status = "queued";
  await runWorker(d);
  assert.equal(d.wa.sent.length, 1);
  assert.equal(db.t.ai_messages.filter((m) => m.direction === "outbound").length, 1);
  assert.equal(db.t.ai_messages.find((m) => m.direction === "outbound").status, "sent");
  assert.equal(d.llm.calls.length, 1);
});

test("AI auto-reply off: nothing is sent, the AI is not called, and no Telegram alert for the message", async () => {
  const db = memdb(world()); flags(db, { ai_auto_reply: false });
  db.t.ai_settings[0].notifications = { whatsapp_alerts: true }; // even the old switch cannot bring per-message alerts back
  const d = deps(db);
  await runWorker(d);
  assert.equal(d.llm.calls.length, 0);
  assert.equal(d.wa.sent.length, 0);
  assert.equal((db.t.telegram || []).length, 0);
});

test("STOP is honoured even while a person handles the chat: consent withdrawn, follow-ups cancelled, confirmation sent", async () => {
  const w = world();
  w.ai_conversations[0].mode = "human"; w.ai_leads[0].ai_paused = true; w.ai_messages[0].body = "STOP";
  w.ai_follow_up_jobs = [{ id: "F1", lead_id: "L1", status: "scheduled", run_at: ago(-600), step_index: 0 }];
  const db = memdb(w), d = deps(db);
  await runWorker(d);
  assert.equal(d.llm.calls.length, 0);
  assert.deepEqual(db.t.ai_consent_records.map((c) => [c.purpose, c.status]).sort(), [["marketing", "withdrawn"], ["service", "withdrawn"]]);
  assert.equal(db.t.ai_follow_up_jobs[0].status, "cancelled");
  assert.equal(d.wa.sent.length, 1);
});

test("several quick messages are answered together, once", async () => {
  const w = world();
  w.ai_messages.push({ id: "M2", conversation_id: "V1", direction: "inbound", sender_type: "customer", body: "Ada unit 3 bilik?", created_at: ago(0.5), status: "received" });
  w.ai_jobs.push({ id: "J2", kind: "wa_reply", payload: { conversation_id: "V1", message_id: "M2" }, status: "queued", attempts: 0, max_attempts: 5 });
  const db = memdb(w), d = deps(db);
  await runWorker(d);
  assert.equal(d.llm.calls.length, 1);
  assert.equal(d.wa.sent.length, 1);
  assert.match(d.llm.calls[0].messages.at(-1).content, /boleh info M Mira\?\nAda unit 3 bilik\?/);
});

test("two messages in the same second: exactly one reply, whichever job runs first", async () => {
  for (const order of [["J1", "J2"], ["J2", "J1"]]) {
    const w = world();
    w.ai_messages = [{ id: "MA", conversation_id: "V1", direction: "inbound", sender_type: "customer", body: "Hi", created_at: ago(1), status: "received" },
                     { id: "MB", conversation_id: "V1", direction: "inbound", sender_type: "customer", body: "info M Mira?", created_at: ago(1), status: "received" }];
    const jobs = { J1: { id: "J1", kind: "wa_reply", payload: { conversation_id: "V1", message_id: "MA" }, status: "queued", attempts: 0, max_attempts: 5 },
                   J2: { id: "J2", kind: "wa_reply", payload: { conversation_id: "V1", message_id: "MB" }, status: "queued", attempts: 0, max_attempts: 5 } };
    w.ai_jobs = order.map((k) => jobs[k]);
    const db = memdb(w), d = deps(db);
    await runWorker(d);
    assert.equal(d.wa.sent.length, 1, "order " + order.join(","));
  }
});

test("calendar unavailable: the AI is not told there are free slots", async () => {
  const db = memdb(world()); flags(db, { calendar_booking: true });
  const d = deps(db, { cal: { slots: async () => { throw new Error("403"); }, book: async () => "x" } });
  await runWorker(d);
  assert.doesNotMatch(d.llm.calls[0].system, /available_slots in the context/);
  assert.match(d.llm.calls[0].system, /Calendar booking is not connected/);
});

test("media the AI cannot read: polite holding reply and a handover, no AI call", async () => {
  const w = world();
  Object.assign(w.ai_messages[0], { body: "[audio]", media: [{ type: "audio" }] });
  const db = memdb(w), d = deps(db);
  await runWorker(d);
  assert.equal(d.llm.calls.length, 0);
  assert.equal(d.wa.sent.length, 1);
  assert.match(db.t.ai_handover_events[0].summary.text, /audio/);
});

test("WhatsApp sending switched off: the AI drafts, nothing goes to the buyer, no Telegram alert", async () => {
  const db = memdb(world()); flags(db, { whatsapp_outbound: false });
  const d = deps(db);
  await runWorker(d);
  assert.equal(d.llm.calls.length, 1);
  assert.equal(d.wa.sent.length, 0);
  assert.equal((db.t.telegram || []).length, 0);
});

test("Telegram: AI replies send nothing; an undelivered reply opens ONE follow-up task per buyer per day", async () => {
  const db = memdb(world()), d = deps(db);
  await runWorker(d);
  assert.equal(d.wa.sent.length, 1);
  assert.equal((db.t.telegram || []).length, 0, "a normal AI reply is not announced");

  const fail = Object.assign(new Error("WhatsApp refused the message (400)"), { kind: "rejected" });
  const w = world(); w.ai_messages.push({ id: "M2", conversation_id: "V1", direction: "inbound", sender_type: "customer", body: "Hello?", created_at: ago(0.5), status: "received" });
  w.ai_jobs.push({ id: "J2", kind: "wa_reply", payload: { conversation_id: "V1", message_id: "M2" }, status: "queued", attempts: 0, max_attempts: 5 });
  const db2 = memdb(w);
  const d2 = { ...deps(db2), wa: { send: async () => { throw fail; } } };
  await runWorker(d2);                                      // J1 superseded by J2; J2's reply fails
  db2.t.ai_jobs.forEach((j) => { if (j.status === "failed") j.status = "queued"; });
  await runWorker(d2);                                      // retried, fails again
  assert.equal(db2.t.ai_tasks.length, 1, "one task, not one per failure");
  assert.deepEqual([db2.t.ai_tasks[0].lead_id, db2.t.ai_tasks[0].title], ["L1", "Reply to the buyer: the AI's reply could not be delivered"]);
  assert.match(db2.t.ai_tasks[0].source_key, /^undelivered:V1:\d{4}-\d\d-\d\d$/);
  assert.match(db2.t.ai_tasks[0].details, /WhatsApp error: WhatsApp refused the message \(400\)[\s\S]*Buyer's last message .*"Hello\?"/);
  assert.deepEqual(db2.t.telegram.map((x) => x.p_kind), ["task_reminder"], "announced as a follow-up task, once");
  assert.ok(!db2.t.telegram.some((x) => x.p_kind === "whatsapp_message"));
});

const SLOT = { id: "2026-10-29T11:00", start: "2026-10-29T03:00:00.000Z", end: "2026-10-29T04:00:00.000Z", label_ms: "Khamis, 29 Okt, 11:00 Pagi", label_en: "Thu, 29 Oct, 11:00 am" };
const calOf = ({ taken = false } = {}) => { const booked = []; return { booked, slots: async () => [SLOT], book: async (x) => { if (taken) throw Object.assign(new Error("no longer free"), { kind: "taken" }); booked.push(x); return "EV1"; } }; };
const pickSlot = (slot_id) => draft({ reply: "Baik, saya tempah slot Khamis 11 pagi sekarang. Mesej pengesahan akan menyusul.", intent: "appointment", agent: "appointment",
  appointment_request: { wanted: true, kind: "showroom_visit", preferred_text: "Khamis 11 pagi", project_id: "p1", slot_id } });

test("calendar booking: a chosen free slot is booked, then the fixed confirmation is sent", async () => {
  const w = world(); w.ai_agent_runs = [];
  w.ai_messages.unshift({ id: "M0", conversation_id: "V1", direction: "outbound", sender_type: "ai", body: "Hai, saya pembantu AI", created_at: ago(5), status: "sent" });
  const db = memdb(w); flags(db, { calendar_booking: true });
  const cal = calOf(), d = deps(db, { llm: llmOf(pickSlot(SLOT.id)), cal });
  await runWorker(d);
  assert.match(d.llm.calls[0].system, /available_slots in the context are free times/);
  assert.match(d.llm.calls[0].messages.at(-1).content, /"available_slots":\[\{"id":"2026-10-29T11:00"/);
  assert.equal(cal.booked.length, 1);
  const a = db.t.ai_appointments[0];
  assert.deepEqual([a.status, a.calendar_event_id, a.start_at, a.location], ["confirmed", "EV1", SLOT.start, "M Mira Gallery"]);
  assert.equal(d.wa.sent.length, 2, "AI reply, then the confirmation — no reminder straight after booking");
  assert.match(d.wa.sent[1].msg.text, /^✅ Temujanji anda telah disahkan/);
});

test("calendar booking: a slot we did not offer is never booked; a slot taken meanwhile stays pending with an apology", async () => {
  let db = memdb(world()); flags(db, { calendar_booking: true });
  let cal = calOf(), d = deps(db, { llm: llmOf(pickSlot("2026-10-30T20:00")), cal });
  await runWorker(d);
  assert.equal(cal.booked.length, 0);
  assert.equal(db.t.ai_appointments[0].status, "pending_confirmation");
  assert.equal(db.t.ai_appointments[0].start_at, undefined);

  db = memdb(world()); flags(db, { calendar_booking: true });
  cal = calOf({ taken: true }); d = deps(db, { llm: llmOf(pickSlot(SLOT.id)), cal });
  await runWorker(d);
  assert.equal(db.t.ai_appointments[0].status, "pending_confirmation");
  assert.match(db.t.ai_appointments[0].notes, /taken/);
  assert.match(d.wa.sent[1].msg.text, /^Maaf, saya tidak dapat menempah/);
  assert.match(db.t.ai_handover_events.at(-1).summary.text, /Calendar booking/);
});

const SEQ = { id: "S1", name: "New enquiry", lead_type: "new_enquiry", active: true, stop_on: ["customer_reply", "opt_out"],
  steps: [{ delay_hours: 24, purpose: "service", instruction: "Check in about their question." }, { delay_hours: 48, purpose: "service", instruction: "Offer a visit.", template: "check_in" }] };
const fuWorld = (o = {}) => world({ ai_jobs: [], ai_follow_up_sequences: [SEQ],
  ai_messages: [{ id: "M1", conversation_id: "V1", direction: "inbound", sender_type: "customer", body: "Salam, boleh info M Mira?", created_at: ago(60), status: "received" },
                { id: "M0", conversation_id: "V1", direction: "outbound", sender_type: "ai", body: "Hai! Saya pembantu AI One Stop Centre. M MIRA ada 3 jenis unit.", created_at: ago(59), status: "read" }],
  ai_follow_up_jobs: [{ id: "F1", lead_id: "L1", sequence_id: "S1", step_index: 0, status: "scheduled", run_at: new Date(Date.now() - 60e3).toISOString(), attempts: 0 }], ...o });

test("follow-up inside the 24-hour window: AI-written, checked, sent; the next step is scheduled", async () => {
  const db = memdb(fuWorld());
  const d = deps(db, { llm: llmOf(draft({ reply: "Hai Aina, ada apa-apa soalan lagi tentang M MIRA?" })) });
  const r = await runWorker(d);
  assert.equal(r.follow_ups, 1);
  assert.match(d.llm.calls[0].messages.at(-1).content, /<follow_up_task>[\s\S]*Check in about their question/);
  assert.equal(d.wa.sent[0].msg.text, "Hai Aina, ada apa-apa soalan lagi tentang M MIRA?");
  assert.equal(db.t.ai_follow_up_jobs[0].status, "sent");
  assert.equal(db.t.ai_messages.find((m) => m.source_job_id === "F1").purpose, "service");
  const next = db.t.ai_follow_up_jobs[1];
  assert.deepEqual([next.step_index, next.run_at], [1, new Date(NOW.getTime() + 48 * 3600e3).toISOString()]);
});

test("follow-up outside the window: approved template sent, otherwise skipped with the reason", async () => {
  const w = fuWorld();
  w.ai_conversations[0].last_inbound_at = ago(3 * 24 * 60);
  w.ai_follow_up_jobs[0].step_index = 1;
  let db = memdb(w), d = deps(db);
  await runWorker(d);
  assert.equal(d.wa.sent.length, 0);
  assert.match(db.t.ai_follow_up_jobs[0].reason, /not approved/);

  w.ai_message_templates = [{ id: "T1", name: "check_in", lang: "ms", category: "utility", active: true, wa_status: "approved", wa_template_name: "check_in_ms", body: "Hai {{1}}, masih berminat dengan {{2}}?", variables: ["name", "project"] }];
  db = memdb(w); d = deps(db);
  await runWorker(d);
  assert.deepEqual(d.wa.sent[0].msg, { template: { name: "check_in_ms", lang: "ms", params: ["Aina", "M MIRA"] } });
  assert.equal(db.t.ai_messages.find((m) => m.source_job_id === "F1").body, "Hai Aina, masih berminat dengan M MIRA?");
  assert.equal(d.llm.calls.length, 0);
});

test("follow-ups: cancelled when a person took over, deferred outside business hours, never claimed while switched off", async () => {
  let w = fuWorld(); w.ai_leads[0].ai_paused = true;
  let db = memdb(w), d = deps(db);
  await runWorker(d);
  assert.deepEqual([db.t.ai_follow_up_jobs[0].status, db.t.ai_follow_up_jobs.length], ["cancelled", 1]);

  db = memdb(fuWorld()); d = { ...deps(db), now: () => new Date("2026-10-28T11:00:00Z") }; // Wed 19:00
  await runWorker(d);
  assert.deepEqual([db.t.ai_follow_up_jobs[0].status, db.t.ai_follow_up_jobs[0].run_at], ["scheduled", "2026-10-29T01:00:00.000Z"]);
  assert.equal(d.wa.sent.length, 0);

  db = memdb(fuWorld()); flags(db, { follow_ups: false }); d = deps(db);
  await runWorker(d);
  assert.equal(db.t.ai_follow_up_jobs[0].status, "scheduled", "left for the database to announce to staff");
});

/* ---------------- conversation ownership, 12-hour follow-up, staff reminders, appointment messages */
const PAST = NOW.toISOString(); // due at NOW: the in-memory claim uses the test clock (t.__now), decisions use NOW
const jobOf = (o) => ({ id: "AJ1", status: "scheduled", run_at: PAST, attempts: 0, conversation_id: "V1", lead_id: "L1", ...o });
const routine = (db) => (db.t.telegram || []).filter((x) => x.p_kind === "whatsapp_message");

test("second message while the AI owns the chat: the AI answers again (no one-reply limit)", async () => {
  const w = world();
  w.ai_messages.push({ id: "M0", conversation_id: "V1", direction: "outbound", sender_type: "ai", body: "Hai! Saya pembantu AI.", created_at: ago(0.9), status: "read" },
                     { id: "M2", conversation_id: "V1", direction: "inbound", sender_type: "customer", body: "Harga Type A?", created_at: ago(0.5), status: "received" });
  w.ai_jobs = [{ id: "J2", kind: "wa_reply", payload: { conversation_id: "V1", message_id: "M2" }, status: "queued", attempts: 0, max_attempts: 5 }];
  const db = memdb(w), d = deps(db, { llm: llmOf(draft({ reply: "Type A bermula RM476,000 (harga indikatif dari laman web, tertakluk pengesahan)." })) });
  await runWorker(d);
  assert.equal(d.wa.sent.length, 1);
  assert.match(d.llm.calls[0].messages.at(-1).content, /Harga Type A\?/);
  assert.equal(routine(db).length, 0, "no Telegram for routine messages");
});

test("human takeover: buyer messages get no AI reply and no routine Telegram alert", async () => {
  const w = world(); w.ai_conversations[0].mode = "human"; w.ai_leads[0].ai_paused = true;
  w.ai_settings[0].notifications = { whatsapp_alerts: false }; delete w.ai_settings[0].ai.auto_insights;
  const writes = [];
  const rpcs = { ai_lead_profile_set: (a) => { writes.push(["profile", a]); return { applied: ["work_area"] }; }, ai_lead_summary_set: (a) => { writes.push(["summary", a]); return {}; } };
  const insights = { profile_updates: [{ field: "work_area", value: "KLCC", status: "confirmed" }], summary: { changed: true, text: "Works in KLCC.", last_client_question: "", outstanding: "", next_question: "" },
    next_action: { action: "", reason: "", priority: "", due_in_days: 0 }, stage_update: { stage: "", evidence: "" } };
  const db = memdb(w, rpcs), d = deps(db, { llm: llmOf(insights) });
  await runWorker(d);
  assert.equal(d.wa.sent.length, 0, "no reply while a person handles the chat");
  assert.equal((db.t.telegram || []).length, 0);
  // the AI still keeps the client's profile and summary up to date (one call, no message)
  assert.equal(d.llm.calls.length, 1);
  assert.match(d.llm.calls[0].system, /^You keep the CRM profile/);
  assert.deepEqual(writes.map(([k]) => k), ["profile", "summary"]);
  assert.deepEqual(writes[0][1].p_changes, [{ field: "work_area", value: "KLCC", status: "confirmed" }]);
  assert.equal(writes[0][1].p_source, "ai");
  assert.ok(writes[0][1].p_message, "tied to the buyer's message, so it is never applied twice");
  // switched off in AI settings: not called at all
  const w2 = world(); w2.ai_conversations[0].mode = "human"; w2.ai_leads[0].ai_paused = true; w2.ai_settings[0].ai = { ...(w2.ai_settings[0].ai || {}), auto_insights: false };
  const db2 = memdb(w2, rpcs), d2 = deps(db2);
  await runWorker(d2);
  assert.equal(d2.llm.calls.length, 0);
});

test("a person takes over while the AI is writing: the AI reply is not sent (checked right before sending)", async () => {
  const db = memdb(world());
  const llm = async () => { db.t.ai_conversations[0].mode = "human"; db.t.ai_leads[0].ai_paused = true; return { data: draft(), model: "m", usage: {} }; };
  const d = deps(db, { llm });
  const r = await runWorker(d);
  assert.equal(d.wa.sent.length, 0);
  assert.deepEqual(r.errors, []);
  const out = db.t.ai_messages.find((m) => m.direction === "outbound");
  assert.deepEqual([out.status, out.status_reason], ["skipped", "a person took over before it was sent"]);
  assert.equal(db.t.ai_jobs[0].status, "done", "not retried");
  db.t.ai_jobs[0].status = "queued"; // even a retry cannot deliver it
  await runWorker(d);
  assert.equal(d.wa.sent.length, 0);
});

const quiet = (o = {}) => { // buyer wrote 12 h ago, the AI answered, nothing since
  const w = world({ ai_jobs: [], ...o });
  w.ai_messages = [{ id: "M1", conversation_id: "V1", direction: "inbound", sender_type: "customer", body: "Nak tahu pasal loan LPPSA", created_at: ago(12 * 60), status: "received" },
                   { id: "M0", conversation_id: "V1", direction: "outbound", sender_type: "ai", purpose: "reply", body: "Boleh, Tuan kerja kerajaan?", created_at: ago(12 * 60 - 1), status: "read" }];
  w.ai_conversations[0].last_inbound_at = ago(12 * 60);
  w.ai_automation_jobs = [jobOf({ kind: "smart_follow_up", anchor_message_id: "M1" })];
  return w;
};

test("12-hour follow-up: AI-written from the conversation, sent once, every check recorded", async () => {
  const db = memdb(quiet()), d = deps(db, { llm: llmOf(draft({ reply: "Tuan, kalau masih nak check kelayakan LPPSA, saya boleh bantu kira anggaran." })) });
  await runWorker(d);
  assert.equal(d.wa.sent.length, 1);
  assert.match(d.llm.calls[0].messages.at(-1).content, /<follow_up_task>[\s\S]*about 12 hours ago[\s\S]*loan or LPPSA question/);
  const j = db.t.ai_automation_jobs[0];
  assert.equal(j.status, "sent");
  assert.ok(j.sent_at && j.message_id);
  assert.ok(j.checks.length >= 8 && j.checks.every((c) => c.ok), JSON.stringify(j.checks));
  const msg = db.t.ai_messages.find((m) => m.id === j.message_id);
  assert.deepEqual([msg.sender_type, msg.purpose, msg.source_job_id], ["ai", "service", "AJ1"]);
  assert.ok(db.t.ai_conversations[0].last_follow_up_at);
  // the job is not handed out again; a redelivered/reclaimed job cannot send twice
  await runWorker(d);
  db.t.ai_automation_jobs[0].status = "scheduled";
  await runWorker(d);
  assert.equal(d.wa.sent.length, 1);
});

test("12-hour follow-up is cancelled when a person replied, took over, the buyer wrote again or opted out", async () => {
  const cases = [
    ["a person already followed up", (w) => { w.ai_messages.push({ id: "H1", conversation_id: "V1", direction: "outbound", sender_type: "human", body: "Saya call Tuan esok", created_at: ago(60), status: "sent" }); }],
    ["a person is handling this conversation", (w) => { w.ai_conversations[0].mode = "human"; }],
    ["superseded by a newer buyer message", (w) => { w.ai_messages.push({ id: "M9", conversation_id: "V1", direction: "inbound", sender_type: "customer", body: "Ok", created_at: ago(30), status: "received" }); }],
    ["buyer opted out", (w) => { w.ai_consent_records = [{ contact_id: "C1", channel: "whatsapp", purpose: "service", status: "withdrawn", recorded_at: ago(100) }]; }],
    ["follow-ups switched off for this conversation", (w) => { w.ai_conversations[0].automation = { follow_ups: false }; }],
  ];
  for (const [reason, change] of cases) {
    const w = quiet(); change(w);
    const db = memdb(w), d = deps(db);
    await runWorker(d);
    assert.equal(d.wa.sent.length, 0, reason);
    assert.equal(d.llm.calls.length, 0, reason);
    assert.deepEqual([db.t.ai_automation_jobs[0].status, db.t.ai_automation_jobs[0].reason], ["cancelled", reason]);
  }
});

test("12-hour follow-up: outside business hours it waits; after 24 hours only an approved template; otherwise a follow-up task is opened", async () => {
  const evening = quiet(); evening.ai_automation_jobs[0].run_at = "2026-10-28T11:00:00.000Z"; evening.__now = "2026-10-28T11:00:00.000Z";
  let db = memdb(evening), d = { ...deps(db), now: () => new Date("2026-10-28T11:00:00Z") }; // Wed 19:00 MYT, closed at 18:00
  await runWorker(d);
  assert.deepEqual([db.t.ai_automation_jobs[0].status, db.t.ai_automation_jobs[0].run_at], ["scheduled", "2026-10-29T01:00:00.000Z"]);
  assert.equal(d.wa.sent.length, 0);

  const late = () => { const w = quiet(); w.ai_conversations[0].last_inbound_at = ago(30 * 60); w.ai_messages[0].created_at = ago(30 * 60); return w; };
  db = memdb(late()); d = deps(db);
  await runWorker(d);
  assert.equal(d.wa.sent.length, 0);
  assert.equal(db.t.ai_automation_jobs[0].status, "skipped");
  assert.match(db.t.ai_automation_jobs[0].reason, /no approved follow-up template/);
  assert.equal(db.t.ai_tasks[0].title, "Follow up with the buyer: the automatic follow-up could not be sent");
  assert.match(db.t.ai_tasks[0].details, /Reason: more than 24 hours[\s\S]*Nak tahu pasal loan LPPSA/);
  assert.deepEqual(db.t.telegram.map((x) => x.p_kind), ["task_reminder"]);

  const w = late(); w.ai_message_templates = [{ id: "T9", name: "follow_up", lang: "ms", category: "utility", active: true, wa_status: "approved", wa_template_name: "follow_up_ms", body: "Hai {{1}}, masih berminat dengan {{2}}?", variables: ["name", "project"] }];
  db = memdb(w); d = deps(db);
  await runWorker(d);
  assert.deepEqual(d.wa.sent[0].msg, { template: { name: "follow_up_ms", lang: "ms", params: ["Aina", "M MIRA"] } });
  assert.equal(d.llm.calls.length, 0);

  db = memdb(quiet()); flags(db, { follow_ups: false }); d = deps(db);
  await runWorker(d);
  assert.deepEqual([db.t.ai_automation_jobs[0].status, db.t.ai_automation_jobs[0].reason], ["skipped", "automatic follow-ups are switched off"]);
  assert.match(db.t.telegram[0].p_text, /Follow-up task/);
});

test("no 'waiting for your reply' alerts: an old reply-reminder job is closed without Telegram (Test D)", async () => {
  const w = world({ ai_jobs: [] }); w.ai_conversations[0].mode = "human"; w.ai_leads[0].ai_paused = true;
  w.ai_messages[0].created_at = ago(70); w.ai_automation_jobs = [jobOf({ kind: "human_reminder", anchor_message_id: "M1" })];
  const db = memdb(w), d = deps(db);
  await runWorker(d);
  assert.deepEqual([db.t.ai_automation_jobs[0].status, db.t.ai_automation_jobs[0].reason], ["cancelled", "buyers waiting for a reply are no longer sent to Telegram"]);
  assert.equal((db.t.telegram || []).length, 0);
  assert.equal((db.t.ai_tasks || []).length, 0, "and no task: a buyer waiting for a reply is in the inbox");
});

const APPT = { id: "A1", lead_id: "L1", kind: "showroom_visit", status: "confirmed", project_id: "p1", start_at: new Date(NOW.getTime() + 24 * 3600e3).toISOString(), reminders: [], wa_reminders: true };
const apptWorld = (job, o = {}) => world({ ai_jobs: [], ai_appointments: [structuredClone(APPT)], ai_automation_jobs: [jobOf({ appointment_id: "A1", ref_time: APPT.start_at, ...job })], ...o });

test("appointment messages follow the buyer's own language when the saved one is 'mixed' or unknown", async () => {
  // a buyer saved as "mixed" who writes in English (the 28 Oct case) gets English
  let w = apptWorld({ kind: "appt_confirmation" });
  w.ai_contacts[0].preferred_language = "mixed";
  w.ai_messages = [{ id: "M1", conversation_id: "V1", direction: "inbound", body: "Hi, Boss. how abt 2pm this saturday?", created_at: ago(5) }, { id: "M2", conversation_id: "V1", direction: "inbound", body: "Thanks boss", created_at: ago(2) }, { id: "M3", conversation_id: "V1", direction: "inbound", body: "[reaction]", created_at: ago(1) }];
  let db = memdb(w), d = deps(db);
  await runWorker(d);
  assert.match(d.wa.sent[0].msg.text, /^✅ Your appointment is confirmed: Showroom visit \(M MIRA\) on \w{3}, \d+ \w{3}, \d+:\d\d (am|pm)/);
  // no saved language and Malay messages: Malay
  w = apptWorld({ kind: "appt_reminder", offset_minutes: 1440 }); w.ai_contacts[0].preferred_language = null;
  db = memdb(w); d = deps(db);
  await runWorker(d);
  assert.match(d.wa.sent[0].msg.text, /^Peringatan: lawatan showroom/);
  // a saved choice always wins
  w = apptWorld({ kind: "appt_reminder", offset_minutes: 1440 }); w.ai_contacts[0].preferred_language = "en"; w.ai_messages[0].body = "Saya nak datang";
  db = memdb(w); d = deps(db);
  await runWorker(d);
  assert.match(d.wa.sent[0].msg.text, /^Reminder: your showroom visit/);
});

test("appointment confirmation and reminders: fixed text with place and map; asks once whether they can make it", async () => {
  const facts = [{ project_id: "p1", showroom_address: "M MIRA Sales Gallery", showroom_map_url: "https://maps.app.goo.gl/abc" }];
  let db = memdb(apptWorld({ kind: "appt_confirmation" }, { ai_project_facts: facts })), d = deps(db);
  await runWorker(d);
  assert.match(d.wa.sent[0].msg.text, /^✅ Temujanji anda telah disahkan: Lawatan showroom \(M MIRA\) pada .* di M MIRA Sales Gallery\..*\n📍 https:\/\/maps\.app\.goo\.gl\/abc$/s);
  assert.equal(db.t.ai_messages.at(-1).sender_type, "system");

  db = memdb(apptWorld({ kind: "appt_reminder", offset_minutes: 1440 }, { ai_project_facts: facts })); d = deps(db);
  await runWorker(d);
  assert.match(d.wa.sent[0].msg.text, /^Peringatan: lawatan showroom \(M MIRA\) anda pada .* di M MIRA Sales Gallery\. Tuan\/Puan masih boleh datang\?/);
  assert.equal(db.t.ai_appointments[0].reminders[0].type, "wa_1440m");

  // the buyer already confirmed they are coming: the 2-hour reminder does not ask again
  const w = apptWorld({ kind: "appt_reminder", offset_minutes: 120 }); w.ai_appointments[0].attendance_confirmed_at = ago(60);
  db = memdb(w); d = deps(db);
  await runWorker(d);
  assert.doesNotMatch(d.wa.sent[0].msg.text, /masih boleh datang/);

  // a person handling the chat does not stop an appointment reminder (it is an operational message)
  const w2 = apptWorld({ kind: "appt_reminder", offset_minutes: 120 }); w2.ai_conversations[0].mode = "human"; w2.ai_leads[0].ai_paused = true;
  db = memdb(w2); d = deps(db);
  await runWorker(d);
  assert.equal(d.wa.sent.length, 1);
});

test("appointment reminders: cancelled, rescheduled, switched off or outside the window without a template — not sent, with the reason", async () => {
  const cases = [
    ["appointment cancelled", (w) => { w.ai_appointments[0].status = "cancelled"; }, "cancelled"],
    ["appointment rescheduled", (w) => { w.ai_appointments[0].start_at = new Date(NOW.getTime() + 48 * 3600e3).toISOString(); }, "cancelled"],
    ["reminders switched off for this appointment", (w) => { w.ai_appointments[0].wa_reminders = false; }, "cancelled"],
    ["appointment reminders switched off for this conversation", (w) => { w.ai_conversations[0].automation = { appointment_reminders: false }; }, "cancelled"],
    ["buyer opted out", (w) => { w.ai_consent_records = [{ contact_id: "C1", channel: "any", purpose: "service", status: "withdrawn", recorded_at: ago(5) }]; }, "cancelled"],
    ['outside the 24-hour window and no approved "appointment_reminder" template', (w) => { w.ai_conversations[0].last_inbound_at = ago(3 * 24 * 60); }, "skipped"],
  ];
  for (const [reason, change, status] of cases) {
    const w = apptWorld({ kind: "appt_reminder", offset_minutes: 1440 }); change(w);
    const db = memdb(w), d = deps(db);
    await runWorker(d);
    assert.equal(d.wa.sent.length, 0, reason);
    assert.deepEqual([db.t.ai_automation_jobs[0].status, db.t.ai_automation_jobs[0].reason], [status, reason]);
  }
  // with the approved template outside the window: name, time and the place
  const w = apptWorld({ kind: "appt_reminder", offset_minutes: 1440 }, { ai_message_templates: [{ id: "T2", name: "appointment_reminder", lang: "ms", category: "utility", active: true, wa_status: "approved", wa_template_name: "appointment_reminder", body: "Hai {{1}}, temujanji {{2}} di {{3}}.", variables: ["name", "appointment", "location"] }] });
  w.ai_conversations[0].last_inbound_at = ago(3 * 24 * 60);
  const db = memdb(w), d = deps(db);
  await runWorker(d);
  assert.deepEqual(d.wa.sent[0].msg.template.params, ["Aina", d.wa.sent[0].msg.template.params[1], "M Mira Gallery"]);
});

test("AI booking confirmation goes through its job: sent once, the scheduled worker does not repeat it", async () => {
  const w = world(); w.ai_agent_runs = [];
  w.ai_messages.unshift({ id: "M0", conversation_id: "V1", direction: "outbound", sender_type: "ai", body: "Hai, saya pembantu AI", created_at: ago(5), status: "sent" });
  // stands in for the database trigger: confirming the appointment creates its confirmation job
  const db = memdb(w, { ai_claim_automation_jobs: undefined });
  const patch = db.patch.bind(db);
  db.patch = async (path, body) => { const r = await patch(path, body);
    if (path.startsWith("ai_appointments") && body.status === "confirmed") { const a = db.t.ai_appointments[0]; (db.t.ai_automation_jobs ||= []).push(jobOf({ id: "CJ", kind: "appt_confirmation", appointment_id: a.id, ref_time: a.start_at })); }
    return r; };
  flags(db, { calendar_booking: true });
  const d = deps(db, { llm: llmOf(pickSlot(SLOT.id)), cal: calOf() });
  await runWorker(d);
  assert.equal(d.wa.sent.length, 2);
  assert.match(d.wa.sent[1].msg.text, /^✅ Temujanji anda telah disahkan/);
  assert.equal(db.t.ai_automation_jobs[0].status, "sent");
  db.t.__now = "2030-01-01T00:00:00Z";
  await runWorker(d);
  assert.equal(d.wa.sent.length, 2, "not sent twice");
});

test("a job that could not run on time is dropped, not sent late", async () => {
  const w = quiet(); w.ai_automation_jobs[0].run_at = new Date(NOW.getTime() - 7 * 3600e3).toISOString();
  const db = memdb(w), d = deps(db);
  await runWorker(d);
  assert.equal(d.wa.sent.length, 0);
  assert.deepEqual([db.t.ai_automation_jobs[0].status, db.t.ai_automation_jobs[0].reason], ["cancelled", "too late to send (7 h after it was due)"]);
  assert.equal((db.t.telegram || []).length, 0, "no burst of Telegram reminders either");
});

test("Resume AI: once a person hands the chat back, the AI answers the buyer's next message", async () => {
  const w = world(); Object.assign(w.ai_conversations[0], { mode: "ai", ai_resumed_at: ago(5), human_takeover_at: ago(60) });
  w.ai_messages.unshift({ id: "H0", conversation_id: "V1", direction: "outbound", sender_type: "human", body: "Saya serahkan pada pembantu AI kami", created_at: ago(6), status: "sent" });
  const db = memdb(w), d = deps(db);
  await runWorker(d);
  assert.equal(d.wa.sent.length, 1);
  assert.equal(db.t.ai_messages.at(-1).sender_type, "ai");
});

test("retention clean-up runs once a day at 03:00 Malaysia time, and not from the webhook", async () => {
  const purged = [];
  const at = (iso) => { const db = memdb(world({ ai_jobs: [] }), { ai_purge_expired: () => { purged.push(iso); return { notifications_deleted: 0 }; } }); return { ...deps(db), now: () => new Date(iso) }; };
  await runWorker(at("2026-10-27T19:00:30Z")); // 03:00 MYT
  await runWorker(at("2026-10-27T19:02:00Z"));
  await runWorker(at("2026-10-27T03:00:00Z"));
  assert.deepEqual(purged, ["2026-10-27T19:00:30Z"]);
  await runWorker(at("2026-10-27T19:00:30Z"), { reminders: false }); // webhook-triggered runs skip it
  assert.equal(purged.length, 1);
});

test("appointment place: the project's showroom and map for visits, the default otherwise, nothing for calls", async () => {
  const { placeFor, reminderText } = await import("../../lib/calendar.mjs");
  const settings = { business: { appointments: { location: "One Stop Centre, Wangsa Maju" } } };
  const facts = { p1: { showroom_address: "M Mira Sales Gallery, Jalan Wangsa Delima 6", showroom_map_url: "https://maps.app.goo.gl/abc" }, p2: { showroom_address: null, showroom_map_url: "https://maps.app.goo.gl/x" } };
  const db = { get: async (path) => { const id = /project_id=eq\.([^&]+)/.exec(path)[1]; return facts[id] ? [facts[id]] : []; } };
  assert.deepEqual(await placeFor(db, { kind: "showroom_visit", project_id: "p1" }, settings), { location: facts.p1.showroom_address, map: "https://maps.app.goo.gl/abc" });
  assert.deepEqual(await placeFor(db, { kind: "property_viewing", project_id: "p2" }, settings), { location: "One Stop Centre, Wangsa Maju", map: "" }, "no address: default place, and not the project's map");
  assert.deepEqual(await placeFor(db, { kind: "showroom_visit", project_id: null }, settings), { location: "One Stop Centre, Wangsa Maju", map: "" });
  assert.deepEqual(await placeFor(db, { kind: "phone_call", project_id: "p1" }, settings), { location: "", map: "" });
  const c = confirmationText({ kind: "showroom_visit", start: "2026-10-29T03:00:00Z", location: facts.p1.showroom_address, map: "https://maps.app.goo.gl/abc", lang: "en" });
  assert.match(c, /at M Mira Sales Gallery, Jalan Wangsa Delima 6\. Reply to this message.*\n📍 https:\/\/maps\.app\.goo\.gl\/abc$/s);
  assert.doesNotMatch(reminderText({ kind: "phone_call", start: "2026-10-29T03:00:00Z", location: "", lang: "ms" }), / di |📍/);
});

test("Malay appointment times use full day names and Pagi / Tengah Hari / Petang / Malam", () => {
  assert.equal(formatWhen("2026-10-29T01:00:00Z", "ms"), "Khamis, 29 Okt, 9:00 Pagi");
  assert.equal(formatWhen("2026-10-29T04:00:00Z", "ms"), "Khamis, 29 Okt, 12:00 Tengah Hari");
  assert.equal(formatWhen("2026-10-29T06:30:00Z", "ms"), "Khamis, 29 Okt, 2:30 Petang");
  assert.equal(formatWhen("2026-10-29T13:00:00Z", "ms"), "Khamis, 29 Okt, 9:00 Malam");
  assert.equal(formatWhen("2026-10-31T01:00:00Z", "ms"), "Sabtu, 31 Okt, 9:00 Pagi");
  assert.equal(formatWhen("2026-10-29T01:00:00Z", "en"), "Thu, 29 Oct, 9:00 am");
});

test("cancelling deletes the Google Calendar event; an event already gone counts as deleted; other errors throw", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const cfg = { email: "bot@p.iam.gserviceaccount.com", key: privateKey.export({ type: "pkcs8", format: "pem" }), calendarId: "cal@group" };
  _resetTokenCache();
  const calls = []; let status = 204;
  const fetchImpl = async (u, i) => {
    if (u.includes("oauth2")) return Response.json({ access_token: "AT", expires_in: 3600 });
    calls.push([i.method, u]);
    return status === 204 ? new Response(null, { status }) : Response.json({ error: { message: "Forbidden" } }, { status });
  };
  assert.equal(await cancelEvent(cfg, "EV1", { fetchImpl }), true);
  assert.deepEqual(calls[0], ["DELETE", "https://www.googleapis.com/calendar/v3/calendars/cal%40group/events/EV1"]);
  status = 410; assert.equal(await cancelEvent(cfg, "EV1", { fetchImpl }), true);
  status = 403; await assert.rejects(cancelEvent(cfg, "EV1", { fetchImpl }), (e) => e.kind === "config" && /403/.test(e.message));
});

/* ================================================================ follow-up workflows (RMK as the example) */
// the workflow and its stages come from the database (migration 15); nothing about RMK is in the code
const WF = { id: "WF1", key: "rmk", name: "RMK — Residensi Metropolitan Kepong", project_id: null, status: "active", sending_enabled: true, pause_if_active_hours: 6,
  entry: { ai_confirm: true, exclusive_project: true }, ai_instructions: "Ask whether RMK means Residensi Metropolitan Kepong." };
const WF_STAGES = [
  { key: "new", position: 10, name: "New RMK enquiry", step_en: "Confirm interest in RMK", keywords: ["RMK"], follow_up_hours: 0, max_follow_ups: 0 },
  { key: "to_book", position: 20, name: "To book unit", step_en: "Book a unit", step_ms: "Buat tempahan unit", keywords: ["DONE BOOKED", "DONE BOOKING"], follow_up_hours: 24, max_follow_ups: 2, template: "rmk_to_book",
    message_ms: "Hai {name}, tempahan unit RMK? Balas *DONE BOOKED* bila dah booking.", message_en: "Hi {{name}}, {{current_stage}} for RMK. Reply *{{keyword}}* once booked." },
  { key: "to_portal", position: 30, name: "To apply portal (RUMAWIP)", keywords: ["DONE PORTAL"], follow_up_hours: 24, max_follow_ups: 3, message_ms: "Hai {{name}}, daftar portal RUMAWIP. Balas *DONE PORTAL*." },
  { key: "all_signed", position: 60, name: "All signed", keywords: [], is_final: true },
].map((x) => ({ id: "S-" + x.key, workflow_id: "WF1", active: true, archived_at: null, escalate_after_max: true, ...x }));
const wfWorld = ({ stage = "to_book", seq = 1, enrolled = true, wf = {}, ...o } = {}) => {
  const w = quiet(o);
  w.ai_workflows = [{ ...WF, ...wf }];
  w.ai_workflow_stages = structuredClone(WF_STAGES);
  w.ai_workflow_leads = enrolled ? [{ id: "E1", workflow_id: "WF1", lead_id: "L1", stage: "to_book", status: "active", history: [] }] : [];
  w.ai_automation_jobs = [jobOf({ kind: "workflow_follow_up", workflow_id: "WF1", stage, seq })];
  return w;
};
const wfRpcs = { ai_wf_advance: (a, t) => { (t.wf_calls ||= []).push(["advance", a]); return true; }, ai_wf_enroll: (a, t) => { (t.wf_calls ||= []).push(["enroll", a]); return true; } };

test("workflow reminder: the stage message from the database is sent with the buyer's name, the next one is scheduled, nothing on Telegram", async () => {
  const db = memdb(wfWorld()), d = deps(db);
  await runWorker(d);
  assert.equal(db.t.ai_automation_jobs[0].status, "sent", JSON.stringify(db.t.ai_automation_jobs[0]));
  assert.deepEqual(d.wa.sent.map((x) => x.msg.text), ["Hai Aina, tempahan unit RMK? Balas *DONE BOOKED* bila dah booking."]);
  assert.deepEqual([db.t.ai_messages.at(-1).sender_type, db.t.ai_messages.at(-1).purpose], ["system", "service"]);
  const next = db.t.ai_automation_jobs.find((j) => j.seq === 2);
  assert.deepEqual([next.kind, next.workflow_id, next.stage, next.run_at], ["workflow_follow_up", "WF1", "to_book", new Date(NOW.getTime() + 24 * 3600e3).toISOString()]);
  assert.equal(d.llm.calls.length, 0, "fixed message, no AI call");
  assert.equal((db.t.telegram || []).length, 0);
  // an English-speaking buyer gets the English text with {{current_stage}} and {{keyword}} filled in
  const w = wfWorld(); w.ai_contacts[0].preferred_language = "en";
  const db2 = memdb(w), d2 = deps(db2);
  await runWorker(d2);
  assert.deepEqual(d2.wa.sent.map((x) => x.msg.text), ["Hi Aina, To book unit for RMK. Reply *DONE BOOKED* once booked."]);
});

test("workflow isolation: re-checked before sending — not enrolled, other stage, other project, paused, switched off or archived: nothing is sent", async () => {
  const cases = [
    [wfWorld({ enrolled: false }), "cancelled", "lead is not in the workflow"],
    [wfWorld({ stage: "to_portal" }), "cancelled", "stage changed"],
    [(() => { const w = wfWorld({ wf: { project_id: "p-rmk" } }); w.ai_leads[0].primary_project_id = "p1"; return w; })(), "cancelled", "the lead's project is no longer this workflow's"],
    [(() => { const w = wfWorld(); w.ai_workflow_leads[0].status = "paused"; return w; })(), "cancelled", "automation is paused"],
    [wfWorld({ wf: { sending_enabled: false } }), "skipped", "RMK — Residensi Metropolitan Kepong follow-ups are switched off"],
    [wfWorld({ wf: { status: "archived" } }), "cancelled", "workflow archived or removed"],
    [(() => { const w = wfWorld(); w.ai_workflow_stages[1].active = false; return w; })(), "cancelled", "the stage no longer sends reminders"],
    [(() => { const w = wfWorld(); w.ai_automation_jobs[0].kind = "rmk_follow_up"; return w; })(), "cancelled", "replaced by follow-up workflow reminders"],
  ];
  for (const [w, status, reason] of cases) {
    const db = memdb(w), d = deps(db);
    await runWorker(d);
    assert.deepEqual([db.t.ai_automation_jobs[0].status, db.t.ai_automation_jobs[0].reason], [status, reason]);
    assert.equal(d.wa.sent.length, 0, reason);
  }
  // a buyer in no workflow gets the 12-hour follow-up; a buyer at a stage with reminders is left to the workflow
  let db = memdb(quiet()), d = deps(db);
  await runWorker(d);
  assert.equal(db.t.ai_automation_jobs[0].status, "sent");
  const inWf = (stage) => { const w = quiet(); w.ai_workflows = [WF]; w.ai_workflow_stages = structuredClone(WF_STAGES); w.ai_workflow_leads = [{ workflow_id: "WF1", lead_id: "L1", stage, status: "active" }]; return w; };
  db = memdb(inWf("to_portal")); d = deps(db);
  await runWorker(d);
  assert.deepEqual([db.t.ai_automation_jobs[0].status, db.t.ai_automation_jobs[0].reason], ["skipped", "a follow-up workflow follows up this buyer"]);
  db = memdb(inWf("new")); d = deps(db);
  await runWorker(d);
  assert.equal(db.t.ai_automation_jobs[0].status, "sent", "a stage without reminders leaves the 12-hour follow-up on");
});

test("workflow reminder waits while the buyer is talking; outside 24 h only a template, else a follow-up task; after the last reminder a person takes over", async () => {
  // the buyer wrote an hour ago: wait until 6 h after that message
  let w = wfWorld(); w.ai_messages.push({ id: "M5", conversation_id: "V1", direction: "inbound", sender_type: "customer", body: "Ok nanti saya booking", created_at: ago(60) });
  let db = memdb(w), d = deps(db);
  await runWorker(d);
  assert.deepEqual([db.t.ai_automation_jobs[0].status, db.t.ai_automation_jobs[0].run_at], ["scheduled", new Date(NOW.getTime() + 5 * 3600e3).toISOString()]);
  assert.equal(d.wa.sent.length, 0);
  // 30 h since the buyer wrote, no approved template: a follow-up task, and the lead is marked for a person
  const late = () => { const x = wfWorld(); x.ai_conversations[0].last_inbound_at = ago(30 * 60); x.ai_messages.forEach((m) => { m.created_at = ago(30 * 60); }); return x; };
  db = memdb(late()); d = deps(db);
  await runWorker(d);
  assert.equal(d.wa.sent.length, 0);
  assert.match(db.t.ai_tasks[0].title, /^RMK — Residensi Metropolitan Kepong: message Aina about "To book unit"/);
  assert.equal(db.t.ai_tasks[0].source_key.split(":")[0], "wf-rmk");
  assert.equal(db.t.ai_workflow_leads[0].status, "human");
  // with the approved template it is sent
  w = late(); w.ai_message_templates = [{ id: "T1", name: "rmk_to_book", lang: "ms", category: "utility", active: true, wa_status: "approved", wa_template_name: "rmk_to_book_ms", body: "Hai {{1}}, peringatan tempahan RMK.", variables: ["name"] }];
  db = memdb(w); d = deps(db);
  await runWorker(d);
  assert.deepEqual(d.wa.sent[0].msg, { template: { name: "rmk_to_book_ms", lang: "ms", params: ["Aina"] } });
  // a website lead with no WhatsApp chat yet: a person contacts them
  w = wfWorld(); w.ai_conversations = []; w.ai_automation_jobs[0].conversation_id = null; w.ai_contacts[0].full_name = "Web Buyer";
  db = memdb(w); d = deps(db);
  await runWorker(d);
  assert.equal(d.wa.sent.length, 0);
  assert.match(db.t.ai_tasks[0].title, /: contact the buyer about "To book unit" \(no WhatsApp conversation yet\)/);
  // the check after the last reminder: no progress, a person takes over — unless the stage says not to
  db = memdb(wfWorld({ seq: 3 })); d = deps(db);
  await runWorker(d);
  assert.equal(d.wa.sent.length, 0);
  assert.match(db.t.ai_tasks[0].title, /: Aina still at "To book unit" after 2 reminders/);
  assert.deepEqual([db.t.ai_workflow_leads[0].status, db.t.ai_workflow_leads[0].status_reason], ["human", "no progress after 2 reminders"]);
  w = wfWorld({ seq: 3 }); w.ai_workflow_stages[1].escalate_after_max = false;
  db = memdb(w); d = deps(db);
  await runWorker(d);
  assert.equal((db.t.ai_tasks || []).length, 0);
  assert.equal(db.t.ai_workflow_leads[0].status, "active");
});

test("workflows and the AI: the buyer's own words move them on one stage (only the current one); a confirmed offer enrols them", async () => {
  const run = async (workflow, stage) => {
    const w = world(); w.ai_workflows = [WF]; w.ai_workflow_stages = structuredClone(WF_STAGES);
    w.ai_workflow_leads = stage ? [{ workflow_id: "WF1", lead_id: "L1", stage, status: "active", history: [] }] : [];
    w.ai_messages[0].body = "Dah booking semalam";
    const db = memdb(w, wfRpcs), d = deps(db, { llm: llmOf(draft({ reply: "Hai! Saya pembantu AI One Stop Centre. Tahniah, booking direkod!", workflow })) });
    await runWorker(d);
    return { calls: db.t.wf_calls || [], ctx: d.llm.calls[0].messages.at(-1).content };
  };
  let r = await run({ key: "rmk", interest: "", stage_done: "to_book" }, "to_book");
  assert.deepEqual(r.calls, [["advance", { p_wf: "WF1", p_lead: "L1", p_from: "to_book", p_by: "ai", p_via: "ai" }]]);
  assert.match(r.ctx, /"workflows":\[\{"workflow":"rmk","name":"RMK — Residensi Metropolitan Kepong"[\s\S]*"stage":"to_book","stage_label":"To book unit","automation":"active"[\s\S]*"reply_keyword_when_done":"DONE BOOKED"/);
  assert.doesNotMatch(r.ctx, /"workflow_offers"/, "not offered a workflow they are in");
  r = await run({ key: "rmk", interest: "", stage_done: "to_portal" }, "to_book");
  assert.deepEqual(r.calls, [], "a different step does not move the buyer");
  r = await run({ key: "other", interest: "", stage_done: "to_book" }, "to_book");
  assert.deepEqual(r.calls, [], "another workflow's key does not move the buyer");
  r = await run({ key: "rmk", interest: "confirmed", stage_done: "" }, null);
  assert.deepEqual(r.calls, [["enroll", { p_wf: "WF1", p_lead: "L1", p_source: "whatsapp", p_by: "ai" }]]);
  assert.match(r.ctx, /"workflow_offers":\[\{"workflow":"rmk"[\s\S]*"guidance":"Ask whether RMK means/);
  r = await run({ key: "nope", interest: "confirmed", stage_done: "" }, null);
  assert.deepEqual(r.calls, [], "only an offered workflow can be joined");
  r = await run({ key: "", interest: "", stage_done: "" }, null);
  assert.deepEqual(r.calls, []);
  assert.doesNotMatch(r.ctx, /"workflows":\[/, "no workflow context for buyers outside one");
});

test("workflow helpers: next stage, messages with variables, builder validation", async () => {
  const { nextStage, fillMessage, messageVars, validateWorkflow, normKeyword, unknownVariables } = await import("../../../sales/shared/workflow.mjs");
  const st = structuredClone(WF_STAGES);
  assert.deepEqual(["new", "to_book", "to_portal", "all_signed"].map((k) => nextStage(st, k)?.key ?? null), ["to_book", "to_portal", "all_signed", null]);
  st[2].active = false;
  assert.equal(nextStage(st, "to_book").key, "all_signed", "inactive stages are skipped");
  st[0].next_stage_key = "to_portal"; st[2].active = true;
  assert.equal(nextStage(st, "new").key, "to_portal", "an explicit next stage wins");
  const v = messageVars({ name: "", lang: "ms", projectName: "Residensi Metropolitan Kepong", stages: WF_STAGES, stageKey: "to_book" });
  assert.equal(fillMessage("Hai {{name}} / {name}: {{current_stage}} → {{next_stage}} di {{project_name}}, balas {{keyword}} {{other}}", v),
    "Hai tuan/puan / tuan/puan: To book unit → To apply portal (RUMAWIP) di Residensi Metropolitan Kepong, balas DONE BOOKED {{other}}");
  assert.deepEqual(unknownVariables("Hi {{name}} {{other}}"), ["other"]);
  assert.equal(normKeyword(" done, Booked! "), "DONE BOOKED");
  const good = { key: "x1", name: "X", pause_if_active_hours: 6, stages: [{ key: "a", name: "A", keywords: ["DONE A"] }, { key: "z", name: "Z", is_final: true }] };
  assert.deepEqual(validateWorkflow(good), []);
  assert.match(validateWorkflow({ ...good, stages: [good.stages[0], { ...good.stages[1], is_final: false }] }).join(), /final/);
  assert.match(validateWorkflow({ ...good, stages: [good.stages[0], { ...good.stages[1], keywords: ["done a!"] }] }).join(), /used by/);
  assert.match(validateWorkflow({ ...good, stages: [{ ...good.stages[0], follow_up_hours: 24, max_follow_ups: 2 }, good.stages[1]] }).join(), /write a reminder message/);
  assert.match(validateWorkflow({ ...good, stages: [{ ...good.stages[0], next_stage_key: "gone" }, good.stages[1]] }).join(), /next stage/);
  assert.match(validateWorkflow({ ...good, stages: [{ ...good.stages[0], message_ms: "Hai {{nama}}" }, good.stages[1]] }).join(), /unknown placeholder/);
});

/* ================================================================ client insights on a live reply */
test("live reply: client insights come from a separate call after the reply (own job, once per buyer message); a person's entry is not overwritten", async () => {
  const w = world();
  w.ai_leads[0].qualification = { purpose: "investment", signals: {} };
  w.ai_leads[0].profile_meta = { purpose: { status: "confirmed", source: "staff" } };
  w.ai_messages[0].body = "Saya nak duduk sendiri, kerja di KLCC";
  delete w.ai_settings[0].ai.auto_insights; // the default: on
  const calls = [];
  const rpcs = { ai_lead_profile_set: (a) => { calls.push(["profile", a]); return { applied: [] }; }, ai_lead_summary_set: (a) => { calls.push(["summary", a]); return {}; } };
  const insights = { profile_updates: [{ field: "work_area", value: "KLCC", status: "confirmed" }, { field: "purpose", value: "own_stay", status: "confirmed" }],
    summary: { changed: true, text: "Own stay; works in KLCC.", last_client_question: "", outstanding: "", next_question: "" },
    next_action: { action: "", reason: "", priority: "", due_in_days: 0 }, stage_update: { stage: "", evidence: "" } };
  const d0 = draft();
  const db = memdb(w, rpcs), d = deps(db, { llm: llmOf({ ...d0, qualification_updates: { ...d0.qualification_updates, purpose: "own_stay" } }, insights) });
  await runWorker(d);
  assert.equal(d.wa.sent.length, 1, "the reply goes out first, unaffected");
  assert.ok(!("insights" in d.llm.calls[0].schema.properties), "the reply call carries no insights (that made the API refuse the schema)");
  assert.equal(db.t.ai_leads[0].qualification.purpose, "investment", "the person's entry stays");
  const job = db.t.ai_jobs.find((j) => j.kind === "lead_insights");
  assert.deepEqual([job.payload, job.dedupe_key], [{ lead_id: "L1", message_id: w.ai_messages[0].id }, `insights:${w.ai_messages[0].id}`]);
  assert.equal(calls.length, 0, "nothing written before the insights job runs");
  await runWorker(d);
  assert.equal(d.llm.calls.length, 2);
  assert.ok("profile_updates" in d.llm.calls[1].schema.properties, "the insights call has its own small schema");
  assert.deepEqual(calls[0][1].p_changes, insights.profile_updates, "the database rules decide: a different value from a person's entry becomes a conflict, not an overwrite");
  assert.equal(calls[0][1].p_message, w.ai_messages[0].id, "tied to the buyer's message");
  assert.equal(calls.find((c) => c[0] === "summary")[1].p_summary.text, "Own stay; works in KLCC.");
  assert.equal(db.t.ai_jobs.find((j) => j.kind === "lead_insights").status, "done");
  // the reply call's context still carries what is known about the client
  assert.match(d.llm.calls[0].messages.at(-1).content, /"client_profile":\{"known":\{"purpose":\{"value":"investment","status":"confirmed"\}\}/);
  // switched off in settings (auto_insights: false): no insights job
  const w2 = world();
  const db2 = memdb(w2), d2 = deps(db2);
  await runWorker(d2);
  assert.equal(db2.t.ai_jobs.filter((j) => j.kind === "lead_insights").length, 0);
});

/* ================================================================ several WhatsApp messages in one AI turn */
const THREE = ["Hai! Saya OSC Property Assistant, pembantu AI. Stesen paling dekat ialah LRT Sri Rampai.", "MRT3 Circle Line pula masih dalam perancangan, jadi buat masa ini LRT ialah pilihan utama.", "Tuan/puan kerja di kawasan mana? Saya boleh semak laluan yang paling mudah."];
const multi = (n = 3, o = {}) => draft({ reply: undefined, messages: THREE.slice(0, n), ...o });
const outbound = (db) => db.t.ai_messages.filter((m) => m.direction === "outbound");
// a WhatsApp stub that can run something right after a given message goes out (a take-over, a new buyer message…)
function waAfter(n, fn, { failAt = null } = {}) {
  const sent = [];
  return { sent, send: async (to, msg) => {
    if (failAt && sent.length + 1 === failAt) { failAt = null; throw Object.assign(new Error("timeout"), { kind: "network" }); }
    sent.push({ to, msg }); if (sent.length === n) await fn(); return "wamid.out" + sent.length; } };
}
const depsM = (db, o = {}) => ({ ...deps(db, o), messageGapMs: 0 });

test("one AI turn, three WhatsApp messages: sent separately and in order, one record each, CRM updated once", async () => {
  const db = memdb(world()), d = depsM(db, { llm: llmOf(multi(3)) });
  await runWorker(d);
  assert.deepEqual(d.wa.sent.map((s) => s.msg.text), THREE, "three separate sends, in order");
  const out = outbound(db);
  assert.deepEqual(out.map((m) => [m.body, m.status, m.purpose, m.sender_type]), THREE.map((t) => [t, "sent", "reply", "ai"]));
  assert.equal(out[0].source_job_id, "J1", "the first keeps the job's own key");
  assert.equal(new Set(out.map((m) => m.source_job_id)).size, 3, "each message has its own idempotency key");
  assert.equal(db.t.ai_agent_runs.length, 1, "one AI run");
  assert.equal(d.llm.calls.length, 1);
  assert.deepEqual(db.t.started, [{ p_lead: "L1", p_lead_type: "new_enquiry" }], "follow-ups started once");
  assert.equal((db.t.telegram || []).length, 0, "no Telegram for an answered message");
  assert.equal(db.t.ai_leads.length, 1);
  // redelivered job: nothing is sent or recorded again
  db.t.ai_jobs[0].status = "queued";
  await runWorker(d);
  assert.equal(d.wa.sent.length, 3);
  assert.equal(outbound(db).length, 3);
  assert.equal(d.llm.calls.length, 1);
});

test("a single-message turn is unchanged: one send, keyed by the job", async () => {
  const db = memdb(world()), d = depsM(db, { llm: llmOf(multi(1)) });
  await runWorker(d);
  assert.equal(d.wa.sent.length, 1);
  assert.deepEqual(outbound(db).map((m) => [m.source_job_id, m.status]), [["J1", "sent"]]);
});

test("a person takes over after the first message: the rest are never sent", async () => {
  const db = memdb(world());
  const d = depsM(db, { llm: llmOf(multi(3)), wa: waAfter(1, async () => { db.t.ai_conversations[0].mode = "human"; }) });
  await runWorker(d);
  assert.equal(d.wa.sent.length, 1);
  assert.deepEqual(outbound(db).map((m) => m.status), ["sent", "skipped", "skipped"]);
  assert.match(outbound(db)[1].status_reason, /person took over/);
  assert.equal(db.t.ai_jobs[0].status, "done", "not retried");
  db.t.ai_jobs[0].status = "queued"; db.t.ai_conversations[0].mode = "ai";
  await runWorker(d);
  assert.equal(d.wa.sent.length, 1, "skipped parts stay unsent, even if the AI is switched back on");
});

test("the buyer writes again during delivery: remaining parts are dropped and the new message gets a fresh reply that knows what was sent", async () => {
  const w = world(), db = memdb(w);
  const d = depsM(db, { llm: llmOf(multi(3), multi(1, { messages: ["Baik, saya faham. Wangsa Maju memang dekat dengan pejabat tuan/puan."] })), wa: waAfter(1, async () => {
    db.t.ai_messages.push({ id: "M2", conversation_id: "V1", direction: "inbound", sender_type: "customer", body: "Saya kerja di Wangsa Maju", created_at: new Date(Date.now() + 5).toISOString(), status: "received" });
    db.t.ai_jobs.push({ id: "J2", kind: "wa_reply", payload: { conversation_id: "V1", message_id: "M2" }, status: "queued", attempts: 0, max_attempts: 5 });
  }) });
  await runWorker(d);
  assert.deepEqual(outbound(db).filter((m) => m.source_job_id !== "J2").map((m) => m.status), ["sent", "skipped", "skipped"]);
  assert.match(outbound(db)[1].status_reason, /buyer wrote again/);
  await runWorker(d); // J2 (if not already handled in the same run)
  assert.equal(d.llm.calls.length, 2);
  const second = d.llm.calls[1].messages;
  const text = second.map((m) => m.content).join("\n");
  assert.match(text, /Stesen paling dekat ialah LRT Sri Rampai/, "what was sent is history");
  assert.doesNotMatch(text, /MRT3 Circle Line pula masih dalam perancangan/, "what was never sent is not");
  assert.match(second.at(-1).content, /<buyer_message>\nSaya kerja di Wangsa Maju\n<\/buyer_message>/, "only the new message is answered");
  assert.equal(d.wa.sent.length, 2);
});

test("a failed second message is retried alone: the first is never sent twice and the AI is not called again", async () => {
  const db = memdb(world()), d = depsM(db, { llm: llmOf(multi(3)), wa: waAfter(99, async () => {}, { failAt: 2 }) });
  const r1 = await runWorker(d);
  assert.equal(r1.errors.length, 1);
  assert.deepEqual(outbound(db).map((m) => m.status), ["sent", "failed", "queued"]);
  db.t.ai_jobs[0].status = "queued";
  await runWorker(d);
  assert.deepEqual(d.wa.sent.map((s) => s.msg.text), THREE, "each message exactly once, in order");
  assert.deepEqual(outbound(db).map((m) => m.status), ["sent", "sent", "sent"]);
  assert.equal(d.llm.calls.length, 1);
  assert.equal(db.t.ai_agent_runs.length, 1);
});

test("hand-overs and safe replies are one message, whatever the model drafted", async () => {
  const db = memdb(world()), d = depsM(db, { llm: llmOf(multi(3, { handover: { needed: true, reason: "negotiation", summary: "wants a discount", next_action: "call" } })) });
  await runWorker(d);
  assert.equal(d.wa.sent.length, 1);
  assert.equal(d.wa.sent[0].msg.text, THREE.join("\n\n"));
});

test("two quick buyer messages: the reply still being written when the second arrives is dropped whole; one reply answers both, no staff task", async () => {
  // as on 29 Oct 14:19: message A, then B 4 s later, while the AI is still writing A's reply
  const w = world();
  w.ai_messages[0].body = "Kalau M Azura pergi bangsar";
  const db = memdb(w);
  let n = 0;
  const llm = async (p) => {
    n++;
    if (n === 1) { // B arrives while A's reply is being written
      db.t.ai_messages.push({ id: "M2", conversation_id: "V1", direction: "inbound", sender_type: "customer", body: "How was the distance", created_at: new Date(Date.now() + 5).toISOString(), status: "received" });
      db.t.ai_jobs.push({ id: "J2", kind: "wa_reply", payload: { conversation_id: "V1", message_id: "M2" }, status: "queued", attempts: 0, max_attempts: 5 });
      return { data: multi(2, { messages: ["Reply to A only: saya pembantu AI, part one with enough words.", "Reply to A only, part two with enough words."] }), model: "m", usage: {} };
    }
    llm.last = p;
    return { data: multi(1, { messages: ["Saya pembantu AI One Stop Centre. Dari M AZURA ke Bangsar, naik LRT dari Sri Rampai."] }), model: "m", usage: {} };
  };
  const d = depsM(db, { llm });
  await runWorker(d);           // A's job: reply dropped before anything is sent
  await runWorker(d);           // B's job: answers both
  assert.deepEqual(d.wa.sent.map((s) => s.msg.text), ["Saya pembantu AI One Stop Centre. Dari M AZURA ke Bangsar, naik LRT dari Sri Rampai."], "the buyer gets one reply");
  const a = outbound(db).filter((m) => m.source_job_id !== "J2" && m.body.startsWith("Reply to A"));
  assert.deepEqual(a.map((m) => m.status), ["skipped", "skipped"]);
  assert.match(a[0].status_reason, /buyer wrote again while this reply was being written/);
  assert.equal((db.t.ai_tasks || []).length, 0, "no 'reply could not be delivered' task");
  assert.match(llm.last.messages.at(-1).content, /Kalau M Azura pergi bangsar\nHow was the distance/, "the second reply answers both messages");
  assert.equal(db.t.ai_jobs.find((j) => j.id === "J1").status, "done");
});

test("fixed replies (STOP, 'talk to a person') always go out, even if the buyer has written again", async () => {
  const w = world(); w.ai_messages.push({ id: "M2", conversation_id: "V1", direction: "inbound", sender_type: "customer", body: "ok", created_at: new Date(Date.now() + 5).toISOString(), status: "received" });
  const db = memdb(w), d = depsM(db);
  const conv = db.t.ai_conversations[0];
  const sys = await sendTurn(d, { conversation: conv, to: "60123456789", messages: ["Baik, kami tidak akan menghantar mesej lagi."], senderType: "system", jobId: "J9", inboundId: "M1" });
  assert.deepEqual([sys.sent, sys.superseded], [1, undefined]);
  const ai = await sendTurn(d, { conversation: conv, to: "60123456789", messages: ["Jawapan AI yang sudah lapuk."], senderType: "ai", jobId: "J8", inboundId: "M1" });
  assert.deepEqual([ai.sent, ai.superseded], [0, true], "an AI reply to an older message is dropped");
  assert.equal(d.wa.sent.length, 1);
});
