// AI Sales dashboard — Financing tools: LPPSA eligibility calculator, bank loan eligibility calculator and the
// LPPSA vs bank comparison. Internal advisor tools: every figure comes from the deterministic engines in
// ../shared/calc (exact decimals, versioned rules with sources); nothing here is sent to a buyer automatically.
import { SB, S, can, $, $$, esc, attr, q, act, toast, modal, opt, badge, empty, api } from "./core.js";
import { lppsaRuleset, bankRuleset, LPPSA_ALLOWANCES, BANKS, SOURCES, VERIFIED_ON } from "../shared/calc/rules.mjs";
import { calcLppsa } from "../shared/calc/lppsa.mjs";
import { calcBank, COMMITMENTS } from "../shared/calc/bank.mjs";
import { whatsappSummary, compareScenarios } from "../shared/calc/summary.mjs";
import { lppsaFromDocs, bankFromDocs } from "../shared/calc/autofill.mjs";
import { DOC_KINDS, DOC_MIME, DOC_MAX_BYTES } from "../shared/finance-docs.mjs";

const rm = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "—" : "RM" + Number(n).toLocaleString("en-MY", { minimumFractionDigits: d, maximumFractionDigits: d }));
const rm0 = (n) => rm(n, 0);
// status colours: never green, so no result reads as an approval
const STATUS_KIND = { within: "info", exceeds: "warn", more_info: "", cannot_assess: "alert" };
const statusChip = (r) => `<span class="calc-status ${STATUS_KIND[r.status] || ""}" role="status">${esc(r.status_label || "")}</span>`;
const store = {
  get: (k) => { try { return JSON.parse(sessionStorage.getItem("sales:calc:" + k) || "null"); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem("sales:calc:" + k, JSON.stringify(v)); } catch { /* storage is optional */ } },
  del: (k) => { try { sessionStorage.removeItem("sales:calc:" + k); } catch { /* ignore */ } },
};
const tabs = (on) => `<nav class="seg calc-tabs" aria-label="Financing tools">${[["calc-lppsa", "LPPSA calculator"], ["calc-bank", "Bank loan calculator"], ["calc-compare", "LPPSA vs bank"]]
  .map(([k, l]) => `<a href="#/${k}" class="${on === k ? "on" : ""}">${l}</a>`).join("")}</nav>`;
const n = (name, label, { hint = "", step = "any", min = 0, max = "", ph = "" } = {}) =>
  `<label>${label}${hint ? ` <small class="note">${hint}</small>` : ""}<input name="${name}" type="number" inputmode="decimal" step="${step}" min="${min}"${max !== "" ? ` max="${max}"` : ""} placeholder="${attr(ph)}"></label>`;
const sel = (name, label, options, hint = "") => `<label>${label}${hint ? ` <small class="note">${hint}</small>` : ""}<select name="${name}">${options.map(([v, l]) => opt(v, l, options[0][0])).join("")}</select></label>`;

/* ---------- form state: nested names ("allowances.itka", "commitments.car.amount") ---------- */
function readForm(f) {
  const out = {};
  for (const el of f.elements) {
    if (!el.name) continue;
    let v;
    if (el.type === "checkbox") v = el.checked;
    else if (el.value === "") continue;
    else v = el.type === "number" ? Number(el.value) : el.value;
    const path = el.name.split(".");
    let o = out;
    path.slice(0, -1).forEach((p) => { o = o[p] = o[p] || {}; });
    o[path.at(-1)] = v;
  }
  return out;
}
function fillForm(f, data) {
  if (!data) return;
  for (const el of f.elements) {
    if (!el.name) continue;
    const v = el.name.split(".").reduce((o, p) => (o == null ? undefined : o[p]), data);
    if (el.type === "checkbox") { if (v !== undefined) el.checked = !!v; } else if (v !== undefined && v !== null) el.value = v;
  }
}
// negative or impossible numbers are flagged where they are typed
function validate(f) {
  let ok = true;
  for (const el of f.querySelectorAll("input[type=number]")) {
    const bad = el.value !== "" && (!el.checkValidity() || Number(el.value) < 0);
    el.setAttribute("aria-invalid", bad ? "true" : "false");
    if (bad) ok = false;
  }
  return ok;
}

