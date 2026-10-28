// AI Sales dashboard — overview, leads/CRM, lead detail, pipeline, appointments, handover queue, inbox.
import { SB, S, can, $, $$, esc, attr, fmtDate, ago, q, act, toast, guardForm, clearDraft, formData, modal, tempBadge, badge, opt, empty, ro,
  projectName, stageName, sourceName, projectPriceFrom, toLocalInput, fromLocalInput, flag, errText, api, keepPlace } from "./core.js";
import { normalizePhone, formatPhone } from "../shared/phone.mjs";
import { scoreLead } from "../shared/scoring.mjs";
import { loadFinancing, financingSection, bindFinancing } from "./financing.js";
import { rmkLeadCard, bindRmkLeadCard } from "./rmk.js";

const openStages = () => S.stages.filter((s) => s.active && !s.is_won && !s.is_lost);
const teamOptions = (sel) => opt("", "— Unassigned —", sel) + [...new Set([...S.team.filter((m) => m.active).map((m) => m.email), S.email])].map((e) => opt(e, e, sel)).join("");
const projectOptions = (sel, blank = "— None —") => opt("", blank, sel) + S.projects.map((p) => opt(p.id, p.name + (p.area ? " · " + p.area : "") + (p.published ? "" : " (unpublished)"), sel)).join("");
const contactName = (c) => (c && (c.full_name || (c.phone_e164 ? formatPhone(c.phone_e164) : c.email))) || "(no name)";

/* ======================= Overview ======================= */
export async function overview(el) {
  const since7 = new Date(Date.now() - 7 * 864e5).toISOString();
  const in7 = new Date(Date.now() + 7 * 864e5).toISOString();
  const today = new Date(); today.setHours(23, 59, 59, 999);
  const [open, recent, tasks, handovers, appts] = await Promise.all([
    q(SB.from("ai_leads").select("temperature, stage_id").is("closed_at", null).limit(5000)),
    q(SB.from("ai_leads").select("id", { count: "exact", head: true }).gte("created_at", since7)),
    q(SB.from("ai_tasks").select("id,title,due_at,lead_id").eq("status", "open").eq("assignee_email", S.email).lte("due_at", today.toISOString()).order("due_at").limit(10)),
    q(SB.from("ai_handover_events").select("id", { count: "exact", head: true }).eq("status", "open")),
    q(SB.from("ai_appointments").select("id,kind,status,start_at,preferred_text,lead_id").is("archived_at", null).in("status", ["pending_confirmation", "confirmed", "rescheduled"]).or(`start_at.is.null,start_at.lte.${in7}`).order("start_at", { nullsFirst: true }).limit(10)),
  ]);
  const t = { hot: 0, warm: 0, nurture: 0, unqualified: 0 };
  (open || []).forEach((l) => { t[l.temperature] = (t[l.temperature] || 0) + 1; });
  let pendingWeb = null;
  if (can("advisor")) {
    try {
      const [{ count: web }, { count: done }] = await Promise.all([
        SB.from("leads").select("id", { count: "exact", head: true }),
        SB.from("ai_activities").select("id", { count: "exact", head: true }).eq("kind", "website_enquiry"),
      ]);
      if (web !== null && done !== null) pendingWeb = Math.max(0, web - done);
    } catch { /* staff who are not website admins cannot count website enquiries */ }
  }
  const flags = S.settings.flags || {};
  el.innerHTML = `
  <div class="page-head"><h1>Overview</h1><p class="sub">Measured from CRM records · ${esc(fmtDate(new Date()))}</p></div>
  <div class="kpis">
    <a class="kpi" href="#/leads?status=open"><b>${(open || []).length}</b><span>Open leads</span></a>
    <a class="kpi hot" href="#/leads?temp=hot"><b>${t.hot}</b><span>Hot</span></a>
    <a class="kpi warm" href="#/leads?temp=warm"><b>${t.warm}</b><span>Warm</span></a>
    <a class="kpi" href="#/leads?temp=nurture"><b>${t.nurture}</b><span>Nurture</span></a>
    <a class="kpi" href="#/leads?since=7"><b>${recent ?? 0}</b><span>New in 7 days</span></a>
    <a class="kpi ${handovers ? "alert" : ""}" href="#/handover"><b>${handovers ?? 0}</b><span>Waiting for a human</span></a>
  </div>
  ${pendingWeb ? `<div class="card notice"><div><b>${pendingWeb} website enquir${pendingWeb === 1 ? "y" : "ies"}</b> not yet in the CRM.</div>
     <button class="btn pri" id="imp"${flags.website_lead_import ? "" : " disabled title='Switched off in Settings'"}>Import into CRM</button></div>` : ""}
  <div class="grid2">
    <section class="card"><h2>My tasks due</h2>${(tasks || []).length ? `<ul class="list">${tasks.map((x) => `<li><a href="#/lead/${attr(x.lead_id)}">${esc(x.title)}</a><small class="${new Date(x.due_at) < Date.now() ? "late" : ""}">${esc(fmtDate(x.due_at))}</small></li>`).join("")}</ul>` : empty("Nothing due. 🎉")}</section>
    <section class="card"><h2>Upcoming &amp; pending appointments</h2>${(appts || []).length ? `<ul class="list">${appts.map((a) => `<li><a href="#/lead/${attr(a.lead_id)}">${esc(kindLabel(a.kind))}</a> ${apptBadge(a.status)}<small>${a.start_at ? esc(fmtDate(a.start_at)) : "Preferred: " + esc(a.preferred_text || "—")}</small></li>`).join("")}</ul>` : empty("No appointments in the next 7 days.")}</section>
  </div>
  <section class="card"><h2>Automation status</h2>
    <div class="flags">${[["ai_auto_reply", "AI auto-reply"], ["whatsapp_outbound", "WhatsApp sending"], ["follow_ups", "Automated follow-ups"], ["calendar_booking", "Calendar booking"]]
      .map(([k, l]) => `<span class="flag ${flags[k] ? "on" : ""}">${flags[k] ? "●" : "○"} ${esc(l)}: ${flags[k] ? "On" : "Off"}</span>`).join("")}</div>
    <p class="note">AI replies, WhatsApp and calendar integrations are delivered in Phases 3–4. Until then these stay off and nothing is sent to customers automatically.</p>
  </section>`;
  const b = $("#imp", el);
  if (b) b.onclick = () => act(b, async () => {
    const r = await q(SB.rpc("ai_import_website_leads", { max_rows: 500 }));
    toast(`Imported ${r.imported} enquir${r.imported === 1 ? "y" : "ies"}${r.skipped_no_contact ? ` · ${r.skipped_no_contact} skipped (no phone or email)` : ""}`);
    overview(el);
  });
}

