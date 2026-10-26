// AI Sales dashboard — property database (verified facts, units, prices, promotions) and knowledge base.
// public.projects (the website listings) is read-only here; listing edits stay in the existing website admin.
import { parseCSV, chunkText } from "../shared/text.mjs";
import { SB, S, can, $, $$, esc, attr, fmtDate, q, act, toast, guardForm, clearDraft, formData, modal, badge, opt, empty, ro, money, projectName } from "./core.js";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
const projectOptions = (sel, blank = "— General (all projects) —") => opt("", blank, sel) + S.projects.map((p) => opt(p.id, p.name, sel)).join("");
const ageDays = (d) => (d ? Math.floor((Date.now() - new Date(d)) / 864e5) : null);
const freshness = (d, maxDays) => { const a = ageDays(d); if (a === null) return badge("Not verified", "alert"); return a > maxDays ? badge(`Verified ${a} d ago — stale`, "warn") : badge(`Verified ${a === 0 ? "today" : a + " d ago"}`, "ok"); };

const num = (v) => { const n = Number(String(v ?? "").replace(/[^\d.]/g, "")); return v !== "" && v !== null && v !== undefined && isFinite(n) && n > 0 ? n : null; };

/* ======================= Property list ======================= */
export async function properties(el) {
  const facts = (await q(SB.from("ai_project_facts").select("project_id,verified_at"))) || [];
  const units = (await q(SB.from("ai_project_units").select("project_id,status"))) || [];
  const promos = (await q(SB.from("ai_active_promotions").select("project_id"))) || [];
  const maxDays = S.settings.business?.price_max_age_days || 30;
  el.innerHTML = `<div class="page-head"><h1>Property projects</h1><p class="sub">Listings come from your website (${S.projects.length}). Add verified details the AI may quote: unit inventory, prices, promotions, booking fees, showroom hours.</p></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Project</th><th>Website</th><th>Verified facts</th><th>Units available</th><th>Active promotions</th></tr></thead><tbody>
  ${S.projects.map((p) => { const f = facts.find((x) => x.project_id === p.id); const u = units.filter((x) => x.project_id === p.id); return `<tr data-href="#/property/${attr(p.id)}" tabindex="0">
    <td data-label="Project"><a href="#/property/${attr(p.id)}"><b>${esc(p.name)}</b></a><small>${esc([p.area, p.data.d].filter(Boolean).join(" · "))}</small></td>
    <td data-label="Website">${p.published ? badge("Published", "ok") : badge("Unpublished")}</td>
    <td data-label="Verified facts">${f ? freshness(f.verified_at, maxDays) : badge("None", "alert")}</td>
    <td data-label="Units">${u.length ? `${u.filter((x) => x.status === "available").length} / ${u.length}` : "—"}</td>
    <td data-label="Promotions">${promos.filter((x) => x.project_id === p.id || !x.project_id).length || "—"}</td></tr>`; }).join("")}
  </tbody></table></div>`;
  $$("tr[data-href]", el).forEach((tr) => { tr.onclick = (e) => { if (!e.target.closest("a")) location.hash = tr.dataset.href; }; tr.onkeydown = (e) => { if (e.key === "Enter") location.hash = tr.dataset.href; }; });
}

