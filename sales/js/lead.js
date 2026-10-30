// AI Sales dashboard — the lead workspace: everything about one client on one page. A header with quick actions;
// Summary (AI conversation summary, next best action, conflicts, score), Profile (contact, client profile, property
// interests, qualification), Sales (stage, tasks, appointments, workflows, financing, consent) and Activity
// (timeline, notes, field history). The WhatsApp conversation sits beside them on wide screens and is its own tab on
// narrow ones; it is the inbox's own conversation view, so there is one conversation history.
import { SB, S, can, $, $$, esc, attr, fmtDate, ago, q, act, toast, guardForm, clearDraft, formData, modal, tempBadge, badge, opt, empty, ro,
  projectName, stageName, projectPriceFrom, fromLocalInput, keepPlace, api } from "./core.js";
import { contactName, kindLabel, apptBadge, KIND, APPT, teamOptions, projectOptions, thread } from "./crm.js";
import { normalizePhone, formatPhone } from "../shared/phone.mjs";
import { scoreLead } from "../shared/scoring.mjs";
import { loadFinancing, financingSection, bindFinancing } from "./financing.js";
import { leadWorkflowsCard, bindLeadWorkflowsCard } from "./workflows.js";
import { PROFILE_GROUPS, PROFILE_FIELDS, QUAL_FIELDS, FIELD, FIELD_STATUS, fieldLabel, statusOf, showValue } from "../shared/profile.mjs";
import { icon } from "./icons.js";
import { addressFor, nameGender } from "../shared/salutation.mjs";

const TABS = [["summary", "Summary"], ["conversation", "Conversation"], ["profile", "Profile"], ["sales", "Sales"], ["activity", "Activity"]];
const PRIORITY = { primary: "Primary interest", alternative: "Alternative option", comparison: "Comparison only", no_longer: "No longer interested" };
const STATUS_KIND = { confirmed: "ok", inferred: "warn", conflict: "alert", missing: "" };
const STATUS_SHORT = { confirmed: "Confirmed", inferred: "Inferred", conflict: "Conflict", missing: "Not provided" };
const ACT_FILTER = { all: "All", stage_change: "Stages", profile_update: "Profile", tasks: "Tasks & appointments", note: "Notes & calls", ai: "AI" };
const actGroup = (k) => (["appointment", "assignment"].includes(k) ? "tasks" : ["call", "note", "website_enquiry"].includes(k) ? "note" : ["ai_summary", "message_summary", "handover"].includes(k) ? "ai" : k === "qualification" ? "profile_update" : k);
const stageOf = (id) => S.stages.find((s) => s.id === id) || {};
const stageChip = (s) => `<span class="stage-chip c-${attr(s.color || "slate")}">${esc(s.name || "—")}</span>`;
const isBlank = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);

