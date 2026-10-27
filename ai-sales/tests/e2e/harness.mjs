// Shared browser-test harness (Playwright): serves the site locally with the real _headers rules, replaces
// Supabase and the server functions with an in-memory fake, and serves CDN libraries from VENDOR_DIR.
// Nothing here talks to production.
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assess } from "../../../sales/shared/finance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const VENDOR = process.env.VENDOR_DIR;
export const skip = !VENDOR || !existsSync(VENDOR) ? "set VENDOR_DIR to run browser tests (see ai-sales/run-tests.sh)" : false;
let chromium;
try { ({ chromium } = createRequire(import.meta.url)("playwright")); } catch { /* reported via skip below */ }

/* ---------- static server that applies the real _headers rules for /sales/* ---------- */
function headerRules() {
  const rules = []; let cur = null;
  for (const line of readFileSync(path.join(root, "_headers"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { cur = { pattern: line.trim(), headers: {} }; rules.push(cur); }
    else if (cur) { const i = line.indexOf(":"); cur.headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
  }
  return rules;
}
const RULES = headerRules();
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".webp": "image/webp", ".jpg": "image/jpeg" };
let server, base, browser;
export const canRun = () => !skip && !!chromium;

/** Starts the local server and browser; returns the base URL. */
export async function start() {
  if (!canRun()) return null;
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/index.html";
    if (p.endsWith("/")) p += "index.html";
    if (/^\/(ai-sales|netlify\/functions)\//.test(p)) { res.writeHead(404); return res.end("blocked"); }
    const f = path.join(root, p);
    if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end("nf"); }
    const h = { "content-type": TYPES[path.extname(f)] || "application/octet-stream" };
    for (const r of RULES) { const re = new RegExp("^" + r.pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"); if (re.test(p)) Object.assign(h, r.headers); }
    res.writeHead(200, h); res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch();
  return base;
}
export async function stop() { await browser?.close(); server?.close(); }

/* ---------- fake Supabase (TEST FIXTURES ONLY) ---------- */
const NOW = new Date().toISOString();
const FIN_INPUTS = { route: "lppsa", age: 30, basic_salary: 4000, fixed_allowances: 1000, mandatory_deductions: 500, commitments_monthly: 800, confirmed_service: "yes", property_price: 450000 };

export function fixtures() {
  const finResult = assess(FIN_INPUTS);
  const stages = ["New Lead", "Contacted", "Qualified", "Appointment Pending", "Won", "Lost"].map((n, i) => ({ id: "s" + i, name: n, position: i + 1, is_won: n === "Won", is_lost: n === "Lost", active: true }));
  const contact = { id: "c1", full_name: "Test Buyer", phone_e164: "60123456789", email: "buyer@example.test", preferred_language: "ms" };
  return {
    ai_settings: [{ id: 1, flags: { module_enabled: true, website_lead_import: true, ai_auto_reply: false, whatsapp_outbound: false, follow_ups: false, calendar_booking: false },
      persona: { name: "OSC Property Assistant", tone: "Friendly", greeting_en: "Hi", greeting_ms: "Hai", allow_manglish: true }, business: { timezone: "Asia/Kuala_Lumpur", hours: { mon: ["09:00", "18:00"], sun: null }, inventory_max_age_hours: 72, price_max_age_days: 30, max_marketing_messages_per_week: 2 },
      scoring: { weights: { readiness: 25, budget: 20, suitability: 15, timeline: 15, engagement: 15, financing: 10 }, thresholds: { hot: 70, warm: 45, nurture: 20 } }, ai: { provider: "anthropic", model: "", confidence_threshold: 0.7, max_reply_chars: 700 }, compliance: { pdpa_notice_en: "x", pdpa_notice_ms: "y" },
      notifications: { telegram_enabled: true, telegram_chat_id: "123456789", whatsapp_alerts: true, appointment_changes: true, appointment_reminder_minutes: [1440, 120], task_reminders: true, task_lead_minutes: 30, daily_digest: true, digest_hour: 8 } }],
    ai_pipeline_stages: stages,
    ai_lead_sources: [{ id: "src1", name: "Website enquiry form", channel: "website", active: true }],
    ai_campaigns: [], ai_team_members: [{ email: "advisor@test.local", role: "advisor", active: true }],
    projects: [{ id: "t1", slug: "test-residence", published: true, data: { id: "t1", slug: "test-residence", n: "Test Residence", l: "Cheras", d: "Test Developer", s: "New Launch", t: "Condominium", c: "Residential", types: [{ name: "Type A", size: "800", beds: "3", baths: "2", price: "RM450,000" }], gallery: [] } }],
    settings: [{ data: { wa: "60123456789", email: "test@example.test", order: ["t1"] } }],
    ai_leads: [{ id: "L1", lead_code: "OSC-000001", contact_id: "c1", contact, stage_id: "s0", temperature: "warm", score: 52, score_rationale: [{ label: "Purchase readiness", points: 15, max: 25, known: true, detail: "considering" }], qualification: { readiness: "considering" }, owner_email: null, source_id: "src1", primary_project_id: "t1", handover_status: "none", ai_paused: false, created_at: NOW, updated_at: NOW, closed_at: null }],
    ai_contacts: [contact], ai_activities: [{ id: "a1", lead_id: "L1", kind: "website_enquiry", body: "Berapa harga?", actor: "website", created_at: NOW }],
    ai_tasks: [], ai_appointments: [{ id: "A1", lead_id: "L1", kind: "showroom_visit", status: "pending_confirmation", preferred_text: "Sabtu pagi", start_at: null, reminders: [], created_at: NOW, lead: { id: "L1", lead_code: "OSC-000001", contact } }], ai_lead_interests: [{ lead_id: "L1", project_id: "t1", interest: "enquired" }], ai_consent_current: [], ai_consent_records: [],
    ai_handover_events: [],
    ai_automation_jobs: [
      { id: "AJ1", kind: "smart_follow_up", status: "scheduled", run_at: new Date(Date.now() + 6 * 3600e3).toISOString(), conversation_id: "V1", lead: { id: "L1", lead_code: "OSC-000001", contact }, checks: [] },
      { id: "AJ2", kind: "appt_reminder", status: "sent", offset_minutes: 1440, run_at: NOW, sent_at: NOW, conversation_id: "V1", lead: { id: "L1", lead_code: "OSC-000001", contact },
        checks: [{ check: "appointment is confirmed", ok: true }, { check: "inside WhatsApp's 24-hour window (free-form message allowed)", ok: true }] },
      { id: "AJ3", kind: "smart_follow_up", status: "cancelled", reason: "a person replied", run_at: NOW, conversation_id: "V1", lead: { id: "L1", lead_code: "OSC-000001", contact }, checks: [] }],
    ai_financing_profiles: [{ id: "FP1", lead_id: "L1", route: "lppsa", inputs: FIN_INPUTS, result: finResult, outcome: finResult.outcome, source: "ai", updated_by: "ai", updated_at: NOW }],
    ai_financing_assessments: [{ id: "FA1", lead_id: "L1", route: "lppsa", outcome: finResult.outcome, result: finResult, source: "ai", created_by: "ai", created_at: NOW, rules_version: finResult.rules_version }],
    ai_conversations: [{ id: "V1", contact_id: "c1", lead_id: "L1", channel: "whatsapp", mode: "ai", status: "open", last_inbound_at: NOW, unread_count: 2, created_at: NOW, contact, lead: { id: "L1", lead_code: "OSC-000001", ai_paused: false } }],
    ai_messages: [
      { id: "m1", conversation_id: "V1", direction: "inbound", sender_type: "customer", body: "Salam, boleh info M Mira?", status: "received", created_at: NOW },
      { id: "m2", conversation_id: "V1", direction: "outbound", sender_type: "ai", body: "Hai! Saya pembantu AI One Stop Centre.", status: "read", created_at: NOW },
      { id: "m3", conversation_id: "V1", direction: "outbound", sender_type: "human", sender_email: "advisor@test.local", body: "Boleh saya call?", status: "failed", status_reason: "131026 Message undeliverable", created_at: NOW }],
    ai_project_facts: [], ai_project_units: [], ai_project_prices: [], ai_promotions: [], ai_active_promotions: [],
    ai_faqs: [], ai_documents: [], ai_knowledge_chunks: [], ai_objections: [{ id: "o1", key: "price_too_high", examples: ["Harga mahal"], guidance_en: "Acknowledge", guidance_ms: "Akui", escalate: false, active: true }],
    ai_message_templates: [], ai_follow_up_sequences: [{ id: "f1", name: "New enquiry (example)", lead_type: "new_enquiry", steps: [{ delay_hours: 24, purpose: "service", instruction: "Check in" }], stop_on: ["opt_out"], active: false }],
    ai_follow_up_jobs: [], ai_audit_logs: [{ id: 1, actor: "owner@test.local", action: "update", table_name: "ai_settings", record_id: "1", changes: {}, created_at: NOW }],
    ai_integration_accounts: [{ provider: "anthropic", status: "not_configured" }, { provider: "whatsapp_cloud", status: "not_configured" }],
    leads: [],
    ai_usage_daily: [{ day: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }), ai_messages: 12, capped: 0 }],
    ai_notifications: [{ kind: "appointment_reminder", status: "sent", error: null, created_at: NOW, message: "⏰ Appointment in 2 hour(s)" }],
  };
}

export async function newPage(viewport, { signedIn = true, mutate = null } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const db = fixtures();
  if (mutate) mutate(db);
  const writes = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  if (process.env.E2E_DEBUG) { page.on("console", (m) => console.error("console", m.type(), m.text().slice(0, 300))); page.on("request", (r) => console.error("req", r.method(), r.url().slice(0, 160))); page.on("requestfinished", (r) => console.error("done", r.url().slice(0, 100))); }
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_|fonts\.g/.test(m.text())) errors.push("console: " + m.text()); });
  await page.route("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.min.js", (r) => r.fulfill({ path: path.join(VENDOR, "supabase-supabase-js-2.49.4/package/dist/umd/supabase.js"), contentType: "text/javascript" }));
  await page.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ body: "", contentType: "text/css" }));
  await page.route("https://fonts.gstatic.com/**", (r) => r.abort());
  await page.route("https://deethrwnmyezwsohmhzl.supabase.co/**", async (r) => {
    const req = r.request(), u = new URL(req.url()), m = req.method();
    const json = (b, status = 200, h = {}) => r.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-expose-headers": "content-range", ...h }, body: JSON.stringify(b) });
    if (m === "OPTIONS") return json({});
    if (u.pathname === "/auth/v1/token") return json({ access_token: "tok", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r", user: { id: "u1", email: "owner@test.local", aud: "authenticated" } });
    if (u.pathname === "/auth/v1/user") return json({ id: "u1", email: "owner@test.local" });
    if (u.pathname === "/auth/v1/logout") return json({});
    const rpc = u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)/);
    if (rpc) {
      writes.push({ rpc: rpc[1], body: req.postDataJSON?.() });
      if (rpc[1] === "ai_role") return json("owner");
      if (rpc[1] === "ai_upsert_contact") return json("c2");
      if (rpc[1] === "ai_open_lead") return json("L2");
      if (rpc[1] === "ai_telegram_test") return json({ queued: true, status: "sent", error: null });
      if (rpc[1] === "ai_import_website_leads") return json({ imported: 0, skipped_no_contact: 0 });
      if (rpc[1] === "ai_take_over") return json({ mode: "human" });
      if (rpc[1] === "ai_resume_ai") return json({ mode: "ai", handovers_resolved: 0 });
      if (rpc[1] === "ai_cancel_automation_job") return json(true);
      return json([]);
    }
    const t = u.pathname.replace("/rest/v1/", "");
    if (m !== "GET" && m !== "HEAD") { const body = req.postData() ? JSON.parse(req.postData()) : null; writes.push({ table: t, method: m, body, query: u.search }); return json(Array.isArray(body) ? body : [{ ...(body || {}), id: "new" }], m === "POST" ? 201 : 200); }
    let rows = db[t] || [];
    for (const [k, v] of u.searchParams) { const mm = /^eq\.(.*)$/.exec(v); if (mm && !k.includes(".")) rows = rows.filter((x) => String(x[k]) === mm[1]); }
    if (m === "HEAD") return json(null, 200, { "content-range": `0-0/${rows.length}` });
    if ((req.headers()["accept"] || "").includes("vnd.pgrst.object")) return rows.length ? json(rows[0]) : json(null, 406, {});
    return json(rows, 200, { "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}` });
  });
  await page.route("**/api/sales/ai/simulate", async (r) => {
    const req = JSON.parse(r.request().postData() || "{}");
    writes.push({ simulate: req });
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ decision: "handover", reply: "Baik, permintaan diskaun perlu disemak oleh penasihat kami.", intent: "negotiation", agent: "handover", language: "ms", confidence: 0.9, model: "claude-opus-5-5", latency_ms: 4200,
      attempts: [{ attempt: 1, reply: "Saya boleh bagi RM10,000 lagi!", violations: [{ code: "unverified_price", detail: "RM10,000 does not match any verified price" }] }, { attempt: 2, reply: "ok", violations: [] }],
      actions: [{ type: "handover", reason: "negotiation", next_action: "Call about pricing" }, { type: "update_qualification", changed: ["asked_price"], score: 34, temperature: "nurture" }], facts_used: ["price:t1:Type A"], simulated: true, financing: { inputs: { route: "bank", age: 35 }, result: null, recalculated: true } }) });
  });
  await page.route("**/api/sales/whatsapp/send", (r) => { writes.push({ send: JSON.parse(r.request().postData() || "{}") }); r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, message_id: "new" }) }); });
  await page.route("**/api/sales/appointments/slots", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ slots: [
    { id: "s1", start: "2030-01-05T02:00:00.000Z", end: "2030-01-05T03:00:00.000Z", label_en: "Sat, 5 Jan, 10:00 am", label_ms: "Sab, 5 Jan, 10:00 PG" },
    { id: "s2", start: "2030-01-07T06:00:00.000Z", end: "2030-01-07T07:00:00.000Z", label_en: "Mon, 7 Jan, 2:00 pm", label_ms: "Isn, 7 Jan, 2:00 PTG" }] }) }));
  await page.route("**/api/sales/appointments/confirm", (r) => { writes.push({ confirm: JSON.parse(r.request().postData() || "{}") }); r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, calendar: true, buyer_notified: true, note: null }) }); });
  await page.route("**/api/sales/whatsapp/setup", (r) => { const b = JSON.parse(r.request().postData() || "{}"); writes.push({ setup: b });
    const linked = b.action === "subscribe";
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ healthy: linked, waba_id: b.waba_id, phone: { display_phone_number: "+60 18-763 6796", verified_name: "Hafizan Hanis", status: "CONNECTED" }, phone_in_account: true,
      subscribed_apps: linked ? [{ id: "1", name: "OneStopCentre Sales" }] : [], ...(linked ? { linked: { ok: true } } : {}) }) }); });
  await page.route("**/api/sales/health", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ server_enabled: false, database: "ok", configured: { llm_anthropic: false }, checked_at: NOW }) }));
  if (signedIn) {
    await page.addInitScript((s) => localStorage.setItem("sb-deethrwnmyezwsohmhzl-auth-token", JSON.stringify(s)), { access_token: "tok", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r", user: { id: "u1", email: "owner@test.local", aud: "authenticated" } });
  }
  return { page, ctx, errors, writes };
}

/** Every dashboard route the browser tests visit. */
export const SECTIONS = ["overview", "inbox", "inbox?c=V1", "ai-test", "leads", "lead/L1", "pipeline", "appointments", "handover", "properties", "property/t1", "knowledge", "knowledge?tab=entries", "knowledge?tab=faqs", "knowledge?tab=search",
  "templates", "templates?tab=templates", "followups", "campaigns", "reports", "settings", "settings?tab=persona", "settings?tab=ai", "settings?tab=scoring", "settings?tab=business", "settings?tab=compliance", "settings?tab=notifications", "settings?tab=financing", "settings/pipeline", "team", "integrations", "audit", "audit?tab=consent", "audit?tab=retention"];

/** Navigates the dashboard to `#/route` and waits until that page (not the previous one) has rendered. */
export async function go(page, route) {
  await page.evaluate((h) => {
    document.querySelectorAll("#view > *").forEach((n) => { n.dataset.stale = "1"; });
    if (location.hash === "#/" + h) window.dispatchEvent(new HashChangeEvent("hashchange")); else location.hash = "#/" + h;
  }, route);
  await page.waitForFunction(() => {
    const v = document.querySelector("#view");
    return v && v.firstElementChild && !v.querySelector("[data-stale]") && !v.querySelector(".loading") && (v.querySelector("h1") || v.querySelector(".card.error"));
  }, null, { timeout: 10000 }).catch(async () => { throw new Error(`${route}: did not finish rendering. View: ${(await page.textContent("#view")).slice(0, 300)}`); });
}
