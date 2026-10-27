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
