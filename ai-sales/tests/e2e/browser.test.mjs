// Browser tests (Playwright): /sales/ dashboard on phone, iPad and desktop, plus a smoke test that the
// existing website still renders. Supabase is replaced by an in-memory fake (harness.mjs); CDN libraries are
// served from a local copy given in VENDOR_DIR (same pinned versions). Nothing here talks to production.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { skip as harnessSkip, canRun, start, stop, newPage, go, SECTIONS } from "./harness.mjs";

const skip = harnessSkip;
const chromium = canRun();
let base;
before(async () => { base = await start(); });
after(stop);

const VIEWPORTS = { phone: { width: 390, height: 844 }, ipad: { width: 820, height: 1180 }, desktop: { width: 1366, height: 900 } };

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
        await go(page, s);
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
    assert.equal(await page.locator("#sf input[name=whatsapp_alerts]").count(), 0, "no per-WhatsApp-message alert option");
    assert.equal(await page.isChecked("#sf input[name=cat_new_website_lead]"), true, "the three alert types are on by default");
    await page.uncheck("#sf input[name=cat_appointment_notification]");
    await page.click("#sf button[type=submit]");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /saved/.test(t.textContent)));
    const w = writes.find((x) => x.table === "ai_settings" && x.body && x.body.notifications);
    assert.deepEqual(w.body.notifications.appointment_reminder_minutes, [1440, 120, 30]);
    assert.equal(w.body.notifications.telegram_chat_id, "123456789");
    assert.deepEqual(w.body.notifications.categories, { new_website_lead: true, human_followup_reminder: true, appointment_notification: false });
    assert.ok(!("cat_new_website_lead" in w.body.notifications) && !("whatsapp_alerts" in w.body.notifications));
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
    assert.deepEqual(sent, { lead_id: null, history: [], message: "Boleh bagi discount lagi?", financing_inputs: null });
    await page.fill("#msg", "ok terima kasih");
    await page.click("#say button");
    await page.waitForFunction(() => document.querySelectorAll(".msg.ai").length === 2);
    if (process.env.E2E_SHOTS) { await page.click(".msg.ai details summary"); await page.screenshot({ path: path.join(process.env.E2E_SHOTS, "phone-ai-test.png"), fullPage: true }); }
    const second = writes.filter((w) => w.simulate)[1].simulate;
    assert.equal(second.history.length, 2, "previous buyer message and AI reply are sent as history");
    assert.deepEqual(second.financing_inputs, { route: "bank", age: 35 }, "loan figures from earlier turns are carried forward");
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
    assert.match(await page.textContent("#thread"), /Follow-up pending[\s\S]*Sending a reply here \(or from the WhatsApp app\) hands the chat to you/);
    await page.fill("#reply textarea", "Boleh, saya call petang ini.");
    await page.click("#reply button");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /Sent on WhatsApp — you are now handling this chat/.test(t.textContent)));
    assert.deepEqual(writes.find((w) => w.send).send, { conversation_id: "V1", text: "Boleh, saya call petang ini." });
    await page.click("#take");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /You are handling this chat/.test(t.textContent)));
    assert.deepEqual(writes.find((w) => w.rpc === "ai_take_over").body, { p_conversation: "V1" });
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