/* ---------- shared page frame ---------- */
function frame(el, { key, title, sub, formHtml }) {
  el.innerHTML = `<div class="page-head"><div><h1>${esc(title)}</h1><p class="sub">${sub}</p></div></div>${tabs(key)}
  ${can("advisor") && S.settings?.flags?.financing_documents !== false ? `<section class="card calc-docs" id="cdocs" aria-live="polite"></section>` : ""}
  <div class="calc">
    <form class="calc-in card" id="cf" novalidate autocomplete="off">${formHtml}</form>
    <a class="calc-mini" id="cmini" href="#cres-anchor" aria-label="Go to the result"></a>
    <aside class="calc-out" aria-live="polite" id="cres-anchor"><div class="card" id="cres"></div>
      <div class="calc-actions">
        <button type="button" class="btn" id="c-copy">Copy for WhatsApp</button>
        <button type="button" class="btn" id="c-print">Print / save PDF</button>
        ${can("advisor") ? `<button type="button" class="btn pri" id="c-save">Save to client</button>` : ""}
        <a class="btn" href="#/calc-compare">Compare LPPSA vs bank</a>
        <button type="button" class="btn ghost" id="c-reset">Clear all</button>
      </div></aside>
  </div>`;
}

function bindFrame(el, { key, run, saveRoute, autofill }) {
  const f = $("#cf", el), out = $("#cres", el);
  let last = null;
  const recalc = () => {
    const okInputs = validate(f);
    const input = readForm(f);
    store.set(key, input);
    try { last = run(input); } catch (e) { out.innerHTML = `<p class="err">Could not calculate: ${esc(e.message)}</p>`; last = null; return; }
    store.set(key + ":result", last);
    const mini = $("#cmini", el), key1 = last.approved_estimate?.instalment ?? last.requested?.instalment, key2 = last.eligibility?.max_financing;
    mini.innerHTML = `${statusChip(last)} <span>${key1 !== undefined ? rm(key1) + "/month" : key2 !== undefined ? "max " + rm0(key2) : "Result"}</span> <b>↓</b>`;
    out.innerHTML = (okInputs ? "" : `<p class="err" role="alert">Some figures are negative or not valid; they are left out until corrected.</p>`) + render(last);
    $$("[data-show]", f).forEach((x) => { x.hidden = !x.dataset.show.split("|").some((c) => { const [k, v] = c.split("="); return String(input[k] ?? "") === v; }); });
  };
  fillForm(f, store.get(key));
  f.addEventListener("input", recalc);
  f.addEventListener("change", recalc);
  recalc();
  const docsBox = $("#cdocs", el);
  if (docsBox && autofill) bindDocs(docsBox, f, autofill, recalc);
  $("#c-reset", el).onclick = () => { if (!confirm("Clear all figures on this calculator?")) return; f.reset(); store.del(key); store.del(key + ":result"); recalc(); };
  $("#c-print", el).onclick = printPage;
  $("#c-copy", el).onclick = async () => {
    if (!last) return;
    const text = whatsappSummary(last, "ms");
    try { await navigator.clipboard.writeText(text); toast("Summary copied: paste it into WhatsApp"); }
    catch { modal("Copy for WhatsApp", `<textarea rows="14" readonly>${esc(text)}</textarea><p class="note">Select the text and copy it.</p>`); }
  };
  const save = $("#c-save", el);
  if (save) save.onclick = () => last && saveToClient(last, saveRoute);
  // render is per calculator
  function render(r) { return key === "lppsa" ? lppsaResult(r) : bankResult(r); }
}

/* ---------- auto-fill from documents: read once, used by both calculators ---------- */
// The file is read by the AI and returned; neither the file nor the figures are stored on the server. What was read is
// kept in this browser tab only (like the calculator figures) so the other calculator can use it too.
const docsStore = { get: () => store.get("docs") || [], set: (v) => store.set("docs", v) };
async function prepareFile(file) {
  if (!file.type.startsWith("image/")) return { blob: file, mime: file.type, name: file.name };
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) return { blob: file, mime: file.type, name: file.name };
  const s = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement("canvas");
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
  return blob ? { blob, mime: "image/jpeg", name: file.name } : { blob: file, mime: file.type, name: file.name };
}
const toBase64 = (blob) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
const KIND_READ = { payslip: "Payslip", ccris: "CCRIS report", bank_statement: "Bank statement", other: "Not a financing document" };