/* ======================= Leads list ======================= */
export async function leads(el, params) {
  const f = { status: params.get("status") || "open", temp: params.get("temp") || "", stage: params.get("stage") || "", owner: params.get("owner") || "", since: params.get("since") || "", q: params.get("q") || "" };
  let query = SB.from("ai_leads").select("id,lead_code,temperature,score,stage_id,owner_email,source_id,primary_project_id,handover_status,ai_paused,created_at,updated_at,last_contact_at,closed_at,contact:ai_contacts(id,full_name,phone_e164,email)").order("updated_at", { ascending: false }).limit(1000);
  if (f.status === "open") query = query.is("closed_at", null);
  if (f.status === "closed") query = query.not("closed_at", "is", null);
  if (f.temp) query = query.eq("temperature", f.temp);
  if (f.stage) query = query.eq("stage_id", f.stage);
  if (f.owner === "me") query = query.eq("owner_email", S.email);
  if (f.owner === "none") query = query.is("owner_email", null);
  if (f.since) query = query.gte("created_at", new Date(Date.now() - Number(f.since) * 864e5).toISOString());
  let rows = (await q(query)) || [];
  if (f.q) {
    const needle = f.q.toLowerCase(), digits = normalizePhone(f.q);
    rows = rows.filter((l) => [l.lead_code, l.contact?.full_name, l.contact?.email, projectName(l.primary_project_id)].some((v) => String(v || "").toLowerCase().includes(needle)) || (digits && String(l.contact?.phone_e164 || "").includes(digits)));
  }
  el.innerHTML = `
  <div class="page-head"><h1>Leads &amp; CRM</h1>${can("advisor") ? `<button class="btn pri" id="new">＋ New lead</button>` : ""}</div>
  <form class="filters" id="flt">
    <input type="search" name="q" placeholder="Search name, phone, email, OSC code, project" value="${attr(f.q)}" aria-label="Search leads">
    <select name="status" aria-label="Status">${opt("open", "Open", f.status)}${opt("closed", "Closed", f.status)}${opt("all", "All", f.status)}</select>
    <select name="temp" aria-label="Temperature">${opt("", "Any temperature", f.temp)}${["hot", "warm", "nurture", "unqualified"].map((t) => opt(t, t[0].toUpperCase() + t.slice(1), f.temp)).join("")}</select>
    <select name="stage" aria-label="Stage">${opt("", "Any stage", f.stage)}${S.stages.map((s) => opt(s.id, s.name, f.stage)).join("")}</select>
    <select name="owner" aria-label="Owner">${opt("", "Anyone", f.owner)}${opt("me", "Mine", f.owner)}${opt("none", "Unassigned", f.owner)}</select>
  </form>
  <p class="sub">${rows.length} lead${rows.length === 1 ? "" : "s"}${rows.length >= 1000 ? " (showing the latest 1,000)" : ""}</p>
  ${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Lead</th><th>Contact</th><th>Project</th><th>Stage</th><th>Temp</th><th>Owner</th><th>Updated</th></tr></thead><tbody>
  ${rows.map((l) => `<tr data-href="#/lead/${attr(l.id)}" tabindex="0">
    <td data-label="Lead"><a href="#/lead/${attr(l.id)}"><b>${esc(l.lead_code)}</b></a>${l.handover_status === "requested" ? " " + badge("Needs human", "alert") : ""}${l.ai_paused ? " " + badge("AI paused") : ""}</td>
    <td data-label="Contact">${esc(contactName(l.contact))}<small>${esc(l.contact?.phone_e164 ? formatPhone(l.contact.phone_e164) : l.contact?.email || "")}</small></td>
    <td data-label="Project">${esc(projectName(l.primary_project_id)) || "—"}</td>
    <td data-label="Stage">${esc(stageName(l.stage_id))}</td>
    <td data-label="Temp">${tempBadge(l.temperature)}${l.score !== null ? ` <small>${l.score}</small>` : ""}</td>
    <td data-label="Owner">${esc(l.owner_email || "—")}</td>
    <td data-label="Updated">${esc(ago(l.updated_at))}</td></tr>`).join("")}
  </tbody></table></div>` : empty("No leads match these filters.")}`;
  const form = $("#flt", el);
  const apply = () => { const d = formData(form); const p = new URLSearchParams(); Object.entries(d).forEach(([k, v]) => v && p.set(k, v)); if (!d.status) p.set("status", "open"); location.hash = "#/leads?" + p.toString(); };
  form.onchange = apply;
  form.onsubmit = (e) => { e.preventDefault(); apply(); };
  $$("tr[data-href]", el).forEach((tr) => { tr.onclick = (e) => { if (!e.target.closest("a")) location.hash = tr.dataset.href; }; tr.onkeydown = (e) => { if (e.key === "Enter") location.hash = tr.dataset.href; }; });
  const nb = $("#new", el);
  if (nb) nb.onclick = () => newLeadModal();
}

function newLeadModal() {
  const dlg = modal("New lead", `<form id="nl" class="form">
    <label>Name<input name="name" maxlength="120" autocomplete="off"></label>
    <label>Phone (WhatsApp)<input name="phone" inputmode="tel" placeholder="012-345 6789" autocomplete="off"></label>
    <label>Email<input name="email" type="email" autocomplete="off"></label>
    <label>Source<select name="source">${opt("", "— Select —")}${S.sources.filter((s) => s.active).map((s) => opt(s.name, s.name)).join("")}</select></label>
    <label>Project of interest<select name="project">${projectOptions("")}</select></label>
    <label class="full">First note<textarea name="note" rows="3" placeholder="What did they ask about?"></textarea></label>
    <p class="note full">If this phone number already belongs to a contact with an open lead, that lead is reused — no duplicate is created.</p>
    <div class="actions full"><button class="btn pri" type="submit">Save lead</button></div></form>`);
  const form = $("#nl", dlg);
  guardForm(form, "new-lead");
  form.onsubmit = (e) => {
    e.preventDefault();
    const d = formData(form);
    if (!d.phone && !d.email) return toast("Enter a phone number or email.", "err");
    if (d.phone && !normalizePhone(d.phone)) return toast("That phone number does not look valid.", "err");
    act(form.querySelector("button[type=submit]"), async () => {
      const cid = await q(SB.rpc("ai_upsert_contact", { p_phone: d.phone, p_name: d.name, p_email: d.email, p_wa_id: null }));
      const { data: existing } = await SB.from("ai_leads").select("id,lead_code").eq("contact_id", cid).is("closed_at", null).maybeSingle();
      const lid = await q(SB.rpc("ai_open_lead", { p_contact: cid, p_source: d.source, p_project: d.project }));
      if (d.note) await q(SB.from("ai_activities").insert({ lead_id: lid, contact_id: cid, kind: "note", body: d.note }));
      clearDraft(form);
      dlg.done();
      toast(existing ? `Existing open lead ${existing.lead_code} updated (no duplicate created)` : "Lead created");
      location.hash = "#/lead/" + lid;
    });
  };
}

/* ======================= Lead detail ======================= */
const KIND = { showroom_visit: "Showroom visit", property_viewing: "Property viewing", phone_call: "Phone consultation", video_call: "Video consultation", financing_discussion: "Financing discussion" };
const kindLabel = (k) => KIND[k] || k;
const APPT = { pending_confirmation: ["Pending confirmation", "warn"], confirmed: ["Confirmed", "ok"], rescheduled: ["Rescheduled", "warn"], cancelled: ["Cancelled", ""], completed: ["Completed", "ok"], no_show: ["No-show", "alert"] };
const apptBadge = (s) => badge((APPT[s] || [s])[0], (APPT[s] || [, ""])[1]);

export async function leadDetail(el, id) {
  const lead = await q(SB.from("ai_leads").select("*, contact:ai_contacts(*)").eq("id", id).maybeSingle());
  if (!lead) { el.innerHTML = empty("Lead not found, or you do not have access."); return; }
  const c = lead.contact;
  const [acts, tasks, appts, interests, consent, handovers, inbound, fin, rmkCard] = await Promise.all([
    q(SB.from("ai_activities").select("*").eq("lead_id", id).order("created_at", { ascending: false }).limit(200)),
    q(SB.from("ai_tasks").select("*").eq("lead_id", id).order("status").order("due_at")),
    q(SB.from("ai_appointments").select("*").eq("lead_id", id).order("created_at", { ascending: false })),
    q(SB.from("ai_lead_interests").select("*").eq("lead_id", id).order("created_at")),
    q(SB.from("ai_consent_current").select("*").eq("contact_id", c.id)),
    q(SB.from("ai_handover_events").select("*").eq("lead_id", id).order("created_at", { ascending: false })),
    SB.from("ai_messages").select("id, ai_conversations!inner(contact_id)", { count: "exact", head: true }).eq("ai_conversations.contact_id", c.id).eq("direction", "inbound"),
    loadFinancing(id),
    rmkLeadCard(id).catch(() => ""),
  ]);
  const qf = lead.qualification || {};
  const sig = qf.signals || {};
  const stage = S.stages.find((s) => s.id === lead.stage_id) || {};
  el.innerHTML = `
  <div class="page-head"><div><a class="back" href="#/leads">← Leads</a><h1>${esc(contactName(c))} <small class="code">${esc(lead.lead_code)}</small></h1>
    <p class="sub">${tempBadge(lead.temperature)} ${lead.score !== null ? `Score ${lead.score}/100 · ` : ""}${esc(stage.name || "")}${lead.closed_at ? " · Closed " + esc(fmtDate(lead.closed_at, false)) : ""} · Created ${esc(fmtDate(lead.created_at))}</p></div>
    <div class="head-actions">${c.phone_e164 ? `<a class="btn" href="https://wa.me/${attr(c.phone_e164)}" target="_blank" rel="noopener">WhatsApp</a><a class="btn" href="tel:+${attr(c.phone_e164)}">Call</a>` : ""}
    ${can("advisor") && lead.handover_status !== "requested" ? `<button class="btn" id="ho">Flag for human</button>` : ""}</div></div>
  <div class="detail">
   <div class="col">
    <section class="card"><h2>Contact</h2><form id="fc" class="form two">
      <label>Name<input name="full_name" value="${attr(c.full_name)}" maxlength="120"${ro("advisor")}></label>
      <label>Salutation<input name="salutation" value="${attr(c.salutation)}" placeholder="Encik / Puan / Mr / Ms"${ro("advisor")}></label>
      <label>Phone<input name="phone" value="${attr(c.phone_e164 ? formatPhone(c.phone_e164) : "")}" inputmode="tel"${ro("advisor")}></label>
      <label>Email<input name="email" type="email" value="${attr(c.email)}"${ro("advisor")}></label>
      <label>Language<select name="preferred_language"${ro("advisor")}>${opt("", "Unknown", c.preferred_language)}${opt("ms", "Bahasa Malaysia", c.preferred_language)}${opt("en", "English", c.preferred_language)}${opt("mixed", "Mixed / Manglish", c.preferred_language)}</select></label>
      <label class="full">Notes<textarea name="notes" rows="2"${ro("advisor")}>${esc(c.notes)}</textarea></label>
      ${can("advisor") ? `<div class="actions full"><button class="btn pri">Save contact</button></div>` : ""}</form></section>

    <section class="card"><h2>Lead</h2><form id="fl" class="form two">
      <label>Stage<select name="stage_id"${ro("advisor")}>${S.stages.filter((s) => s.active || s.id === lead.stage_id).map((s) => opt(s.id, s.name, lead.stage_id)).join("")}</select></label>
      <label>Owner<select name="owner_email"${ro("advisor")}>${teamOptions(lead.owner_email)}</select></label>
      <label>Source<select name="source_id"${ro("advisor")}>${opt("", "—", lead.source_id)}${S.sources.map((s) => opt(s.id, s.name, lead.source_id)).join("")}</select></label>
      <label>Campaign<select name="campaign_id"${ro("advisor")}>${opt("", "—", lead.campaign_id)}${S.campaigns.map((x) => opt(x.id, x.name, lead.campaign_id)).join("")}</select></label>
      <label>Main project<select name="primary_project_id"${ro("advisor")}>${projectOptions(lead.primary_project_id)}</select></label>
      <label>Lost reason<input name="lost_reason" value="${attr(lead.lost_reason)}" placeholder="If lost: why?"${ro("advisor")}></label>
      <label class="check full"><input type="checkbox" name="ai_paused"${lead.ai_paused ? " checked" : ""}${ro("advisor")}> Pause AI for this lead (a human handles every reply)</label>
      ${can("advisor") ? `<div class="actions full"><button class="btn pri">Save lead</button></div>` : ""}</form></section>

    <section class="card"><h2>Qualification &amp; score</h2>
      <p class="note">Collected progressively in conversation. Only record financial details the buyer chose to share. The score indicates intent only — it is not a prediction of purchase or loan approval.</p>
      <form id="fq" class="form two">
      <label>Purpose<select name="purpose"${ro("advisor")}>${opt("", "Unknown", qf.purpose)}${opt("own_stay", "Own stay", qf.purpose)}${opt("investment", "Investment", qf.purpose)}${opt("both", "Both", qf.purpose)}</select></label>
      <label>First home?<select name="first_home"${ro("advisor")}>${opt("", "Unknown", qf.first_home)}${opt("yes", "Yes", qf.first_home)}${opt("no", "No — additional property", qf.first_home)}</select></label>
      <label>Bedrooms<input name="bedrooms" value="${attr(qf.bedrooms)}" placeholder="e.g. 3"${ro("advisor")}></label>
      <label>Built-up (sqft)<input name="size_sqft" value="${attr(qf.size_sqft)}" placeholder="e.g. 800–1,000"${ro("advisor")}></label>
      <label>Budget min (RM)<input name="budget_min" type="number" min="0" step="1000" value="${attr(qf.budget_min)}"${ro("advisor")}></label>
      <label>Budget max (RM)<input name="budget_max" type="number" min="0" step="1000" value="${attr(qf.budget_max)}"${ro("advisor")}></label>
      <label>Employment<select name="employment"${ro("advisor")}>${opt("", "Unknown", qf.employment)}${opt("government", "Government servant", qf.employment)}${opt("private", "Private sector", qf.employment)}${opt("self_employed", "Self-employed", qf.employment)}</select></label>
      <label>Financing<select name="financing"${ro("advisor")}>${opt("", "Unknown", qf.financing)}${opt("lppsa", "LPPSA", qf.financing)}${opt("bank", "Bank loan", qf.financing)}${opt("cash", "Cash", qf.financing)}${opt("preapproved", "Pre-approved (stated)", qf.financing)}${opt("undecided", "Undecided", qf.financing)}</select></label>
      <label>Timeline (months)<input name="timeline_months" type="number" min="0" max="120" value="${attr(qf.timeline_months)}"${ro("advisor")}></label>
      <label>Readiness<select name="readiness"${ro("advisor")}>${opt("", "Unknown", qf.readiness)}${opt("ready", "Ready for next step", qf.readiness)}${opt("considering", "Considering options", qf.readiness)}${opt("researching", "Early research", qf.readiness)}</select></label>
      <label>Project fit<select name="project_fit"${ro("advisor")}>${opt("", "Not assessed", qf.project_fit)}${opt("strong", "Strong", qf.project_fit)}${opt("partial", "Partial", qf.project_fit)}${opt("poor", "Poor", qf.project_fit)}</select></label>
      <label>Budget fit<select name="budget_fit"${ro("advisor")}>${opt("", "Calculate from budget & price", qf.budget_fit)}${opt("strong", "Within budget", qf.budget_fit)}${opt("partial", "Slightly above", qf.budget_fit)}${opt("poor", "Well above", qf.budget_fit)}</select></label>
      <label class="full">Main concerns<textarea name="concerns" rows="2"${ro("advisor")}>${esc(qf.concerns)}</textarea></label>
      <label class="check"><input type="checkbox" name="asked_price"${sig.asked_price ? " checked" : ""}${ro("advisor")}> Asked about price</label>
      <label class="check"><input type="checkbox" name="requested_brochure"${sig.requested_brochure ? " checked" : ""}${ro("advisor")}> Requested brochure / price list</label>
      <label class="check"><input type="checkbox" name="unsuitable"${qf.unsuitable ? " checked" : ""}${ro("advisor")}> Unqualified / unsuitable</label>
      <label>Reason (if unsuitable)<input name="unsuitable_reason" value="${attr(qf.unsuitable_reason)}"${ro("advisor")}></label>
      ${can("advisor") ? `<div class="actions full"><button class="btn pri">Save &amp; rescore</button></div>` : ""}</form>
      ${(lead.score_rationale || []).length ? `<details class="why"><summary>Why this score?</summary><table class="mini"><tbody>${lead.score_rationale.map((r) => `<tr><td>${esc(r.label)}</td><td>${r.known ? `${r.points} / ${r.max}` : "unknown"}</td><td><small>${esc(r.detail)}</small></td></tr>`).join("")}</tbody></table></details>` : ""}
    </section>
    ${financingSection(fin)}
    ${rmkCard}
   </div>
   <div class="col">
    <section class="card"><h2>Projects of interest</h2>
      ${(interests || []).length ? `<ul class="list">${interests.map((i) => `<li>${esc(projectName(i.project_id))} ${badge(i.interest)}${can("advisor") ? ` <button class="link" data-rm-int="${attr(i.project_id)}">Remove</button>` : ""}</li>`).join("")}</ul>` : empty("None recorded.")}
      ${can("advisor") ? `<form id="fi" class="inline"><select name="project_id" aria-label="Project">${projectOptions("", "Add a project…")}</select><select name="interest" aria-label="Interest">${["enquired", "interested", "shortlisted", "visited", "rejected"].map((x) => opt(x, x)).join("")}</select><button class="btn">Add</button></form>` : ""}
    </section>

    <section class="card"><h2>Follow-ups &amp; tasks</h2><p class="note">Give a task a due time and you get a Telegram reminder before it is due.</p>
      ${(tasks || []).length ? `<ul class="list">${tasks.map((t) => `<li class="${t.status !== "open" ? "done" : ""}">${can("advisor") && t.status === "open" ? `<button class="link" data-done="${attr(t.id)}" aria-label="Mark done">☐</button>` : t.status === "done" ? "☑" : "✕"} ${esc(t.title)}<small class="${t.status === "open" && t.due_at && new Date(t.due_at) < Date.now() ? "late" : ""}">${esc(t.due_at ? fmtDate(t.due_at) : "")}${t.assignee_email ? " · " + esc(t.assignee_email) : ""}</small></li>`).join("")}</ul>` : empty("No tasks.")}
      ${can("advisor") ? `<form id="ft" class="form two"><label class="full">New follow-up / task<input name="title" maxlength="200" required placeholder="e.g. Follow up on Type B floor plan"></label><label>Due<input name="due_at" type="datetime-local"></label><label>Assignee<select name="assignee_email">${teamOptions(S.email)}</select></label><div class="actions full"><button class="btn">Add task</button></div></form>` : ""}
    </section>

    <section class="card"><h2>Appointments</h2>
      <p class="note">Advisor-recorded. AI-booked appointments are only marked confirmed after the calendar confirms them (Phase 4).</p>
      ${(appts || []).length ? `<ul class="list">${appts.map((a) => `<li><b>${esc(kindLabel(a.kind))}</b> ${apptBadge(a.status)} ${a.project_id ? "· " + esc(projectName(a.project_id)) : ""}<small>${a.start_at ? esc(fmtDate(a.start_at)) : "Preferred: " + esc(a.preferred_text || "—")}${a.advisor_email ? " · " + esc(a.advisor_email) : ""}${a.archived_at ? " · archived" : ""}</small>
        ${can("advisor") ? `<select data-appt="${attr(a.id)}" aria-label="Change status">${Object.entries(APPT).map(([k, v]) => opt(k, v[0], a.status)).join("")}</select>` : ""}
        ${a.status === "confirmed" ? `<small>WhatsApp confirmation &amp; reminders: ${a.wa_reminders === false ? "off" : "on"}${a.attendance_confirmed_at ? " · buyer confirmed they are coming" : ""}${can("advisor") ? ` <button class="link" data-wa-rem="${attr(a.id)}" data-on="${a.wa_reminders === false ? "1" : ""}">${a.wa_reminders === false ? "Turn on" : "Turn off"}</button>` : ""}</small>` : ""}</li>`).join("")}</ul>` : empty("No appointments.")}
      ${can("advisor") ? `<details><summary>Add appointment</summary><form id="fa" class="form two">
        <label>Type<select name="kind">${Object.entries(KIND).map(([k, v]) => opt(k, v)).join("")}</select></label>
        <label>Project<select name="project_id">${projectOptions(lead.primary_project_id)}</select></label>
        <label>Start<input name="start_at" type="datetime-local"></label><label>End<input name="end_at" type="datetime-local"></label>
        <label>Status<select name="status">${opt("pending_confirmation", "Pending confirmation")}${opt("confirmed", "Confirmed (time agreed with buyer)")}</select></label>
        <label>Advisor<select name="advisor_email">${teamOptions(S.email)}</select></label>
        <label class="full">Buyer's preferred time (if not fixed)<input name="preferred_text" placeholder="e.g. Sabtu petang"></label>
        <label class="full">Location<input name="location" placeholder="Showroom address or call link"></label>
        <label class="check full"><input type="checkbox" name="wa_reminders" checked> When confirmed, send the buyer a WhatsApp confirmation and reminders</label>
        <div class="actions full"><button class="btn">Save appointment</button></div></form></details>` : ""}
    </section>

    <section class="card"><h2>Consent</h2>
      ${(consent || []).length ? `<ul class="list">${consent.map((x) => `<li>${esc(x.purpose)} · ${esc(x.channel)} ${badge(x.status, x.status === "granted" ? "ok" : "alert")}<small>${esc(x.source)} · ${esc(fmtDate(x.recorded_at))}</small></li>`).join("")}</ul>` : empty("No consent on record. Do not send marketing messages.")}
      ${can("advisor") ? `<details><summary>Record consent or opt-out</summary><form id="fco" class="form two">
        <label>Purpose<select name="purpose">${opt("service", "Service (reply to enquiry)")}${opt("marketing", "Marketing / promotions")}</select></label>
        <label>Channel<select name="channel">${["whatsapp", "phone", "email", "sms", "any"].map((x) => opt(x, x)).join("")}</select></label>
        <label>Status<select name="status">${opt("granted", "Granted")}${opt("withdrawn", "Withdrawn / opt-out")}</select></label>
        <label class="full">Evidence (required)<input name="evidence" required placeholder="e.g. Buyer said 'ok boleh hantar promo' on WhatsApp 12 Oct"></label>
        <div class="actions full"><button class="btn">Record</button></div></form></details>` : ""}
    </section>

    ${(handovers || []).length ? `<section class="card"><h2>Human handover</h2><ul class="list">${handovers.map((h) => `<li>${esc(h.reason)} ${badge(h.status, h.status === "open" ? "alert" : "")}<small>${esc(fmtDate(h.created_at))}${h.accepted_by ? " · " + esc(h.accepted_by) : ""}</small></li>`).join("")}</ul></section>` : ""}

    <section class="card"><h2>Timeline</h2>
      ${can("advisor") ? `<form id="fn" class="form"><textarea name="body" rows="2" required aria-label="Note or call summary" placeholder="Add a note or call summary…"></textarea><div class="actions"><select name="kind" aria-label="Type">${opt("note", "Note")}${opt("call", "Call")}</select><button class="btn">Add</button></div></form>` : ""}
      ${(acts || []).length ? `<ol class="timeline">${acts.map((a) => `<li class="k-${attr(a.kind)}"><div><b>${esc(a.kind.replace(/_/g, " "))}</b> <small>${esc(fmtDate(a.created_at))} · ${esc(a.actor)}</small></div>${a.body ? `<p>${esc(a.body)}</p>` : ""}</li>`).join("")}</ol>` : empty("No activity yet.")}
    </section>
    ${can("owner") ? `<section class="card danger"><h2>Personal data (PDPA)</h2><p class="note">Erasing anonymises this contact, their messages and notes, and removes them from the audit trail. Consent history is kept as proof. This cannot be undone.</p><button class="btn danger" id="erase">Erase personal data…</button></section>` : ""}
   </div>
  </div>`;

  const reload = () => keepPlace(el, () => leadDetail(el, id));
  const fc = $("#fc", el), fl = $("#fl", el), fq = $("#fq", el);
  [[fc, "contact"], [fl, "lead"], [fq, "qual"]].forEach(([f, k]) => can("advisor") && guardForm(f, `lead:${id}:${k}`));

  if (can("advisor")) {
    fc.onsubmit = (e) => { e.preventDefault(); const d = formData(fc);
      const ph = d.phone ? normalizePhone(d.phone) : null;
      if (d.phone && !ph) return toast("That phone number does not look valid.", "err");
      act(fc.querySelector("button"), async () => {
        await q(SB.from("ai_contacts").update({ full_name: d.full_name, salutation: d.salutation, phone_e164: ph, email: d.email, preferred_language: d.preferred_language, notes: d.notes }).eq("id", c.id).select("id"), { expectRows: true });
        clearDraft(fc); reload();
      }, "Contact saved"); };
    fl.onsubmit = (e) => { e.preventDefault(); const d = formData(fl);
      act(fl.querySelector("button"), async () => {
        await q(SB.from("ai_leads").update({ stage_id: d.stage_id, owner_email: d.owner_email, source_id: d.source_id, campaign_id: d.campaign_id, primary_project_id: d.primary_project_id, lost_reason: d.lost_reason, ai_paused: d.ai_paused }).eq("id", id).select("id"), { expectRows: true });
        clearDraft(fl); reload();
      }, "Lead saved"); };
    fq.onsubmit = (e) => { e.preventDefault(); const d = formData(fq);
      act(fq.querySelector("button"), async () => {
        const { asked_price, requested_brochure, ...rest } = d;
        const qual = { ...qf, ...rest, signals: { ...sig, asked_price, requested_brochure } };
        const projId = (lead.primary_project_id) || (interests && interests[0] && interests[0].project_id);
        const scored = scoreLead({ ...qual, project_price_from: projectPriceFrom(projId) }, {
          replies: inbound.count || 0, asked_price, requested_brochure,
          appointment_requested: (appts || []).some((a) => a.status !== "cancelled"),
          appointment_confirmed: (appts || []).some((a) => ["confirmed", "completed"].includes(a.status)),
        }, S.settings.scoring);
        await q(SB.from("ai_leads").update({ qualification: qual, score: scored.score, temperature: scored.temperature, score_rationale: scored.rationale }).eq("id", id).select("id"), { expectRows: true });
        await SB.from("ai_activities").insert({ lead_id: id, contact_id: c.id, kind: "qualification", body: `Score ${scored.score} → ${scored.temperature}` });
        clearDraft(fq); reload();
      }, "Qualification saved and lead rescored"); };

    const fi = $("#fi", el);
    fi.onsubmit = (e) => { e.preventDefault(); const d = formData(fi); if (!d.project_id) return;
      act(fi.querySelector("button"), async () => { await q(SB.from("ai_lead_interests").upsert({ lead_id: id, project_id: d.project_id, interest: d.interest })); reload(); }, "Interest saved"); };
    $$("[data-rm-int]", el).forEach((b) => b.onclick = () => act(b, async () => { await q(SB.from("ai_lead_interests").delete().eq("lead_id", id).eq("project_id", b.dataset.rmInt).select("lead_id"), { expectRows: true }); reload(); }, "Removed"));

    const ft = $("#ft", el);
    guardForm(ft, `lead:${id}:task`);
    ft.onsubmit = (e) => { e.preventDefault(); const d = formData(ft);
      act(ft.querySelector("button"), async () => { await q(SB.from("ai_tasks").insert({ lead_id: id, title: d.title, due_at: fromLocalInput(d.due_at), assignee_email: d.assignee_email })); clearDraft(ft); reload(); }, "Task added"); };
    $$("[data-done]", el).forEach((b) => b.onclick = () => act(b, async () => { await q(SB.from("ai_tasks").update({ status: "done" }).eq("id", b.dataset.done).select("id"), { expectRows: true }); reload(); }, "Task done"));

    const fa = $("#fa", el);
    guardForm(fa, `lead:${id}:appt`);
    fa.onsubmit = (e) => { e.preventDefault(); const d = formData(fa);
      if (d.status === "confirmed" && !d.start_at) return toast("A confirmed appointment needs a start time.", "err");
      if (!d.start_at && !d.preferred_text) return toast("Enter a start time or the buyer's preferred time.", "err");
      act(fa.querySelector("button"), async () => {
        await q(SB.from("ai_appointments").insert({ lead_id: id, kind: d.kind, project_id: d.project_id, start_at: fromLocalInput(d.start_at), end_at: fromLocalInput(d.end_at), status: d.status, advisor_email: d.advisor_email, preferred_text: d.preferred_text, location: d.location, calendar_provider: "manual", wa_reminders: d.wa_reminders !== false }));
        await SB.from("ai_activities").insert({ lead_id: id, contact_id: c.id, kind: "appointment", body: `${kindLabel(d.kind)} · ${d.status.replace(/_/g, " ")}${d.start_at ? " · " + fmtDate(fromLocalInput(d.start_at)) : ""}` });
        clearDraft(fa); reload();
      }, "Appointment saved"); };
    $$("[data-wa-rem]", el).forEach((b) => b.onclick = () => act(b, async () => {
      await q(SB.from("ai_appointments").update({ wa_reminders: !!b.dataset.on }).eq("id", b.dataset.waRem).select("id"), { expectRows: true }); reload();
    }, b.dataset.on ? "WhatsApp reminders on for this appointment" : "WhatsApp reminders off for this appointment"));
    $$("[data-appt]", el).forEach((s) => s.onchange = () => act(null, async () => {
      await q(SB.from("ai_appointments").update({ status: s.value }).eq("id", s.dataset.appt).select("id"), { expectRows: true }); reload();
    }, "Appointment updated"));

    const fco = $("#fco", el);
    fco.onsubmit = (e) => { e.preventDefault(); const d = formData(fco);
      act(fco.querySelector("button"), async () => { await q(SB.from("ai_consent_records").insert({ contact_id: c.id, channel: d.channel, purpose: d.purpose, status: d.status, source: "advisor_recorded", evidence: d.evidence })); reload(); }, "Consent recorded"); };

    const fn = $("#fn", el);
    guardForm(fn, `lead:${id}:note`);
    fn.onsubmit = (e) => { e.preventDefault(); const d = formData(fn);
      act(fn.querySelector("button"), async () => { await q(SB.from("ai_activities").insert({ lead_id: id, contact_id: c.id, kind: d.kind, body: d.body })); if (d.kind === "call") await SB.from("ai_leads").update({ last_contact_at: new Date().toISOString() }).eq("id", id); clearDraft(fn); reload(); }, "Added"); };

    const ho = $("#ho", el);
    if (ho) ho.onclick = () => handoverModal(lead, c, interests, reload);
    bindFinancing(el, { leadId: id, contactId: c.id, data: fin, qualification: qf, reload });
    bindRmkLeadCard(el, id, reload);
  }
  const er = $("#erase", el);
  if (er) er.onclick = () => {
    const reason = prompt("Reason for erasure (e.g. 'Customer request on WhatsApp 26 Oct'). Type a reason to continue:");
    if (!reason) return;
    if (!confirm("Erase this person's personal data permanently?")) return;
    act(er, async () => { await q(SB.rpc("ai_erase_contact", { p_contact: c.id, p_reason: reason })); reload(); }, "Personal data erased");
  };
}

function handoverModal(lead, c, interests, reload) {
  const reasons = { customer_request: "Buyer asked for a human", ready_to_buy: "Ready to book / purchase", negotiation: "Discount / negotiation", legal: "Legal or contract question", complaint: "Complaint", financing: "Financing needs professional assessment", conflicting_info: "Project info conflicting / missing", sensitive: "Sensitive situation", other: "Other" };
  const dlg = modal("Flag for human handover", `<form id="fh" class="form">
    <label>Reason<select name="reason">${Object.entries(reasons).map(([k, v]) => opt(k, v)).join("")}</select></label>
    <label>Summary for the advisor<textarea name="summary" rows="4" required placeholder="What does the buyer want? What has been answered? What is outstanding?"></textarea></label>
    <label>Recommended next action<input name="next" placeholder="e.g. Call to discuss booking fee"></label>
    <div class="actions"><button class="btn pri">Flag</button></div></form>`);
  const f = $("#fh", dlg);
  f.onsubmit = (e) => { e.preventDefault(); const d = formData(f);
    act(f.querySelector("button"), async () => {
      const q2 = lead.qualification || {};
      await q(SB.from("ai_handover_events").insert({ lead_id: lead.id, reason: d.reason, summary: {
        text: d.summary, next_action: d.next, lead_code: lead.lead_code, name: c.full_name, phone: c.phone_e164, email: c.email,
        projects: (interests || []).map((i) => projectName(i.project_id)), budget: [q2.budget_min, q2.budget_max].filter(Boolean).join("–"),
        score: lead.score, temperature: lead.temperature, rationale: lead.score_rationale, stage: stageName(lead.stage_id), flagged_by: S.email } }));
      await q(SB.from("ai_leads").update({ handover_status: "requested" }).eq("id", lead.id).select("id"), { expectRows: true });
      await SB.from("ai_activities").insert({ lead_id: lead.id, contact_id: c.id, kind: "handover", body: reasons[d.reason] + ": " + d.summary });
      dlg.done(); reload();
    }, "Flagged for a human advisor"); };
}

/* ======================= Pipeline ======================= */
export async function pipeline(el) {
  const rows = (await q(SB.from("ai_leads").select("id,lead_code,temperature,score,stage_id,owner_email,primary_project_id,updated_at,contact:ai_contacts(full_name,phone_e164,email)").is("closed_at", null).order("updated_at", { ascending: false }).limit(2000))) || [];
  const cols = openStages();
  el.innerHTML = `<div class="page-head"><h1>Sales pipeline</h1><p class="sub">${rows.length} open leads · move a lead with its stage menu</p>${can("manager") ? `<a class="btn" href="#/settings/pipeline">Edit stages</a>` : ""}</div>
  <div class="kanban">${cols.map((s) => { const ls = rows.filter((l) => l.stage_id === s.id); return `<section class="col-k"><h3>${esc(s.name)} <span>${ls.length}</span></h3>
    ${ls.map((l) => `<article class="kcard"><a href="#/lead/${attr(l.id)}"><b>${esc(contactName(l.contact))}</b></a><small>${esc(l.lead_code)} · ${esc(projectName(l.primary_project_id) || "No project")}</small>
      <div>${tempBadge(l.temperature)} <small>${esc(l.owner_email || "Unassigned")}</small></div>
      ${can("advisor") ? `<select data-move="${attr(l.id)}" aria-label="Move ${attr(l.lead_code)}">${S.stages.filter((x) => x.active).map((x) => opt(x.id, x.name, l.stage_id)).join("")}</select>` : ""}</article>`).join("") || `<p class="empty sm">Empty</p>`}</section>`; }).join("")}</div>`;
  $$("[data-move]", el).forEach((s) => s.onchange = () => act(null, async () => {
    await q(SB.from("ai_leads").update({ stage_id: s.value }).eq("id", s.dataset.move).select("id"), { expectRows: true });
    pipeline(el);
  }, "Moved to " + stageName(s.value)));
}

/* ======================= Appointments ======================= */
export async function appointments(el, params) {
  const scope = ["upcoming", "all", "archived"].includes(params.get("scope")) ? params.get("scope") : "upcoming";
  let query = SB.from("ai_appointments").select("*, lead:ai_leads(id,lead_code,contact:ai_contacts(full_name,phone_e164))").limit(500);
  if (scope === "archived") query = query.not("archived_at", "is", null).order("archived_at", { ascending: false });
  else {
    query = query.is("archived_at", null);
    if (scope === "upcoming") query = query.in("status", ["pending_confirmation", "confirmed", "rescheduled"]).order("start_at", { nullsFirst: true });
    else query = query.order("created_at", { ascending: false });
  }
  const rows = (await q(query)) || [];
  const adv = can("advisor");
  const seg = (k, label) => `<a class="${scope === k ? "on" : ""}" href="#/appointments?scope=${k}">${label}</a>`;
  el.innerHTML = `<div class="page-head"><h1>Appointments</h1><div class="seg">${seg("upcoming", "Upcoming &amp; pending")}${seg("all", "All")}${seg("archived", "Archived")}</div></div>
  <div class="card notice"><div>${scope === "archived" ? "Archived appointments are hidden from the other lists. Nothing was deleted: <b>Restore</b> brings one back." : `${flag("calendar_booking") ? "<b>Calendar booking is on.</b> The AI offers free Google Calendar slots and books the one the buyer picks; the buyer gets a confirmation only after the event exists." : "AI-requested slots stay <b>pending confirmation</b> until you confirm them here."} Confirming creates the Google Calendar event when the calendar is connected (Integrations). Use <b>Close…</b> to mark one done, a no-show or cancelled, or to archive it.`}</div></div>
  ${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Type</th><th>Buyer</th><th>Project</th><th>Advisor</th><th>Status</th><th></th></tr></thead><tbody>
  ${rows.map((a) => `<tr><td data-label="When">${a.start_at ? esc(fmtDate(a.start_at)) : `<i>Preferred: ${esc(a.preferred_text || "—")}</i>`}</td><td data-label="Type">${esc(kindLabel(a.kind))}</td>
    <td data-label="Buyer"><a href="#/lead/${attr(a.lead?.id)}">${esc(contactName(a.lead?.contact))}</a><small>${esc(a.lead?.lead_code || "")}</small></td><td data-label="Project">${esc(projectName(a.project_id)) || "—"}</td>
    <td data-label="Advisor">${esc(a.advisor_email || "—")}</td><td data-label="Status">${apptBadge(a.status)}${a.calendar_event_id && a.status !== "cancelled" ? `<small>On Google Calendar</small>` : ""}${a.archived_at ? `<small>Archived ${esc(fmtDate(a.archived_at))}</small>` : ""}${a.notes ? `<small>${esc(a.notes)}</small>` : ""}</td>
    <td class="row-actions">${!adv ? "" : a.archived_at ? `<button class="btn" data-restore="${attr(a.id)}" data-busy="Restoring…">Restore</button>`
      : `${["pending_confirmation", "rescheduled"].includes(a.status) && !a.calendar_event_id ? `<button class="btn" data-confirm="${attr(a.id)}">Confirm…</button>` : ""}<button class="btn" data-close-appt="${attr(a.id)}">Close…</button>`}</td></tr>`).join("")}</tbody></table></div>`
    : empty(scope === "archived" ? "No archived appointments." : "No appointments.")}`;
  const reload = () => keepPlace(el, () => appointments(el, params));
  const find = (id) => rows.find((a) => a.id === id);
  $$("[data-confirm]", el).forEach((b) => b.onclick = () => confirmAppointment(find(b.dataset.confirm), reload));
  $$("[data-close-appt]", el).forEach((b) => b.onclick = () => closeAppointment(find(b.dataset.closeAppt), reload));
  $$("[data-restore]", el).forEach((b) => b.onclick = () => act(b, async () => {
    await q(SB.from("ai_appointments").update({ archived_at: null, archived_by: null }).eq("id", b.dataset.restore).select("id"), { expectRows: true }); reload();
  }, "Appointment restored"));
}