test("appointments: archive a pending request (no status change), restore it, and cancel a booked one through the server", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const NOW = new Date().toISOString(), FUTURE = new Date(Date.now() + 3 * 864e5).toISOString();
  const { page, ctx, writes, errors } = await newPage(VIEWPORTS.ipad, { mutate: (db) => {
    db.ai_appointments.push({ id: "A2", lead_id: "L1", kind: "showroom_visit", status: "confirmed", start_at: FUTURE, calendar_provider: "google", calendar_event_id: "EV9", reminders: [], created_at: NOW, lead: db.ai_appointments[0].lead });
    db.ai_appointments.push({ id: "A3", lead_id: "L1", kind: "phone_call", status: "cancelled", archived_at: NOW, reminders: [], created_at: NOW, lead: db.ai_appointments[0].lead });
  } });
  try {
    page.on("dialog", (d) => d.accept());
    await page.goto(base + "/sales/#/appointments");
    await page.click("[data-close-appt=A1]");
    await page.click("[data-choice=archive]");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /archived/.test(t.textContent)));
    const arch = writes.find((w) => w.table === "ai_appointments" && w.body?.archived_at);
    assert.match(arch.query, /id=eq\.A1/);
    assert.deepEqual(Object.keys(arch.body).sort(), ["archived_at", "archived_by"], "archiving never changes the status");

    // a booked appointment still ahead cannot be archived, only closed; cancelling goes through the server (calendar)
    await page.click("[data-close-appt=A2]");
    assert.equal(await page.$("dialog [data-choice=archive]"), null);
    assert.match(await page.textContent("dialog"), /Google Calendar event is deleted/);
    await page.click("[data-choice=cancel]");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /removed from Google Calendar/.test(t.textContent)));
    assert.equal(writes.find((w) => w.cancel).cancel.appointment_id, "A2");

    await page.goto(base + "/sales/#/appointments?scope=archived");
    await page.click("[data-restore=A3]");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /restored/.test(t.textContent)));
    assert.deepEqual(writes.find((w) => w.table === "ai_appointments" && w.body && "archived_at" in w.body && w.body.archived_at === null).body, { archived_at: null, archived_by: null });
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("property projects: 'What the AI knows' shows listing gaps, conflicts and per-field coverage", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, errors } = await newPage(VIEWPORTS.ipad, { mutate: (db) => {
    Object.assign(db.projects[0].data, { tenure: "Freehold", year: "2028", maintPsf: "0.35", furn: "No", furnList: ["Sofa"] });
    db.projects[0].data.types.push({ name: "Type B", size: "1000", beds: "4", baths: "3", price: "RM560,000", carparks: "2 (Tandem)" });
  } });
  try {
    await page.goto(base + "/sales/#/properties");
    await page.waitForSelector("#coverage");
    const row = await page.textContent("#coverage tbody tr");
    assert.match(row, /Test Residence/);
    assert.match(row, /Car parks \(some layouts\)/, "Type A has no car parks on the website");
    assert.match(row, /Furnishing/, "Unfurnished with furnished items listed is a conflict");
    await page.goto(base + "/sales/#/property/t1");
    await page.waitForSelector("#coverage dl");
    const kv = await page.textContent("#coverage dl");
    assert.match(kv, /Car parks\s*Some layouts\s*Type A: — · Type B: 2 \(Tandem\)/);
    assert.match(kv, /Lease years\s*N\/A/);
    assert.match(kv, /Maintenance fee\s*On website\s*RM0.35 psf/);
    assert.match(kv, /Booking fee \(staff\)\s*Not provided/);
    assert.match(await page.textContent(".mini"), /Car parks[\s\S]*2 \(Tandem\)/);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

const toastSeen = (page, re) => page.waitForFunction((src) => [...document.querySelectorAll(".toast")].some((t) => new RegExp(src).test(t.textContent)), re.source);

test("app shell: grouped menu, breadcrumb, collapsible rail remembered, global search, quick add and notifications", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, errors } = await newPage(VIEWPORTS.desktop);
  try {
    await page.goto(base + "/sales/#/lead/L1");
    await page.waitForSelector("#view .page");
    assert.deepEqual(await page.$$eval("#side .grp", (g) => g.map((x) => x.textContent)), ["Overview", "Sales & Clients", "AI & Knowledge", "Reporting", "Administration", "Website"]);
    assert.match(await page.textContent("#crumbs"), /Sales & Clients\s*\/\s*Leads & CRM\s*\/\s*Lead/);
    assert.equal(await page.getAttribute("[data-nav=leads]", "aria-current"), "page");
    // collapse to icons; remembered after a reload
    await page.click("#cbtn");
    assert.ok(await page.$(".shell.collapsed"));
    await page.reload();
    await page.waitForSelector(".shell.collapsed #view .page");
    // notifications: what needs a person, with links
    await page.click("#bellbtn");
    assert.match(await page.textContent("#bellmenu"), /workflow lead\(s\) need a person[\s\S]*appointment\(s\) to confirm/);
    await page.keyboard.press("Escape");
    assert.equal(await page.isVisible("#bellmenu"), false);
    // global search goes to the leads list with the search filled in
    await page.fill("#gq", "osc-000001");
    await page.press("#gq", "Enter");
    await page.waitForFunction(() => location.hash === "#/leads?q=osc-000001");
    await page.waitForFunction(() => document.querySelector("#flt input[name=q]")?.value === "osc-000001");
    // quick add: new lead form opens straight away
    await page.click("#addbtn");
    await page.click("#addmenu a[href='#/leads?new=1']");
    await page.waitForSelector("dialog.modal #nl");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("workflow page: board by stage, overdue shown, stage change and pause through the database functions; the old RMK link still works", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes, errors } = await newPage(VIEWPORTS.ipad);
  try {
    await page.goto(base + "/sales/#/rmk");
    await page.waitForSelector(".wf-kpis");
    assert.match(await page.textContent(".wf-kpis"), /2\s*Leads[\s\S]*1\s*To book unit[\s\S]*1\s*To sign LO, SPA & LA[\s\S]*1\s*Overdue/);
    assert.match(await page.textContent(".notice"), /Sending is off/);
    const board = await page.textContent(".kanban");
    assert.match(board, /To book unit\s*1[\s\S]*Buyer replies DONE BOOKED[\s\S]*Test Buyer[\s\S]*Facebook/);
    assert.match(board, /To sign LO, SPA & LA\s*1[\s\S]*Rina Signer[\s\S]*Needs a person/);
    assert.equal(await page.getAttribute("[data-nav=workflows]", "class"), "on");
    await page.goto(base + "/sales/#/workflow/rmk?view=list");
    await page.waitForSelector("[data-stage=L1]");
    await page.selectOption("[data-stage=L1]", "to_portal");
    await toastSeen(page, /Stage changed: To apply portal/);
    assert.deepEqual(writes.find((w) => w.rpc === "ai_wf_set_stage").body, { p_wf: "WF1", p_lead: "L1", p_stage: "to_portal" });
    page.once("dialog", (d) => d.accept("buyer travelling"));
    await page.click("[data-pause=L1]");
    await toastSeen(page, /Paused/);
    assert.deepEqual(writes.find((w) => w.rpc === "ai_wf_set_status").body, { p_wf: "WF1", p_lead: "L1", p_status: "paused", p_reason: "buyer travelling" });
    await page.goto(base + "/sales/#/workflow/rmk?view=list&q=rina");
    await page.waitForFunction(() => /Rina Signer/.test(document.querySelector("#wfv")?.textContent || "") && !/Test Buyer/.test(document.querySelector("#wfv").textContent));
    assert.equal(await page.inputValue("#wff input[name=q]"), "rina");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("workflow list and new workflow: cards with real counts; a copy of RMK for another project is created with sending off", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes, errors } = await newPage(VIEWPORTS.desktop);
  try {
    await page.goto(base + "/sales/#/workflows");
    await page.waitForSelector(".wf-card");
    const c = await page.textContent(".wf-card");
    assert.match(c, /RMK — Residensi Metropolitan Kepong[\s\S]*Sending off[\s\S]*6 stages[\s\S]*2\s*Leads[\s\S]*1\s*Active[\s\S]*1\s*Need a person/);
    assert.match(await page.textContent(".wf-flow"), /New RMK enquiry\s*→\s*To book unit[\s\S]*All signed/);
    await page.click("#wfnew");
    await page.fill("#wfn input[name=name]", "Test Residence buyers");
    assert.equal(await page.inputValue("#wfn input[name=key]"), "test_residence_buyers");
    await page.selectOption("#wfn select[name=project_id]", "t1");
    await page.selectOption("#wfn select[name=from]", "WF1");
    await page.click("#wfn button.pri");
    await toastSeen(page, /Workflow created/);
    const p = writes.find((w) => w.rpc === "ai_wf_save").body.p;
    assert.deepEqual([p.id, p.key, p.name, p.project_id, p.sending_enabled, p.status], [undefined, "test_residence_buyers", "Test Residence buyers", "t1", false, "active"]);
    assert.deepEqual(p.stages.map((s) => [s.key, s.id, s.follow_up_hours, s.template]), [["new", undefined, 0, ""], ["to_book", undefined, 24, "rmk_to_book"], ["to_portal", undefined, 24, "rmk_to_portal"],
      ["to_submit_loan", undefined, 48, "rmk_to_submit_loan"], ["to_sign", undefined, 48, "rmk_to_sign"], ["all_signed", undefined, 0, ""]]);
    await page.waitForFunction(() => location.hash === "#/workflow/test_residence_buyers?view=stages");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("stage builder: edit interval and message with live preview, add / reorder / archive stages, validation before saving, one save with every stage", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes, errors } = await newPage(VIEWPORTS.ipad);
  try {
    page.on("dialog", (d) => d.accept());
    await page.goto(base + "/sales/#/workflow/rmk?view=stages");
    await page.waitForSelector("#wfb");
    const card = (i) => `#wfb details.wf-stage[data-i="${i}"]`;
    assert.match(await page.textContent(`${card(1)} summary`), /2\s*To book unit[\s\S]*reply DONE BOOKED · every 24 h × 3 · template rmk_to_book/);
    await page.click(`${card(1)} summary`);
    await page.fill(`${card(1)} input[data-f=follow_up_hours]`, "12");
    await page.fill(`${card(1)} textarea[data-f=message_ms]`, "Hai ");
    await page.click(`${card(1)} button[data-var=name]`);
    await page.type(`${card(1)} textarea[data-f=message_ms]`, ", langkah: ");
    await page.click(`${card(1)} button[data-var=current_stage]`);
    await page.type(`${card(1)} textarea[data-f=message_ms]`, ". Balas ");
    await page.click(`${card(1)} button[data-var=keyword]`);
    assert.equal(await page.inputValue(`${card(1)} textarea[data-f=message_ms]`), "Hai {{name}}, langkah: {{current_stage}}. Balas {{keyword}}");
    assert.equal(await page.textContent(`${card(1)} [data-pv=ms]`), "Hai Aina, langkah: To book unit. Balas DONE BOOKED");
    // a new stage goes before the final one; a keyword already used elsewhere is caught before saving
    await page.click("#wfadd");
    const added = card(5);
    await page.fill(`${added} input[data-f=name]`, "Key collection");
    await page.fill(`${added} input[data-f=key]`, "keys");
    await page.fill(`${added} input[data-f=keywords]`, "done booked");
    await page.fill(`${added} textarea[data-f=message_ms]`, "Hai {{name}}, kunci sedia.");
    await page.click("#wfb button.pri");
    await page.waitForSelector("#wferr .error");
    assert.match(await page.textContent("#wferr"), /Keyword “done booked” is used by “To book unit” and “Key collection”/);
    assert.ok(!writes.some((w) => w.rpc === "ai_wf_save"), "nothing saved while invalid");
    await page.fill(`${added} input[data-f=keywords]`, "DONE KEYS, Kunci dah ambil");
    // move it up above "To sign"; archive "To apply portal" (no leads there)
    await page.click(`${added} button[data-op=up]`);
    await page.click(`${card(2)} summary`);
    await page.click(`${card(2)} button[data-op=archive]`);
    await page.fill("#wfb input[name=change_note]", "shorter booking reminder");
    await page.click("#wfb button.pri");
    await toastSeen(page, /Workflow saved/);
    const p = writes.find((w) => w.rpc === "ai_wf_save").body.p;
    assert.equal(p.change_note, "shorter booking reminder");
    assert.deepEqual(p.stages.map((s) => [s.key, !!s.archived]), [["new", false], ["to_book", false], ["to_portal", true], ["to_submit_loan", false], ["keys", false], ["to_sign", false], ["all_signed", false]]);
    const tb = p.stages[1];
    assert.deepEqual([tb.id, tb.follow_up_hours, tb.max_follow_ups, tb.template, tb.message_ms], ["S-to_book", 12, 3, "rmk_to_book", "Hai {{name}}, langkah: {{current_stage}}. Balas {{keyword}}"]);
    assert.deepEqual(p.stages[4].keywords, ["DONE KEYS", "Kunci dah ambil"]);
    assert.equal(p.stages[4].id, undefined);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("stage builder: archiving a stage that has leads asks where to move them; unsaved edits survive a reload", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes, errors } = await newPage(VIEWPORTS.phone);
  try {
    page.on("dialog", (d) => d.accept());
    await page.goto(base + "/sales/#/workflow/rmk?view=stages");
    await page.waitForSelector("#wfb");
    await page.click('#wfb details.wf-stage[data-i="1"] summary');
    await page.fill('#wfb details.wf-stage[data-i="1"] input[data-f=name]', "Book a unit");
    await page.reload();
    await page.waitForSelector("#wfb .notice");
    assert.match(await page.textContent("#wfb .notice"), /Unsaved changes restored/);
    await page.click('#wfb details.wf-stage[data-i="1"] summary');
    assert.equal(await page.inputValue('#wfb details.wf-stage[data-i="1"] input[data-f=name]'), "Book a unit");
    await page.click('#wfb details.wf-stage[data-i="1"] button[data-op=archive]');
    await page.click("#wfb button.pri");
    await page.waitForSelector("#wferr .error");
    assert.match(await page.textContent("#wferr"), /choose where to move its leads/);
    await page.selectOption('#wfb details.wf-stage[data-i="1"] select[data-f=move_to]', "to_portal");
    await page.click("#wfb button.pri");
    await toastSeen(page, /Workflow saved/);
    const st = writes.find((w) => w.rpc === "ai_wf_save").body.p.stages[1];
    assert.deepEqual([st.key, st.archived, st.move_to, st.name], ["to_book", true, "to_portal", "Book a unit"]);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("workflow settings: entry rules and sending saved in one call; history lists what changed", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes, errors } = await newPage(VIEWPORTS.ipad);
  try {
    page.on("dialog", (d) => d.accept());
    await page.goto(base + "/sales/#/workflow/rmk?view=settings");
    await page.waitForSelector("#wfs");
    assert.equal(await page.inputValue("#wfs input[name=ad_phrases]"), "metropolitan kepong, RMK");
    await page.check("#wfs input[name=sending_enabled]");
    await page.fill("#wfs input[name=message_phrases]", "metropolitan kepong, residensi kepong");
    await page.selectOption("#wfs select[name=project_id]", "t1");
    await page.click("#wfs button.pri");
    await toastSeen(page, /Settings saved/);
    const p = writes.find((w) => w.rpc === "ai_wf_save").body.p;
    assert.deepEqual([p.id, p.sending_enabled, p.project_id, p.entry.message_phrases, p.stages.length], ["WF1", true, "t1", ["metropolitan kepong", "residensi kepong"], 6]);
    await page.goto(base + "/sales/#/workflow/rmk?view=history");
    await page.waitForSelector(".timeline");
    const h = await page.textContent("#wfv");
    assert.match(h, /updated by manager@test\.local — “shorter booking reminder”/);
    assert.match(h, /Stage added: Extra step/);
    assert.match(h, /To book unit: interval/);
    assert.match(h, /Test Buyer:\s*New RMK enquiry → To book unit/);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("lead page: the buyer's workflow stage is shown; 'Add to workflow' for others (asks first)", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  let { page, ctx, writes, errors } = await newPage(VIEWPORTS.ipad);
  try {
    await page.goto(base + "/sales/#/lead/L1");
    await page.waitForSelector("#wfc");
    assert.match(await page.textContent("#wfc"), /Follow-up workflows\s*RMK — Residensi Metropolitan Kepong: To book unit\s*Active/);
    assert.equal(await page.$("#wfadd"), null);
  } finally { await ctx.close(); }
  ({ page, ctx, writes, errors } = await newPage(VIEWPORTS.ipad, { mutate: (db) => { db.ai_workflow_leads = []; } }));
  try {
    page.on("dialog", (d) => d.accept());
    await page.goto(base + "/sales/#/lead/L1");
    await page.waitForSelector("#wfadd");
    await page.selectOption("#wfadd select[name=source]", "instagram");
    await page.click("#wfadd button");
    await toastSeen(page, /Added to RMK/);
    assert.deepEqual(writes.find((w) => w.rpc === "ai_wf_enroll").body, { p_wf: "WF1", p_lead: "L1", p_source: "instagram" });
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

test("saving one section keeps the reader's place: scroll position and open sections survive the refresh", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes, errors } = await newPage({ width: 820, height: 1000 });
  try {
    await page.goto(base + "/sales/#/property/t1");
    await page.waitForSelector("#fpr", { state: "attached" });
    await page.click("summary:has-text('Add promotion')");
    await page.fill("#fpr input[name=title]", "Free legal fees");
    await page.fill("#fpr textarea[name=details]", "On SPA and loan agreement");
    await page.fill("#fpr input[name=source]", "Developer circular 42");
    await page.locator("#fpr button").scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => window.scrollY);
    assert.ok(before > 500, "the promotion form is far down the page");
    await page.evaluate(() => { document.querySelector("#view .page-head").dataset.stale = "1"; });
    await page.click("#fpr button");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /Promotion saved/.test(t.textContent)));
    await page.waitForFunction(() => !document.querySelector("#view [data-stale]"), null, { timeout: 10000 }); // the page was rebuilt
    assert.ok(writes.some((w) => w.table === "ai_promotions" && w.method === "POST"));
    const after = await page.evaluate(() => window.scrollY);
    assert.ok(Math.abs(after - before) < 5, `page stayed put (${before} → ${after})`);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("details")].find((d) => /Add promotion/.test(d.textContent)).open), true, "the section stays open");
    // a different page starts at the top
    await page.evaluate(() => { location.hash = "#/leads"; });
    await page.waitForSelector("#view h1:has-text('Leads')");
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("an unsent WhatsApp reply survives taking over the chat", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx } = await newPage(VIEWPORTS.ipad, { mutate: (db) => { db.ai_settings[0].flags.whatsapp_outbound = true; } });
  try {
    await page.goto(base + "/sales/#/inbox?c=V1");
    await page.waitForSelector("#reply textarea");
    await page.fill("#reply textarea", "Draft not sent yet");
    await page.click("#take");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /You are handling this chat/.test(t.textContent)));
    await page.waitForSelector("#reply textarea");
    assert.equal(await page.inputValue("#reply textarea"), "Draft not sent yet");
  } finally { await ctx.close(); }
});