/* ======================= Property detail ======================= */
export async function property(el, id) {
  const p = S.projects.find((x) => x.id === id);
  if (!p) { el.innerHTML = empty("Project not found. It may have been removed from the website."); return; }
  const [facts, units, prices, promos, faqs, docs] = await Promise.all([
    q(SB.from("ai_project_facts").select("*").eq("project_id", id).maybeSingle()),
    q(SB.from("ai_project_units").select("*").eq("project_id", id).order("unit_no")),
    q(SB.from("ai_project_prices").select("*").eq("project_id", id).order("effective_from", { ascending: false })),
    q(SB.from("ai_promotions").select("*").or(`project_id.eq.${id},project_id.is.null`).order("valid_from", { ascending: false })),
    q(SB.from("ai_faqs").select("*").eq("project_id", id).order("created_at")),
    q(SB.from("ai_documents").select("id,title,kind,extract_status,share_with_customers").eq("project_id", id)),
  ]);
  const f = facts || {};
  const d = p.data;
  const B = S.settings.business || {};
  const current = (prices || []).filter((x) => !x.effective_to);
  const history = (prices || []).filter((x) => x.effective_to);
  const t = today();
  const promoState = (x) => !x.approved ? badge("Not approved", "warn") : x.valid_from > t ? badge("Starts " + x.valid_from) : x.valid_to && x.valid_to < t ? badge("Expired", "alert") : badge("Active", "ok");
  el.innerHTML = `
  <div class="page-head"><div><a class="back" href="#/properties">← Projects</a><h1>${esc(p.name)}</h1><p class="sub">${esc([p.area, d.d, d.s].filter(Boolean).join(" · "))}</p></div>
   <div class="head-actions">${p.published ? `<a class="btn" href="/property/${attr(p.slug)}/" target="_blank" rel="noopener">View on website</a>` : ""}<a class="btn" href="/#admin" target="_blank" rel="noopener">Edit listing (website admin)</a></div></div>
  <div class="detail">
   <div class="col">
    <section class="card"><h2>From the website listing <small>(indicative)</small></h2>
      <dl class="kv">${[["Developer", d.d], ["Type", d.t], ["Status", d.s], ["Tenure", d.tenure], ["Expected completion", d.year], ["Built-up", d.z && d.z + " sqft"], ["Maintenance (website)", d.maintPsf && "RM" + d.maintPsf + " psf"], ["Address", d.address]].filter((x) => x[1]).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      ${(d.types || []).length ? `<table class="mini"><thead><tr><th>Layout</th><th>Size</th><th>Beds</th><th>Website price</th></tr></thead><tbody>${d.types.filter((x) => x && x.name).map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.size)}</td><td>${esc(x.beds)}</td><td>${esc(x.price)}</td></tr>`).join("")}</tbody></table>` : ""}
      <p class="note">The AI treats website prices as <b>indicative</b>. It quotes a price as confirmed only from "Verified prices" below while it is current and not older than ${esc(B.price_max_age_days || 30)} days.</p>
    </section>

    <section class="card"><h2>Verified facts ${freshness(f.verified_at, B.price_max_age_days || 30)}</h2>
      <form id="ff" class="form two">
      <label>Title type<input name="title_type" value="${attr(f.title_type)}" placeholder="Strata / individual"${ro("manager")}></label>
      <label>Booking fee<input name="booking_fee" value="${attr(f.booking_fee)}" placeholder="e.g. RM1,000"${ro("manager")}></label>
      <label class="full">Payment terms<textarea name="payment_terms" rows="2"${ro("manager")}>${esc(f.payment_terms)}</textarea></label>
      <label>Maintenance fee (RM psf)<input name="maintenance_fee_psf" type="number" step="0.001" min="0" value="${attr(f.maintenance_fee_psf)}"${ro("manager")}></label>
      <label>Sinking fund (RM psf)<input name="sinking_fund_psf" type="number" step="0.001" min="0" value="${attr(f.sinking_fund_psf)}"${ro("manager")}></label>
      <label>Parking allocation<input name="parking_allocation" value="${attr(f.parking_allocation)}"${ro("manager")}></label>
      <label>Completion date (verified)<input name="completion_date" type="date" value="${attr(f.completion_date)}"${ro("manager")}></label>
      <label class="full">Eligibility<textarea name="eligibility" rows="2" placeholder="e.g. Bumiputera quota, first-home buyers, income limits"${ro("manager")}>${esc(f.eligibility)}</textarea></label>
      <label class="full">Restrictions<textarea name="restrictions" rows="2"${ro("manager")}>${esc(f.restrictions)}</textarea></label>
      <label class="full">Showroom address<input name="showroom_address" value="${attr(f.showroom_address)}"${ro("manager")}></label>
      <label>Showroom hours<input name="showroom_hours" value="${attr(f.showroom_hours)}" placeholder="Mon–Sun 10am–6pm"${ro("manager")}></label>
      <label>Showroom map link<input name="showroom_map_url" type="url" value="${attr(f.showroom_map_url)}"${ro("manager")}></label>
      <label class="full">Official project URL<input name="official_url" type="url" value="${attr(f.official_url)}"${ro("manager")}></label>
      <label class="full">Source of this information<input name="source" value="${attr(f.source)}" placeholder="e.g. Developer sales kit v3, 20 Oct 2026" required${ro("manager")}></label>
      <label class="full">Internal notes<textarea name="notes" rows="2"${ro("manager")}>${esc(f.notes)}</textarea></label>
      <label class="check full"><input type="checkbox" name="mark_verified" checked${ro("manager")}> I have checked these details against the source today</label>
      ${can("manager") ? `<div class="actions full"><button class="btn pri">Save facts</button></div>` : ""}</form>
      ${f.verified_by ? `<p class="note">Last verified by ${esc(f.verified_by)} on ${esc(fmtDate(f.verified_at))}.</p>` : ""}
    </section>

    <section class="card"><h2>FAQs &amp; documents</h2>
      ${(faqs || []).length ? `<ul class="list">${faqs.map((x) => `<li>${esc(x.question)} ${x.approved ? badge("Approved", "ok") : badge("Draft", "warn")} ${badge(x.lang.toUpperCase())}</li>`).join("")}</ul>` : empty("No project FAQs yet.")}
      ${(docs || []).length ? `<ul class="list">${docs.map((x) => `<li>📄 ${esc(x.title)} ${badge(x.kind)} ${x.share_with_customers ? badge("Shareable", "ok") : ""}</li>`).join("")}</ul>` : ""}
      <a class="btn" href="#/knowledge?project=${attr(id)}">Manage in knowledge base</a>
    </section>
   </div>
   <div class="col">
    <section class="card"><h2>Unit inventory</h2>
      <p class="note">The AI never promises a unit is available unless its status was verified within ${esc(B.inventory_max_age_hours || 72)} hours.</p>
      ${(units || []).length ? `<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>Unit</th><th>Type</th><th>Size</th><th>Price</th><th>Status</th><th>Checked</th></tr></thead><tbody>
       ${units.map((u) => { const h = u.status_verified_at ? (Date.now() - new Date(u.status_verified_at)) / 36e5 : null; return `<tr><td data-label="Unit"><b>${esc(u.unit_no)}</b><small>${esc([u.tower, u.floor && "Fl " + u.floor].filter(Boolean).join(" · "))}</small></td><td data-label="Type">${esc(u.unit_type)}</td><td data-label="Size">${esc(u.size_sqft)}</td><td data-label="Price">${esc(money(u.list_price))}</td>
        <td data-label="Status">${can("manager") ? `<select data-ustat="${attr(u.id)}" aria-label="Status of ${attr(u.unit_no)}">${["available", "reserved", "booked", "sold", "unavailable", "unknown"].map((s) => opt(s, s, u.status)).join("")}</select>` : esc(u.status)}</td>
        <td data-label="Checked">${h === null ? badge("Never", "alert") : h > (B.inventory_max_age_hours || 72) ? badge(Math.round(h / 24) + " d ago", "warn") : badge(h < 1 ? "<1 h ago" : Math.round(h) + " h ago", "ok")}${can("manager") ? ` <button class="link" data-uver="${attr(u.id)}">Checked now</button>` : ""}</td></tr>`; }).join("")}</tbody></table></div>` : empty("No units recorded. Without inventory the AI will say availability must be confirmed.")}
      ${can("manager") ? `<details><summary>Add a unit</summary><form id="fu" class="form two">
        <label>Unit no.<input name="unit_no" required></label><label>Layout type<input name="unit_type" list="types-${attr(id)}"></label>
        <label>Tower<input name="tower"></label><label>Floor<input name="floor"></label>
        <label>Size (sqft)<input name="size_sqft" type="number" min="1" step="1"></label><label>List price (RM)<input name="list_price" type="number" min="1" step="1"></label>
        <label>Bedrooms<input name="bedrooms"></label><label>Bathrooms<input name="bathrooms"></label>
        <label>Status<select name="status">${["available", "reserved", "booked", "sold", "unavailable", "unknown"].map((s) => opt(s, s, "available")).join("")}</select></label>
        <label>Source<input name="source" required placeholder="e.g. Developer availability chart 26 Oct"></label>
        <div class="actions full"><button class="btn">Add unit</button></div></form>
        <datalist id="types-${attr(id)}">${(d.types || []).filter((x) => x && x.name).map((x) => `<option value="${attr(x.name)}">`).join("")}</datalist></details>
        <details><summary>Import units from CSV</summary><p class="note">Columns: unit_no, unit_type, tower, floor, size_sqft, bedrooms, bathrooms, status, list_price. Existing unit numbers are updated.</p>
        <form id="fuc" class="form"><input type="file" name="file" accept=".csv,text/csv" required><label>Source<input name="source" required placeholder="e.g. Availability chart 26 Oct"></label><div class="actions"><button class="btn">Import</button></div></form></details>` : ""}
    </section>

    <section class="card"><h2>Verified prices</h2>
      ${current.length ? `<table class="mini"><thead><tr><th>Layout</th><th>Kind</th><th>Price</th><th>Since</th><th>Status</th></tr></thead><tbody>${current.map((x) => `<tr><td>${esc(x.unit_type)}</td><td>${esc(x.price_kind)}</td><td><b>${esc(money(x.price_myr))}</b></td><td>${esc(x.effective_from)}</td><td>${freshness(x.verified_at || x.created_at, B.price_max_age_days || 30)}</td></tr>`).join("")}</tbody></table>` : empty("No verified prices. The AI will only give website prices as indicative and say confirmation is required.")}
      ${history.length ? `<details><summary>Price history (${history.length})</summary><table class="mini"><tbody>${history.map((x) => `<tr><td>${esc(x.unit_type)}</td><td>${esc(x.price_kind)}</td><td>${esc(money(x.price_myr))}</td><td>${esc(x.effective_from)} → ${esc(x.effective_to)}</td><td><small>${esc(x.source)}</small></td></tr>`).join("")}</tbody></table></details>` : ""}
      ${can("manager") ? `<details><summary>Add or change a price</summary><form id="fp" class="form two">
        <label>Layout type<input name="unit_type" required list="types-${attr(id)}"></label>
        <label>Kind<select name="price_kind">${opt("list", "List price")}${opt("nett", "Nett price")}${opt("promo", "Promotional price")}${opt("from", "From price")}</select></label>
        <label>Price (RM)<input name="price_myr" type="number" min="1" step="1" required></label>
        <label>Effective from<input name="effective_from" type="date" value="${attr(today())}" required></label>
        <label class="full">Source<input name="source" required placeholder="e.g. Developer price list Oct 2026"></label>
        <p class="note full">Saving a new price keeps the old one in history automatically.</p>
        <div class="actions full"><button class="btn">Save price</button></div></form></details>
        <details><summary>Import prices from CSV</summary><p class="note">Columns: unit_type, price_myr, price_kind (list/nett/promo/from), effective_from (YYYY-MM-DD).</p>
        <form id="fpc" class="form"><input type="file" name="file" accept=".csv,text/csv" required><label>Source<input name="source" required></label><div class="actions"><button class="btn">Import</button></div></form></details>` : ""}
    </section>

    <section class="card"><h2>Promotions</h2>
      <p class="note">Only approved promotions within their validity dates are shared by the AI, always with their conditions.</p>
      ${(promos || []).length ? `<ul class="list">${promos.map((x) => `<li><b>${esc(x.title)}</b> ${promoState(x)} ${x.project_id ? "" : badge("All projects")}<small>${esc(x.valid_from)} → ${esc(x.valid_to || "open-ended")} · ${esc(x.source)}</small><p>${esc(x.details)}</p>${x.conditions ? `<p class="note">Conditions: ${esc(x.conditions)}</p>` : ""}
        ${can("manager") ? `<div class="actions">${x.approved ? `<button class="link" data-unapprove="${attr(x.id)}">Withdraw approval</button>` : `<button class="link" data-approve="${attr(x.id)}">Approve</button>`}</div>` : ""}</li>`).join("")}</ul>` : empty("No promotions on record.")}
      ${can("manager") ? `<details><summary>Add promotion</summary><form id="fpr" class="form two">
        <label class="full">Title<input name="title" required placeholder="e.g. Free legal fees on SPA"></label>
        <label class="full">Details<textarea name="details" rows="2" required></textarea></label>
        <label class="full">Conditions<textarea name="conditions" rows="2" placeholder="Eligibility, units covered, deadlines"></textarea></label>
        <label>Valid from<input name="valid_from" type="date" required value="${attr(today())}"></label><label>Valid to<input name="valid_to" type="date"></label>
        <label class="full">Source<input name="source" required placeholder="Developer circular ref / URL"></label>
        <label class="check full"><input type="checkbox" name="all_projects"> Applies to all projects</label>
        <div class="actions full"><button class="btn">Save (needs approval)</button></div></form></details>` : ""}
    </section>
   </div>
  </div>`;
  const reload = () => property(el, id);
  if (!can("manager")) return;
  const ff = $("#ff", el);
  guardForm(ff, `prop:${id}:facts`);
  ff.onsubmit = (e) => { e.preventDefault(); const v = formData(ff); const { mark_verified, ...rest } = v;
    act(ff.querySelector("button"), async () => {
      await q(SB.from("ai_project_facts").upsert({ project_id: id, ...rest, ...(mark_verified ? { verified_at: new Date().toISOString(), verified_by: S.email } : {}) }).select("project_id"), { expectRows: true });
      clearDraft(ff); reload();
    }, "Facts saved"); };
  $$("[data-ustat]", el).forEach((s) => s.onchange = () => act(null, async () => { await q(SB.from("ai_project_units").update({ status: s.value, status_verified_at: new Date().toISOString() }).eq("id", s.dataset.ustat).select("id"), { expectRows: true }); reload(); }, "Unit status saved"));
  $$("[data-uver]", el).forEach((b) => b.onclick = () => act(b, async () => { await q(SB.from("ai_project_units").update({ status_verified_at: new Date().toISOString() }).eq("id", b.dataset.uver).select("id"), { expectRows: true }); reload(); }, "Marked as checked now"));
  const fu = $("#fu", el);
  fu.onsubmit = (e) => { e.preventDefault(); const v = formData(fu);
    act(fu.querySelector("button"), async () => { await q(SB.from("ai_project_units").insert({ project_id: id, ...v, status_verified_at: new Date().toISOString() })); reload(); }, "Unit added"); };
  const fuc = $("#fuc", el);
  fuc.onsubmit = (e) => { e.preventDefault(); const file = fuc.file.files[0], source = fuc.source.value.trim();
    act(fuc.querySelector("button"), async () => {
      const rows = parseCSV(await file.text()).filter((r) => r.unit_no);
      if (!rows.length) throw new Error("No rows with a unit_no column found.");
      const STAT = ["available", "reserved", "booked", "sold", "unavailable", "unknown"];
      const recs = rows.map((r) => ({ project_id: id, unit_no: r.unit_no, unit_type: r.unit_type || null, tower: r.tower || null, floor: r.floor || null, size_sqft: num(r.size_sqft), bedrooms: r.bedrooms || null, bathrooms: r.bathrooms || null,
        status: STAT.includes((r.status || "").toLowerCase()) ? r.status.toLowerCase() : "unknown", list_price: num(r.list_price), source, status_verified_at: new Date().toISOString() }));
      await q(SB.from("ai_project_units").upsert(recs, { onConflict: "project_id,unit_no" }));
      toast(`Imported ${recs.length} unit${recs.length === 1 ? "" : "s"}`); reload();
    }); };
  const fp = $("#fp", el);
  guardForm(fp, `prop:${id}:price`);
  fp.onsubmit = (e) => { e.preventDefault(); const v = formData(fp);
    act(fp.querySelector("button"), async () => { await q(SB.from("ai_project_prices").insert({ project_id: id, ...v, verified_by: S.email, verified_at: new Date().toISOString() })); clearDraft(fp); reload(); }, "Price saved; previous price moved to history"); };
  const fpc = $("#fpc", el);
  fpc.onsubmit = (e) => { e.preventDefault(); const file = fpc.file.files[0], source = fpc.source.value.trim();
    act(fpc.querySelector("button"), async () => {
      const rows = parseCSV(await file.text()).filter((r) => r.unit_type && num(r.price_myr));
      if (!rows.length) throw new Error("No rows with unit_type and price_myr found.");
      // one by one so each new price closes the previous one in order
      for (const r of rows) await q(SB.from("ai_project_prices").insert({ project_id: id, unit_type: r.unit_type, price_myr: num(r.price_myr), price_kind: ["list", "nett", "promo", "from"].includes(r.price_kind) ? r.price_kind : "list", effective_from: /^\d{4}-\d\d-\d\d$/.test(r.effective_from || "") ? r.effective_from : today(), source, verified_by: S.email, verified_at: new Date().toISOString() }));
      toast(`Imported ${rows.length} price${rows.length === 1 ? "" : "s"}`); reload();
    }); };
  const fpr = $("#fpr", el);
  guardForm(fpr, `prop:${id}:promo`);
  fpr.onsubmit = (e) => { e.preventDefault(); const v = formData(fpr); const { all_projects, ...rest } = v;
    act(fpr.querySelector("button"), async () => { await q(SB.from("ai_promotions").insert({ ...rest, project_id: all_projects ? null : id })); clearDraft(fpr); reload(); }, "Promotion saved — approve it to make it usable"); };
  $$("[data-approve]", el).forEach((b) => b.onclick = () => act(b, async () => { await q(SB.from("ai_promotions").update({ approved: true, approved_by: S.email, approved_at: new Date().toISOString() }).eq("id", b.dataset.approve).select("id"), { expectRows: true }); reload(); }, "Approved"));
  $$("[data-unapprove]", el).forEach((b) => b.onclick = () => act(b, async () => { await q(SB.from("ai_promotions").update({ approved: false }).eq("id", b.dataset.unapprove).select("id"), { expectRows: true }); reload(); }, "Approval withdrawn"));
}

/* ======================= Knowledge base ======================= */
const loadScript = (src) => new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load " + src)); document.head.appendChild(s); });
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const XLSXJS = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

async function extractText(file) {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    await loadScript(PDFJS);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS.replace("pdf.min.js", "pdf.worker.min.js");
    const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const c = await (await pdf.getPage(i)).getTextContent();
      pages.push(c.items.map((x) => x.str + (x.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+/g, " ").trim());
    }
    return { sections: pages.map((t, i) => ({ title: `Page ${i + 1}`, text: t })).filter((s) => s.text) };
  }
  if (/\.(xlsx|xls|ods)$/.test(name)) {
    await loadScript(XLSXJS);
    const wb = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
    return { sections: wb.SheetNames.map((n) => ({ title: "Sheet " + n, text: window.XLSX.utils.sheet_to_csv(wb.Sheets[n]), table: true })) };
  }
  if (/\.(csv)$/.test(name) || file.type === "text/csv") return { sections: [{ title: file.name, text: await file.text(), table: true }] };
  if (/\.(txt|md)$/.test(name) || file.type.startsWith("text/")) return { sections: [{ title: file.name, text: await file.text() }] };
  return null; // images / video: stored, not text-searchable
}

export async function knowledge(el, params) {
  const tab = params.get("tab") || "docs";
  const proj = params.get("project") || "";
  const tabs = [["docs", "Documents"], ["entries", "Knowledge entries"], ["faqs", "FAQs"], ["search", "Test search"]];
  const link = (t, extra = {}) => "#/knowledge?" + new URLSearchParams({ tab: t, ...(proj ? { project: proj } : {}), ...extra });
  el.innerHTML = `<div class="page-head"><h1>Knowledge base</h1><p class="sub">Only <b>approved</b> entries are used by the AI. Everything else is a draft.</p></div>
  <div class="seg">${tabs.map(([k, l]) => `<a class="${tab === k ? "on" : ""}" href="${link(k)}">${l}</a>`).join("")}</div>
  <form class="filters" id="kp"><select name="project" aria-label="Project filter">${opt("", "All projects", proj)}${S.projects.map((p) => opt(p.id, p.name, proj)).join("")}</select></form>
  <div id="kbody"></div>`;
  $("#kp", el).onchange = (e) => { location.hash = "#/knowledge?" + new URLSearchParams({ tab, ...(e.target.value ? { project: e.target.value } : {}) }); };
  const body = $("#kbody", el);
  if (tab === "docs") return docsTab(body, proj);
  if (tab === "entries") return entriesTab(body, proj, params.get("doc"));
  if (tab === "faqs") return faqsTab(body, proj);
  return searchTab(body, proj);
}

async function docsTab(el, proj) {
  let query = SB.from("ai_documents").select("*").order("created_at", { ascending: false }).limit(300);
  if (proj) query = query.eq("project_id", proj);
  const docs = (await q(query)) || [];
  const counts = (await q(SB.from("ai_knowledge_chunks").select("document_id,approved").not("document_id", "is", null))) || [];
  el.innerHTML = `${can("manager") ? `<section class="card"><h2>Upload documents</h2><form id="up" class="form two">
    <label class="full">Files<input type="file" name="files" multiple required accept=".pdf,.csv,.txt,.md,.xlsx,.xls,image/*,video/*"></label>
    <label>Project<select name="project_id">${projectOptions(proj)}</select></label>
    <label>Kind<select name="kind">${["brochure", "price_list", "floor_plan", "spreadsheet", "promotion", "image", "video", "faq", "other"].map((k) => opt(k, k.replace("_", " "))).join("")}</select></label>
    <label>Language<select name="lang">${opt("", "—")}${opt("en", "English")}${opt("ms", "Bahasa Malaysia")}${opt("mixed", "Mixed")}</select></label>
    <label class="check"><input type="checkbox" name="share_with_customers"> AI may send this file to buyers</label>
    <p class="note full">Files are stored privately (max 50 MB). Text from PDF, spreadsheet, CSV and text files is extracted in your browser into draft knowledge entries for you to review and approve.</p>
    <div class="actions full"><button class="btn pri" data-busy="Uploading…">Upload &amp; extract</button></div><div id="upmsg" class="full note" aria-live="polite"></div></form></section>` : ""}
  ${docs.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Document</th><th>Project</th><th>Text</th><th>Entries</th><th></th></tr></thead><tbody>
   ${docs.map((d) => { const c = counts.filter((x) => x.document_id === d.id); return `<tr><td data-label="Document"><b>${esc(d.title)}</b><small>${esc(d.kind)} · ${esc(((d.size_bytes || 0) / 1048576).toFixed(1))} MB · ${esc(fmtDate(d.created_at, false))}</small>${d.share_with_customers ? badge("Shareable", "ok") : ""}</td>
    <td data-label="Project">${esc(projectName(d.project_id)) || "All"}</td><td data-label="Text">${badge(d.extract_status.replace("_", " "), d.extract_status === "failed" ? "alert" : d.extract_status === "extracted" ? "ok" : "")}${d.extract_error ? `<small>${esc(d.extract_error)}</small>` : ""}</td>
    <td data-label="Entries"><a href="#/knowledge?tab=entries&doc=${attr(d.id)}">${c.filter((x) => x.approved).length} approved / ${c.length}</a></td>
    <td><button class="link" data-dl="${attr(d.storage_path)}">Open</button>${can("manager") ? ` <button class="link" data-share="${attr(d.id)}" data-v="${d.share_with_customers ? "0" : "1"}">${d.share_with_customers ? "Stop sharing" : "Allow sharing"}</button> <button class="link danger" data-deldoc="${attr(d.id)}" data-path="${attr(d.storage_path)}">Delete</button>` : ""}</td></tr>`; }).join("")}</tbody></table></div>` : empty("No documents uploaded yet.")}`;
  const reload = () => docsTab(el, proj);
  $$("[data-dl]", el).forEach((b) => b.onclick = () => act(b, async () => { const { data, error } = await SB.storage.from("ai-docs").createSignedUrl(b.dataset.dl, 300); if (error) throw error; window.open(data.signedUrl, "_blank", "noopener"); }));
  if (!can("manager")) return;
  $$("[data-share]", el).forEach((b) => b.onclick = () => act(b, async () => { await q(SB.from("ai_documents").update({ share_with_customers: b.dataset.v === "1" }).eq("id", b.dataset.share).select("id"), { expectRows: true }); reload(); }, "Saved"));
  $$("[data-deldoc]", el).forEach((b) => b.onclick = () => { if (!confirm("Delete this document and all knowledge entries extracted from it?")) return;
    act(b, async () => { await SB.storage.from("ai-docs").remove([b.dataset.path]); await q(SB.from("ai_documents").delete().eq("id", b.dataset.deldoc).select("id"), { expectRows: true }); reload(); }, "Deleted"); });
  const up = $("#up", el);
  up.onsubmit = (e) => { e.preventDefault(); const v = formData(up); const files = [...up.files.files]; const msg = $("#upmsg", el);
    act(up.querySelector("button"), async () => {
      let ok = 0, entries = 0;
      for (const file of files) {
        if (file.size > 50 * 1048576) { toast(`${file.name} is over 50 MB — skipped`, "err"); continue; }
        msg.textContent = `Uploading ${file.name}…`;
        const docId = crypto.randomUUID();
        const path = `docs/${docId}/${file.name.replace(/[^\w.\-]+/g, "_").slice(-120)}`;
        const { error: upErr } = await SB.storage.from("ai-docs").upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
        if (upErr) throw upErr;
        await q(SB.from("ai_documents").insert({ id: docId, title: file.name, project_id: v.project_id, kind: v.kind, lang: v.lang, storage_path: path, mime_type: file.type, size_bytes: file.size, share_with_customers: !!v.share_with_customers }));
        ok++;
        try {
          msg.textContent = `Extracting text from ${file.name}…`;
          const ex = await extractText(file);
          if (!ex) { await SB.from("ai_documents").update({ extract_status: "not_applicable" }).eq("id", docId); continue; }
          const chunks = chunkText(ex.sections);
          if (!chunks.length) throw new Error("No selectable text found (scanned PDFs need OCR — add the key facts manually).");
          for (let i = 0; i < chunks.length; i += 100) {
            await q(SB.from("ai_knowledge_chunks").insert(chunks.slice(i, i + 100).map((c, j) => ({ document_id: docId, project_id: v.project_id, lang: v.lang, title: c.title, content: c.content.slice(0, 8000), position: i + j }))));
          }
          entries += chunks.length;
          await SB.from("ai_documents").update({ extract_status: "extracted", extract_error: null }).eq("id", docId);
        } catch (x) {
          await SB.from("ai_documents").update({ extract_status: "failed", extract_error: String(x.message || x).slice(0, 300) }).eq("id", docId);
        }
      }
      msg.textContent = "";
      toast(`${ok} file${ok === 1 ? "" : "s"} uploaded · ${entries} draft entr${entries === 1 ? "y" : "ies"} to review`);
      reload();
    }); };
}

