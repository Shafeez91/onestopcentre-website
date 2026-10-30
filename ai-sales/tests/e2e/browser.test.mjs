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
    await page.waitForSelector("#view h1:has-text('Dashboard')");
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
    await page.goto(base + "/sales/#/lead/L1?tab=profile");
    await page.waitForSelector("#fc");
    await page.fill("#fc input[name=full_name]", "Edited Name Not Saved");
    await page.evaluate(() => { location.hash = "#/pipeline"; });
    await page.waitForSelector("#view h1:has-text('pipeline')");
    await page.evaluate(() => { location.hash = "#/lead/L1?tab=profile"; });
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
    await page.goto(base + "/sales/#/lead/L1?tab=profile");
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

test("website editor: the 'Location & accessibility' text (field nearby) has its own box and is shown under About this project", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, errors } = await newPage(VIEWPORTS.ipad, { signedIn: false });
  try {
    await page.goto(base + "/");
    await page.waitForFunction(() => document.body.innerText.includes("Test Residence"), null, { timeout: 15000 });
    const r = await page.evaluate(() => {
      // the editor's own code: open the "Highlights & Description" section for a project with brochure text
      W = nz({ n: "M MIRA", nearby: "PUBLIC TRANSPORT\n650m – Sri Rampai LRT Station", desc: "" }); esec = "h";
      const host = document.createElement("div"); host.innerHTML = edBody(); document.body.appendChild(host);
      const box = host.querySelector('textarea[data-k="nearby"]');
      return { box: !!box, value: box?.value, label: host.innerText.includes("Location & accessibility"), desc: !!host.querySelector('textarea[data-k="desc"]') };
    });
    assert.deepEqual(r, { box: true, value: "PUBLIC TRANSPORT\n650m – Sri Rampai LRT Station", label: true, desc: true });
    assert.deepEqual(errors, []);
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

test("AI test console: an outage is labelled as one (no fake confidence); a normal reply shows project, language and sources", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, errors } = await newPage(VIEWPORTS.ipad);
  try {
    const results = [
      { decision: "error", errorKind: "unavailable", error: "AI service busy or unavailable (HTTP 529).", reply: "Thanks for your question. I need to confirm this with our advisor first so the answer is accurate. One of our advisors will get back to you shortly.",
        language: "en", agent: "handover", confidence: null, model: null, latency_ms: 3100, attempts: [], actions: [{ type: "handover", reason: "low_confidence", summary: "The AI could not answer" }] },
      { decision: "reply", reply: "M Mira is in Wangsa Maju. Type A is 850 sq ft with 3 bedrooms, from RM400,000. Would you like the price list?", intent: "project_info", agent: "knowledge", language: "en", confidence: 0.86,
        model: "claude-opus-5-5", latency_ms: 9800, attempts: [{ attempt: 1, reply: "x", violations: [] }], facts_used: ["layout:mm:Type A"], actions: [{ type: "set_language", language: "en" }],
        retrieval: { focus: ["M Mira"], focus_source: "named in the buyer's current message", ambiguous: false, not_on_record: { "M Mira": ["maintenance_fee"] }, conflicts: {} } },
    ];
    await page.route("**/api/sales/ai/simulate", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...results.shift(), simulated: true }) }));
    await page.goto(base + "/sales/#/ai-test");
    await page.waitForSelector("#msg");
    await page.evaluate(() => sessionStorage.clear());
    await page.fill("#msg", "Send info M Mira");
    await page.click("#say button");
    await page.waitForSelector(".msg.ai .why");
    const why = await page.textContent(".msg.ai .why");
    assert.match(why, /AI service busy or down — fixed safe reply \+ human alert/);
    assert.match(why, /Self-rating: not available/);
    assert.doesNotMatch(why, /0%/);
    await page.click(".msg.ai details summary");
    assert.match(await page.textContent(".msg.ai details"), /No answer — AI service busy or down/);
    await page.fill("#msg", "Send info M Mira");
    await page.click("#say button");
    await page.waitForFunction(() => document.querySelectorAll(".msg.ai").length === 2);
    const second = page.locator(".msg.ai").nth(1);
    assert.match(await second.locator(".why").textContent(), /AI reply — would send.*AI self-rating 86%/s);
    await second.locator("details summary").click();
    const d = await second.locator("details").textContent();
    for (const re of [/Answered \(claude-opus-5-5\)/, /project info · knowledge step/, /English/, /M Mira \(named in the buyer's current message\)/, /M Mira: maintenance fee/, /layout:mm:Type A/, /Remember the buyer's language: English/]) assert.match(d, re);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("AI test console: a 504 keeps the typed message and history and says what happened; Send works again; double clicks send once", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx } = await newPage(VIEWPORTS.phone);
  try {
    let n = 0, release;
    const gate = new Promise((r) => { release = r; });
    await page.route("**/api/sales/ai/simulate", async (r) => {
      n++;
      if (n === 1) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ decision: "reply", reply: "LRT Sri Rampai is the nearest station.", messages: ["LRT Sri Rampai is the nearest station."], intent: "project_info", language: "en", confidence: 0.85, model: "m", latency_ms: 9000, attempts: [], actions: [], simulated: true }) });
      if (n === 2) { await gate; return r.fulfill({ status: 504, contentType: "text/html", body: "<html>Gateway Timeout</html>" }); }
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ decision: "reply", reply: "Yes, a shuttle is listed.", messages: ["Yes, a shuttle is listed."], intent: "project_info", language: "en", confidence: 0.85, model: "m", latency_ms: 9000, attempts: [], actions: [], simulated: true }) });
    });
    await page.goto(base + "/sales/#/ai-test");
    await page.waitForSelector("#msg");
    await page.evaluate(() => sessionStorage.clear());
    await page.fill("#msg", "How far m mira from nearest public transport?");
    await page.click("#say button");
    await page.waitForSelector(".msg.ai");
    await page.fill("#msg", "Does it has shuttle service?");
    await page.click("#say button");
    await page.locator("#say button").click({ force: true }).catch(() => {}); // a second click while the first is running
    await page.keyboard.press("Enter");
    release();
    await page.waitForSelector(".chat .card.error");
    assert.equal(n, 2, "one request for the message, however often Send was pressed");
    assert.match(await page.textContent(".chat .card.error"), /longer than the 30-second limit.*Your message is kept/);
    assert.equal(await page.inputValue("#msg"), "Does it has shuttle service?", "the typed message is kept");
    assert.equal(await page.locator(".msg.ai").count(), 1, "the earlier reply is still there");
    assert.equal(await page.locator(".msg.buyer").count(), 1, "the failed message is not left as a sent bubble");
    assert.equal(await page.isDisabled("#say button"), false);
    await page.click("#say button");
    await page.waitForFunction(() => document.querySelectorAll(".msg.ai").length === 2);
    assert.match(await page.locator(".msg.ai").nth(1).textContent(), /shuttle is listed/);
  } finally { await ctx.close(); }
});