test("date and time fields size like other fields (iPad/iPhone Safari would otherwise draw them wider than their column)", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx } = await newPage({ width: 1180, height: 820 });
  try {
    await page.goto(base + "/sales/#/property/t1");
    await page.waitForSelector("#ff input[name=completion_date]");
    const s = await page.$eval("#ff input[name=completion_date]", (e) => { const cs = getComputedStyle(e), l = getComputedStyle(e.closest("label")); return { appearance: cs.appearance, minWidth: cs.minWidth, labelMin: l.minWidth }; });
    assert.deepEqual(s, { appearance: "none", minWidth: "0px", labelMin: "0px" });
  } finally { await ctx.close(); }
});

test("financing check: lead page shows the saved result; the calculator previews and saves a bank check", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  for (const vp of [VIEWPORTS.phone, { width: 1280, height: 900 }]) {
    const { page, ctx, writes, errors } = await newPage(vp);
    try {
      await page.goto(base + "/sales/#/lead/L1");
      await page.waitForSelector("#fin");
      const card = await page.textContent("#fin");
      assert.match(card, /Potentially affordable/);
      assert.match(card, /RM450,000/);
      assert.match(card, /not a loan or financing approval/);
      await page.click("#fin-calc summary");
      await page.selectOption("#ffin select[name=route]", "bank");
      for (const [k, v] of Object.entries({ age: "35", basic_salary: "6000", fixed_allowances: "0", mandatory_deductions: "900", commitments_monthly: "1000", credit_card_balance: "5000", property_price: "500000", down_payment: "" })) await page.fill(`#ffin input[name=${k}]`, v);
      await page.waitForFunction(() => /May be affordable with adjustments/.test(document.querySelector("#fin-preview").textContent));
      const prev = await page.textContent("#fin-preview");
      assert.match(prev, /RM397,000/);       // conservative 60% DSR scenario
      assert.match(prev, /RM2,047/);         // instalment on RM450,000 at 4.2%, 35 years
      await page.click("#ffin button.pri");
      await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /Financing check saved/.test(t.textContent)));
      const prof = writes.find((w) => w.table === "ai_financing_profiles" && w.method === "PATCH");
      assert.equal(prof.body.outcome, "may_be_affordable_with_adjustments");
      assert.equal(prof.body.source, "advisor");
      assert.equal(prof.body.inputs.basic_salary, 6000);
      assert.ok(writes.some((w) => w.table === "ai_financing_assessments" && w.method === "POST" && w.body.route === "bank"));
      assert.ok(writes.some((w) => w.table === "ai_leads" && w.body?.qualification?.financing_check === "may_be_affordable_with_adjustments"));
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  }
});