function bindDocs(box, form, autofill, recalc) {
  let lastChecks = [];
  const apply = () => {
    const docs = docsStore.get().map((d) => d.extraction);
    const { values, sources, checks } = autofill(docs);
    $$(".autofilled", form).forEach((x) => { x.classList.remove("autofilled"); x.removeAttribute("title"); });
    for (const [name, v] of Object.entries(values)) {
      const inp = form.elements[name];
      if (!inp) continue;
      inp.value = v; inp.classList.add("autofilled"); inp.title = "From " + sources[name];
    }
    lastChecks = checks;
    recalc();
    render();
    return Object.keys(values).length;
  };
  const render = () => {
    const docs = docsStore.get();
    box.innerHTML = `<div class="calc-docs-head"><div><h2>Auto-fill from documents</h2><p class="note">Upload the buyer's <b>payslip</b>, <b>CCRIS report</b> or <b>bank statement</b>. The AI reads the figures, fills this calculator and it recalculates. Figures filled in are <span class="autofilled-key">highlighted</span>: check each against the document. Files are read and not stored; only upload documents the buyer agreed to share.</p></div></div>
      <form id="cdf" class="calc-docs-form"><label>Document<select name="kind">${Object.entries(DOC_KINDS).map(([k, v]) => opt(k, v.en, "payslip")).join("")}</select></label>
        <label>File (PDF or photo, up to 4 MB)<input type="file" name="file" accept="${attr(DOC_MIME.join(","))}" required></label>
        <button class="btn pri">Read and fill</button></form>
      ${docs.length ? `<ul class="list calc-docs-list">${docs.map((d, i) => `<li><b>${esc(KIND_READ[d.extraction.document_kind] || d.extraction.document_kind)}</b>${d.extraction.period ? ` · ${esc(d.extraction.period)}` : ""} · ${esc(d.extraction.confidence)} confidence <small>${esc(d.file)}</small>
          ${!d.extraction.readable ? `<small class="err">Could not be read: nothing taken from it.</small>` : ""}${(d.extraction.warnings || []).map((w) => `<small>⚠ ${esc(w)}</small>`).join("")}
          <button type="button" class="link" data-rmdoc="${i}">Remove</button></li>`).join("")}</ul>
        ${lastChecks.length ? `<div class="calc-warn">${lastChecks.map((c) => `<p>⚠ ${esc(c)}</p>`).join("")}</div>` : ""}
        <div class="calc-actions"><button type="button" class="btn" id="cdfill">Fill this calculator from ${docs.length} document${docs.length === 1 ? "" : "s"}</button><button type="button" class="btn ghost" id="cdforget">Forget documents</button></div>` : ""}`;
    const df = $("#cdf", box);
    df.onsubmit = (e) => {
      e.preventDefault();
      const file = df.file.files[0];
      if (!file) return toast("Choose a file first.", "err");
      if (!DOC_MIME.includes(file.type)) return toast("Only PDF, JPG, PNG or WEBP files.", "err");
      act(df.querySelector("button"), async () => {
        const p = await prepareFile(file);
        if (p.blob.size > DOC_MAX_BYTES) throw new Error("The file is larger than 4 MB. Upload a smaller scan or one page at a time.");
        const { extraction } = await api("/api/sales/financing/documents", { method: "POST", body: JSON.stringify({ action: "extract", kind: df.kind.value, mime: p.mime, data: await toBase64(p.blob) }) });
        docsStore.set([...docsStore.get(), { file: file.name.slice(0, 80), kind: df.kind.value, extraction, at: new Date().toISOString() }]);
        const n = apply();
        toast(extraction.readable ? `${n} field${n === 1 ? "" : "s"} filled: check the highlighted figures` : "The AI could not read this as a financing document.", extraction.readable ? "ok" : "err");
      });
    };
    $$("[data-rmdoc]", box).forEach((b) => b.onclick = () => { const d = docsStore.get(); d.splice(Number(b.dataset.rmdoc), 1); docsStore.set(d); apply(); });
    const fill = $("#cdfill", box);
    if (fill) fill.onclick = () => { const n = apply(); toast(`${n} field${n === 1 ? "" : "s"} filled: check the highlighted figures`); };
    const forget = $("#cdforget", box);
    if (forget) forget.onclick = () => { docsStore.set([]); lastChecks = []; $$(".autofilled", form).forEach((x) => { x.classList.remove("autofilled"); x.removeAttribute("title"); }); render(); };
  };
  // a highlighted figure the advisor changes is theirs now
  form.addEventListener("input", (e) => { if (e.target.classList?.contains("autofilled")) { e.target.classList.remove("autofilled"); e.target.removeAttribute("title"); } });
  render();
}

// the printed summary includes the rules and sources
function printPage() { $$(".calc-src").forEach((d) => { d.open = true; }); window.print(); }

