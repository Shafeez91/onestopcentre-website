// AI Sales dashboard — loan eligibility & affordability: the lead page card (advisor+) and the owner's
// "Financing rules" settings. All figures come from the shared engine (../shared/finance.mjs), the same code the
// WhatsApp AI uses. Results are preliminary estimates, never approvals.
import { SB, S, can, $, $$, esc, attr, fmtDate, q, act, toast, guardForm, clearDraft, formData, badge, opt, empty, money, api } from "./core.js";
import { assess, financingRules, DEFAULT_FINANCING, OUTCOMES, DISCLAIMER, advisorSummary } from "../shared/finance.mjs";
import { DOC_KINDS, DOC_MIME, DOC_MAX_BYTES, suggestInputs } from "../shared/finance-docs.mjs";

const OUTCOME_KIND = { potentially_affordable: "ok", may_be_affordable_with_adjustments: "warn", potentially_challenging: "alert", insufficient_information: "" };
const ESCALATE = {
  not_confirmed_in_service: "not yet confirmed in service", short_service: "short service", second_lppsa_financing: "second LPPSA financing",
  joint_application: "joint application", self_employed_income: "self-employed income", challenging_outcome: "challenging result", no_tenure: "no tenure left",
};
const FIELD_LABEL = {
  route: "Route", age: "Age", basic_salary: "Basic salary", fixed_allowances: "Fixed allowances", self_employed_income: "Business income",
  mandatory_deductions: "Statutory deductions", commitments_monthly: "Monthly commitments", credit_card_balance: "Credit card balance",
  confirmed_service: "Confirmed in service", property_price: "Property price",
};
export const outcomeBadge = (o) => badge((OUTCOMES[o] || {}).en || "No check yet", OUTCOME_KIND[o] || "");
const rules = () => financingRules(S.settings?.financing);
const docsOn = () => S.settings?.flags?.financing_documents !== false;

// null hides the card: viewers never see income figures, and the lead page keeps working if the tables are missing
export async function loadFinancing(leadId) {
  if (!can("advisor")) return null;
  try {
    const [profile, history, docs] = await Promise.all([
      q(SB.from("ai_financing_profiles").select("*").eq("lead_id", leadId).maybeSingle()),
      q(SB.from("ai_financing_assessments").select("id,route,outcome,result,source,created_by,created_at,rules_version").eq("lead_id", leadId).order("created_at", { ascending: false }).limit(10)),
      // null when the documents table is not there yet (migration 19) or the feature is switched off
      docsOn() ? q(SB.from("ai_financing_documents").select("*").eq("lead_id", leadId).order("created_at", { ascending: false })).catch(() => null) : null,
    ]);
    return { profile, history: history || [], docs };
  } catch (e) { console.warn("financing check unavailable:", e?.message || e); return null; }
}