export async function leadWorkspace(el, params, id) {
  const lead = await q(SB.from("ai_leads").select("*, contact:ai_contacts(*)").eq("id", id).maybeSingle());
  if (!lead) { el.innerHTML = empty("Lead not found, or you do not have access."); return; }
  const c = lead.contact, adv = can("advisor");
  const [acts, tasks, appts, interests, consent, handovers, inbound, fin, wfCard, convs, fieldHistory, jobs] = await Promise.all([
    q(SB.from("ai_activities").select("*").eq("lead_id", id).order("created_at", { ascending: false }).limit(300)),
    q(SB.from("ai_tasks").select("*").eq("lead_id", id).order("status").order("due_at")),
    q(SB.from("ai_appointments").select("*").eq("lead_id", id).order("created_at", { ascending: false })),
    q(SB.from("ai_lead_interests").select("*").eq("lead_id", id).order("created_at")),
    q(SB.from("ai_consent_current").select("*").eq("contact_id", c.id)),
    q(SB.from("ai_handover_events").select("*").eq("lead_id", id).order("created_at", { ascending: false })),
    SB.from("ai_messages").select("id, ai_conversations!inner(contact_id)", { count: "exact", head: true }).eq("ai_conversations.contact_id", c.id).eq("direction", "inbound"),
    loadFinancing(id),
    leadWorkflowsCard(id).catch(() => ""),
    q(SB.from("ai_conversations").select("*, contact:ai_contacts(full_name,phone_e164,wa_id), lead:ai_leads(id,lead_code,ai_paused,closed_at)").eq("contact_id", c.id).eq("channel", "whatsapp").order("updated_at", { ascending: false }).limit(1)).catch(() => []),
    q(SB.from("ai_lead_field_history").select("*").eq("lead_id", id).order("at", { ascending: false }).limit(100)).catch(() => []),
    q(SB.from("ai_automation_jobs").select("kind,run_at,status").eq("lead_id", id).eq("status", "scheduled").order("run_at").limit(5)).catch(() => []),
  ]);
  const conv = (convs || [])[0] || null;
  const qf = lead.qualification || {}, sig = qf.signals || {}, pf = lead.profile || {}, meta = lead.profile_meta || {}, sm = lead.ai_summary || {};
  const stage = stageOf(lead.stage_id);
  const tab = TABS.some(([k]) => k === params.get("tab")) ? params.get("tab") : "summary";
  const valueOf = (k) => (k in FIELD && QUAL_FIELDS.some((f) => f.key === k) ? qf[k] : pf[k]);
  const lastTouch = [conv?.last_inbound_at, conv?.last_outbound_at, lead.last_contact_at].filter(Boolean).sort().pop();
  const aiState = !conv ? ["No WhatsApp chat", ""] : lead.ai_paused || conv.mode !== "ai" ? ["A person is handling", "warn"] : ["AI active", "ok"];
  const openTasks = (tasks || []).filter((t) => t.status === "open");
  const nextFollow = [...openTasks.filter((t) => t.due_at).map((t) => ({ at: t.due_at, what: "Task: " + t.title })), ...(jobs || []).map((j) => ({ at: j.run_at, what: j.kind === "workflow_follow_up" ? "Workflow reminder" : j.kind === "smart_follow_up" ? "AI check-in" : "Appointment message" }))]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
  const conflicts = Object.entries(meta).filter(([, m]) => m?.conflict);

  // a value row with its evidence status
  const row = (k, label = fieldLabel(k), value = valueOf(k), st = statusOf(value, meta[k])) =>
    `<div class="kvr${st === "missing" ? " miss" : ""}"><dt>${esc(label)}</dt><dd>${st === "missing" ? "—" : esc(showValue(k, value) || String(value))}${st !== "missing" || meta[k]?.conflict ? ` <span class="st ${STATUS_KIND[st]}" title="${attr(FIELD_STATUS[st])}${meta[k]?.source ? " · " + attr(meta[k].source === "ai" ? "from the conversation" : "entered by " + (meta[k].by || "staff")) : ""}">${STATUS_SHORT[st]}</span>` : ""}</dd></div>`;
  const plain = (label, html, missing = false) => `<div class="kvr${missing ? " miss" : ""}"><dt>${esc(label)}</dt><dd>${html || "—"}</dd></div>`;
  const budget = [qf.budget_min, qf.budget_max].filter(Boolean).map((v) => "RM" + Number(v).toLocaleString("en-MY")).join(" – ");
  const others = (interests || []).filter((i) => i.project_id !== lead.primary_project_id && i.priority !== "no_longer");
  const section = (title, rows) => { const n = rows.filter((r) => r.includes('class="kvr miss"')).length;
    return `<div class="sum-sec"><h3>${esc(title)}</h3><dl class="kvl">${rows.join("")}</dl>${n ? `<button type="button" class="link more-miss">${n} not provided</button>` : ""}</div>`; };

  const summaryHtml = `
    <section class="card ai-sum" id="aisum"><div class="card-h"><h2>${icon("sparkle", { size: 18 })} AI Conversation Summary</h2>
        ${adv ? `<div class="row-actions"><button class="btn sm" id="refsum" data-busy="Reading the conversation…">${icon("refresh", { size: 16 })}Refresh</button><button class="btn sm" id="editsum">Edit</button></div>` : ""}</div>
      <p class="sum-text" id="sumtext">${sm.text ? esc(sm.text) : `<span class="note">No summary yet. It is written from the WhatsApp conversation as the buyer replies${adv ? ", or press Refresh" : ""}.</span>`}</p>
      ${sm.updated_at ? `<p class="note sm">${sm.source === "staff" ? "Edited by " + esc(sm.updated_by) : "Written by the AI from the conversation"} · ${esc(ago(sm.updated_at))}. Facts only; the next action below is a recommendation.</p>` : ""}
      <div class="sum-grid">
        ${section("Property interest", [
          plain("Main property", lead.primary_project_id ? esc(projectName(lead.primary_project_id)) : "", !lead.primary_project_id),
          plain("Also considering", others.map((i) => esc(projectName(i.project_id)) + ` <small class="inl">${esc(PRIORITY[i.priority] || "")}</small>`).join(", "), !others.length),
          row("bedrooms", "Preferred unit / bedrooms"), row("size_sqft"),
          plain("Budget", budget ? esc(budget) : "", !budget), row("preferred_location"), row("concerns", "Questions & concerns")])}
        ${section("Personal profile", [
          plain("Name", esc(contactName(c)) + (c.salutation ? ` <small class="inl">${esc(c.salutation)}</small>` : "")),
          plain("Language", esc({ ms: "Bahasa Malaysia", en: "English", mixed: "Mixed / Manglish" }[c.preferred_language] || ""), !c.preferred_language),
          ...["age_range", "residential_area", "work_area", "occupation", "marital_status", "occupants"].map((k) => row(k))])}
        ${section("Lifestyle & location", ["commute_mode", "transport_needs", "area_familiarity", "area_info_needed", "proximity", "recreation"].map((k) => row(k)))}
        ${section("Purchase intent", [row("purpose"), row("first_home"), row("financing"), row("max_monthly_instalment"), row("motivation"), row("timeline_months"), row("decision_makers")])}
        ${section("Current progress", [
          plain("Stage", stageChip(stage)), plain("Last interaction", lastTouch ? esc(ago(lastTouch)) : "", !lastTouch),
          plain("Last client question", sm.last_client_question ? `“${esc(sm.last_client_question)}”` : "", !sm.last_client_question),
          plain("Outstanding", esc(sm.outstanding || ""), !sm.outstanding), row("documents_pending"),
          plain("Next follow-up", nextFollow ? `${esc(fmtDate(nextFollow.at))} <small class="inl">${esc(nextFollow.what)}</small>` : "", !nextFollow)])}
      </div>
      <p class="note sm">Every field can be edited on the Profile tab. Unknown details are never guessed: <span class="st ok">Confirmed</span> the client said it, <span class="st warn">Inferred</span> needs confirming, <span class="st alert">Conflict</span> needs your review.</p>
    </section>
    ${nextActionHtml(sm.next_action, sm.next_question, adv)}
    ${conflicts.length ? `<section class="card conflicts"><h2>Needs your review</h2><p class="note">The conversation says something different from what a person entered. Your entry stays until you choose.</p>
      <ul class="list">${conflicts.map(([k, m]) => `<li><span><b>${esc(fieldLabel(k))}</b>: entered <b>${esc(showValue(k, valueOf(k)) || "—")}</b>, conversation says <b>${esc(showValue(k, m.conflict.value) || String(m.conflict.value))}</b></span>
        ${adv ? `<span class="row-actions"><button class="btn sm" data-keep="${attr(k)}">Keep entered</button><button class="btn sm pri" data-accept="${attr(k)}">Use the client's</button></span>` : ""}</li>`).join("")}</ul></section>` : ""}
    <section class="card"><div class="card-h"><h2>Qualification &amp; score</h2>${tempBadge(lead.temperature)}</div>
      <div class="score-row"><div class="score-big"><b>${lead.score ?? "—"}</b><span>/100 engagement</span></div>
        <div>${(lead.score_rationale || []).length ? `<ul class="factors">${lead.score_rationale.map((r) => `<li><span>${esc(r.label)}</span><i style="--w:${r.known && r.max ? (r.points / r.max) * 100 : 0}%"></i><b>${r.known ? `${r.points}/${r.max}` : "?"}</b></li>`).join("")}</ul>` : `<p class="note">Not scored yet.</p>`}</div></div>
      ${(() => { const miss = ["purpose", "budget_max", "timeline_months", "financing", "readiness"].filter((k) => isBlank(qf[k])); return miss.length ? `<p class="note">Still unknown: ${miss.map((k) => esc(fieldLabel(k))).join(", ")}. A missing detail never lowers the score — it shows as “?”.</p>` : ""; })()}
      <p class="note sm">The score shows sales engagement and intent only. It is not a prediction of a sale or of loan approval.</p></section>`;

  const profileHtml = `
    <section class="card"><h2>Contact</h2><form id="fc" class="form two">
      <label>Name<input name="full_name" value="${attr(c.full_name)}" maxlength="120"${ro("advisor")}></label>
      <label>Preferred salutation<input name="salutation" value="${attr(c.salutation)}" list="sal-list" placeholder="Mr / Ms / Encik / Puan / none"${ro("advisor")}>
        <datalist id="sal-list">${["Mr", "Ms", "Encik", "Puan", "Cik", "Tuan", "Dr", "Dato'", "Datin", "Mrs", "Miss", "none"].map((t) => `<option value="${t}">`).join("")}</datalist></label>
      ${"gender" in c ? `<label>Gender<select name="gender"${ro("advisor")}>${opt("", "Not set", c.gender)}${opt("male", "Male", c.gender)}${opt("female", "Female", c.gender)}${opt("unknown", "Unknown — use no title", c.gender)}${opt("not_provided", "Not provided — use no title", c.gender)}</select></label>
      <p class="note full">${(() => { const a = addressFor(c, { preferredName: pf.preferred_name?.value ?? pf.preferred_name }), g = nameGender(c.full_name);
        return `The AI addresses this client as <b>${esc(a.en || "—")}</b> in English and <b>${esc(a.ms || "—")}</b> in Malay (${esc({ confirmed: "confirmed", high: "from a clear name", uncertain: "no title: uncertain" }[a.certainty])}${a.source && a.source !== "not_set" ? ", source: " + esc({ customer: "the client", advisor: "an advisor", name_recognition: "name recognition" }[a.source]) : ""}). ${g.confidence === "high" ? `Name suggestion: ${esc(g.reason)}.` : ""} Setting a salutation or gender here overrides the name. "none" = name only.`; })()}</p>` : ""}
      <label>Phone<input name="phone" value="${attr(c.phone_e164 ? formatPhone(c.phone_e164) : "")}" inputmode="tel"${ro("advisor")}></label>
      <label>Email<input name="email" type="email" value="${attr(c.email)}"${ro("advisor")}></label>
      <label>Language<select name="preferred_language"${ro("advisor")}>${opt("", "Unknown", c.preferred_language)}${opt("ms", "Bahasa Malaysia", c.preferred_language)}${opt("en", "English", c.preferred_language)}${opt("mixed", "Mixed / Manglish", c.preferred_language)}</select></label>
      <label class="full">Notes<textarea name="notes" rows="2"${ro("advisor")}>${esc(c.notes)}</textarea></label>
      ${adv ? `<div class="actions full"><button class="btn pri" type="submit">Save contact</button></div>` : ""}</form></section>
    <section class="card"><h2>Client profile</h2><p class="note">Filled in from the conversation where the client said so, or by you. Only record what the client chose to share — never a full home address, IC or bank details.</p>
      <form id="fp" class="form two">${PROFILE_GROUPS.map(([g, title]) => `<h3>${esc(title)}</h3>${PROFILE_FIELDS.filter((f) => f.group === g).map((f) => fieldInput(f, pf[f.key], meta[f.key], adv)).join("")}`).join("")}
        ${adv ? `<label class="full">Note for the history (optional)<input name="__note" maxlength="200" placeholder="e.g. confirmed on a call"></label><div class="actions full"><button class="btn pri" type="submit">Save profile</button></div>` : ""}</form></section>
    <section class="card"><h2>Property interests</h2><p class="note">One client can consider several projects. The AI answers each from that project's own information, and project workflows (e.g. RMK) only run for the project they belong to.</p>
      ${(interests || []).length ? `<div class="ints">${interests.map((i) => `<form class="int-row form two" data-int="${attr(i.project_id)}"><div class="full int-h"><b>${esc(projectName(i.project_id))}</b> ${i.project_id === lead.primary_project_id ? badge("Main", "ok") : ""}</div>
        <label>Priority<select name="priority"${ro("advisor")}>${Object.entries(PRIORITY).map(([k, v]) => opt(k, v, i.priority)).join("")}</select></label>
        <label>Status<select name="interest"${ro("advisor")}>${["enquired", "interested", "shortlisted", "visited", "rejected"].map((x) => opt(x, x[0].toUpperCase() + x.slice(1), i.interest)).join("")}</select></label>
        <label>Unit type<input name="unit_type" value="${attr(i.unit_type)}" placeholder="e.g. Type B, 3 bedrooms"${ro("advisor")}></label>
        <label>Budget<input name="budget_text" value="${attr(i.budget_text)}" placeholder="e.g. up to RM450k"${ro("advisor")}></label>
        <label class="full">Next action<input name="next_action" value="${attr(i.next_action)}" placeholder="e.g. send Type B floor plan"${ro("advisor")}></label>
        ${adv ? `<div class="actions full"><button class="btn sm" type="submit">Save</button><button class="link danger" type="button" data-rm-int="${attr(i.project_id)}">Remove</button></div>` : ""}</form>`).join("")}</div>` : empty("No projects recorded yet.")}
      ${adv ? `<form id="fi" class="inline"><select name="project_id" aria-label="Project">${projectOptions("", "Add a project…")}</select><select name="priority" aria-label="Priority">${Object.entries(PRIORITY).map(([k, v]) => opt(k, v, "alternative")).join("")}</select><button class="btn">Add</button></form>` : ""}
    </section>
    <section class="card"><h2>Qualification</h2>
      <p class="note">Collected progressively in conversation. Only record financial details the buyer chose to share.</p>
      <form id="fq" class="form two">
      ${QUAL_FIELDS.filter((f) => f.key !== "concerns").map((f) => fieldInput(f, qf[f.key], meta[f.key], adv)).join("")}
      <label>Project fit<select name="project_fit"${ro("advisor")}>${opt("", "Not assessed", qf.project_fit)}${opt("strong", "Strong", qf.project_fit)}${opt("partial", "Partial", qf.project_fit)}${opt("poor", "Poor", qf.project_fit)}</select></label>
      <label>Budget fit<select name="budget_fit"${ro("advisor")}>${opt("", "Calculate from budget & price", qf.budget_fit)}${opt("strong", "Within budget", qf.budget_fit)}${opt("partial", "Slightly above", qf.budget_fit)}${opt("poor", "Well above", qf.budget_fit)}</select></label>
      ${fieldInput({ ...FIELD.concerns, type: "textarea" }, qf.concerns, meta.concerns, adv)}
      <label class="check"><input type="checkbox" name="asked_price"${sig.asked_price ? " checked" : ""}${ro("advisor")}> Asked about price</label>
      <label class="check"><input type="checkbox" name="requested_brochure"${sig.requested_brochure ? " checked" : ""}${ro("advisor")}> Requested brochure / price list</label>
      <label class="check"><input type="checkbox" name="unsuitable"${qf.unsuitable ? " checked" : ""}${ro("advisor")}> Unqualified / unsuitable</label>
      <label>Reason (if unsuitable)<input name="unsuitable_reason" value="${attr(qf.unsuitable_reason)}"${ro("advisor")}></label>
      ${adv ? `<div class="actions full"><button class="btn pri" type="submit">Save &amp; rescore</button></div>` : ""}</form></section>`;

  const salesHtml = `
    <section class="card"><h2>Lead</h2><form id="fl" class="form two">
      <label>Stage<select name="stage_id"${ro("advisor")}>${S.stages.filter((s) => s.active || s.id === lead.stage_id).map((s) => opt(s.id, s.name, lead.stage_id)).join("")}</select></label>
      <label>Owner<select name="owner_email"${ro("advisor")}>${teamOptions(lead.owner_email)}</select></label>
      <label class="full stage-note" hidden>Why / how confirmed (recorded on the timeline)<input name="stage_note" maxlength="300" placeholder="e.g. booking fee receipt seen; bank letter received"></label>
      <label>Source<select name="source_id"${ro("advisor")}>${opt("", "—", lead.source_id)}${S.sources.map((s) => opt(s.id, s.name, lead.source_id)).join("")}</select></label>
      <label>Campaign<select name="campaign_id"${ro("advisor")}>${opt("", "—", lead.campaign_id)}${S.campaigns.map((x) => opt(x.id, x.name, lead.campaign_id)).join("")}</select></label>
      <label>Main project<select name="primary_project_id"${ro("advisor")}>${projectOptions(lead.primary_project_id)}</select></label>
      <label>Lost reason<input name="lost_reason" value="${attr(lead.lost_reason)}" placeholder="If lost: why?"${ro("advisor")}></label>
      <label class="check full"><input type="checkbox" name="ai_paused"${lead.ai_paused ? " checked" : ""}${ro("advisor")}> Pause AI for this lead (a human handles every reply)</label>
      ${adv ? `<div class="actions full"><button class="btn pri" type="submit">Save lead</button></div>` : ""}</form>
      <p class="note sm">Changing the stage cancels the automatic check-ins scheduled for the old situation; the buyer's next message schedules fresh ones. Project workflows keep their own stages.</p></section>
    <section class="card" id="tasks"><h2>Follow-ups &amp; tasks</h2><p class="note">Give a task a due time and you get a Telegram reminder before it is due.</p>
      ${(tasks || []).length ? `<ul class="list">${tasks.map((t) => `<li class="${t.status !== "open" ? "done" : ""}">${adv && t.status === "open" ? `<button class="link" data-done="${attr(t.id)}" aria-label="Mark done">☐</button>` : t.status === "done" ? "☑" : "✕"} ${esc(t.title)}<small class="${t.status === "open" && t.due_at && new Date(t.due_at) < Date.now() ? "late" : ""}">${esc(t.due_at ? fmtDate(t.due_at) : "")}${t.assignee_email ? " · " + esc(t.assignee_email) : ""}</small></li>`).join("")}</ul>` : empty("No tasks.")}
      ${adv ? `<form id="ft" class="form two"><label class="full">New follow-up / task<input name="title" maxlength="200" required placeholder="e.g. Follow up on Type B floor plan"></label><label>Due<input name="due_at" type="datetime-local"></label><label>Assignee<select name="assignee_email">${teamOptions(S.email)}</select></label><div class="actions full"><button class="btn" type="submit">Add task</button></div></form>` : ""}
    </section>
    <section class="card" id="appts"><h2>Appointments</h2>
      <p class="note">A confirmed appointment moves the lead to Appointment Booked; a completed one to Appointment Attended (never backwards).</p>
      ${(appts || []).length ? `<ul class="list">${appts.map((a) => `<li><b>${esc(kindLabel(a.kind))}</b> ${apptBadge(a.status)} ${a.project_id ? "· " + esc(projectName(a.project_id)) : ""}<small>${a.start_at ? esc(fmtDate(a.start_at)) : "Preferred: " + esc(a.preferred_text || "—")}${a.advisor_email ? " · " + esc(a.advisor_email) : ""}${a.archived_at ? " · archived" : ""}</small>
        ${adv ? `<select data-appt="${attr(a.id)}" aria-label="Change status">${Object.entries(APPT).map(([k, v]) => opt(k, v[0], a.status)).join("")}</select>` : ""}
        ${a.status === "confirmed" ? `<small>WhatsApp confirmation &amp; reminders: ${a.wa_reminders === false ? "off" : "on"}${a.attendance_confirmed_at ? " · buyer confirmed they are coming" : ""}${adv ? ` <button class="link" data-wa-rem="${attr(a.id)}" data-on="${a.wa_reminders === false ? "1" : ""}">${a.wa_reminders === false ? "Turn on" : "Turn off"}</button>` : ""}</small>` : ""}</li>`).join("")}</ul>` : empty("No appointments.")}
      ${adv ? `<details id="addappt"><summary>Add appointment</summary><form id="fa" class="form two">
        <label>Type<select name="kind">${Object.entries(KIND).map(([k, v]) => opt(k, v)).join("")}</select></label>
        <label>Project<select name="project_id">${projectOptions(lead.primary_project_id)}</select></label>
        <label>Start<input name="start_at" type="datetime-local"></label><label>End<input name="end_at" type="datetime-local"></label>
        <label>Status<select name="status">${opt("pending_confirmation", "Pending confirmation")}${opt("confirmed", "Confirmed (time agreed with buyer)")}</select></label>
        <label>Advisor<select name="advisor_email">${teamOptions(S.email)}</select></label>
        <label class="full">Buyer's preferred time (if not fixed)<input name="preferred_text" placeholder="e.g. Sabtu petang"></label>
        <label class="full">Location<input name="location" placeholder="Showroom address or call link"></label>
        <label class="check full"><input type="checkbox" name="wa_reminders" checked> When confirmed, send the buyer a WhatsApp confirmation and reminders</label>
        <div class="actions full"><button class="btn" type="submit">Save appointment</button></div></form></details>` : ""}
    </section>
    ${wfCard}
    ${financingSection(fin)}
    ${(handovers || []).length ? `<section class="card"><h2>Human handover</h2><ul class="list">${handovers.map((h) => `<li>${esc(String(h.reason).replace(/_/g, " "))} ${badge(h.status, h.status === "open" ? "alert" : "")}<small>${esc(fmtDate(h.created_at))}${h.accepted_by ? " · " + esc(h.accepted_by) : ""}</small>${h.summary?.text ? `<small>${esc(String(h.summary.text).slice(0, 300))}</small>` : ""}</li>`).join("")}</ul></section>` : ""}
    <section class="card"><h2>Consent</h2>
      ${(consent || []).length ? `<ul class="list">${consent.map((x) => `<li>${esc(x.purpose)} · ${esc(x.channel)} ${badge(x.status, x.status === "granted" ? "ok" : "alert")}<small>${esc(x.source)} · ${esc(fmtDate(x.recorded_at))}</small></li>`).join("")}</ul>` : empty("No consent on record. Do not send marketing messages.")}
      ${adv ? `<details><summary>Record consent or opt-out</summary><form id="fco" class="form two">
        <label>Purpose<select name="purpose">${opt("service", "Service (reply to enquiry)")}${opt("marketing", "Marketing / promotions")}</select></label>
        <label>Channel<select name="channel">${["whatsapp", "phone", "email", "sms", "any"].map((x) => opt(x, x)).join("")}</select></label>
        <label>Status<select name="status">${opt("granted", "Granted")}${opt("withdrawn", "Withdrawn / opt-out")}</select></label>
        <label class="full">Evidence (required)<input name="evidence" required placeholder="e.g. Buyer said 'ok boleh hantar promo' on WhatsApp 12 Oct"></label>
        <div class="actions full"><button class="btn" type="submit">Record</button></div></form></details>` : ""}
    </section>
    ${can("owner") ? `<section class="card danger"><h2>Personal data (PDPA)</h2><p class="note">Erasing anonymises this contact, their messages, notes, client profile and summary, and removes them from the audit trail. Consent history is kept as proof. This cannot be undone.</p><button class="btn danger" id="erase">Erase personal data…</button></section>` : ""}`;

  const fAct = ACT_FILTER[params.get("act")] ? params.get("act") : "all";
  const shownActs = (acts || []).filter((a) => fAct === "all" || actGroup(a.kind) === fAct);
  const activityHtml = `
    <section class="card"><h2>Activity</h2>
      ${adv ? `<form id="fn" class="form"><textarea name="body" rows="2" required aria-label="Note or call summary" placeholder="Add an internal note or call summary (never sent to the client)…"></textarea><div class="actions"><select name="kind" aria-label="Type">${opt("note", "Internal note")}${opt("call", "Call")}</select><button class="btn" type="submit">Add</button></div></form>` : ""}
      <div class="seg act-f">${Object.entries(ACT_FILTER).map(([k, v]) => `<a class="${fAct === k ? "on" : ""}" href="#/lead/${attr(id)}?tab=activity${k === "all" ? "" : "&act=" + k}">${esc(v)}</a>`).join("")}</div>
      ${shownActs.length ? `<ol class="timeline">${shownActs.map((a) => `<li class="k-${attr(a.kind)}"><div><b>${esc(a.kind === "profile_update" ? "profile" : a.kind === "ai_summary" ? "summary" : a.kind.replace(/_/g, " "))}</b> <small>${esc(fmtDate(a.created_at))} · ${esc(a.actor === "ai" ? "AI" : a.actor)}</small></div>${a.body ? `<p>${esc(a.kind === "profile_update" ? profileBody(a) : a.body)}</p>` : ""}</li>`).join("")}</ol>` : empty("No activity of this kind yet.")}
    </section>
    <details class="card"><summary>Field change history (${(fieldHistory || []).length})</summary>
      ${(fieldHistory || []).length ? `<table class="mini"><thead><tr><th>When</th><th>Field</th><th>From</th><th>To</th><th>How</th></tr></thead><tbody>${fieldHistory.map((h) => `<tr><td>${esc(fmtDate(h.at))}</td><td>${esc(fieldLabel(h.field))}</td><td>${esc(showValue(h.field, h.old_value) || "—")}</td><td>${esc(showValue(h.field, h.new_value) || "—")}</td>
        <td>${esc(h.status === "conflict" ? "conversation disagreed (review)" : h.source === "ai" ? `AI · ${h.status}` : h.by)}${h.note ? `<small>${esc(h.note)}</small>` : ""}</td></tr>`).join("")}</tbody></table>` : empty("No changes recorded yet.")}</details>`;

  el.innerHTML = `
  <div class="ws" data-tab="${attr(tab)}" id="ws">
    <header class="ws-head">
      <div class="ws-id"><a class="back" href="#/leads">← Leads</a>
        <h1>${esc(contactName(c))} <small class="code">${esc(lead.lead_code)}</small></h1>
        <div class="ws-badges">${stageChip(stage)} ${tempBadge(lead.temperature)} ${badge(aiState[0], aiState[1])}${lead.handover_status === "requested" ? " " + badge("Waiting for a person", "alert") : ""}${lead.closed_at ? " " + badge("Closed " + fmtDate(lead.closed_at, false)) : ""}</div>
        <p class="sub">${lead.primary_project_id ? `<span class="proj">${icon("building", { size: 15 })}${esc(projectName(lead.primary_project_id))}</span> · ` : ""}${esc(lead.owner_email || "Unassigned")}${lastTouch ? ` · last contact ${esc(ago(lastTouch))}` : ""} · created ${esc(fmtDate(lead.created_at, false))}</p></div>
      <div class="head-actions">${conv ? `<button class="btn" id="gochat">${icon("inbox", { size: 18 })}WhatsApp</button>` : c.phone_e164 ? `<a class="btn" href="https://wa.me/${attr(c.phone_e164)}" target="_blank" rel="noopener">${icon("inbox", { size: 18 })}WhatsApp</a>` : ""}
        ${c.phone_e164 ? `<a class="btn" href="tel:+${attr(c.phone_e164)}">Call</a>` : ""}
        ${adv ? `<button class="btn" id="goappt">${icon("calendar", { size: 18 })}Appointment</button>` : ""}
        ${adv && lead.handover_status !== "requested" ? `<button class="btn" id="ho">${icon("flag", { size: 18 })}Flag for human</button>` : ""}</div>
    </header>
    <nav class="ws-tabs" role="tablist" aria-label="Lead workspace">${TABS.map(([k, l]) => `<a role="tab" class="${k === tab ? "on" : ""}" aria-selected="${k === tab}" data-tab="${k}" href="#/lead/${attr(id)}?tab=${k}">${esc(l)}${k === "conversation" && conv?.unread_count ? ` <span class="cnt">${esc(conv.unread_count)}</span>` : ""}${k === "summary" && conflicts.length ? ` <span class="cnt">${conflicts.length}</span>` : ""}</a>`).join("")}</nav>
    <div class="ws-body">
      <div class="ws-main">
        <div class="ws-panel" data-p="summary">${summaryHtml}</div>
        <div class="ws-panel" data-p="profile">${profileHtml}</div>
        <div class="ws-panel" data-p="sales">${salesHtml}</div>
        <div class="ws-panel" data-p="activity">${activityHtml}</div>
      </div>
      <aside class="ws-side ws-panel" data-p="conversation"><section class="card thread" id="wsconv">${conv ? "" : `<h2>WhatsApp</h2>${empty("No WhatsApp conversation with this client yet.")}${c.phone_e164 ? `<p><a class="btn" href="https://wa.me/${attr(c.phone_e164)}" target="_blank" rel="noopener">Open in WhatsApp</a></p>` : ""}`}</section></aside>
    </div>
  </div>`;

  const reload = () => keepPlace(el, () => leadWorkspace(el, new URLSearchParams(location.hash.split("?")[1] || ""), id));
  if (conv) await thread($("#wsconv", el), conv, (jobs || []).some((j) => j.kind === "smart_follow_up"), reload, { embedded: true });

  // tabs switch in place (the URL keeps the tab, so a reload or a shared link opens the same view)
  const ws = $("#ws", el);
  $$(".ws-tabs a", el).forEach((a) => a.onclick = (e) => { e.preventDefault(); show(a.dataset.tab); history.replaceState(null, "", a.getAttribute("href")); });
  function show(t) { ws.dataset.tab = t; $$(".ws-tabs a", el).forEach((x) => { x.classList.toggle("on", x.dataset.tab === t); x.setAttribute("aria-selected", String(x.dataset.tab === t)); }); }
  const goChat = () => { show("conversation"); history.replaceState(null, "", `#/lead/${id}?tab=conversation`); const t = $("#wsconv textarea, #wsconv select", el); $("#wsconv", el).scrollIntoView({ block: "start", behavior: "smooth" }); if (t) setTimeout(() => t.focus({ preventScroll: true }), 250); };
  if ($("#gochat", el)) $("#gochat", el).onclick = goChat;
  const goAppt = () => { show("sales"); history.replaceState(null, "", `#/lead/${id}?tab=sales`); const d = $("#addappt", el); if (d) { d.open = true; d.scrollIntoView({ block: "center", behavior: "smooth" }); } };
  if ($("#goappt", el)) $("#goappt", el).onclick = goAppt;
  $$(".more-miss", el).forEach((b) => b.onclick = () => { b.closest(".sum-sec").classList.add("show-miss"); b.remove(); });

  if (!adv) return;
  const fc = $("#fc", el), fl = $("#fl", el), fq = $("#fq", el), fp = $("#fp", el);
  [[fc, "contact"], [fl, "lead"], [fq, "qual"], [fp, "profile"]].forEach(([f, k]) => guardForm(f, `lead:${id}:${k}`));

  fc.onsubmit = (e) => { e.preventDefault(); const d = formData(fc);
    const ph = d.phone ? normalizePhone(d.phone) : null;
    if (d.phone && !ph) return toast("That phone number does not look valid.", "err");
    act(fc.querySelector("button"), async () => {
      // Smart Salutation: a title or gender set here is the advisor's and overrides name recognition
      const sal = (d.salutation || "").trim() || null, gen = "gender" in c ? d.gender || null : undefined;
      const salChanged = sal !== (c.salutation || null) || (gen !== undefined && gen !== (c.gender || null));
      const salFields = gen === undefined ? {} : { gender: gen, ...(salChanged ? (sal || gen ? { salutation_source: "advisor", salutation_confidence: "confirmed" } : { salutation_source: null, salutation_confidence: null }) : {}) };
      await q(SB.from("ai_contacts").update({ full_name: d.full_name, salutation: sal, phone_e164: ph, email: d.email, preferred_language: d.preferred_language, notes: d.notes, ...salFields }).eq("id", c.id).select("id"), { expectRows: true });
      clearDraft(fc); reload();
    }, "Contact saved"); };

  // profile: only fields that changed are sent, so the history shows exactly what was edited
  fp.onsubmit = (e) => { e.preventDefault();
    const changes = PROFILE_FIELDS.map((f) => ({ field: f.key, value: readField(fp, f) })).filter((x) => JSON.stringify(x.value ?? null) !== JSON.stringify(isBlank(pf[x.field]) ? null : pf[x.field]));
    if (!changes.length) { clearDraft(fp); return toast("Nothing changed"); }
    act(fp.querySelector("button[type=submit]"), async () => {
      await q(SB.rpc("ai_lead_profile_set", { p_lead: id, p_changes: changes.map((x) => ({ ...x, value: x.value ?? "" })), p_source: "staff", p_message: null, p_note: fp.__note.value || null }));
      clearDraft(fp); reload();
    }, "Profile saved"); };

  fl.stage_id.onchange = () => { $(".stage-note", fl).hidden = fl.stage_id.value === lead.stage_id; };
  fl.onsubmit = (e) => { e.preventDefault(); const d = formData(fl);
    act(fl.querySelector("button[type=submit]"), async () => {
      // the stage goes through the database function: it records who, why and cancels stale check-ins
      if (d.stage_id !== lead.stage_id) await q(SB.rpc("ai_lead_set_stage", { p_lead: id, p_stage: d.stage_id, p_note: d.stage_note || null, p_source: "staff", p_evidence: null }));
      await q(SB.from("ai_leads").update({ owner_email: d.owner_email, source_id: d.source_id, campaign_id: d.campaign_id, primary_project_id: d.primary_project_id, lost_reason: d.lost_reason, ai_paused: d.ai_paused }).eq("id", id).select("id"), { expectRows: true });
      clearDraft(fl); reload();
    }, "Lead saved"); };

  fq.onsubmit = (e) => { e.preventDefault(); const d = formData(fq);
    act(fq.querySelector("button[type=submit]"), async () => {
      const { asked_price, requested_brochure, ...rest } = d;
      for (const f of QUAL_FIELDS) if (f.type === "number" && rest[f.key] !== null && rest[f.key] !== undefined) rest[f.key] = Number(rest[f.key]);
      const norm = (v) => (v === false || isBlank(v) ? null : v);
      const changes = Object.entries(rest).filter(([k, v]) => JSON.stringify(norm(v)) !== JSON.stringify(norm(qf[k]))).map(([field, value]) => ({ field, value: norm(value) ?? "" }));
      if (changes.length) await q(SB.rpc("ai_lead_profile_set", { p_lead: id, p_changes: changes, p_source: "staff", p_message: null, p_note: null }));
      const qual = { ...qf, ...rest, signals: { ...sig, asked_price, requested_brochure } };
      const projId = lead.primary_project_id || interests?.[0]?.project_id;
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
    act(fi.querySelector("button"), async () => {
      await q(SB.from("ai_lead_interests").upsert({ lead_id: id, project_id: d.project_id, interest: "interested", priority: d.priority }));
      if (d.priority === "primary") await setPrimary(d.project_id);
      reload();
    }, "Interest saved"); };
  // one main project: making another one primary moves the previous main project to "alternative"
  const setPrimary = async (pid) => {
    await q(SB.from("ai_lead_interests").update({ priority: "alternative" }).eq("lead_id", id).eq("priority", "primary").neq("project_id", pid));
    await q(SB.from("ai_leads").update({ primary_project_id: pid }).eq("id", id).select("id"), { expectRows: true });
  };
  $$("form[data-int]", el).forEach((f) => f.onsubmit = (e) => { e.preventDefault(); const d = formData(f);
    act(f.querySelector("button[type=submit]"), async () => {
      await q(SB.from("ai_lead_interests").update({ priority: d.priority, interest: d.interest, unit_type: d.unit_type, budget_text: d.budget_text, next_action: d.next_action, updated_at: new Date().toISOString() }).eq("lead_id", id).eq("project_id", f.dataset.int).select("lead_id"), { expectRows: true });
      if (d.priority === "primary" && lead.primary_project_id !== f.dataset.int) await setPrimary(f.dataset.int);
      reload();
    }, "Interest saved"); });
  $$("[data-rm-int]", el).forEach((b) => b.onclick = () => { if (!confirm("Remove this project from the client's interests?")) return;
    act(b, async () => { await q(SB.from("ai_lead_interests").delete().eq("lead_id", id).eq("project_id", b.dataset.rmInt).select("lead_id"), { expectRows: true }); reload(); }, "Removed"); });

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

  // summary: refresh from the conversation, or edit by hand
  const rb = $("#refsum", el);
  if (rb) rb.onclick = () => act(rb, async () => {
    const r = await api("/api/sales/ai/summary", { method: "POST", body: JSON.stringify({ lead_id: id }) });
    if (!r.ok) toast(r.note || "Nothing to update", "ok");
    reload();
  }, null);
  const eb = $("#editsum", el);
  if (eb) eb.onclick = () => {
    const dlg = modal("Edit the summary", `<form id="fsum" class="form"><label>Summary<textarea name="text" rows="6" maxlength="1500" required>${esc(sm.text || "")}</textarea></label>
      <label>Last client question<input name="last_client_question" value="${attr(sm.last_client_question)}" maxlength="400"></label>
      <label>Outstanding<input name="outstanding" value="${attr(sm.outstanding)}" maxlength="600"></label>
      <p class="note">Your edit is kept until the conversation brings something new.</p><div class="actions"><button class="btn pri">Save</button></div></form>`);
    const f = $("#fsum", dlg);
    f.onsubmit = (e) => { e.preventDefault(); const d = formData(f);
      act(f.querySelector("button"), async () => { await q(SB.rpc("ai_lead_summary_set", { p_lead: id, p_summary: { text: d.text, last_client_question: d.last_client_question || "", outstanding: d.outstanding || "" }, p_source: "staff", p_message: null })); dlg.done(); reload(); }, "Summary saved"); };
  };

  // next best action
  const na = sm.next_action;
  const setNa = (status, b, msg) => act(b, async () => { await q(SB.rpc("ai_lead_next_action", { p_lead: id, p_status: status })); reload(); }, msg);
  if ($("#na-done", el)) $("#na-done", el).onclick = (e) => setNa("done", e.currentTarget, "Marked done");
  if ($("#na-dismiss", el)) $("#na-dismiss", el).onclick = (e) => setNa("dismissed", e.currentTarget, "Dismissed");
  if ($("#na-chat", el)) $("#na-chat", el).onclick = goChat;
  if ($("#na-appt", el)) $("#na-appt", el).onclick = goAppt;
  if ($("#na-task", el)) $("#na-task", el).onclick = (e) => act(e.currentTarget, async () => {
    const due = na.due_at ? new Date(na.due_at + "T10:00:00+08:00").toISOString() : null;
    await q(SB.from("ai_tasks").insert({ lead_id: id, title: String(na.action).slice(0, 200), details: na.reason || null, due_at: due, assignee_email: lead.owner_email || S.email }));
    await q(SB.rpc("ai_lead_next_action", { p_lead: id, p_status: "done" }));
    reload();
  }, "Follow-up task created");

  // conflicts
  $$("[data-keep]", el).forEach((b) => b.onclick = () => act(b, async () => { await q(SB.rpc("ai_lead_profile_resolve", { p_lead: id, p_field: b.dataset.keep, p_accept: false })); reload(); }, "Kept your entry"));
  $$("[data-accept]", el).forEach((b) => b.onclick = () => act(b, async () => { await q(SB.rpc("ai_lead_profile_resolve", { p_lead: id, p_field: b.dataset.accept, p_accept: true })); reload(); }, "Updated from the conversation"));

  const ho = $("#ho", el);
  if (ho) ho.onclick = () => handoverModal(lead, c, interests, reload);
  bindFinancing(el, { leadId: id, contactId: c.id, data: fin, qualification: qf, reload });
  bindLeadWorkflowsCard(el, id, reload);
  const er = $("#erase", el);
  if (er) er.onclick = () => {
    const reason = prompt("Reason for erasure (e.g. 'Customer request on WhatsApp 26 Oct'). Type a reason to continue:");
    if (!reason) return;
    if (!confirm("Erase this person's personal data permanently?")) return;
    act(er, async () => { await q(SB.rpc("ai_erase_contact", { p_contact: c.id, p_reason: reason })); reload(); }, "Personal data erased");
  };
}

// "AI updated work_area, commute_mode" → field labels
const profileBody = (a) => {
  const m = a.meta || {}, f = (m.fields || []).map(fieldLabel), cf = (m.conflicts || []).map(fieldLabel);
  return f.length || cf.length ? [f.length ? (m.source === "ai" ? "AI updated: " : "Updated: ") + f.join(", ") : "", cf.length ? "needs review: " + cf.join(", ") : ""].filter(Boolean).join(" · ") : a.body;
};

function nextActionHtml(na, nextQuestion, adv) {
  const open = na && na.status === "open";
  return `<section class="card next-act" id="nextact"><div class="card-h"><h2>${icon("task", { size: 18 })} AI Recommended Next Action</h2>${open ? badge(na.priority === "high" ? "High priority" : na.priority === "low" ? "Low priority" : "Normal", na.priority === "high" ? "alert" : na.priority === "low" ? "" : "warn") : ""}</div>
    ${open ? `<p class="na-action">${esc(na.action)}</p>${na.reason ? `<p class="note">Why: ${esc(na.reason)}</p>` : ""}${na.due_at ? `<p class="note">Suggested by ${esc(fmtDate(na.due_at + "T00:00:00+08:00", false))}</p>` : ""}
      ${adv ? `<div class="row-actions"><button class="btn sm pri" id="na-chat">${icon("inbox", { size: 16 })}Reply on WhatsApp</button><button class="btn sm" id="na-task">${icon("task", { size: 16 })}Create follow-up task</button>
        <button class="btn sm" id="na-appt">${icon("calendar", { size: 16 })}Book appointment</button><button class="btn sm" id="na-done">Mark done</button><button class="link" id="na-dismiss">Dismiss</button></div>` : ""}
      <p class="note sm">A recommendation only: nothing is sent or created until you choose.</p>`
      : `<p class="note">${na?.status === "done" ? `Last recommendation done: “${esc(na.action)}”.` : na?.status === "dismissed" ? `Last recommendation dismissed: “${esc(na.action)}”.` : "No recommendation yet. One appears as the conversation develops."}</p>`}
    ${nextQuestion ? `<p class="note">Useful next question: <b>${esc(nextQuestion)}</b></p>` : ""}</section>`;
}

/** One profile / qualification input, with its evidence status. */
function fieldInput(f, value, meta, adv) {
  const st = statusOf(value, meta), dis = adv ? "" : " disabled";
  const chip = st !== "missing" ? ` <span class="st ${STATUS_KIND[st]}" title="${attr(FIELD_STATUS[st])}">${STATUS_SHORT[st]}</span>` : "";
  const lab = `${esc(f.label)}${chip}${f.hint ? `<small>${esc(f.hint)}</small>` : ""}`;
  if (f.type === "multi") return `<fieldset class="full multi" data-f="${attr(f.key)}"><legend>${lab}</legend>${Object.entries(f.options).map(([k, v]) => `<label class="check"><input type="checkbox" name="${attr(f.key)}" value="${attr(k)}"${(value || []).includes(k) ? " checked" : ""}${dis}> ${esc(v)}</label>`).join("")}</fieldset>`;
  if (f.type === "select") return `<label>${lab}<select name="${attr(f.key)}"${dis}>${opt("", "Not provided", value ?? "")}${Object.entries(f.options).map(([k, v]) => opt(k, v, value ?? "")).join("")}</select></label>`;
  if (f.type === "textarea") return `<label class="full">${lab}<textarea name="${attr(f.key)}" rows="2" maxlength="1000"${dis}>${esc(value ?? "")}</textarea></label>`;
  return `<label>${lab}<input name="${attr(f.key)}"${f.type === "number" ? ' type="number" min="0"' : ""} value="${attr(value ?? "")}" maxlength="300"${dis}></label>`;
}
function readField(form, f) {
  if (f.type === "multi") { const v = $$(`input[name="${f.key}"]:checked`, form).map((x) => x.value); return v.length ? v : null; }
  const el = form.elements[f.key];
  const v = el ? String(el.value).trim() : "";
  if (!v) return null;
  return f.type === "number" ? Number(v) : v;
}

function handoverModal(lead, c, interests, reload) {
  const reasons = { customer_request: "Buyer asked for a human", ready_to_buy: "Ready to book / purchase", negotiation: "Discount / negotiation", legal: "Legal or contract question", complaint: "Complaint", financing: "Financing needs professional assessment", conflicting_info: "Project info conflicting / missing", sensitive: "Sensitive situation", other: "Other" };
  const dlg = modal("Flag for human handover", `<form id="fh" class="form">
    <label>Reason<select name="reason">${Object.entries(reasons).map(([k, v]) => opt(k, v)).join("")}</select></label>
    <label>Summary for the advisor<textarea name="summary" rows="4" required placeholder="What does the buyer want? What has been answered? What is outstanding?">${esc(lead.ai_summary?.text || "")}</textarea></label>
    <label>Recommended next action<input name="next" placeholder="e.g. Call to discuss booking fee" value="${attr(lead.ai_summary?.next_action?.status === "open" ? lead.ai_summary.next_action.action : "")}"></label>
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