async function entriesTab(el, proj, docId) {
  let query = SB.from("ai_knowledge_chunks").select("id,document_id,project_id,lang,title,content,approved,approved_by,position,updated_at").order("approved").order("position").limit(300);
  if (proj) query = query.eq("project_id", proj);
  if (docId) query = query.eq("document_id", docId);
  const rows = (await q(query)) || [];
  el.innerHTML = `${can("manager") ? `<details class="card"><summary><b>Add a knowledge entry manually</b></summary><form id="ke" class="form two">
    <label>Project<select name="project_id">${projectOptions(proj)}</select></label>
    <label>Language<select name="lang">${opt("en", "English")}${opt("ms", "Bahasa Malaysia")}${opt("mixed", "Mixed")}</select></label>
    <label class="full">Title<input name="title" required placeholder="e.g. Nearest LRT and travel times"></label>
    <label class="full">Content<textarea name="content" rows="5" required maxlength="8000" placeholder="Verified facts only. Mention the source."></textarea></label>
    <label class="check full"><input type="checkbox" name="approved"> Approved for AI use</label>
    <div class="actions full"><button class="btn pri">Save entry</button></div></form></details>` : ""}
  ${docId ? `<p><a href="#/knowledge?tab=entries${proj ? "&project=" + attr(proj) : ""}">Show entries from all documents</a></p>` : ""}
  ${rows.length && can("manager") && rows.some((r) => !r.approved) ? `<div class="actions"><button class="btn" id="apall">Approve all ${rows.filter((r) => !r.approved).length} drafts shown</button></div>` : ""}
  ${rows.length ? rows.map((r) => `<article class="card entry ${r.approved ? "" : "draft"}"><div class="ho-h"><b>${esc(r.title || "Untitled")}</b> ${r.approved ? badge("Approved", "ok") : badge("Draft", "warn")} ${r.lang ? badge(r.lang.toUpperCase()) : ""} <small>${esc(projectName(r.project_id) || "All projects")}</small></div>
    <pre class="content">${esc(r.content)}</pre>
    ${can("manager") ? `<div class="actions">${r.approved ? `<button class="link" data-ap="${attr(r.id)}" data-v="0">Unapprove</button>` : `<button class="link" data-ap="${attr(r.id)}" data-v="1">Approve</button>`} <button class="link" data-edit="${attr(r.id)}">Edit</button> <button class="link danger" data-del="${attr(r.id)}">Delete</button></div>` : ""}</article>`).join("") : empty("No knowledge entries.")}`;
  const reload = () => entriesTab(el, proj, docId);
  if (!can("manager")) return;
  const ke = $("#ke", el);
  guardForm(ke, "kb:new");
  ke.onsubmit = (e) => { e.preventDefault(); const v = formData(ke);
    act(ke.querySelector("button"), async () => { await q(SB.from("ai_knowledge_chunks").insert({ ...v, approved: !!v.approved, approved_by: v.approved ? S.email : null })); clearDraft(ke); reload(); }, "Entry saved"); };
  $$("[data-ap]", el).forEach((b) => b.onclick = () => act(b, async () => { const v = b.dataset.v === "1"; await q(SB.from("ai_knowledge_chunks").update({ approved: v, approved_by: v ? S.email : null }).eq("id", b.dataset.ap).select("id"), { expectRows: true }); reload(); }, "Saved"));
  $$("[data-del]", el).forEach((b) => b.onclick = () => confirm("Delete this entry?") && act(b, async () => { await q(SB.from("ai_knowledge_chunks").delete().eq("id", b.dataset.del).select("id"), { expectRows: true }); reload(); }, "Deleted"));
  $$("[data-edit]", el).forEach((b) => b.onclick = () => { const r = rows.find((x) => x.id === b.dataset.edit);
    const dlg = modal("Edit knowledge entry", `<form id="ee" class="form"><label>Title<input name="title" value="${attr(r.title)}"></label><label>Content<textarea name="content" rows="10" maxlength="8000">${esc(r.content)}</textarea></label><p class="note">Editing an approved entry returns it to draft until re-approved.</p><div class="actions"><button class="btn pri">Save</button></div></form>`, { wide: true });
    const f = $("#ee", dlg); guardForm(f, "kb:edit:" + r.id);
    f.onsubmit = (e) => { e.preventDefault(); const v = formData(f); act(f.querySelector("button"), async () => { await q(SB.from("ai_knowledge_chunks").update({ title: v.title, content: v.content, approved: false, approved_by: null }).eq("id", r.id).select("id"), { expectRows: true }); clearDraft(f); dlg.done(); reload(); }, "Saved as draft"); }; });
  const apall = $("#apall", el);
  if (apall) apall.onclick = () => act(apall, async () => { const ids = rows.filter((r) => !r.approved).map((r) => r.id); await q(SB.from("ai_knowledge_chunks").update({ approved: true, approved_by: S.email }).in("id", ids).select("id"), { expectRows: true }); reload(); }, "Approved");
}