/** The result of one calculation, as a readable block. */
export function resultHtml(r) {
  if (!r) return "";
  const head = `<p>${outcomeBadge(r.outcome)} ${r.route ? `<b>${r.route === "lppsa" ? "LPPSA" : "Bank loan (illustrative)"}</b>` : ""}</p>`;
  if (r.max_financing === undefined) {
    return `${head}<p class="note">Still needed: ${(r.missing || []).map((k) => esc(FIELD_LABEL[k] || k.replace(/_/g, " "))).join(", ") || "—"}.</p>`;
  }
  const kv = [
    ["Estimated max financing", money(r.max_financing)],
    ["Max monthly instalment", money(r.max_instalment ?? r.scenarios?.[0]?.max_instalment)],
    ["Tenure", r.tenure_years + " years"],
    r.financing_needed ? ["Financing needed", money(r.financing_needed)] : null,
    r.instalment_for_needed ? ["Instalment for that amount", money(r.instalment_for_needed) + (r.dsr_pct_for_needed ? ` (DSR ${r.dsr_pct_for_needed}%)` : "")] : null,
    r.buyer_top_up ? ["Above the LPPSA limit (buyer pays)", money(r.buyer_top_up)] : null,
    r.extra_down_payment ? ["Extra down payment (margin)", money(r.extra_down_payment)] : null,
    r.shortfall ? ["Shortfall vs income", money(r.shortfall)] : null,
  ].filter(Boolean);
  const tests = r.tests ? `<table class="mini"><thead><tr><th>LPPSA test</th><th>Max instalment</th><th>Result</th></tr></thead><tbody>${r.tests.map((t) => `<tr><td>${esc(t.en)}</td><td>${money(t.max_instalment)}</td><td>${t.pass === null ? "—" : t.pass ? badge("Pass", "ok") : badge("Fail", "alert")}</td></tr>`).join("")}</tbody></table>` : "";
  const scen = r.scenarios ? `<table class="mini"><thead><tr><th>Scenario</th><th>DSR</th><th>Max loan</th><th>Fits?</th></tr></thead><tbody>${r.scenarios.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.dsr_pct}% @ ${s.rate_pct}%</td><td>${money(s.max_loan)}</td><td>${s.pass === null ? "—" : s.pass ? badge("Yes", "ok") : badge("No", "alert")}</td></tr>`).join("")}</tbody></table>` : "";
  const up = r.upfront ? `<details><summary>Upfront costs estimate · ${money(r.upfront.total)}</summary><table class="mini"><tbody>${r.upfront.items.map((i) => `<tr><td>${esc(i.en)}</td><td>${money(i.amount)}</td></tr>`).join("")}</tbody></table>${r.upfront.notes.map((n) => `<p class="note">${esc(n)}</p>`).join("")}</details>` : "";
  return `${head}<dl class="kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>${tests}${scen}
    ${(r.notes || []).map((n) => `<p class="note">${esc(n)}</p>`).join("")}
    ${r.escalate?.length ? `<p class="note"><b>Advisor needed:</b> ${r.escalate.map((e) => esc(ESCALATE[e] || e)).join(", ")}</p>` : ""}
    ${r.missing?.length ? `<p class="note">Still needed for a full check: ${r.missing.map((k) => esc(FIELD_LABEL[k] || k.replace(/_/g, " "))).join(", ")}.</p>` : ""}
    ${up}
    <details><summary>Assumptions</summary><ul class="checks">${(r.assumptions || []).map((a) => `<li>${esc(a)}</li>`).join("")}</ul></details>
    <p class="note">${esc(DISCLAIMER.en)}</p>`;
}

const num = (name, label, v, extra = "") => `<label>${label}<input name="${name}" type="number" min="0" step="any" inputmode="decimal" value="${attr(v ?? "")}"${extra}></label>`;

/** Lead page card: latest result, history, and the calculator form. */
export function financingSection(data) {
  if (!data) return "";
  const p = data.profile, i = p?.inputs || {};
  return `<section class="card" id="fin"><h2>Financing check</h2>
    <p class="note">Preliminary LPPSA / bank estimate from figures the buyer chose to share. Never type IC, account or card numbers here; documents go in <b>Financing documents</b>.</p>
    <div id="fin-result">${p?.result ? resultHtml(p.result) + `<p class="note">Last updated ${esc(fmtDate(p.updated_at))} by ${esc(p.updated_by)}.</p>` : empty("No financing check yet. The AI fills this in when a buyer asks, or use the calculator below.")}</div>
    ${docsSection(data.docs)}
    <details id="fin-calc"><summary>Calculator — check or update figures</summary>
    <form id="ffin" class="form two">
      <label>Route<select name="route">${opt("", "Choose…", i.route)}${opt("lppsa", "LPPSA (government servant)", i.route)}${opt("bank", "Bank loan", i.route)}</select></label>
      ${num("age", "Age", i.age)}
      ${num("property_price", "Property price (RM)", i.property_price)}
      ${num("down_payment", "Planned down payment (RM)", i.down_payment)}
      ${num("basic_salary", "Basic salary / month (RM)", i.basic_salary)}
      ${num("fixed_allowances", "Fixed allowances / month (RM)", i.fixed_allowances)}
      ${num("mandatory_deductions", "Statutory deductions / month (tax, EPF, SOCSO)", i.mandatory_deductions)}
      ${num("commitments_monthly", "Existing loan instalments / month (RM)", i.commitments_monthly)}
      <h3 class="full">LPPSA only</h3>
      <label>Permanent &amp; confirmed in service?<select name="confirmed_service">${opt("", "Unknown", i.confirmed_service)}${opt("yes", "Yes", i.confirmed_service)}${opt("no", "No", i.confirmed_service)}</select></label>
      ${num("service_years", "Years in service", i.service_years)}
      <label>Second LPPSA financing?<select name="second_financing">${opt("", "No", i.second_financing ? "yes" : "")}${opt("yes", "Yes", i.second_financing ? "yes" : "")}</select></label>
      <h3 class="full">Bank only</h3>
      ${num("variable_income", "Variable income / month (overtime, commission)", i.variable_income)}
      ${num("self_employed_income", "Business income / month (self-employed)", i.self_employed_income)}
      ${num("credit_card_balance", "Credit card balance (total RM)", i.credit_card_balance)}
      ${num("property_count", "Housing loans incl. this one", i.property_count, ' step="1" max="20"')}
      ${num("requested_amount", "Loan amount wanted (RM, optional)", i.requested_amount)}
      ${num("valuation", "Valuation (RM, optional)", i.valuation)}
      <h3 class="full">Joint applicant (bank, optional)</h3>
      ${num("co_age", "Joint applicant age", i.co_age)}
      ${num("co_income", "Joint applicant fixed income / month", i.co_income)}
      ${num("co_mandatory_deductions", "Joint applicant deductions / month", i.co_mandatory_deductions)}
      ${num("co_commitments_monthly", "Joint applicant commitments / month", i.co_commitments_monthly)}
      <div class="full" id="fin-preview" aria-live="polite"></div>
      <div class="actions full"><button class="btn pri">Save to lead</button></div>
    </form></details>
    ${data.history.length ? `<details><summary>History (${data.history.length})</summary><ul class="list">${data.history.map((h) => `<li>${outcomeBadge(h.outcome)} ${esc(h.route === "lppsa" ? "LPPSA" : "Bank")} · max ${esc(money(h.result?.max_financing))}<small>${esc(fmtDate(h.created_at))} · ${esc(h.source === "ai" ? "AI (WhatsApp)" : h.created_by)}</small></li>`).join("")}</ul></details>` : ""}
  </section>`;
}

function inputsOf(form) {
  const d = formData(form), out = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === null || v === undefined) continue;
    if (k === "second_financing") { out[k] = v === "yes"; continue; }
    if (typeof v === "number" && (!isFinite(v) || v < 0)) continue;
    out[k] = v;
  }
  return out;
}

export function bindFinancing(el, { leadId, contactId, data, qualification, reload }) {
  const f = $("#ffin", el);
  if (!f || !data) return;
  bindDocs(el, { leadId, data, form: f, reload });
  guardForm(f, `lead:${leadId}:financing`);
  const preview = $("#fin-preview", f);
  const show = () => { const i = inputsOf(f); preview.innerHTML = Object.keys(i).length ? `<h3>Preview (not saved)</h3>${resultHtml(assess(i, rules()))}` : ""; };
  f.addEventListener("input", show);
  f.addEventListener("change", show);
  show();
  f.onsubmit = (e) => {
    e.preventDefault();
    const inputs = inputsOf(f);
    if (!inputs.route) return toast("Choose LPPSA or bank loan first.", "err");
    const result = assess(inputs, rules());
    act(f.querySelector("button"), async () => {
      const row = { route: inputs.route, inputs, result, outcome: result.outcome, source: "advisor", updated_by: S.email };
      if (data.profile) await q(SB.from("ai_financing_profiles").update(row).eq("id", data.profile.id).select("id"), { expectRows: true });
      else await q(SB.from("ai_financing_profiles").insert({ lead_id: leadId, ...row }).select("id"), { expectRows: true });
      if (result.max_financing !== undefined) {
        await q(SB.from("ai_financing_assessments").insert({ lead_id: leadId, route: inputs.route, inputs, result, outcome: result.outcome, rules_version: result.rules_version, engine_version: result.engine_version, source: "advisor", created_by: S.email }).select("id"));
      }
      await q(SB.from("ai_leads").update({ qualification: { ...qualification, financing: qualification.financing || inputs.route, financing_check: result.outcome } }).eq("id", leadId).select("id"), { expectRows: true });
      await SB.from("ai_activities").insert({ lead_id: leadId, contact_id: contactId, kind: "note", body: advisorSummary(result, inputs) });
      clearDraft(f); reload();
    }, "Financing check saved");
  };
}

/* ---------- Financing documents: staff upload, the AI reads, staff confirm ---------- */
const DOC_STATUS = { uploaded: ["Not read yet", ""], read: ["Read, check figures", "warn"], unreadable: ["Could not read", "alert"], failed: ["Reading failed", "alert"], confirmed: ["Figures confirmed", "ok"] };
const lineList = (items) => (items || []).map((i) => `${esc(i.name)} ${esc(money(i.amount))}`).join(" · ");

function extractedHtml(x) {
  if (!x) return "";
  const p = x.payslip || {}, c = x.ccris || {}, b = x.bank_statement || {};
  const kv = [];
  const add = (k, v) => { if (v !== null && v !== undefined && v !== "") kv.push([k, v]); };
  if (x.document_kind === "payslip") {
    add("Basic salary", money(p.basic_salary)); add("Fixed allowances", lineList(p.fixed_allowances)); add("Overtime / commission", lineList(p.variable_income));
    add("Statutory deductions", lineList(p.statutory_deductions)); add("Loan deductions", lineList(p.loan_deductions)); add("Other deductions", lineList(p.other_deductions));
    add("Gross / net pay", [money(p.gross_pay), money(p.net_pay)].filter(Boolean).join(" / ")); add("Employer", p.employer_sector !== "unknown" ? p.employer_sector.replace("_", " ") : "");
    add("Birth year", p.birth_year); add("Appointed", p.appointment_date); add("Service status", p.service_status !== "unknown" ? p.service_status.replace(/_/g, " ") : "");
  } else if (x.document_kind === "ccris") {
    add("Report date", c.report_date);
    for (const f of c.facilities || []) add(f.facility + (f.is_credit_card ? " (card)" : ""), [f.monthly_instalment !== null ? money(f.monthly_instalment) + "/month" : "", f.outstanding !== null ? money(f.outstanding) + " outstanding" : "", f.in_arrears ? "IN ARREARS" : ""].filter(Boolean).join(" · "));
    if (c.special_attention) add("Special attention account", "Yes");
  } else if (x.document_kind === "bank_statement") {
    add("Months covered", b.months_covered); add("Average salary credit", money(b.average_salary_credit)); add("Regular loan payments", lineList(b.regular_loan_payments));
    add("Average month-end balance", money(b.average_month_end_balance)); if (b.returned_payments) add("Returned / bounced payments", "Yes");
  }
  return `<dl class="kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    ${(x.warnings || []).map((w) => `<p class="note">⚠ ${esc(w)}</p>`).join("")}`;
}