test("financing check is hidden from viewers; settings validate and save the rule set", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes, errors } = await newPage({ width: 1024, height: 900 });
  try {
    await page.goto(base + "/sales/#/settings?tab=financing");
    await page.waitForSelector("#sf input[name=l_rate_tiers]");
    assert.match(await page.textContent("#sbody"), /LPPSA rules not yet verified/);
    await page.fill("#sf input[name=l_rate_tiers]", "4@750000, 4.5@900000");
    await page.click("#sf button.pri");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /last tier has no limit/.test(t.textContent)));
    await page.fill("#sf input[name=l_rate_tiers]", "4@750000, 4.5");
    await page.check("#sf input[name=l_verified]");
    await page.click("#sf button.pri");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /Enter the date/.test(t.textContent)));
    await page.fill("#sf input[name=l_verified_on]", "2026-11-01");
    await page.fill("#sf input[name=b_rate_pct]", "3.95");
    await page.click("#sf button.pri");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /Financing rules saved/.test(t.textContent)));
    const w = writes.find((x) => x.table === "ai_settings" && x.body?.financing);
    assert.equal(w.body.financing.bank.rate_pct, 3.95);
    assert.deepEqual(w.body.financing.lppsa.rate_tiers, [{ rate_pct: 4, up_to: 750000 }, { rate_pct: 4.5, up_to: null }]);
    assert.equal(w.body.financing.lppsa.verified, true);
    assert.equal(w.body.financing.lppsa.verified_on, "2026-11-01");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
  // a viewer never receives income figures: the card is not rendered and the tables are not queried
  const v = await newPage({ width: 1024, height: 900 });
  try {
    await v.page.route("**/rest/v1/rpc/ai_role", (r) => r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify("viewer") }));
    const asked = [];
    v.page.on("request", (r) => { if (/ai_financing/.test(r.url())) asked.push(r.url()); });
    await v.page.goto(base + "/sales/#/lead/L1");
    await v.page.waitForSelector("#view h1");
    assert.equal(await v.page.$("#fin"), null);
    assert.deepEqual(asked, []);
  } finally { await v.ctx.close(); }
});

