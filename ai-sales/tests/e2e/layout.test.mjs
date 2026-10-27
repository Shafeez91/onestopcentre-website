// Layout audit (Playwright): every dashboard page and dialog at phone, tablet, iPad, laptop and desktop widths.
// With every collapsible section opened, it checks that the page does not scroll sideways, that no control or text
// sticks out of its card or dialog, that form fields do not overlap, and that text does not spill out of its box.
// LAYOUT_REPORT=1 prints every finding instead of stopping at the first failing page.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { skip, canRun, start, stop, newPage, go, SECTIONS } from "./harness.mjs";

let base;
before(async () => { base = await start(); });
after(stop);

const WIDTHS = [320, 375, 390, 430, 600, 768, 820, 1024, 1180, 1280, 1440, 1600];
const heightOf = (w) => (w < 600 ? 800 : w < 1024 ? 1100 : 900);
// dialogs: [route, button that opens it]
const DIALOGS = [["leads", "#new"], ["knowledge?tab=entries", "[data-edit=k1]"], ["templates?tab=templates", "[data-edit=tp1]"], ["campaigns", "[data-edit=cp1]"], ["lead/L1", "#ho"], ["appointments", "[data-confirm=A1]"], ["templates", "#no"], ["templates?tab=templates", "#nt"], ["followups", "#ns"], ["campaigns", "#nc"]];

/** Runs in the page: returns layout problems inside `rootSel`. */
function audit(rootSel) {
  const out = [];
  const root = document.querySelector(rootSel);
  if (!root) return ["root " + rootSel + " missing"];
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const name = (e) => {
    const id = e.id ? "#" + e.id : "";
    const cls = typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).join(".") : "";
    const n = e.getAttribute("name") ? `[name=${e.getAttribute("name")}]` : "";
    const txt = (e.innerText || e.value || "").trim().slice(0, 30).replace(/\s+/g, " ");
    return `${e.tagName.toLowerCase()}${id}${cls}${n}${txt ? ` "${txt}"` : ""}`;
  };
  // horizontally scrollable or clipping ancestors contain their own overflow on purpose
  const clippedBy = (e, stop) => { for (let a = e.parentElement; a && a !== stop; a = a.parentElement) { const ox = getComputedStyle(a).overflowX; if (ox !== "visible") return true; } return false; };
  const containers = [...root.querySelectorAll(".card, dialog, .kcard, .col-k, .kpi")].filter(vis);
  if (root.matches(".card, dialog")) containers.push(root);
  for (const c of containers) {
    const cr = c.getBoundingClientRect();
    for (const e of c.querySelectorAll("input, select, textarea, button, .btn, label, table, img, h1, h2, h3, p, dl, ul, pre, .badge, .actions, .inline, .bubble")) {
      if (!vis(e) || clippedBy(e, c)) continue;
      const r = e.getBoundingClientRect();
      if (r.right > cr.right + 1 || r.left < cr.left - 1) out.push(`${name(e)} sticks out of ${name(c).slice(0, 40)} by ${Math.round(Math.max(r.right - cr.right, cr.left - r.left))}px`);
    }
  }
  // every field stays inside its own label / column, and is wide enough to use
  for (const e of root.querySelectorAll("input, select, textarea")) {
    if (!vis(e) || ["checkbox", "radio", "hidden"].includes(e.type) || clippedBy(e, root)) continue;
    const r = e.getBoundingClientRect(), pr = e.parentElement.getBoundingClientRect();
    if (r.right > pr.right + 1 || r.left < pr.left - 1) out.push(`${name(e)} is wider than its column by ${Math.round(Math.max(r.right - pr.right, pr.left - r.left))}px`);
    if (e.closest(".form") && !e.closest(".tbl, .steprow, .inline") && r.width < 150) out.push(`${name(e)} is squeezed to ${Math.round(r.width)}px wide`);
  }
  // overlapping fields in form grids and button rows
  for (const g of root.querySelectorAll(".form, .actions, .inline, .page-head, .filters, .say, .head-actions")) {
    if (!vis(g)) continue;
    const kids = [...g.children].filter((k) => vis(k) && getComputedStyle(k).position !== "absolute" && k.tagName !== "DATALIST");
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 2 && oy > 2) out.push(`${name(kids[i])} overlaps ${name(kids[j])} in ${name(g).slice(0, 30)}`);
    }
  }
  // text spilling out of its own box (inputs scroll their text, so they are skipped)
  for (const e of root.querySelectorAll("label, .btn, button, h1, h2, h3, dd, dt, p, small, td, th, .badge, a, li, summary")) {
    if (!vis(e) || clippedBy(e, root)) continue;
    const cs = getComputedStyle(e);
    if (cs.overflowX !== "visible" || cs.display === "inline") continue;
    if (e.scrollWidth > e.clientWidth + 1) out.push(`text spills out of ${name(e)} (${e.scrollWidth - e.clientWidth}px)`);
  }
  // the page itself must never scroll sideways
  const ov = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  if (ov > 1) out.push(`page scrolls sideways by ${ov}px`);
  return [...new Set(out)];
}

