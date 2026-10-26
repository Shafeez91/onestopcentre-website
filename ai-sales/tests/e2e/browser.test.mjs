// Browser tests (Playwright): /sales/ dashboard on phone, iPad and desktop, plus a smoke test that the
// existing website still renders. Supabase is replaced by an in-memory fake; CDN libraries are served from
// a local copy given in VENDOR_DIR (same pinned versions). Nothing here talks to production.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const VENDOR = process.env.VENDOR_DIR;
const skip = !VENDOR || !existsSync(VENDOR) ? "set VENDOR_DIR to run browser tests (see ai-sales/run-tests.sh)" : false;
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

before(async () => {
  if (skip || !chromium) return;
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
});
after(async () => { await browser?.close(); server?.close(); });

/* ---------- fake Supabase (TEST FIXTURES ONLY) ---------- */
const NOW = new Date().toISOString();
function fixtures() {
  const stages = ["New Lead", "Contacted", "Qualified", "Appointment Pending", "Won", "Lost"].map((n, i) => ({ id: "s" + i, name: n, position: i + 1, is_won: n === "Won", is_lost: n === "Lost", active: true }));
  const contact = { id: "c1", full_name: "Test Buyer", phone_e164: "60123456789", email: "buyer@example.test", preferred_language: "ms" };
  return {
    ai_settings: [{ id: 1, flags: { module_enabled: true, website_lead_import: true, ai_auto_reply: false, whatsapp_outbound: false, follow_ups: false, calendar_booking: false },
      persona: { name: "OSC Property Assistant", tone: "Friendly", greeting_en: "Hi", greeting_ms: "Hai", allow_manglish: true }, business: { timezone: "Asia/Kuala_Lumpur", hours: { mon: ["09:00", "18:00"], sun: null }, inventory_max_age_hours: 72, price_max_age_days: 30, max_marketing_messages_per_week: 2 },
      scoring: { weights: { readiness: 25, budget: 20, suitability: 15, timeline: 15, engagement: 15, financing: 10 }, thresholds: { hot: 70, warm: 45, nurture: 20 } }, ai: { provider: "anthropic", model: "", confidence_threshold: 0.7, max_reply_chars: 700 }, compliance: { pdpa_notice_en: "x", pdpa_notice_ms: "y" },
      notifications: { telegram_enabled: true, telegram_chat_id: "123456789", appointment_changes: true, appointment_reminder_minutes: [1440, 120], task_reminders: true, task_lead_minutes: 30, daily_digest: true, digest_hour: 8 } }],
    ai_pipeline_stages: stages,
    ai_lead_sources: [{ id: "src1", name: "Website enquiry form", channel: "website", active: true }],
    ai_campaigns: [], ai_team_members: [{ email: "advisor@test.local", role: "advisor", active: true }],
    projects: [{ id: "t1", slug: "test-residence", published: true, data: { id: "t1", slug: "test-residence", n: "Test Residence", l: "Cheras", d: "Test Developer", s: "New Launch", t: "Condominium", c: "Residential", types: [{ name: "Type A", size: "800", beds: "3", baths: "2", price: "RM450,000" }], gallery: [] } }],
    settings: [{ data: { wa: "60123456789", email: "test@example.test", order: ["t1"] } }],
    ai_leads: [{ id: "L1", lead_code: "OSC-000001", contact_id: "c1", contact, stage_id: "s0", temperature: "warm", score: 52, score_rationale: [{ label: "Purchase readiness", points: 15, max: 25, known: true, detail: "considering" }], qualification: { readiness: "considering" }, owner_email: null, source_id: "src1", primary_project_id: "t1", handover_status: "none", ai_paused: false, created_at: NOW, updated_at: NOW, closed_at: null }],
    ai_contacts: [contact], ai_activities: [{ id: "a1", lead_id: "L1", kind: "website_enquiry", body: "Berapa harga?", actor: "website", created_at: NOW }],
    ai_tasks: [], ai_appointments: [{ id: "A1", lead_id: "L1", kind: "showroom_visit", status: "pending_confirmation", preferred_text: "Sabtu pagi", start_at: null, reminders: [], created_at: NOW, lead: { id: "L1", lead_code: "OSC-000001", contact } }], ai_lead_interests: [{ lead_id: "L1", project_id: "t1", interest: "enquired" }], ai_consent_current: [], ai_consent_records: [],
    ai_handover_events: [],
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

async function newPage(viewport, { signedIn = true, mutate = null } = {}) {
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
      actions: [{ type: "handover", reason: "negotiation", next_action: "Call about pricing" }, { type: "update_qualification", changed: ["asked_price"], score: 34, temperature: "nurture" }], facts_used: ["price:t1:Type A"], simulated: true }) });
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