function docsSection(docs) {
  if (!docs) return "";
  const usable = docs.filter((d) => (d.status === "read" || d.status === "confirmed") && d.extracted);
  const sug = suggestInputs(usable.map((d) => d.extracted));
  const sugKeys = Object.keys(sug.inputs);
  return `<details id="fin-docs"${docs.length ? " open" : ""}><summary>Financing documents (${docs.length})</summary>
    <p class="note">Upload the buyer's payslip, CCRIS report or bank statement. The AI reads the figures; <b>you check them</b> before they go into the calculator. Files are private to staff, never sent to anyone, and deleted automatically after ${esc(String(S.settings?.compliance?.financing_docs_retention_days || 30))} days. Only upload documents the buyer agreed to share for this check.</p>
    <form id="fdoc" class="form two">
      <label>Document<select name="kind">${Object.entries(DOC_KINDS).map(([k, v]) => opt(k, v.en, "payslip")).join("")}</select></label>
      <label>File (PDF or photo, up to 4 MB)<input type="file" name="file" accept="${attr(DOC_MIME.join(","))}" required></label>
      <div class="actions full"><button class="btn pri">Upload and read</button></div>
    </form>
    ${docs.length ? `<ul class="list">${docs.map((d) => { const [label, kind] = DOC_STATUS[d.status] || [d.status, ""]; return `<li data-doc="${attr(d.id)}">
      <b>${esc(DOC_KINDS[d.kind]?.en || d.kind)}</b> ${badge(label, kind)} <small>${esc(d.file_name)} · ${esc(d.uploaded_by)} · ${esc(fmtDate(d.created_at))} · deleted ${esc(fmtDate(d.expires_at, false))}</small>
      ${d.extracted?.readable ? `<details><summary>What the AI read${d.extracted.period ? " · " + esc(d.extracted.period) : ""} · ${esc(d.extracted.confidence)} confidence</summary>${extractedHtml(d.extracted)}</details>` : ""}
      ${d.status === "unreadable" ? `<p class="note">${esc((d.extracted?.warnings || [])[0] || "The AI could not read this as a " + (DOC_KINDS[d.kind]?.en || "document").toLowerCase() + ". Upload a clearer, uncropped copy.")}</p>` : ""}
      ${d.status === "failed" ? `<p class="note">${esc(d.error || "")}</p>` : ""}
      <div class="actions"><button type="button" class="btn sm" data-doc-view>View</button>${["uploaded", "failed", "unreadable"].includes(d.status) ? ` <button type="button" class="btn sm" data-doc-read>Read with AI</button>` : ""} <button type="button" class="btn sm" data-doc-del>Delete</button></div></li>`; }).join("")}</ul>` : ""}
    ${sugKeys.length ? `<div class="card notice" id="fin-sug"><div><h3>Suggested calculator figures</h3>
      <table class="mini"><thead><tr><th>Field</th><th>Value</th><th>From</th></tr></thead><tbody>${sugKeys.map((k) => `<tr><td>${esc(FIELD_LABEL[k] || k.replace(/_/g, " "))}</td><td>${esc(typeof sug.inputs[k] === "number" && !["age", "service_years"].includes(k) ? money(sug.inputs[k]) : sug.inputs[k])}</td><td>${esc(sug.sources[k])}</td></tr>`).join("")}</tbody></table>
      ${sug.checks.map((c) => `<p class="note">⚠ ${esc(c)}</p>`).join("")}
      <p class="note">Check each figure against the document. Using them fills the calculator below; nothing is saved until you press <b>Save to lead</b>.</p>
      <button type="button" class="btn pri" id="fin-use">I checked these: use in calculator</button></div></div>` : ""}
  </details>`;
}