/* ---------- save to a client (lead): ai_financing_assessments + an activity note ---------- */
const OUTCOME = { within: "potentially_affordable", exceeds: "potentially_challenging", more_info: "insufficient_information", cannot_assess: "insufficient_information" };
function saveToClient(r, route) {
  const dlg = modal("Save to client", `<form id="sv" class="form"><label>Find the client (name, phone or OSC code)<input name="q" required autocomplete="off" placeholder="e.g. Aina or OSC-000123"></label>
    <div id="svlist"></div><p class="note">The calculation (inputs, rules version, rate, tenure, result and warnings) is added to the client's financing history.</p></form>`);
  const f = $("#sv", dlg), list = $("#svlist", dlg);
  let t;
  f.q.oninput = () => { clearTimeout(t); t = setTimeout(search, 250); };
  f.onsubmit = (e) => { e.preventDefault(); search(); };
  async function search() {
    const s = f.q.value.trim().replace(/[%,()]/g, "");
    if (s.length < 2) { list.innerHTML = ""; return; }
    const [byLead, byContact] = await Promise.all([
      q(SB.from("ai_leads").select("id,lead_code,contact_id,contact:ai_contacts(full_name,phone_e164)").ilike("lead_code", `%${s}%`).limit(8)),
      q(SB.from("ai_contacts").select("id,full_name,phone_e164,leads:ai_leads(id,lead_code,closed_at)").or(`full_name.ilike.%${s}%,phone_e164.ilike.%${s.replace(/\D/g, "") || s}%`).limit(8)),
    ]);
    const rows = [...(byLead || []).map((l) => ({ id: l.id, code: l.lead_code, name: l.contact?.full_name, phone: l.contact?.phone_e164, contact: l.contact_id })),
      ...(byContact || []).flatMap((c) => (c.leads || []).map((l) => ({ id: l.id, code: l.lead_code, name: c.full_name, phone: c.phone_e164, contact: c.id })))]
      .filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
    list.innerHTML = rows.length ? `<ul class="list">${rows.map((x) => `<li><button type="button" class="link" data-lead="${attr(x.id)}" data-contact="${attr(x.contact)}">${esc(x.name || "—")} · ${esc(x.code)}</button> <small>${esc(x.phone || "")}</small></li>`).join("")}</ul>` : empty("No client found.");
    $$("[data-lead]", list).forEach((b) => b.onclick = () => act(b, async () => {
      const result = { ...r, max_financing: r.eligibility?.max_financing ?? null };
      await q(SB.from("ai_financing_assessments").insert({ lead_id: b.dataset.lead, route: r.calculator, inputs: r.audit.inputs, result, outcome: OUTCOME[r.status],
        rules_version: r.ruleset, engine_version: r.version, source: "advisor", created_by: S.email }).select("id"));
      await SB.from("ai_activities").insert({ lead_id: b.dataset.lead, contact_id: b.dataset.contact || null, kind: "note", body: `${r.calculator === "lppsa" ? "LPPSA" : "Bank"} calculator (${route}):\n` + whatsappSummary(r, "en") });
      dlg.done();
    }, "Saved to the client's financing history"));
  }
}