const VIEWPORTS = { phone: { width: 390, height: 844 }, ipad: { width: 820, height: 1180 }, desktop: { width: 1366, height: 900 } };
const SECTIONS = ["overview", "inbox", "inbox?c=V1", "ai-test", "leads", "lead/L1", "pipeline", "appointments", "handover", "properties", "property/t1", "knowledge", "knowledge?tab=entries", "knowledge?tab=faqs", "knowledge?tab=search",
  "templates", "templates?tab=templates", "followups", "campaigns", "reports", "settings", "settings?tab=persona", "settings?tab=ai", "settings?tab=scoring", "settings?tab=business", "settings?tab=compliance", "settings?tab=notifications", "settings/pipeline", "team", "integrations", "audit", "audit?tab=consent", "audit?tab=retention"];

for (const [name, vp] of Object.entries(VIEWPORTS)) {
  test(`every dashboard section renders without errors or horizontal scroll — ${name}`, { skip: skip || (!chromium && "playwright not installed") }, async () => {
    const { page, ctx, errors } = await newPage(vp);
    try {
      if (process.env.E2E_DEBUG) console.error("goto");
      await page.goto(base + "/sales/#/overview");
      if (process.env.E2E_DEBUG) console.error("loaded");
      await page.waitForSelector("#view h1");
      for (const s of SECTIONS) {
        if (process.env.E2E_DEBUG) console.error("section", s);
        await page.evaluate((h) => { location.hash = "#/" + h; }, s);
        await page.waitForFunction(() => document.querySelector("#view h1") && !document.querySelector("#view .loading"), null, { timeout: 10000 }).catch(async () => { throw new Error(`${s}: did not finish rendering. View: ${(await page.textContent("#view")).slice(0, 300)}`); });
        const h1 = await page.textContent("#view h1");
        assert.ok(h1 && h1.trim(), `${s}: has a heading`);
        if (await page.locator("#view .card.error").count()) assert.fail(`${s}: error card shown: ${await page.textContent("#view .card.error")}`);
        if (process.env.E2E_SHOTS && ["overview", "lead/L1", "pipeline", "settings"].includes(s)) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, `${name}-${s.replace(/\W+/g, "_")}.png`), fullPage: name !== "desktop" ? false : true });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 1, `${s}: page scrolls horizontally by ${overflow}px at ${vp.width}px`);
      }
      assert.deepEqual(errors, [], "no JavaScript or CSP errors");
    } finally { await ctx.close(); }
  });
}

test("sign-in screen, then owner lands on the overview; mobile menu opens and closes", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, errors } = await newPage(VIEWPORTS.phone, { signedIn: false });
  try {
    await page.goto(base + "/sales/");
    await page.fill("input[name=email]", "owner@test.local");
    await page.fill("input[name=password]", "correct horse battery");
    await page.click("button.btn.pri");
    await page.waitForSelector("#view h1:has-text('Overview')");
    assert.equal(await page.isVisible("#side"), true);
    const box0 = await page.locator("#side").boundingBox();
    assert.ok(box0.x < 0, "menu hidden off-canvas on phones");
    await page.click("#mbtn");
    await page.waitForTimeout(300);
    assert.ok((await page.locator("#side").boundingBox()).x >= 0, "menu slides in");
    await page.click("#side a[data-nav=leads]");
    await page.waitForSelector("#view h1:has-text('Leads')");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("unsaved form edits survive navigating away and back", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx } = await newPage(VIEWPORTS.desktop);
  try {
    await page.goto(base + "/sales/#/lead/L1");
    await page.waitForSelector("#fc");
    await page.fill("#fc input[name=full_name]", "Edited Name Not Saved");
    await page.evaluate(() => { location.hash = "#/pipeline"; });
    await page.waitForSelector("#view h1:has-text('pipeline')");
    await page.evaluate(() => { location.hash = "#/lead/L1"; });
    await page.waitForSelector("#fc");
    assert.equal(await page.inputValue("#fc input[name=full_name]"), "Edited Name Not Saved");
    assert.ok(await page.locator("#fc.has-draft").count(), "form is flagged as an unsaved draft");
  } finally { await ctx.close(); }
});