/** A confirmed appointment still ahead: reminders may go out, so it is cancelled or completed rather than hidden. */
const stillBooked = (a) => ["confirmed", "rescheduled"].includes(a.status) && a.start_at && new Date(a.start_at) > new Date();

function closeAppointment(a, done) {
  const open = ["pending_confirmation", "confirmed", "rescheduled"].includes(a.status), booked = ["confirmed", "rescheduled"].includes(a.status);
  const onCal = a.calendar_event_id && a.calendar_provider === "google";
  const choice = (k, label, note, extra = "") => `<button type="button" class="btn${k === "cancel" ? " danger" : ""}" data-choice="${k}"${extra}>${label}</button><p class="note">${note}</p>`;
  const dlg = modal("Close appointment", `<div class="close-appt">
    <p class="note">${esc(kindLabel(a.kind))} · ${esc(contactName(a.lead?.contact))}${a.start_at ? " · " + esc(fmtDate(a.start_at)) : a.preferred_text ? " · preferred: " + esc(a.preferred_text) : ""} · ${apptBadge(a.status)}</p>
    ${booked ? choice("completed", "Done – we met", "Marks it completed. No message is sent.") + choice("no_show", "No-show", "The buyer did not come. You get a Telegram reminder to follow up.") : ""}
    ${open ? choice("cancel", booked ? "Cancel appointment" : "Cancel request", `Marks it cancelled and stops its WhatsApp reminders.${onCal ? " The Google Calendar event is deleted." : ""} The buyer is <b>not</b> messaged, so tell them yourself if needed.`, ' data-busy="Cancelling…"') : ""}
    ${stillBooked(a) ? `<p class="note">To archive a booked appointment that is still ahead, cancel it or mark it done first.</p>`
      : choice("archive", "Archive (hide from list)", "Only hides it: no message, no alert, nothing deleted. Find it under <b>Archived</b> and restore it any time.", ' data-busy="Archiving…"')}
  </div>`);
  $$("[data-choice]", dlg).forEach((b) => b.onclick = () => act(b, async () => {
    const k = b.dataset.choice;
    if (k === "cancel") {
      if (!confirm(`Cancel this appointment?${onCal ? " Its Google Calendar event will be deleted." : ""}`)) return;
      const r = await api("/api/sales/appointments/cancel", { method: "POST", body: JSON.stringify({ appointment_id: a.id }) });
      dlg.done(); done(); toast(`Appointment cancelled${r.calendar ? " and removed from Google Calendar" : ""}.`);
    } else if (k === "archive") {
      await q(SB.from("ai_appointments").update({ archived_at: new Date().toISOString(), archived_by: S.email }).eq("id", a.id).select("id"), { expectRows: true });
      dlg.done(); done(); toast("Appointment archived. Find it under Archived.");
    } else {
      await q(SB.from("ai_appointments").update({ status: k }).eq("id", a.id).select("id"), { expectRows: true });
      dlg.done(); done(); toast(k === "completed" ? "Marked done." : "Marked as a no-show.");
    }
  }));
}