test("AI test console: a reply that needs outside research shows the draft, then checks sources, then shows the final reply", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, errors } = await newPage(VIEWPORTS.phone);
  try {
    const sent = [];
    const steps = [
      { decision: "handover", reply: "Shuttle details aren't in our project info yet; our advisor will confirm.", messages: ["Shuttle details aren't in our project info yet; our advisor will confirm."], intent: "project_info", language: "en", confidence: 0.8, model: "m", latency_ms: 14000, attempts: [], actions: [{ type: "handover", reason: "conflicting_info" }],
        timings: { context_ms: 400, ai_ms: [13000], total_ms: 14000 }, request_id: "rid-1", step: "reply", continuation: { step: "research", token: "T1" } },
      { step: "research", research: { web: { question: "Does it has shuttle service?", found: true, sources: [{ url: "https://www.mahsing.com.my/m-mira", title: "M MIRA" }], searches: 1 } }, timings: { web_ms: 15000, total_ms: 15000 }, continuation: { step: "redraft", token: "T2" } },
      { decision: "reply", reply: "The developer's page lists a direct shuttle to LRT Sri Rampai; timing to be confirmed.", messages: ["The developer's page lists a direct shuttle to LRT Sri Rampai; timing to be confirmed."], intent: "project_info", language: "en", confidence: 0.8, model: "m", latency_ms: 12000, attempts: [], actions: [],
        research: { web: { question: "Does it has shuttle service?", found: true, sources: [{ url: "https://www.mahsing.com.my/m-mira", title: "M MIRA" }], searches: 1 } }, timings: { context_ms: 300, ai_ms: [11000], total_ms: 12000 }, request_id: "rid-3", step: "redraft" },
    ];
    let hold;
    await page.route("**/api/sales/ai/simulate", async (r) => {
      sent.push(JSON.parse(r.request().postData()));
      const body = steps.shift();
      if (body.step === "research") await new Promise((res) => { hold = res; });
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...body, simulated: true }) });
    });
    await page.goto(base + "/sales/#/ai-test");
    await page.waitForSelector("#msg");
    await page.evaluate(() => sessionStorage.clear());
    await page.fill("#msg", "Does it has shuttle service?");
    await page.click("#say button");
    await page.waitForFunction(() => /Checking outside sources/.test(document.querySelector("#say button")?.textContent || ""));
    assert.match(await page.textContent(".msg.ai .bubble"), /our advisor will confirm/, "the draft is shown while research runs");
    assert.match(await page.textContent(".msg.ai .why"), /Checking outside sources/);
    hold();
    await page.waitForFunction(() => /direct shuttle/.test(document.querySelector(".msg.ai .bubble")?.textContent || ""));
    assert.equal(await page.locator(".msg.ai").count(), 1, "the final reply replaces the draft: one turn");
    assert.deepEqual(sent.map((b) => b.continue || null), [null, "T1", "T2"]);
    assert.ok(sent.every((b) => b.message === "Does it has shuttle service?"));
    await page.click(".msg.ai details summary");
    const why = await page.textContent(".msg.ai details");
    assert.match(why, /Web research\s*Found/);
    assert.match(why, /Timing.*data 0\.3 s.*AI 11\.0 s.*web 15\.0 s.*total 12\.0 s/s);
    assert.match(why, /Request rid-3/);
    assert.equal(await page.isDisabled("#say button"), false);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("AI test console: a turn of three WhatsApp messages shows three bubbles in order; a one-message turn shows one", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, errors } = await newPage(VIEWPORTS.phone);
  try {
    const M = ["Stesen paling dekat ialah LRT Sri Rampai.", "MRT3 Circle Line masih dalam perancangan.", "Tuan/puan kerja di kawasan mana?"];
    const results = [
      { decision: "reply", reply: M.join("\n\n"), messages: M, intent: "project_info", agent: "knowledge", language: "ms", confidence: 0.9, model: "claude-opus-5-5", latency_ms: 9000, attempts: [{ attempt: 1, reply: "x", violations: [] }], actions: [],
        style_notes: [{ code: "long_message", detail: "Message 1 is 70 words; aim for about 20–60 words per message." }] },
      { decision: "reply", reply: "Harga dari RM476,000.\n\nItu harga Type A.", messages: ["Harga dari RM476,000.\n\nItu harga Type A."], intent: "price", agent: "knowledge", language: "ms", confidence: 0.9, model: "claude-opus-5-5", latency_ms: 8000, attempts: [], actions: [] },
    ];
    const sent = [];
    await page.route("**/api/sales/ai/simulate", (r) => { sent.push(JSON.parse(r.request().postData())); r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...results.shift(), simulated: true }) }); });
    await page.goto(base + "/sales/#/ai-test");
    await page.waitForSelector("#msg");
    await page.evaluate(() => sessionStorage.clear());
    await page.fill("#msg", "MRT paling dekat kat mana?");
    await page.click("#say button");
    await page.waitForSelector(".msg.ai .turn");
    const bubbles = await page.$$eval(".msg.ai .turn .bubble", (b) => b.map((x) => x.textContent));
    assert.deepEqual(bubbles, M.map((m, i) => `${i + 1}/3${m}`), "three separate bubbles, numbered, in order");
    assert.match(await page.textContent(".msg.ai .why"), /3 WhatsApp messages/);
    await page.click(".msg.ai details summary");
    assert.match(await page.textContent(".msg.ai details"), /Readability.*Message 1 is 70 words.*never block a reply/s);
    if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, "phone-ai-test-multi.png"), fullPage: true });
    await page.fill("#msg", "Harga?");
    await page.click("#say button");
    await page.waitForFunction(() => document.querySelectorAll(".msg.ai").length === 2);
    const second = page.locator(".msg.ai").nth(1);
    assert.equal(await second.locator(".bubble").count(), 1, "a one-message turn stays one bubble, paragraphs and all");
    assert.equal(await second.locator(".bubble").textContent(), "Harga dari RM476,000.\n\nItu harga Type A.");
    assert.match(await second.locator(".why").textContent(), /1 WhatsApp message\b/);
    assert.equal(sent[1].history.length, 2, "the previous turn is sent back as history");
    assert.equal(sent[1].history[1].text, M.join("\n\n"));
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("dashboard left open across a release: a banner offers to reload; nothing shows while the deploy is unchanged", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, errors } = await newPage(VIEWPORTS.ipad);
  try {
    await page.clock.install();
    let deploy = "deploy-A", calls = 0;
    await page.route("**/api/sales/version", (r) => { calls++; r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deploy }) }); });
    await page.goto(base + "/sales/#/overview");
    await page.waitForSelector(".main");
    await page.waitForFunction(() => true);
    await page.evaluate(() => { location.hash = "#/leads"; });
    await page.waitForTimeout(300);
    assert.equal(await page.locator("#update-bar").count(), 0, "same deploy: no banner");
    deploy = "deploy-B";
    await page.clock.fastForward(121e3);
    await page.evaluate(() => { location.hash = "#/appointments"; });
    await page.waitForSelector("#update-bar");
    assert.match(await page.textContent("#update-bar"), /A new version of the dashboard is available/);
    assert.ok(calls >= 2);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("AI test console: shows the Google Maps lookup (route type, distance, location source, date, link) and web research sources", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, errors } = await newPage(VIEWPORTS.ipad);
  try {
    const link = "https://www.google.com/maps/dir/?api=1&origin=3.19899%2C101.73702&destination=Sri+Rampai+LRT+Station&travelmode=walking&destination_place_id=ChIJ_lrt";
    const result = { decision: "reply", reply: "Sekitar 2.4 km jalan kaki.", messages: ["Sekitar 2.4 km jalan kaki."], intent: "project_info", agent: "knowledge", language: "ms", confidence: 0.9, model: "claude-opus-5-5", latency_ms: 12000, attempts: [], actions: [],
      retrieval: { focus: ["M MIRA"], focus_source: "named in the buyer's current message", ambiguous: false, not_on_record: {}, conflicts: {} },
      research: { maps: { lookups: [{ project: "M MIRA", to: "Sri Rampai LRT Station (Wangsa Maju, Kuala Lumpur)", project_location: "the project's Google Maps pin (website editor)", straight_line: "50 m",
        routes: [{ mode: "walking", distance: "2.4 km", time: "31 min" }, { mode: "driving", distance: "3.1 km", time: "7 min", note: "typical driving time without live traffic" }], maps_link: link, source: "Google Maps (Places + Routes API)", checked_at: "2026-10-29" }] },
        web: { question: "MRT3?", found: true, searches: 2, sources: [{ url: "https://www.mymrt.com.my/mrt3", title: "MRT3 Circle Line" }, { url: "javascript:alert(1)", title: "bad" }] } } };
    await page.route("**/api/sales/ai/simulate", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...result, simulated: true }) }));
    await page.goto(base + "/sales/#/ai-test");
    await page.waitForSelector("#msg");
    await page.evaluate(() => sessionStorage.clear());
    await page.fill("#msg", "M Mira ke LRT Sri Rampai berapa jauh?");
    await page.click("#say button");
    await page.waitForSelector(".msg.ai details");
    await page.click(".msg.ai details summary");
    const d = await page.textContent(".msg.ai details");
    for (const re of [/Answer based on\s*our project data \+ Google Maps \+ web research/, /M MIRA → Sri Rampai LRT Station/, /walking: 2\.4 km · 31 min/, /driving: 3\.1 km · 7 min \(typical driving time without live traffic\)/,
      /straight line 50 m/, /Location: the project's Google Maps pin \(website editor\) · Google Maps \(Places \+ Routes API\), checked 2026-10-29/, /Found · 2 searches/, /MRT3 Circle Line/]) assert.match(d, re);
    assert.equal(await page.getAttribute(".msg.ai details a[href^='https://www.google.com/maps/dir/']", "target"), "_blank");
    assert.equal(await page.locator(".msg.ai details a[href^='javascript:']").count(), 0, "a web source is only a link when it is http(s)");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("AI persona: the Tone guidance editor is ~7× the old height on desktop and iPad, roomy on phones, scrolls, and saves the whole prompt", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  // a master prompt the size of the real one (1,405 lines, 63,129 characters on 30 Oct): headings, numbering, blank lines
  const PROMPT = "CLAUDE MASTER PROMPT\n\n" + Array.from({ length: 1400 }, (_, i) => (i % 50 === 0 ? `\nSECTION ${i / 50 + 1}\n` : `${i % 50}. Rule ${i}: reply in short WhatsApp messages — keep the buyer's language.`)).join("\n") + "\n\nEND OF PROMPT";
  for (const [name, vp, min, max] of [["desktop", VIEWPORTS.desktop, 525, 600], ["ipad", VIEWPORTS.ipad, 525, 600], ["phone", VIEWPORTS.phone, 320, 560]]) {
    const { page, ctx, writes, errors } = await newPage(vp, { mutate: (db) => { db.ai_settings[0].persona = { ...db.ai_settings[0].persona, name: "Hafiz_Ai", tone: PROMPT, greeting_en: "Hi!", greeting_ms: "Salam!" }; } });
    try {
      await page.goto(base + "/sales/#/settings?tab=persona");
      await page.waitForSelector("#sf textarea[name=tone]");
      const box = await page.$eval("#sf textarea[name=tone]", (el) => ({ h: el.getBoundingClientRect().height, scroll: el.scrollHeight, client: el.clientHeight, resize: getComputedStyle(el).resize, overflowY: getComputedStyle(el).overflowY, value: el.value }));
      assert.ok(box.h >= min && box.h <= max, `${name}: editor height ${box.h}px`);
      assert.ok(box.h >= 7 * 75 || name === "phone", `${name}: about 7× the old 75px box`);
      assert.equal(box.value, PROMPT, `${name}: the full prompt is loaded, line breaks and all`);
      assert.ok(box.scroll > box.client * 10, "long text scrolls inside the editor");
      assert.equal(box.resize, "vertical");
      assert.equal(box.overflowY, "auto");
      // the other persona fields keep their small size
      assert.ok((await page.$eval("#sf textarea[name=greeting_en]", (el) => el.getBoundingClientRect().height)) < 120);
      // the page itself does not scroll sideways, and Save stays reachable below the editor
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: no horizontal scroll`);
      await page.$eval("#sf textarea[name=tone]", (el) => { el.scrollTop = el.scrollHeight; });
      assert.ok(await page.$eval("#sf textarea[name=tone]", (el) => el.scrollTop > 0), "scrolls to the end of the prompt");
      if (name === "ipad") {
        await page.$eval("#sf textarea[name=tone]", (el) => { el.value += "\n\nNEW LINE ADDED"; el.dispatchEvent(new Event("input", { bubbles: true })); });
        await page.locator("#sf button").scrollIntoViewIfNeeded();
        await page.click("#sf button");
        await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /Persona saved/.test(t.textContent)));
        const w = writes.find((x) => x.table === "ai_settings" && x.body?.persona);
        assert.equal(w.body.persona.tone, PROMPT + "\n\nNEW LINE ADDED", "the whole prompt is saved, nothing cut");
        assert.equal(w.body.persona.greeting_en, "Hi!");
        assert.equal(w.body.persona.name, "Hafiz_Ai");
        assert.equal(w.body.persona.discloses_ai, true);
      }
      if (process.env.E2E_SHOTS) await page.screenshot({ path: path.join(process.env.E2E_SHOTS, `${name}-persona.png`) });
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  }
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

test("dashboard command centre: real counts, today's priorities, live WhatsApp, workflows and AI usage, each linking to its list", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, errors } = await newPage(VIEWPORTS.desktop);
  try {
    await page.goto(base + "/sales/#/overview");
    await page.waitForSelector(".dash-grid");
    const kpis = await page.textContent(".dash-kpis");
    assert.match(kpis, /1\s*Open leads[\s\S]*0\s*Hot · 1 warm[\s\S]*0\s*Waiting for a person[\s\S]*1\s*Unread WhatsApp chats[\s\S]*1 to confirm/);
    const prio = await page.textContent(".prio");
    assert.match(prio, /Test Buyer · Showroom visit[\s\S]*Confirm visit · Preferred: Sabtu pagi/);
    assert.match(prio, /1 workflow lead needs a person/);
    assert.equal(await page.getAttribute(".prio li a", "href"), "#/lead/L1");
    assert.match(await page.textContent(".convs"), /Test Buyer\s*AI handling/);
    assert.equal(await page.getAttribute(".convs a", "href"), "#/inbox?c=V1");
    assert.match(await page.textContent(".wf-mini"), /RMK — Residensi Metropolitan Kepong\s*Sending off[\s\S]*2 leads · 1 needs a person[\s\S]*1\s*To book unit/);
    assert.match(await page.textContent(".mini-kpis"), /12\/200\s*Daily AI limit/);
    await page.click(".dash-kpis a[href='#/leads?temp=hot']");
    await page.waitForFunction(() => location.hash === "#/leads?temp=hot");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("lead workspace: one page with the AI summary, next action, conflicts, embedded WhatsApp, profile, sales and activity", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, writes, errors } = await newPage(VIEWPORTS.desktop);
  try {
    page.on("dialog", (d) => d.accept());
    await page.goto(base + "/sales/#/lead/L1");
    await page.waitForSelector("#ws");
    // header and the summary first
    assert.match(await page.textContent(".ws-head"), /Test Buyer\s*OSC-000001[\s\S]*New Enquiry[\s\S]*AI active[\s\S]*Test Residence/);
    const sum = await page.textContent("#aisum");
    assert.match(sum, /Works in KLCC and takes the LRT/);
    assert.match(sum, /Work location\s*KLCC\s*Confirmed/);
    assert.match(sum, /Daily commute & transportation\s*LRT \/ MRT \/ Monorail\s*Inferred/);
    assert.match(sum, /Current residential area\s*Cheras\s*Conflict/);
    assert.match(sum, /Last client question\s*“Ada unit 3 bilik bawah RM500k\?”/);
    assert.equal(await page.isVisible("#aisum .kvr.miss"), false, "unknown fields are folded away, never guessed");
    // conversation beside the summary on a wide screen (the inbox's own view, with its composer)
    assert.equal(await page.isVisible("#wsconv .chat"), true);
    assert.match(await page.textContent("#wsconv"), /Salam, boleh info M Mira\?/);
    assert.equal(await page.isVisible(".ws-tabs a[data-tab=conversation]"), false);
    // conflict: use the client's value
    assert.match(await page.textContent(".conflicts"), /Current residential area: entered Cheras, conversation says Kepong/);
    await page.click("[data-accept=residential_area]");
    await toastSeen(page, /Updated from the conversation/);
    assert.deepEqual(writes.find((w) => w.rpc === "ai_lead_profile_resolve").body, { p_lead: "L1", p_field: "residential_area", p_accept: true });
    // next action → follow-up task (only when chosen)
    assert.match(await page.textContent("#nextact"), /Send the Type A floor plan and offer a showroom visit[\s\S]*Why: The buyer asked/);
    await page.click("#na-task");
    await toastSeen(page, /Follow-up task created/);
    const t = writes.find((w) => w.table === "ai_tasks" && w.method === "POST").body;
    assert.deepEqual([t.title, t.lead_id, t.due_at], ["Send the Type A floor plan and offer a showroom visit", "L1", "2026-10-30T02:00:00.000Z"]);
    // refresh the summary from the conversation
    await page.click("#refsum");
    await page.waitForTimeout(300);
    assert.deepEqual(writes.find((w) => w.summary).summary, { lead_id: "L1" });
    // profile tab: only changed fields are saved, through the database rules
    await page.click(".ws-tabs a[data-tab=profile]");
    await page.waitForSelector("#fp");
    await page.fill("#fp input[name=occupation]", "Engineer");
    await page.check("#fp input[name=commute_mode][value=own_car]");
    await page.fill("#fp input[name=__note]", "confirmed on a call");
    await page.click("#fp button[type=submit]");
    await toastSeen(page, /Profile saved/);
    const ps = writes.find((w) => w.rpc === "ai_lead_profile_set").body;
    assert.deepEqual([ps.p_source, ps.p_note, ps.p_changes], ["staff", "confirmed on a call", [{ field: "occupation", value: "Engineer" }, { field: "commute_mode", value: ["own_car", "rail"] }]]);
    // sales tab: a stage change goes through the database function with the reason
    await page.goto(base + "/sales/#/lead/L1?tab=sales");
    await page.waitForSelector("#fl");
    await page.selectOption("#fl select[name=stage_id]", "s4");
    await page.fill("#fl input[name=stage_note]", "booking fee receipt seen");
    await page.click("#fl button[type=submit]");
    await toastSeen(page, /Lead saved/);
    assert.deepEqual(writes.find((w) => w.rpc === "ai_lead_set_stage").body, { p_lead: "L1", p_stage: "s4", p_note: "booking fee receipt seen", p_source: "staff", p_evidence: null });
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("lead workspace on iPad portrait: tabs, the conversation as its own tab, no sideways scrolling", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, errors } = await newPage(VIEWPORTS.ipad);
  try {
    await page.goto(base + "/sales/#/lead/L1");
    await page.waitForSelector("#ws");
    assert.equal(await page.isVisible("#wsconv"), false, "conversation is a tab on a narrow screen");
    await page.click("#gochat");
    await page.waitForFunction(() => document.querySelector("#ws").dataset.tab === "conversation");
    assert.equal(await page.isVisible("#wsconv .chat"), true);
    assert.equal(await page.isVisible("#aisum"), false);
    for (const t of ["profile", "sales", "activity", "summary"]) {
      await page.click(`.ws-tabs a[data-tab=${t}]`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `${t}: page scrolls sideways by ${overflow}px`);
    }
    // the activity filters and field history
    await page.goto(base + "/sales/#/lead/L1?tab=activity&act=profile_update");
    await page.waitForSelector(".act-f a.on");
    assert.equal(await page.textContent(".act-f a.on"), "Profile");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("leads: follow-up queue lists only the leads that need someone now, with the reason", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const { page, ctx, errors } = await newPage(VIEWPORTS.desktop);
  try {
    await page.goto(base + "/sales/#/leads?view=queue");
    await page.waitForSelector(".tbl");
    assert.match(await page.textContent(".tbl"), /OSC-000001[\s\S]*Next action: Send the Type A floor plan/);
    assert.equal(await page.textContent(".seg a.on"), "Follow-up queue");
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("inbox: three panels on a wide screen — conversations with last message and filters, the chat, the client with summary and next action", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  // the fake database does not join tables: give the chat its lead as Supabase would
  const { page, ctx, errors } = await newPage({ width: 1600, height: 1000 }, { mutate: (db) => { db.ai_conversations[0].lead = { ...db.ai_leads[0] }; } });
  try {
    await page.goto(base + "/sales/#/inbox?c=V1");
    await page.waitForSelector("#ibxctx .ctx-sum");
    const item = await page.textContent(".conv-list li.on");
    assert.match(item, /Test Buyer[\s\S]*(You|AI|Auto): |Salam/);
    assert.match(item, /Follow-up pending|AI active/);
    assert.match(await page.textContent(".ibx-f"), /All\s*1[\s\S]*Unread\s*1/);
    const ctx = await page.textContent("#ibxctx");
    assert.match(ctx, /Works in KLCC and takes the LRT[\s\S]*Main property\s*Test Residence[\s\S]*Budget\s*RM500,000/);
    assert.match(ctx, /Next action\s*Send the Type A floor plan/);
    assert.equal(await page.getAttribute("#ibxctx a.btn.pri", "href"), "#/lead/L1");
    // all three side by side
    const [l, t, c] = await Promise.all([".ibx-list", "#thread", "#ibxctx"].map((sel) => page.locator(sel).boundingBox()));
    assert.ok(l.x < t.x && t.x < c.x && Math.abs(l.y - c.y) < 40, "list · chat · client in one row");
    // search and filter keep working through the URL
    await page.fill("#ibxqi", "nobody-matches");
    await page.press("#ibxqi", "Enter");
    await page.waitForFunction(() => /No conversations match/.test(document.querySelector(".conv-list")?.textContent || ""));
    await page.goto(base + "/sales/#/inbox?f=person");
    await page.waitForSelector(".ibx-f a.on");
    assert.match(await page.textContent(".ibx-f a.on"), /Waiting for a person/);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test("calendar: month grid with visits and follow-up tasks; an agenda on phones; tasks list across leads", { skip: skip || (!chromium && "playwright not installed") }, async () => {
  const soon = new Date(Date.now() + 2 * 3600e3).toISOString(), NOW = new Date().toISOString();
  const mutate = (db) => {
    db.ai_appointments.push({ id: "A5", lead_id: "L1", kind: "showroom_visit", status: "confirmed", start_at: soon, project_id: "t1", reminders: [], created_at: NOW, lead: db.ai_appointments[0].lead });
    db.ai_tasks.push({ id: "T1", lead_id: "L1", title: "Call about Type A", due_at: soon, status: "open", assignee_email: "owner@test.local", lead: db.ai_appointments[0].lead },
      { id: "T2", lead_id: "L1", title: "Reply to the buyer: the AI's reply could not be delivered", due_at: new Date(Date.now() - 864e5).toISOString(), status: "open", source_key: "undelivered:x", assignee_email: "owner@test.local", lead: db.ai_appointments[0].lead });
  };
  let { page, ctx, writes, errors } = await newPage(VIEWPORTS.desktop, { mutate });
  try {
    await page.goto(base + "/sales/#/appointments?view=calendar");
    await page.waitForSelector(".cal-grid");
    assert.equal(await page.locator(".cal-h").count(), 7);
    const today = await page.textContent(".cal-day.today");
    assert.match(today, /Test Buyer/);
    assert.match(today, /Call about Type A/);
    assert.equal(await page.locator(".cal-day.today .ev.conf").count(), 1, "confirmed visit");
    assert.match(await page.textContent(".card:has(h2:text('Waiting for a time'))"), /Test Buyer[\s\S]*Preferred: Sabtu pagi/);
    await page.click(".cal-legend a.task");
    await page.waitForFunction(() => !/Call about Type A/.test(document.querySelector(".cal-grid").textContent));
    // the tasks list: overdue first, automatic ones marked, done in one tap
    await page.goto(base + "/sales/#/appointments?view=tasks&who=all");
    await page.waitForSelector(".tasks-l");
    const t = await page.textContent("#view");
    assert.match(t, /Overdue[\s\S]*Reply to the buyer[\s\S]*automatic[\s\S]*Today[\s\S]*Call about Type A/);
    await page.click("[data-done=T1]");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((x) => /Task done/.test(x.textContent)));
    assert.deepEqual(writes.find((w) => w.table === "ai_tasks" && w.method === "PATCH").body, { status: "done" });
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
  ({ page, ctx, errors } = await newPage(VIEWPORTS.phone, { mutate }));
  try {
    await page.goto(base + "/sales/#/appointments?view=calendar");
    await page.waitForSelector(".cal-grid");
    assert.equal(await page.isVisible(".cal-h"), false, "no weekday grid on a phone");
    assert.match(await page.textContent(".cal-day.today .cal-d"), /\d+\s*\w+day/);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no sideways scroll (${overflow}px)`);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

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
    await page.goto(base + "/sales/#/lead/L1?tab=sales");
    await page.waitForSelector("#wfc");
    assert.match(await page.textContent("#wfc"), /Follow-up workflows\s*RMK — Residensi Metropolitan Kepong: To book unit\s*Active/);
    assert.equal(await page.$("#wfadd"), null);
  } finally { await ctx.close(); }
  ({ page, ctx, writes, errors } = await newPage(VIEWPORTS.ipad, { mutate: (db) => { db.ai_workflow_leads = []; } }));
  try {
    page.on("dialog", (d) => d.accept());
    await page.goto(base + "/sales/#/lead/L1?tab=sales");
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
      await page.goto(base + "/sales/#/lead/L1?tab=sales");
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