test("new lead: validates phone, uses the de-duplicating database functions, shows success", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes } = await newPage(VIEWPORTS.ipad);
  try {
    await page.goto(base + "/sales/#/leads");
    await page.click("#new");
    await page.fill("#nl input[name=phone]", "12");
    await page.click("#nl button[type=submit]");
    await page.waitForSelector(".toast.err");
    assert.match(await page.textContent(".toast.err"), /phone number/);
    await page.fill("#nl input[name=name]", "Siti");
    await page.fill("#nl input[name=phone]", "012-888 7777");
    await page.click("#nl button[type=submit]");
    await page.waitForFunction(() => location.hash === "#/lead/L2");
    assert.ok(writes.some((w) => w.rpc === "ai_upsert_contact" && w.body.p_phone === "012-888 7777"));
    assert.ok(writes.some((w) => w.rpc === "ai_open_lead"));
  } finally { await ctx.close(); }
});

test("rescoring a lead stores the transparent score and rationale", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes } = await newPage(VIEWPORTS.desktop);
  try {
    await page.goto(base + "/sales/#/lead/L1");
    await page.waitForSelector("#fq");
    await page.selectOption("#fq select[name=readiness]", "ready");
    await page.fill("#fq input[name=budget_max]", "500000");
    await page.fill("#fq input[name=timeline_months]", "2");
    await page.click("#fq button");
    await page.waitForSelector(".toast:not(.err)");
    const w = writes.find((x) => x.table === "ai_leads" && x.method === "PATCH" && x.body.score !== undefined);
    assert.ok(w, "lead updated with a score");
    assert.ok(w.body.score > 52);
    assert.equal(w.body.score_rationale.find((r) => r.factor === "budget").detail.includes("within budget"), true);
  } finally { await ctx.close(); }
});

test("existing website homepage still renders listings and the enquiry form still writes to public.leads", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes } = await newPage(VIEWPORTS.phone, { signedIn: false });
  try {
    await page.goto(base + "/");
    await page.waitForFunction(() => document.body.innerText.includes("Test Residence"), null, { timeout: 15000 });
    const sales = await page.evaluate(() => [...document.querySelectorAll("a")].filter((a) => /\/sales\//.test(a.getAttribute("href") || "")).length);
    assert.equal(sales, 0, "public website does not link to the staff dashboard");
    const hasForm = await page.locator("#q_name").count();
    if (hasForm) {
      await page.evaluate(() => { const el = document.getElementById("q_name"); el.closest("section,div,form").scrollIntoView(); });
      const ok = await page.evaluate(async () => {
        const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); } };
        set("q_name", "Regression Test"); set("q_phone", "0123456789");
        const ok = document.getElementById("q_ok"); if (ok) ok.checked = true; // the form's own consent box
        return !!document.getElementById("q_go");
      });
      assert.ok(ok, "enquiry button present");
      await page.waitForTimeout(4200); // the form deliberately ignores submissions in the first 4 s (bot guard)
      await page.evaluate(() => document.getElementById("q_go").click());
      await page.waitForFunction(() => /Thank you/.test(document.getElementById("q_msg").textContent), null, { timeout: 5000 });
      const insert = writes.find((w) => w.table === "leads" && w.method === "POST");
      assert.ok(insert, "enquiry posted to public.leads");
      assert.equal(insert.body.name, "Regression Test");
      assert.equal(insert.body.consent, true);
    }
  } finally { await ctx.close(); }
});