async function confirmAppointment(a, done) {
  const ap = S.settings?.business?.appointments || {};
  // in person: the project's showroom by default (same rule as the server); calls have no place
  const inPerson = ["showroom_visit", "property_viewing"].includes(a.kind);
  const facts = inPerson && a.project_id ? ((await q(SB.from("ai_project_facts").select("showroom_address").eq("project_id", a.project_id).limit(1))) || [])[0] : null;
  const where = a.location || (inPerson ? facts?.showroom_address || ap.location || "" : "");
  const dlg = modal("Confirm appointment", `<form id="fc" class="form two">
    <p class="note full">${esc(kindLabel(a.kind))} · ${esc(contactName(a.lead?.contact))}${a.preferred_text ? ` · buyer asked for <i>${esc(a.preferred_text)}</i>` : ""}</p>
    <label>Date and time<input name="start" type="datetime-local" required value="${attr(toLocalInput(a.start_at))}"></label>
    <label>Duration (minutes)<input name="duration_minutes" type="number" min="15" max="480" step="15" value="${attr(ap.duration_minutes || 60)}"></label>
    <label class="full">Location<input name="location" maxlength="300" value="${attr(where)}" placeholder="${inPerson ? "e.g. M MIRA sales gallery, Jalan …" : "Not needed for a call"}"></label>
    <label>Advisor<select name="advisor_email">${teamOptions(a.advisor_email || S.email)}</select></label>
    <label class="check"><input type="checkbox" name="notify_buyer" checked> Send the buyer a WhatsApp confirmation</label>
    <div class="full"><button type="button" class="btn" id="slots" data-busy="Checking calendar…">Show free calendar slots</button><div class="samples" id="slotlist"></div></div>
    <div class="actions full"><button class="btn pri" type="submit" data-busy="Confirming…">Confirm appointment</button></div></form>`, { wide: true });
  const f = $("#fc", dlg);
  $("#slots", dlg).onclick = (e) => act(e.currentTarget, async () => {
    const { slots } = await api("/api/sales/appointments/slots");
    $("#slotlist", dlg).innerHTML = slots.length ? slots.map((x) => `<button type="button" class="chip" data-start="${attr(x.start)}">${esc(x.label_en)}</button>`).join("") : `<span class="note">No free slots in the coming days.</span>`;
    $$("[data-start]", dlg).forEach((c) => c.onclick = () => { f.start.value = toLocalInput(c.dataset.start); });
  });
  f.onsubmit = (e) => { e.preventDefault(); const v = formData(f);
    act(f.querySelector("button[type=submit]"), async () => {
      const r = await api("/api/sales/appointments/confirm", { method: "POST", body: JSON.stringify({ appointment_id: a.id, start_at: fromLocalInput(v.start), duration_minutes: v.duration_minutes, location: v.location || "", advisor_email: v.advisor_email, notify_buyer: v.notify_buyer }) });
      dlg.done(); done();
      toast(`Confirmed${r.calendar ? " and added to Google Calendar" : " (Google Calendar is not connected, so no calendar event was created)"}.${v.notify_buyer ? (r.buyer_notified ? " The buyer was sent a WhatsApp confirmation." : ` Buyer not messaged: ${r.note || "not possible"}`) : ""}`, r.buyer_notified || !v.notify_buyer ? "ok" : "warn");
    }); };
}