/* ---------- LPPSA ---------- */
export async function lppsaCalc(el) {
  const rules = lppsaRuleset(S.settings?.financing);
  frame(el, { key: "calc-lppsa", title: "LPPSA eligibility calculator", sub: "Follows the LPPSA rules as far as they could be verified. An estimate for the consultation, never an approval: confirm with LPPSA Smart Kira.",
    formHtml: `
    <h2>A. Applicant</h2><div class="form two">
      ${sel("employment", "Employment", [["permanent_confirmed", "Permanent, confirmed in service"], ["permanent_probation", "Permanent, on probation"], ["contract", "Contract"], ["other", "Other"]])}
      ${sel("retirement_scheme", "Retirement scheme", [["pension", "Pension (pencen)"], ["kwsp", "KWSP"]])}
      ${n("age", "Age", { step: 1, max: 89 })}
      <div data-show="retirement_scheme=kwsp" hidden>${n("retirement_age", "Retirement age", { step: 1, max: 70, ph: "60" })}</div>
      ${sel("financing_no", "LPPSA financing", [["first", "First financing"], ["second", "Second financing (existing LPPSA financing)"]])}
      <div data-show="financing_no=second" hidden>${n("existing_lppsa_instalment", "Existing LPPSA instalment / month (RM)")}</div>
      ${sel("scheme", "Financing scheme", [["normal", "Normal (up to 35 years)"], ["sppm", "SPPM — aged 30 and below (up to 40 years)"]])}
      ${sel("application_type", "Application type", [["purchase_completed", "Buy a completed house"], ["purchase_under_construction", "Buy a house under construction"], ["build_own_land", "Build on own land"], ["land_and_build", "Buy land and build"], ["renovation", "Renovate / extend"], ["refinance", "Settle another loan (refinance)"]], "recorded; same tests")}
      ${sel("property_type", "Property type", [["landed", "Landed house"], ["strata", "Apartment / condominium (strata)"], ["land", "Land"]], "recorded; same tests")}
    </div>
    <h2>B. Income and deductions (monthly, RM)</h2><div class="form two">
      ${n("basic_salary", "Basic salary")}
      <h3>Eligible fixed allowances <small class="note">only these count (LPPSA FAQ); leave others out</small></h3>
      ${LPPSA_ALLOWANCES.map(([k, l]) => n("allowances." + k, l)).join("")}
      <h3>Mandatory deductions</h3>
      ${n("mandatory.tax", "Income tax (PCB)")}${n("mandatory.kwsp", "KWSP")}${n("mandatory.perkeso", "PERKESO / SOCSO")}${n("mandatory.eis", "EIS / SIP")}${n("mandatory.other", "Other statutory deductions")}
      <h3>Other deductions</h3>
      ${n("financing_deductions", "Financing deductions", { hint: "personal, koperasi, ANGKASA, car (not this LPPSA)" })}
      ${n("other_deductions", "Other deductions", { hint: "zakat, insurance, savings, union" })}
    </div>
    <h2>C. Financing</h2><div class="form two">
      ${n("property_price", "Property purchase price")}
      ${n("valuation", "JPPH / bank valuation", { hint: "optional" })}
      ${n("requested_amount", "Financing amount requested for the property", { hint: "optional" })}
      ${n("tenure_years", "Tenure wanted (years)", { step: 1, max: 40, hint: "optional — maximum used when empty" })}
      ${n("mrtt_premium", "MRTT / MRTA premium financed", { hint: "optional — from the insurer or Smart Kira" })}
      ${sel("finance_legal_fees", "Legal fee of the financing agreement", [["", "Financed by LPPSA (SRO scale + SST)"], ["no", "Paid in cash"]])}
      ${n("legal_fee", "Legal fee, if quoted", { hint: "optional — replaces the SRO estimate" })}
      ${n("other_costs", "Other financed costs (e.g. LTHO)", { hint: "optional" })}
    </div>` });
  bindFrame(el, { key: "lppsa", saveRoute: "LPPSA", autofill: lppsaFromDocs, run: (input) => {
    const m = input.mandatory || {};
    const parts = ["tax", "kwsp", "perkeso", "eis", "other"].map((k) => m[k]).filter((v) => v !== undefined);
    const engine = { ...input, mandatory_deductions: parts.length ? parts.reduce((s, v) => s + (Number(v) || 0), 0) : null };
    delete engine.mandatory;
    return calcLppsa(engine, rules);
  } });
}