// photos are scaled down in the browser (the AI reads 1600 px well, and the request limit is 6 MB)
async function prepareFile(file) {
  if (!file.type.startsWith("image/")) return { blob: file, mime: file.type, name: file.name };
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) return { blob: file, mime: file.type, name: file.name };
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
  return blob ? { blob, mime: "image/jpeg", name: file.name.replace(/\.[^.]+$/, "") + ".jpg" } : { blob: file, mime: file.type, name: file.name };
}
const toBase64 = (blob) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
const docApi = (body) => api("/api/sales/financing/documents", { method: "POST", body: JSON.stringify(body) });

function bindDocs(el, { leadId, data, form, reload }) {
  const box = $("#fin-docs", el);
  if (!box) return;
  const up = $("#fdoc", box);
  up.onsubmit = (e) => {
    e.preventDefault();
    const file = up.file.files[0];
    if (!file) return toast("Choose a file first.", "err");
    if (!DOC_MIME.includes(file.type)) return toast("Only PDF, JPG, PNG or WEBP files.", "err");
    act(up.querySelector("button"), async () => {
      const f = await prepareFile(file);
      if (f.blob.size > DOC_MAX_BYTES) throw new Error("The file is larger than 4 MB. Upload a smaller scan or one page at a time.");
      const { document: doc } = await docApi({ action: "upload", lead_id: leadId, kind: up.kind.value, file_name: f.name, mime: f.mime, data: await toBase64(f.blob) });
      toast("Uploaded. The AI is reading it…");
      let failed = null;
      try { await docApi({ action: "read", id: doc.id }); } catch (err) { failed = err; }
      reload();
      if (failed) throw failed;
    }, "Document read: check the figures");
  };
  $$("[data-doc]", box).forEach((li) => {
    const id = li.dataset.doc;
    const v = $("[data-doc-view]", li), r = $("[data-doc-read]", li), d = $("[data-doc-del]", li);
    v.onclick = () => act(v, async () => { const { url } = await docApi({ action: "view", id }); window.open(url, "_blank", "noopener"); });
    if (r) r.onclick = () => act(r, async () => { await docApi({ action: "read", id }); reload(); }, "Document read: check the figures");
    d.onclick = () => confirm("Delete this document now? The file and what the AI read are removed.") && act(d, async () => { await docApi({ action: "delete", id }); reload(); }, "Document deleted");
  });
  const use = $("#fin-use", box);
  if (use) use.onclick = () => act(use, async () => {
    const usable = data.docs.filter((d) => (d.status === "read" || d.status === "confirmed") && d.extracted);
    const { inputs } = suggestInputs(usable.map((d) => d.extracted));
    for (const [k, v] of Object.entries(inputs)) { const inp = form.elements[k]; if (inp) inp.value = v; }
    $("#fin-calc", el).open = true;
    form.dispatchEvent(new Event("input"));
    await Promise.all(usable.filter((d) => d.status === "read").map((d) => docApi({ action: "confirm", id: d.id })));
    $("#fin-calc", el).scrollIntoView({ behavior: "smooth", block: "start" });
  }, "Figures added to the calculator: choose the route and price, then Save to lead");
}