/* ======================= Handover queue ======================= */
export async function handover(el) {
  const rows = (await q(SB.from("ai_handover_events").select("*, lead:ai_leads(id,lead_code,owner_email,contact:ai_contacts(full_name,phone_e164))").neq("status", "resolved").order("created_at"))) || [];
  el.innerHTML = `<div class="page-head"><h1>Human handover queue</h1><p class="sub">${rows.length} waiting · oldest first</p></div>
  ${rows.length ? rows.map((h) => { const s = h.summary || {}; return `<article class="card ho">
    <div class="ho-h"><div><a href="#/lead/${attr(h.lead?.id)}"><b>${esc(contactName(h.lead?.contact))}</b></a> <small>${esc(h.lead?.lead_code || "")}</small></div>${badge(h.reason.replace(/_/g, " "), "alert")} ${badge(h.status)}</div>
    <p>${esc(s.text || "")}</p>
    <dl class="kv">${[["Projects", (s.projects || []).join(", ")], ["Budget", s.budget], ["Score", s.score !== undefined && s.score !== null ? s.score + " (" + (s.temperature || "") + ")" : ""], ["Stage", s.stage], ["Next action", s.next_action], ["Phone", s.phone ? formatPhone(s.phone) : ""], ["Flagged", fmtDate(h.created_at) + (s.flagged_by ? " by " + s.flagged_by : "")], ["Accepted by", h.accepted_by]].filter((x) => x[1]).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    ${can("advisor") ? `<div class="actions">${h.status === "open" ? `<button class="btn pri" data-accept="${attr(h.id)}" data-lead="${attr(h.lead?.id)}">Accept &amp; take over</button>` : ""}<button class="btn" data-resolve="${attr(h.id)}" data-lead="${attr(h.lead?.id)}">Mark resolved</button></div>` : ""}</article>`; }).join("") : empty("Nobody is waiting for a human right now.")}`;
  $$("[data-accept]", el).forEach((b) => b.onclick = () => act(b, async () => {
    await q(SB.from("ai_handover_events").update({ status: "accepted", accepted_by: S.email, accepted_at: new Date().toISOString() }).eq("id", b.dataset.accept).select("id"), { expectRows: true });
    await q(SB.from("ai_leads").update({ handover_status: "assigned", owner_email: S.email, ai_paused: true }).eq("id", b.dataset.lead).select("id"), { expectRows: true });
    handover(el);
  }, "You own this conversation now. AI is paused for this lead."));
  $$("[data-resolve]", el).forEach((b) => b.onclick = () => act(b, async () => {
    await q(SB.from("ai_handover_events").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", b.dataset.resolve).select("id"), { expectRows: true });
    await q(SB.from("ai_leads").update({ handover_status: "resolved" }).eq("id", b.dataset.lead).select("id"), { expectRows: true });
    handover(el);
  }, "Resolved. AI stays paused until you resume it on the lead."));
}

/* ======================= Inbox ======================= */
const TICK = { queued: ["…", "Sending"], sent: ["✓", "Sent"], delivered: ["✓✓", "Delivered"], read: ["✓✓", "Read"], failed: ["⚠", "Not delivered"], received: ["", ""], skipped: ["–", "Skipped"] };
const WINDOW_MS = 24 * 3600e3 - 60e3;
const SENDER = (m) => (m.direction === "inbound" ? "" : m.sender_type === "ai" ? "AI assistant" : m.sender_type === "system" ? "Automatic" : m.provider === "whatsapp_app" ? "Sent from the WhatsApp app" : m.sender_email || "Staff");

/** Who owns a conversation right now: closed, a person (takeover), the AI with a follow-up scheduled, or the AI. */
export function ownership(c, pendingFollowUp = false) {
  if (c.status === "closed" || c.lead?.closed_at) return ["Closed", ""];
  if (c.mode !== "ai" || c.lead?.ai_paused) return ["Human takeover", "warn"];
  if (pendingFollowUp) return ["Follow-up pending", "ok"];
  return ["AI active", "ok"];
}

export async function inbox(el, params) {
  const sel = params?.get("c") || "";
  const rows = (await q(SB.from("ai_conversations").select("*, contact:ai_contacts(full_name,phone_e164,wa_id), lead:ai_leads(id,lead_code,ai_paused,closed_at)").eq("status", "open").order("last_inbound_at", { ascending: false, nullsFirst: false }).limit(200))) || [];
  // scheduled 12-hour follow-ups (the list still works on a database without automation jobs)
  let pending = new Set();
  try { pending = new Set(((await q(SB.from("ai_automation_jobs").select("conversation_id").eq("status", "scheduled").eq("kind", "smart_follow_up").limit(500))) || []).map((j) => j.conversation_id)); } catch { /* not installed yet */ }
  const on = flag("whatsapp_outbound");
  el.innerHTML = `<div class="page-head"><h1>WhatsApp inbox</h1><p class="sub">${rows.length} open conversation${rows.length === 1 ? "" : "s"}</p></div>
  ${on ? "" : `<div class="card notice"><div><b>WhatsApp sending is off.</b> Messages from buyers still arrive here once WhatsApp is connected (Integrations), but nothing is sent until an owner switches on "WhatsApp sending" in Settings → Feature switches.</div></div>`}
  <div class="inbox${sel ? " has-thread" : ""}"><ul class="conv-list card">${rows.length ? rows.map((c) => { const [label, kind] = ownership(c, pending.has(c.id)); return `<li class="${c.id === sel ? "on" : ""}"><a href="#/inbox?c=${attr(c.id)}"><b>${esc(contactName(c.contact))}</b>
      ${badge(label, kind)} ${c.unread_count ? badge(String(c.unread_count), "alert") : ""}<small>${esc(c.lead?.lead_code || "")} · ${esc(ago(c.last_inbound_at || c.created_at))}</small></a></li>`; }).join("") : `<li>${empty("No WhatsApp conversations yet.")}</li>`}</ul>
    <section class="thread card" id="thread">${sel ? "" : `<p class="note">Choose a conversation.</p>`}</section></div>`;
  if (sel) await thread($("#thread", el), rows.find((c) => c.id === sel), pending.has(sel), () => keepPlace(el, () => inbox(el, params)));
}

async function thread(box, c, pendingFollowUp, reload) {
  if (!c) { box.innerHTML = empty("Conversation not found or closed."); return; }
  const msgs = (await q(SB.from("ai_messages").select("id,direction,sender_type,sender_email,provider,body,media,status,status_reason,template_name,created_at").eq("conversation_id", c.id).order("created_at", { ascending: false }).limit(200))) || [];
  msgs.reverse();
  const adv = can("advisor");
  const aiOn = c.mode === "ai" && !c.lead?.ai_paused;
  const [label, kind] = ownership(c, pendingFollowUp);
  const auto = c.automation || {};
  const open = c.last_inbound_at && Date.now() - new Date(c.last_inbound_at) < WINDOW_MS;
  const tpls = adv && !open ? (await q(SB.from("ai_message_templates").select("id,name,lang,category").eq("wa_status", "approved").eq("active", true).not("wa_template_name", "is", null).order("name"))) || [] : [];
  box.innerHTML = `<div class="ho-h"><div><a class="link back" href="#/inbox">← All</a> <b>${esc(contactName(c.contact))}</b> <small>+${esc(c.contact?.wa_id || c.contact?.phone_e164 || "")}</small>
      ${c.lead ? `<a href="#/lead/${attr(c.lead.id)}"><small>${esc(c.lead.lead_code)}</small></a>` : ""}</div>
    <div>${badge(label, kind)} ${adv ? (aiOn ? `<button class="btn" id="take">Take over</button>` : `<button class="btn" id="back">Resume AI</button>`) : ""}</div></div>
    <p class="note own">${aiOn
      ? "The AI answers this buyer until a person replies. Sending a reply here (or from the WhatsApp app) hands the chat to you."
      : `A person is handling this chat${c.takeover_by ? ` (${esc(c.takeover_by)}` + (c.human_takeover_at ? `, since ${esc(fmtDate(c.human_takeover_at))})` : ")") : ""}. The AI does not reply or follow up until someone presses <b>Resume AI</b>.`}
      ${c.last_human_reply_at ? ` Last staff reply ${esc(ago(c.last_human_reply_at))}.` : ""}${c.last_follow_up_at ? ` Last automatic follow-up ${esc(ago(c.last_follow_up_at))}.` : ""}</p>
    ${adv ? `<form id="auto" class="auto-row"><label class="check"><input type="checkbox" name="follow_ups"${auto.follow_ups === false ? "" : " checked"}> Automatic follow-up</label>
      <label class="check"><input type="checkbox" name="appointment_reminders"${auto.appointment_reminders === false ? "" : " checked"}> Appointment reminders</label></form>` : ""}
    <div class="chat" id="msgs">${msgs.map((m) => `<div class="msg ${m.direction === "inbound" ? "buyer" : "ai"}"><div class="bubble">${esc(m.body || (m.media || []).map((x) => "[" + x.type + "]").join(" ") || "")}</div>
      <small class="meta">${esc(SENDER(m))}${m.template_name ? " · template " + esc(m.template_name) : ""} · ${esc(fmtDate(m.created_at))}${m.direction === "outbound" ? ` <span class="tick ${esc(m.status)}" title="${attr(TICK[m.status]?.[1] || m.status)}">${esc(TICK[m.status]?.[0] || "")}</span>${["failed", "skipped"].includes(m.status) && m.status_reason ? ` <span class="err">${esc(m.status_reason)}</span>` : ""}` : ""}</small></div>`).join("") || empty("No messages yet.")}</div>
    ${adv ? (open ? `<form id="reply" class="say"><label class="sr" for="rtext">Reply</label><textarea id="rtext" name="text" rows="2" maxlength="4096" required placeholder="Reply on WhatsApp as ${attr(S.email)}…"></textarea>
        <button class="btn pri" data-busy="Sending…"${on() ? "" : " disabled"}>Send</button></form>`
      : `<div class="card notice"><div>More than 24 hours since the buyer's last message, so WhatsApp only allows an <b>approved template</b> now.</div></div>
        ${tpls.length ? `<form id="tform" class="say"><label class="sr" for="tsel">Template</label><select id="tsel" name="template_id">${tpls.map((t) => opt(t.id, `${t.name} (${t.lang.toUpperCase()}, ${t.category})`)).join("")}</select><button class="btn pri" data-busy="Sending…"${on() ? "" : " disabled"}>Send template</button></form>` : `<p class="note">No approved templates yet — add them under Templates &amp; objections once Meta approves them.</p>`}`) : ""}`;
  const list = $("#msgs", box); list.scrollTop = list.scrollHeight;
  if (adv && c.unread_count) q(SB.from("ai_conversations").update({ unread_count: 0 }).eq("id", c.id)).catch(() => {});
  // ownership changes go through the database functions, which also cancel or drop the AI's pending work
  const setMode = (ai) => {
    if (ai && !confirm("Resume AI for this buyer? The AI will answer their next message and may follow up automatically.")) return;
    act(ai ? $("#back", box) : $("#take", box), async () => {
      await q(SB.rpc(ai ? "ai_resume_ai" : "ai_take_over", { p_conversation: c.id }));
      reload();
    }, ai ? "AI resumed — it answers this buyer's next message." : "You are handling this chat. The AI will not reply.");
  };
  if ($("#take", box)) $("#take", box).onclick = () => setMode(false);
  if ($("#back", box)) $("#back", box).onclick = () => setMode(true);
  const af = $("#auto", box);
  if (af) af.onchange = (e) => act(null, async () => {
    const next = { ...auto, [e.target.name]: e.target.checked };
    await q(SB.from("ai_conversations").update({ automation: next }).eq("id", c.id).select("id"), { expectRows: true });
    Object.assign(auto, next);
  }, e.target.checked ? "Switched on for this buyer" : "Switched off for this buyer");
  const send = (form, payload, msg) => { form.onsubmit = (e) => { e.preventDefault();
    act(form.querySelector("button"), async () => { await api("/api/sales/whatsapp/send", { method: "POST", body: JSON.stringify({ conversation_id: c.id, ...payload() }) }); clearDraft(form); reload(); }, msg); }; };
  // an unsent reply survives Take over / Resume AI and switching chats
  if ($("#reply", box)) { const f = $("#reply", box); guardForm(f, "reply:" + c.id); send(f, () => ({ text: f.text.value }), "Sent on WhatsApp — you are now handling this chat");
    f.text.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } }); }
  if ($("#tform", box)) { const f = $("#tform", box); send(f, () => ({ template_id: f.template_id.value }), "Template sent"); }
  function on() { return flag("whatsapp_outbound"); }
}

export { contactName, kindLabel, errText, api };