test("inbox ownership: Human takeover shown with who and since when; Resume AI asks first; per-buyer automation switches", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const since = new Date(Date.now() - 3600e3).toISOString();
  const { page, ctx, writes, errors } = await newPage(VIEWPORTS.ipad, { mutate: (db) => {
    db.ai_settings[0].flags.whatsapp_outbound = true;
    Object.assign(db.ai_conversations[0], { mode: "human", takeover_by: "advisor@test.local", human_takeover_at: since, last_human_reply_at: since });
    db.ai_conversations[0].lead.ai_paused = true; db.ai_automation_jobs = []; } });
  try {
    await page.goto(base + "/sales/#/inbox?c=V1");
    await page.waitForSelector("#back");
    assert.match(await page.textContent(".conv-list"), /Human takeover/);
    assert.match(await page.textContent("#thread"), /A person is handling this chat \(advisor@test\.local, since .*\)\. The AI does not reply or follow up until someone presses Resume AI/);
    page.once("dialog", (d) => d.dismiss());
    await page.click("#back");
    assert.ok(!writes.some((w) => w.rpc === "ai_resume_ai"), "cancelled: nothing changes");
    page.once("dialog", (d) => d.accept());
    await page.click("#back");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /AI resumed/.test(t.textContent)));
    assert.deepEqual(writes.find((w) => w.rpc === "ai_resume_ai").body, { p_conversation: "V1" });
    await page.uncheck("#auto input[name=follow_ups]");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /Switched off for this buyer/.test(t.textContent)));
    const w = writes.find((x) => x.table === "ai_conversations" && x.body?.automation);
    assert.deepEqual(w.body.automation, { follow_ups: false });
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("follow-up automation page: settings saved and validated; jobs listed with their checks, filtered and cancellable", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes, errors } = await newPage(VIEWPORTS.phone);
  try {
    await page.goto(base + "/sales/#/followups");
    await page.waitForSelector("#fauto");
    const list = await page.textContent("#jlist");
    assert.match(list, /12-hour follow-up[\s\S]*Pending/);
    assert.match(list, /Appointment reminder[\s\S]*24 h|1 day before/);
    assert.match(list, /Cancelled[\s\S]*a person replied/);
    await page.selectOption("#jstat", "cancelled");
    assert.doesNotMatch(await page.textContent("#jlist"), /Pending/);
    await page.selectOption("#jstat", "");
    page.once("dialog", (d) => d.accept());
    await page.click("[data-cancel-job]");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /Cancelled/.test(t.textContent)));
    assert.ok(writes.some((w) => w.rpc === "ai_cancel_automation_job"));
    await page.fill("#fauto input[name=appointment_reminder_minutes]", "1440, 5");
    await page.click("#fauto button.pri");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /whole minutes from 10/.test(t.textContent)));
    await page.fill("#fauto input[name=appointment_reminder_minutes]", "120, 1440");
    await page.fill("#fauto input[name=follow_up_delay_hours]", "8");
    await page.uncheck("#fauto input[name=human_reminders]");
    await page.click("#fauto button.pri");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /Automation settings saved/.test(t.textContent)));
    const w = writes.find((x) => x.table === "ai_settings" && x.body?.automation);
    assert.equal(w.body.automation.follow_up_delay_hours, 8);
    assert.deepEqual(w.body.automation.appointment_reminder_minutes, [1440, 120]);
    assert.equal(w.body.automation.human_reminders, false);
    assert.equal(w.body.flags.module_enabled, true, "other switches kept");
    assert.ok("handover_alerts" in w.body.notifications && w.body.notifications.telegram_chat_id === "123456789", "Telegram settings kept");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal scroll (${overflow}px)`);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