async function faqsTab(el, proj) {
  let query = SB.from("ai_faqs").select("*").order("approved").order("created_at", { ascending: false }).limit(300);
  if (proj) query = query.eq("project_id", proj);
  const rows = (await q(query)) || [];
  el.innerHTML = `${can("manager") ? `<details class="card" open><summary><b>Add FAQ</b></summary><form id="fq" class="form two">
    <label>Project<select name="project_id">${projectOptions(proj)}</select></label><label>Language<select name="lang">${opt("ms", "Bahasa Malaysia")}${opt("en", "English")}</select></label>
    <label class="full">Question<input name="question" required></label><label class="full">Approved answer<textarea name="answer" rows="3" required></textarea></label>
    <label class="check full"><input type="checkbox" name="approved"> Approved for AI use</label><div class="actions full"><button class="btn pri">Save FAQ</button></div></form></details>` : ""}
  ${rows.length ? rows.map((r) => `<article class="card entry ${r.approved ? "" : "draft"}"><div class="ho-h"><b>${esc(r.question)}</b> ${r.approved ? badge("Approved", "ok") : badge("Draft", "warn")} ${badge(r.lang.toUpperCase())} <small>${esc(projectName(r.project_id) || "General")}</small></div><p>${esc(r.answer)}</p>
    ${can("manager") ? `<div class="actions"><button class="link" data-ap="${attr(r.id)}" data-v="${r.approved ? 0 : 1}">${r.approved ? "Unapprove" : "Approve"}</button> <button class="link danger" data-del="${attr(r.id)}">Delete</button></div>` : ""}</article>`).join("") : empty("No FAQs yet.")}`;
  const reload = () => faqsTab(el, proj);
  if (!can("manager")) return;
  const f = $("#fq", el); guardForm(f, "faq:new");
  f.onsubmit = (e) => { e.preventDefault(); const v = formData(f); act(f.querySelector("button"), async () => { await q(SB.from("ai_faqs").insert({ ...v, approved: !!v.approved, approved_by: v.approved ? S.email : null })); clearDraft(f); reload(); }, "FAQ saved"); };
  $$("[data-ap]", el).forEach((b) => b.onclick = () => act(b, async () => { const v = b.dataset.v === "1"; await q(SB.from("ai_faqs").update({ approved: v, approved_by: v ? S.email : null }).eq("id", b.dataset.ap).select("id"), { expectRows: true }); reload(); }, "Saved"));
  $$("[data-del]", el).forEach((b) => b.onclick = () => confirm("Delete this FAQ?") && act(b, async () => { await q(SB.from("ai_faqs").delete().eq("id", b.dataset.del).select("id"), { expectRows: true }); reload(); }, "Deleted"));
}

async function searchTab(el, proj) {
  el.innerHTML = `<section class="card"><h2>Test what the AI would find</h2><form id="ks" class="inline"><input name="q" required placeholder="e.g. yuran penyelenggaraan, booking fee, LRT" aria-label="Search query"><label class="check"><input type="checkbox" name="drafts"> Include drafts</label><button class="btn pri">Search</button></form><div id="kres"></div></section>`;
  const f = $("#ks", el);
  f.onsubmit = (e) => { e.preventDefault(); const v = formData(f);
    act(f.querySelector("button"), async () => {
      const rows = (await q(SB.rpc("ai_search_knowledge", { q: v.q, p_project: proj || null, only_approved: !v.drafts, max_rows: 10 }))) || [];
      $("#kres", el).innerHTML = rows.length ? rows.map((r) => `<article class="entry"><div class="ho-h"><b>${esc(r.title || "")}</b> ${badge(r.kind)} <small>${esc(projectName(r.project_id) || "General")} · rank ${Number(r.rank).toFixed(3)}</small></div><pre class="content">${esc(r.content)}</pre></article>`).join("") : empty("Nothing found. The AI would answer that it needs to confirm this information.");
    }); };
}