/** Realistic, long content: long names, URLs, messages and full lists are where layouts usually break. */
const LONG = "Pangsapuri Servis Residensi Wangsa Maju Sentral Fasa 2B (Blok Menara Timur)";
const URL_ = "https://maps.app.goo.gl/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789?g_st=ic&utm_source=whatsapp_share_link";
const NOW = new Date().toISOString(), DAY = new Date().toISOString().slice(0, 10);
function rich(db) {
  const p = db.projects[0].data;
  p.n = LONG; p.d = "Mah Sing Group Berhad (Property Development Division)"; p.address = "Lot 12345, Jalan Genting Kelang, Taman Setapak Indah Jaya, 53300 Kuala Lumpur, Wilayah Persekutuan";
  p.types = Array.from({ length: 6 }, (_, i) => ({ name: `Type ${"ABCDEF"[i]} (Dual-Key Corner Unit)`, size: String(700 + i * 150), beds: "3+1", baths: "2", price: "RM" + (380000 + i * 90000).toLocaleString("en-MY") }));
  const c = db.ai_contacts[0];
  c.full_name = "Nur Aisyah Binti Mohamad Shahrul Nizam Al-Haj"; c.email = "nur.aisyah.mohamad.shahrul.nizam.alhaj@verylongcompanydomain.com.my";
  db.ai_team_members.push({ email: "senior.property.advisor.wangsa.maju.branch@onestopcentreproperty.com", role: "manager", active: true });
  db.ai_project_facts = [{ project_id: "t1", title_type: "Strata (leasehold 99 years, individual strata titles to be issued)", booking_fee: "RM1,000 (refundable within 7 days)", payment_terms: "10% upon SPA, progressive billing thereafter according to Schedule H",
    maintenance_fee_psf: 0.35, sinking_fund_psf: 0.035, parking_allocation: "2 bays (tandem) for 3-bedroom units", completion_date: "2028-12-31", showroom_address: "M Mira Sales Gallery, Lot PT 5678, Jalan Wangsa Delima 6, Pusat Bandar Wangsa Maju, 53300 Kuala Lumpur",
    showroom_hours: "Mon–Sun 10am–10pm (closed on first day of Hari Raya)", showroom_map_url: URL_, official_url: "https://www.mahsing.com.my/property/m-mira-residence-wangsa-maju-kuala-lumpur/", source: "Developer sales kit v3, 20 Oct 2026", verified_by: "owner@test.local", verified_at: NOW }];
  db.ai_project_units = Array.from({ length: 5 }, (_, i) => ({ id: "u" + i, project_id: "t1", unit_no: `A-${12 + i}-0${i}`, tower: "Menara Timur", floor: String(12 + i), unit_type: "Type C (Dual-Key Corner Unit)", size_sqft: 1150, list_price: 688000 + i * 1000, status: ["available", "reserved", "sold", "booked", "unknown"][i], status_verified_at: i ? null : NOW }));
  db.ai_project_prices = [{ id: "pr1", project_id: "t1", unit_type: "Type C (Dual-Key Corner Unit)", price_kind: "nett", price_myr: 688000, effective_from: DAY, effective_to: null, verified_at: NOW, source: "Developer price list Oct 2026" },
    { id: "pr2", project_id: "t1", unit_type: "Type C (Dual-Key Corner Unit)", price_kind: "list", price_myr: 720000, effective_from: "2026-01-01", effective_to: DAY, source: "Developer price list Jan 2026 (superseded) " + URL_ }];
  db.ai_promotions = [{ id: "pm1", project_id: "t1", title: "Only 633 units. Low density — free legal fees on SPA and loan agreement for bookings before 31 December", details: "Free legal fees on SPA & loan agreement, plus RM5,000 rebate. " + URL_, conditions: "Bumiputera buyers excluded from the rebate; first 100 bookings only; subject to loan approval within 21 days.", valid_from: DAY, valid_to: null, approved: false, source: "Developer circular ref MSG/2026/10/0042" }];
  db.ai_faqs = [{ id: "fq1", project_id: "t1", question: "Is there a shuttle bus to the nearest LRT station (Sri Rampai / Wangsa Maju) and what are the operating hours?", answer: "Yes. " + URL_, lang: "en", approved: true }];
  db.ai_documents = [{ id: "d1", project_id: "t1", title: "M_Mira_Residence_Sales_Kit_v3_FINAL_approved_by_developer_20Oct2026.pdf", kind: "brochure", extract_status: "done", share_with_customers: true, storage_path: "x" }];
  db.ai_knowledge_chunks = [{ id: "k1", project_id: "t1", title: "Financing: how DSR is calculated for joint applicants with variable income", content: "Long content ".repeat(60) + URL_, approved: false, source: "Bank briefing" }];
  db.ai_message_templates = [{ id: "tp1", name: "appointment_reminder_with_showroom_location_and_map", lang: "ms", purpose: "utility", body: "Hai {{1}}, peringatan temujanji anda di {{2}} pada {{3}}. " + URL_, variables: ["name", "project", "appointment"], wa_status: "pending_approval", wa_template_name: "appointment_reminder_with_showroom_location_and_map", active: true }];
  db.ai_tasks = [{ id: "tk1", lead_id: "L1", title: "Call back about Type C dual-key corner unit and send the latest price list with bank panel contacts", due_at: NOW, status: "open", assignee_email: "owner@test.local" }];
  db.ai_handover_events = [{ id: "h1", lead_id: "L1", reason: "negotiation", summary: "Buyer wants an extra RM20,000 discount and asks whether the developer can absorb the stamp duty " + URL_, status: "open", created_at: NOW, lead: db.ai_leads[0] }];
  db.ai_campaigns = [{ id: "cp1", name: "Facebook Lead Ads — M Mira Residence (Wangsa Maju) Q4 2026 retargeting", source_id: "src1", project_id: "t1", tracking_code: "FB-MMIRA-Q4-RETARGET-2026", spend_myr: 12500, created_at: NOW }];
  db.ai_messages.push({ id: "m4", conversation_id: "V1", direction: "inbound", sender_type: "customer", body: "Boleh share location showroom? " + URL_ + " " + "panjang ".repeat(40), status: "received", created_at: NOW });
  db.ai_activities.push({ id: "a2", lead_id: "L1", kind: "note", body: URL_ + " " + "Nota panjang ".repeat(30), actor: "owner@test.local", created_at: NOW });
}