/* ---------- Settings → Financing rules (owner) ---------- */
const pct = (name, label, v, dis) => `<label>${label}<input name="${name}" type="number" min="0" max="100" step="0.01" value="${attr(v)}"${dis}></label>`;
const rm = (name, label, v, dis) => `<label>${label}<input name="${name}" type="number" min="0" step="1000" value="${attr(v)}"${dis}></label>`;
const yrs = (name, label, v, dis) => `<label>${label}<input name="${name}" type="number" min="1" max="100" step="1" value="${attr(v)}"${dis}></label>`;

export function financingSettings(body, { own, save }) {
  const r = rules(), L = r.lppsa, B = r.bank, dis = own ? "" : " disabled";
  const tiers = (L.rate_tiers || []).map((t) => (t.up_to ? `${t.rate_pct}@${t.up_to}` : `${t.rate_pct}`)).join(", ");
  body.innerHTML = `<h2>Financing rules</h2>
    <p class="note">Used by the loan calculator on lead pages and by the WhatsApp AI when <b>Loan eligibility engine</b> is switched on. Every result is shown as a preliminary estimate, never an approval. Blank fields use the built-in defaults.</p>
    ${L.verified ? "" : `<div class="card notice"><div><b>LPPSA rules not yet verified.</b> The defaults come from: ${esc(DEFAULT_FINANCING.lppsa.source)}. Check them against the official LPPSA rules, adjust if needed, then tick “Verified” with the date. Until then the AI tells buyers the rules are being confirmed by an advisor.</div></div>`}
    <form id="sf" class="form two">
      <h3 class="full">LPPSA (public servants)</h3>
      <label>Rule set version<input name="l_rules_version" value="${attr(L.rules_version)}"${dis}></label>
      <label class="check"><input type="checkbox" name="l_verified"${L.verified ? " checked" : ""}${dis}> Verified against the official LPPSA source</label>
      <label>Verified on<input name="l_verified_on" type="date" value="${attr(L.verified_on)}"${dis}></label>
      <label class="full">Source<input name="l_source" value="${attr(L.source)}" maxlength="500"${dis}></label>
      ${pct("l_repayment_pct_first", "Instalment limit, 1st financing (% of basic + fixed allowances)", L.repayment_pct_first, dis)}
      ${pct("l_repayment_pct_second", "Instalment limit, 2nd financing (%)", L.repayment_pct_second, dis)}
      ${pct("l_dsr_pct", "All deductions limit (% of net income)", L.dsr_pct, dis)}
      ${pct("l_min_net_pct", "Minimum pay left (% of basic + fixed allowances)", L.min_net_pct, dis)}
      <label class="full">Profit rate tiers (rate@up-to-RM, last one without a limit)<input name="l_rate_tiers" value="${attr(tiers)}" placeholder="4@750000, 4.5"${dis}></label>
      ${rm("l_max_financing", "Maximum financing (RM)", L.max_financing, dis)}
      ${pct("l_margin_pct", "Margin (% of price or valuation)", L.margin_pct, dis)}
      ${yrs("l_max_tenure_years", "Maximum tenure (years)", L.max_tenure_years, dis)}
      ${yrs("l_max_age", "Repay by age", L.max_age, dis)}
      ${yrs("l_min_service_years", "Minimum years in service", L.min_service_years, dis)}
      <h3 class="full">Bank loans (illustrative assumptions)</h3>
      <label class="full">Label shown with bank results<input name="b_label" value="${attr(B.label)}" maxlength="200"${dis}></label>
      ${pct("b_rate_pct", "Interest rate assumption (% a year)", B.rate_pct, dis)}
      ${yrs("b_max_tenure_years", "Maximum tenure (years)", B.max_tenure_years, dis)}
      ${yrs("b_max_age", "Repay by age", B.max_age, dis)}
      ${pct("b_margin_pct_first", "Margin of finance, 1st/2nd housing loan (%)", B.margin_pct_first, dis)}
      ${pct("b_margin_pct_third", "Margin of finance, 3rd housing loan onwards (%)", B.margin_pct_third, dis)}
      ${pct("b_variable_income_pct", "Variable income counted (%)", B.variable_income_pct, dis)}
      ${pct("b_self_employed_income_pct", "Self-employed income counted (%)", B.self_employed_income_pct, dis)}
      ${pct("b_credit_card_pct", "Credit card: % of balance counted monthly", B.credit_card_pct, dis)}
      <label class="full">DSR scenarios (label:% of net income, comma-separated)<input name="b_scenarios" value="${attr(B.scenarios.map((s) => `${s.label}:${s.dsr_pct}`).join(", "))}" placeholder="Conservative:60, Moderate:70, Flexible:80"${dis}></label>
      <h3 class="full">Result bands</h3>
      ${pct("o_adjust_band_pct", "“May be affordable with adjustments” when the amount needed is up to this % above the limit", r.outcome.adjust_band_pct, dis)}
      ${own ? `<div class="actions full"><button class="btn pri">Save financing rules</button> <button type="button" class="btn" id="fin-reset">Restore defaults</button></div>` : ""}
    </form>`;
  const f = $("#sf", body);
  if (!own) return;
  guardForm(f, "settings:financing");
  $("#fin-reset", body).onclick = (e) => confirm("Restore the built-in financing defaults?") && act(e.target, () => save("financing", {}, f), "Defaults restored");
  f.onsubmit = (e) => {
    e.preventDefault();
    const v = formData(f), out = { lppsa: {}, bank: {}, outcome: {} };
    for (const [k, x] of Object.entries(v)) {
      const [pre, ...rest] = k.split("_"), key = rest.join("_");
      const sec = { l: "lppsa", b: "bank", o: "outcome" }[pre];
      if (!sec || ["rate_tiers", "scenarios"].includes(key)) continue;
      if (x === null || x === "") continue;
      out[sec][key] = x;
    }
    out.lppsa.verified = !!v.l_verified;
    if (out.lppsa.verified && !v.l_verified_on) return toast("Enter the date the LPPSA rules were verified.", "err");
    const tiers = String(v.l_rate_tiers || "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => { const [rate, up] = s.split("@"); return { rate_pct: Number(rate), up_to: up ? Number(up) : null }; });
    if (tiers.length) {
      if (tiers.some((t) => !(t.rate_pct >= 0 && t.rate_pct < 30) || (t.up_to !== null && !(t.up_to > 0))) || tiers.at(-1).up_to !== null) return toast("Rate tiers: e.g. 4@750000, 4.5 — the last tier has no limit.", "err");
      out.lppsa.rate_tiers = tiers;
    }
    const sc = String(v.b_scenarios || "").split(",").map((s) => s.trim()).filter(Boolean).map((s, i) => { const [label, d] = s.split(":"); return { key: "s" + (i + 1), label: (label || "").trim(), dsr_pct: Number(d) }; });
    if (sc.length) {
      if (sc.some((s) => !s.label || !(s.dsr_pct > 0 && s.dsr_pct <= 100))) return toast("DSR scenarios: e.g. Conservative:60, Moderate:70.", "err");
      out.bank.scenarios = sc;
    }
    for (const [k, x] of Object.entries({ ...out.lppsa, ...out.bank })) if (typeof x === "number" && /pct/.test(k) && x > 100) return toast("Percentages must be 100 or less.", "err");
    act(f.querySelector("button"), () => save("financing", out, f), "Financing rules saved");
  };
}