test("Telegram settings: validates input, saves the reminder timings and sends a test message", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes, errors } = await newPage(VIEWPORTS.phone);
  try {
    await page.goto(base + "/sales/#/settings?tab=notifications");
    await page.waitForSelector("#sf input[name=telegram_chat_id]");
    await page.fill("#sf input[name=appointment_reminder_minutes]", "60, abc");
    await page.click("#sf button[type=submit]");
    await page.waitForSelector(".toast.err");
    await page.fill("#sf input[name=appointment_reminder_minutes]", "120, 1440, 30");
    await page.click("#sf button[type=submit]");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /saved/.test(t.textContent)));
    const w = writes.find((x) => x.table === "ai_settings" && x.body && x.body.notifications);
    assert.deepEqual(w.body.notifications.appointment_reminder_minutes, [1440, 120, 30]);
    assert.equal(w.body.notifications.telegram_chat_id, "123456789");
    await page.click("#tgtest");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /Test message sent/.test(t.textContent)));
    assert.ok(writes.some((x) => x.rpc === "ai_telegram_test"));
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("AI test console: sends the conversation, shows the draft, the checker result and what the AI would do", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes, errors } = await newPage(VIEWPORTS.phone);
  try {
    await page.goto(base + "/sales/#/ai-test");
    await page.waitForSelector("#msg");
    await page.click("[data-s='Boleh bagi discount lagi?']");
    await page.click("#say button");
    await page.waitForSelector(".msg.ai .bubble", { timeout: 8000 }).catch(async (e) => { throw new Error("no AI bubble; chat shows: " + (await page.textContent("#chat")) + " | errors: " + errors.join("; ")); });
    assert.match(await page.textContent(".msg.ai .bubble"), /penasihat kami/);
    assert.match(await page.textContent(".msg.ai .why"), /alert a human/i);
    await page.click(".msg.ai details summary");
    const details = await page.textContent(".msg.ai details");
    assert.match(details, /Alert a human — price negotiation/);
    assert.match(details, /unverified_price/);
    const sent = writes.find((w) => w.simulate).simulate;
    assert.deepEqual(sent, { lead_id: null, history: [], message: "Boleh bagi discount lagi?" });
    await page.fill("#msg", "ok terima kasih");
    await page.click("#say button");
    await page.waitForFunction(() => document.querySelectorAll(".msg.ai").length === 2);
    if (process.env.E2E_SHOTS) { await page.click(".msg.ai details summary"); await page.screenshot({ path: path.join(process.env.E2E_SHOTS, "phone-ai-test.png"), fullPage: true }); }
    const second = writes.filter((w) => w.simulate)[1].simulate;
    assert.equal(second.history.length, 2, "previous buyer message and AI reply are sent as history");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("AI settings: shows today's usage and saves a valid daily limit", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes, errors } = await newPage(VIEWPORTS.ipad);
  try {
    await page.goto(base + "/sales/#/settings?tab=ai");
    await page.waitForSelector("#sf input[name=daily_message_cap]");
    assert.match(await page.textContent("#sbody"), /Today: 12 of 200 AI replies used/);
    await page.fill("#sf input[name=daily_message_cap]", "-5");
    await page.click("#sf button");
    assert.equal(await page.$eval("#sf input[name=daily_message_cap]", (el) => el.checkValidity()), false, "browser rejects a negative limit");
    assert.ok(!writes.some((x) => x.table === "ai_settings"), "nothing saved");
    await page.fill("#sf input[name=daily_message_cap]", "50");
    await page.click("#sf button");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent === "Saved"));
    const w = writes.find((x) => x.table === "ai_settings" && x.body?.ai);
    assert.equal(w.body.ai.daily_message_cap, 50);
    assert.equal(w.body.ai.confidence_threshold, 0.7, "other AI settings kept");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("WhatsApp inbox: thread with delivery ticks, reply as staff, take over from the AI", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes, errors } = await newPage(VIEWPORTS.desktop, { mutate: (db) => { db.ai_settings[0].flags.whatsapp_outbound = true; } });
  try {
    await page.goto(base + "/sales/#/inbox?c=V1");
    await page.waitForSelector("#reply textarea");
    const chat = await page.textContent("#msgs");
    assert.match(chat, /Salam, boleh info M Mira\?/);
    assert.match(chat, /AI assistant/);
    assert.equal(await page.getAttribute(".tick.read", "title"), "Read");
    assert.match(await page.textContent(".msg .err"), /131026 Message undeliverable/);
    assert.ok(writes.some((w) => w.table === "ai_conversations" && w.body?.unread_count === 0), "opening the chat clears the unread count");
    assert.equal(await page.isChecked("#reply input[name=take_over]"), true, "replying pauses the AI by default");
    await page.fill("#reply textarea", "Boleh, saya call petang ini.");
    await page.click("#reply button");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /Sent on WhatsApp/.test(t.textContent)));
    assert.deepEqual(writes.find((w) => w.send).send, { conversation_id: "V1", text: "Boleh, saya call petang ini.", take_over: true });
    await page.click("#take");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /You are handling this chat/.test(t.textContent)));
    assert.ok(writes.some((w) => w.table === "ai_conversations" && w.body?.mode === "human"));
    assert.ok(writes.some((w) => w.table === "ai_leads" && w.body?.ai_paused === true));
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("WhatsApp inbox on a phone: list or thread one at a time; after 24 hours only templates can be sent", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const old = new Date(Date.now() - 2 * 864e5).toISOString();
  const { page, ctx, errors } = await newPage(VIEWPORTS.phone, { mutate: (db) => { db.ai_conversations[0].last_inbound_at = old; } });
  try {
    await page.goto(base + "/sales/#/inbox");
    await page.waitForSelector(".conv-list a");
    assert.equal(await page.isVisible("#thread"), false, "thread hidden until a chat is chosen");
    await page.click(".conv-list a");
    await page.waitForSelector("#msgs");
    assert.equal(await page.isVisible(".conv-list"), false, "list hidden while reading a chat");
    assert.equal(await page.isVisible(".thread .back"), true);
    assert.equal(await page.locator("#reply").count(), 0, "no free-text reply outside the window");
    assert.match(await page.textContent("#thread"), /only allows an approved template/);
    assert.match(await page.textContent("#view"), /WhatsApp sending is off/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal scroll (${overflow}px)`);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("appointments: confirm a pending request using a free calendar slot and notify the buyer", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes, errors } = await newPage(VIEWPORTS.ipad);
  try {
    await page.goto(base + "/sales/#/appointments");
    await page.click("[data-confirm=A1]");
    await page.waitForSelector("#fc");
    assert.match(await page.textContent("#fc"), /buyer asked for Sabtu pagi/);
    await page.click("#slots");
    await page.waitForSelector("[data-start]");
    await page.click("[data-start='2030-01-07T06:00:00.000Z']");
    await page.click("#fc button[type=submit]");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /added to Google Calendar/.test(t.textContent)));
    const c = writes.find((w) => w.confirm).confirm;
    assert.deepEqual([c.appointment_id, c.start_at, c.notify_buyer, c.duration_minutes], ["A1", "2030-01-07T06:00:00.000Z", true, 60]);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("integrations: WhatsApp connection check finds the unlinked account and links it", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes, errors } = await newPage(VIEWPORTS.ipad);
  try {
    await page.goto(base + "/sales/#/integrations");
    await page.waitForSelector("#wac");
    await page.fill("#wac input[name=waba_id]", "850701657747469");
    await page.click("#wac button");
    await page.waitForSelector("#walink");
    assert.match(await page.textContent("#wacr"), /not fully connected[\s\S]*\+60 18-763 6796[\s\S]*Account linked to an app\s*No/);
    await page.click("#walink");
    await page.waitForFunction(() => /WhatsApp is connected\./.test(document.querySelector("#wacr").textContent));
    assert.deepEqual(writes.filter((w) => w.setup).map((w) => w.setup.action), ["check", "subscribe"]);
    assert.match(await page.textContent("#wacr"), /OneStopCentre Sales/);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