const openAll =(page) => page.evaluate(() => document.querySelectorAll("#view details, dialog details").forEach((d) => { d.open = true; }));

for (const w of WIDTHS) {
  test(`layout audit at ${w}px: pages and dialogs stay inside the screen and their cards`, { skip: skip || (!canRun() && "playwright not installed") }, async () => {
    const { page, ctx, errors } = await newPage({ width: w, height: heightOf(w) }, { mutate: rich });
    const problems = [];
    try {
      await page.goto(base + "/sales/#/overview");
      await page.waitForSelector("#view h1");
      for (const s of SECTIONS) {
        await go(page, s);
        await openAll(page);
        for (const p of await page.evaluate(audit, "#view")) problems.push(`${s}: ${p}`);
      }
      for (const [s, btn] of DIALOGS) {
        await go(page, s);
        await page.click(btn);
        await page.waitForSelector("dialog[open]");
        await openAll(page);
        for (const p of await page.evaluate(audit, "dialog[open]")) problems.push(`${s} dialog: ${p}`);
        await page.evaluate(() => document.querySelectorAll("dialog").forEach((d) => { d.close(); d.remove(); }));
      }
      if (process.env.LAYOUT_REPORT) console.log(`--- ${w}px: ${problems.length} problem(s)\n` + problems.join("\n"));
      assert.deepEqual(problems, [], `layout problems at ${w}px`);
      assert.deepEqual(errors, [], "no JavaScript errors");
    } finally { await ctx.close(); }
  });
}