function lppsaResult(r) {
  const e = r.eligibility, a = r.approved_estimate, q = r.requested;
  const tiles = [
    ["Estimated maximum financing eligibility", e ? rm0(e.max_financing) : "—", e ? `at ${e.rate_pct}% · ${r.tenure_years} years` : ""],
    ["Maximum eligible monthly instalment", r.max_instalment !== undefined ? rm(r.max_instalment) : "—", r.binding_test ? `limited by: ${esc((r.limits || []).find((l) => l.key === r.binding_test)?.label || "")}` : ""],
    ["Maximum property price (no financed costs)", e ? rm0(e.max_property_price_no_costs) : "—", e && e.max_property_price_with_costs !== e.max_property_price_no_costs ? `with the costs entered: ${rm0(e.max_property_price_with_costs)}` : ""],
    ["Estimated monthly instalment", a ? rm(a.instalment) : "—", a ? `${a.rate_pct}% · ${r.tenure_years} years` : ""],
  ];
  return `<div class="calc-head"><h2>Result</h2>${statusChip(r)}</div>
    <div class="calc-tiles">${tiles.map(([l, v, s]) => `<div class="calc-tile"><span>${esc(l)}</span><b>${v}</b>${s ? `<small>${s}</small>` : ""}</div>`).join("")}</div>
    ${r.reasons.length ? `<ul class="calc-reasons">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${r.missing.length ? `<p class="note">Still needed: ${r.missing.map((k) => esc(k.replace(/_/g, " "))).join(", ")}.</p>` : ""}
    ${r.income ? `<h3>Income</h3><dl class="kv"><dt>Gross (basic + eligible allowances)</dt><dd>${rm(r.income.gross)}</dd><dt>Mandatory deductions</dt><dd>${rm(r.income.mandatory_deductions)}</dd>
      <dt>Net income</dt><dd>${rm(r.income.net)}</dd><dt>Financing deductions</dt><dd>${rm(r.income.financing_deductions)}</dd><dt>Other deductions</dt><dd>${rm(r.income.other_deductions)}</dd>
      ${r.remaining_income !== undefined ? `<dt>Remaining monthly income</dt><dd>${rm(r.remaining_income)}</dd>` : ""}</dl>` : ""}
    ${q ? `<h3>Financing for this property</h3><table class="mini"><thead><tr><th></th><th>Requested</th><th>Estimated approvable</th></tr></thead><tbody>
      <tr><td>Property price${q.valuation ? ` (valuation ${rm0(q.valuation)})` : ""}</td><td colspan="2">${rm0(q.property_price)}</td></tr>
      <tr><td>Property part</td><td>${rm(q.property_part)}</td><td>${rm(a.property_part)}</td></tr>
      <tr><td>MRTT / MRTA premium</td><td>${rm(q.mrtt)}</td><td>${rm(a.mrtt)}</td></tr>
      <tr><td>Legal fee${q.legal_financed ? " (financed)" : " — paid in cash"}</td><td>${rm(q.legal_fee)}</td><td>${rm(a.legal_fee)}</td></tr>
      ${q.other_costs ? `<tr><td>Other costs</td><td>${rm(q.other_costs)}</td><td>${rm(a.other_costs)}</td></tr>` : ""}
      <tr><td><b>Total financing</b></td><td><b>${rm(q.total)}</b></td><td><b>${rm(a.total)}</b></td></tr>
      <tr><td>Monthly instalment</td><td>${rm(q.instalment)}</td><td>${rm(a.instalment)}</td></tr>
      <tr><td>Paid by the buyer for the property</td><td colspan="2">${rm(a.buyer_pays_for_property)}</td></tr>
      <tr><td>Total profit over ${r.tenure_years} years</td><td colspan="2">${rm(a.total_profit)}</td></tr>
    </tbody></table><p class="note">Approvable = the lowest of the property price, the valuation, the amount requested, the applicant's eligibility and the LPPSA maximum.</p>` : ""}
    ${r.tests ? `<h3>The three LPPSA tests</h3><table class="mini"><thead><tr><th>Test</th><th>Max instalment</th><th>Result</th></tr></thead><tbody>${r.tests.map((t) => `<tr><td>${esc(t.label)}</td><td>${rm(t.max_instalment)}</td><td>${t.pass ? badge("Passes", "") : badge("Fails", "alert")}</td></tr>`).join("")}</tbody></table>`
      : r.limits ? `<h3>The three LPPSA tests</h3><table class="mini"><tbody>${r.limits.map((t) => `<tr><td>${esc(t.label)}</td><td>${rm(t.max_instalment)}</td></tr>`).join("")}</tbody></table>` : ""}
    ${r.warnings.length ? `<div class="calc-warn">${r.warnings.map((w) => `<p>⚠ ${esc(w)}</p>`).join("")}</div>` : ""}
    ${assumptions(r, lppsaRuleset(S.settings?.financing))}`;
}

/* ---------- bank ---------- */
export async function bankCalc(el) {
  const rules = bankRuleset(S.settings?.financing);
  frame(el, { key: "calc-bank", title: "Bank loan eligibility calculator", sub: "An indicative scenario with the assumptions you choose. Banks assess differently and do not publish their DSR rules: confirm with the bank.",
    formHtml: `
    <h2>A. Bank and applicant</h2><div class="form two">
      <label>Bank<select name="bank">${BANKS.map((b) => opt(b.key, b.name, "")).join("")}</select></label><p class="note" id="banklink"></p>
      ${n("age", "Age", { step: 1, max: 75 })}
      ${sel("employment_type", "Employment", [["private", "Private-sector employee"], ["government", "Government servant"], ["self_employed", "Self-employed"], ["business_owner", "Business owner"], ["other", "Other"]])}
      ${n("employment_months", "Months in current job", { step: 1 })}
    </div>
    <h2>B. Income (monthly, RM)</h2><div class="form two">
      ${n("basic_salary", "Basic salary")}${n("fixed_allowances", "Fixed allowances")}
      ${n("variable_income", "Variable income (overtime, commission)", { hint: "average" })}${n("variable_income_pct", "Variable income counted (%)", { max: 100, ph: String(rules.variable_income_pct) })}
      ${n("business_income", "Business / self-employed income", { hint: "average" })}${n("business_income_pct", "Business income counted (%)", { max: 100, ph: String(rules.self_employed_income_pct) })}
      ${n("statutory_deductions", "Statutory deductions", { hint: "tax, EPF, SOCSO, EIS" })}
    </div>
    <h2>C. Monthly commitments</h2><p class="note">Tick the ones the selected bank counts in its DSR.</p><div class="calc-commit">
      ${COMMITMENTS.map(([k, l]) => `<label>${l}<span class="calc-commit-row"><input name="commitments.${k}.amount" type="number" min="0" step="any" inputmode="decimal"><span class="check"><input type="checkbox" name="commitments.${k}.counted" checked> counted</span></span></label>`).join("")}
      ${n("credit_card_balance", "Or: total credit card balance", { hint: `counted at ${rules.credit_card_pct}% a month` })}
    </div>
    <h2>D. Property and financing</h2><div class="form two">
      ${n("property_price", "Property purchase price")}
      ${sel("housing_loans", "Housing loans including this one", [["1", "1 (first)"], ["2", "2"], ["3", "3 or more"]])}
      <label>Financing margin<select name="margin_pct">${rules.margin_options.map((m) => opt(m, m + "%", 90)).join("")}</select></label>
      ${n("tenure_years", "Tenure (years)", { step: 1, max: rules.max_tenure_years, hint: "maximum used when empty" })}
      ${n("rate_pct", "Interest / profit rate (% a year)", { max: 30, ph: String(rules.default_rate_pct), hint: "the bank's quoted rate" })}
      <label>DSR assumption<select name="dsr_pct">${rules.dsr_options.map((d) => opt(d.dsr_pct, `${d.label} — ${d.dsr_pct}%`, rules.default_dsr_pct)).join("")}</select></label>
      ${n("mrta_premium", "MRTA / MLTA premium financed", { hint: "optional" })}
      ${n("other_fees", "Other capitalised fees", { hint: "optional, e.g. legal fees financed" })}
    </div>` });
  const showBank = () => { const b = BANKS.find((x) => x.key === $("#cf [name=bank]", el).value); $("#banklink", el).innerHTML = b?.calculator ? `Official calculator: <a href="${attr(b.calculator)}" target="_blank" rel="noopener">${esc(b.name)}</a>` : b?.key ? "No official calculator page verified for this bank yet." : ""; };
  bindFrame(el, { key: "bank", saveRoute: "bank", autofill: bankFromDocs, run: (input) => {
    const r = calcBank({ ...input, housing_loans: Number(input.housing_loans || 1) }, rules);
    return r;
  } });
  $("#cf [name=bank]", el).addEventListener("change", showBank);
  showBank();
}

function bankResult(r) {
  const e = r.eligibility, q = r.requested;
  const tiles = [
    ["Indicative maximum financing", e ? rm0(e.max_financing) : "—", e ? `DSR ${r.dsr_pct}% · ${r.rate_pct}% · ${r.tenure_years} years` : ""],
    ["Maximum instalment at this DSR", e ? rm(e.max_instalment) : "—", r.income ? `current DSR ${r.income.current_dsr_pct}%` : ""],
    ["Estimated monthly instalment", q ? rm(q.instalment) : "—", q ? `DSR after ${q.dsr_after_pct}%` : ""],
    ["Down payment", q ? rm(q.down_payment) : "—", q ? `${q.margin_pct}% financing` : ""],
  ];
  return `<div class="calc-head"><h2>Result</h2>${statusChip(r)}</div><p class="note"><b>${esc(r.label)}</b></p>
    <div class="calc-tiles">${tiles.map(([l, v, s]) => `<div class="calc-tile"><span>${esc(l)}</span><b>${v}</b>${s ? `<small>${esc(s)}</small>` : ""}</div>`).join("")}</div>
    ${r.reasons.length ? `<ul class="calc-reasons">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${r.missing.length ? `<p class="note">Still needed: ${r.missing.map((k) => esc(k.replace(/_/g, " "))).join(", ")}.</p>` : ""}
    ${r.income ? `<h3>Income and commitments</h3><dl class="kv"><dt>Recognised gross income</dt><dd>${rm(r.income.recognised_gross)}</dd><dt>Statutory deductions</dt><dd>${rm(r.income.statutory_deductions)}</dd>
      <dt>Net income</dt><dd>${rm(r.income.net)}</dd><dt>Commitments counted</dt><dd>${rm(r.income.commitments_counted)}</dd><dt>Commitments declared</dt><dd>${rm(r.income.commitments_declared)}</dd>
      ${q ? `<dt>Remaining monthly income</dt><dd>${rm(q.remaining_income)}</dd>` : ""}</dl>` : ""}
    ${q ? `<h3>Financing</h3><table class="mini"><tbody>
      <tr><td>Property price</td><td>${rm0(q.property_price)}</td></tr><tr><td>Property loan (${q.margin_pct}%)</td><td>${rm(q.property_loan)}</td></tr>
      <tr><td>MRTA / MLTA premium</td><td>${rm(q.mrta_premium)}</td></tr><tr><td>Other capitalised fees</td><td>${rm(q.other_fees)}</td></tr>
      <tr><td><b>Total financing</b></td><td><b>${rm(q.financing)}</b></td></tr><tr><td>Monthly instalment</td><td>${rm(q.instalment)}</td></tr>
      <tr><td>Total interest over ${r.tenure_years} years</td><td>${rm(q.total_interest)}</td></tr></tbody></table>` : ""}
    ${r.warnings.length ? `<div class="calc-warn">${r.warnings.map((w) => `<p>⚠ ${esc(w)}</p>`).join("")}</div>` : ""}
    ${assumptions(r, bankRuleset(S.settings?.financing))}`;
}

function assumptions(r, rules) {
  return `<details class="calc-src"><summary>Rules, sources and audit</summary>
    <p class="note">Rules ${esc(r.ruleset)} · engine ${esc(r.version)} · calculated ${esc(new Date(r.calculated_at).toLocaleString("en-MY"))}${r.calculator === "lppsa" && !r.rules_owner_verified ? " · LPPSA rules not yet marked verified in Settings → Financing rules" : ""}.</p>
    <ul class="checks">${rules.sources.map((k) => SOURCES[k]).map((s) => `<li><b>${esc(s.status)}</b> — ${esc(s.rule)}${s.url ? ` <a href="${attr(s.url)}" target="_blank" rel="noopener">${esc(s.org)}</a>` : ""}${s.effective ? ` (effective ${esc(s.effective)})` : ""}</li>`).join("")}</ul>
    <p class="note">Sources reviewed ${esc(VERIFIED_ON)}. The LPPSA website and Smart Kira could not be opened from the development environment, so results were not compared with Smart Kira: confirm important cases there.</p>
    <p class="note">Preliminary estimate only, not a financing approval or offer. The final decision is made by LPPSA or the bank.</p></details>`;
}

/* ---------- comparison ---------- */
export async function compareCalc(el) {
  const l = store.get("lppsa:result"), b = store.get("bank:result");
  const c = compareScenarios(l, b);
  const fmt = (v, label) => (v === null || v === undefined ? "—" : typeof v === "number" ? (/Rate|Tenure/.test(label) ? String(v) : rm(v)) : esc(v));
  el.innerHTML = `<div class="page-head"><div><h1>LPPSA vs bank</h1><p class="sub">The last scenario from each calculator in this browser tab, side by side.</p></div></div>${tabs("calc-compare")}
  ${!l && !b ? empty("Fill in the LPPSA and bank calculators first; their latest results appear here.") : `<div class="card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th></th><th>LPPSA</th><th>Bank (indicative)</th></tr></thead><tbody>
    ${c.rows.map((x) => `<tr><td>${esc(x.label)}</td><td>${fmt(x.lppsa, x.label)}</td><td>${fmt(x.bank, x.label)}</td></tr>`).join("")}</tbody></table></div>
    ${!l ? `<p class="note">No LPPSA scenario yet: <a href="#/calc-lppsa">open the LPPSA calculator</a>.</p>` : ""}${!b ? `<p class="note">No bank scenario yet: <a href="#/calc-bank">open the bank calculator</a>.</p>` : ""}
    <h3>Main differences to explain</h3><ul class="checks">${c.differences.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
    <p class="note">${esc(c.note)} Preliminary estimates only, not approvals.</p>
    <div class="calc-actions"><button type="button" class="btn" id="c-print">Print / save PDF</button></div></div>`}`;
  const p = $("#c-print", el);
  if (p) p.onclick = printPage;
}
