// AI Sales dashboard — follow-up workflows (migration 15): one per project, each with its own stages, keywords,
// reminder intervals, BM/EN messages and templates, all edited here and stored in the database. Leads join from an ad,
// a buyer's message, the project's website listing, the AI (when the buyer confirms) or staff. Stage changes and
// reminders are handled by the database functions; this page only reads them and calls ai_wf_save / ai_wf_* to change.
import { SB, S, can, $, $$, esc, attr, fmtDate, ago, q, act, toast, formData, badge, opt, empty, keepPlace, modal, projectName, markDirty } from "./core.js";
import { WF_STATUS, WF_STATUS_KIND, WF_SOURCES, WF_VARIABLES, fillMessage, messageVars, validateWorkflow, orderedStages, stageOf, nextStage } from "../shared/workflow.mjs";

const who = (l) => l?.contact?.full_name || (l?.contact?.phone_e164 ? "+" + l.contact.phone_e164 : "(no name)");
const when = (d) => (d ? fmtDate(d) : "—");
const DRAFT = (k) => "sales:draft:wf:" + k;
const lines = (v) => String(v || "").split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
const slug = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

async function loadWorkflows() {
  const [ws, ss, ls] = await Promise.all([
    q(SB.from("ai_workflows").select("*").order("name")),
    q(SB.from("ai_workflow_stages").select("*").order("position")),
    q(SB.from("ai_workflow_leads").select("workflow_id,stage,status").limit(10000)),
  ]);
  return (ws || []).map((w) => ({ ...w, stages: orderedStages((ss || []).filter((s) => s.workflow_id === w.id)), leads: (ls || []).filter((l) => l.workflow_id === w.id) }));
}

/** What ai_wf_save takes, from a workflow as stored (stages in their order, archived ones flagged). */
const payloadOf = (w) => ({
  id: w.id, key: w.key, name: w.name, description: w.description || "", project_id: w.project_id || "", status: w.status, sending_enabled: !!w.sending_enabled,
  pause_if_active_hours: Number(w.pause_if_active_hours ?? 6), entry: { ad_phrases: [], message_phrases: [], project_listing: true, ai_confirm: true, exclusive_project: true, ...(w.entry || {}) },
  ai_instructions: w.ai_instructions || "",
  stages: orderedStages(w.stages).map((s) => ({ id: s.id, key: s.key, name: s.name, step_en: s.step_en || "", step_ms: s.step_ms || "", keywords: s.keywords || [],
    follow_up_hours: Number(s.follow_up_hours) || 0, max_follow_ups: Number(s.max_follow_ups) || 0, template: s.template || "", message_ms: s.message_ms || "", message_en: s.message_en || "",
    next_stage_key: s.next_stage_key || "", is_final: !!s.is_final, human_on_enter: !!s.human_on_enter, escalate_after_max: s.escalate_after_max !== false, active: s.active !== false,
    archived: !!s.archived_at })),
});
const save = (p) => q(SB.rpc("ai_wf_save", { p }));

/* ================================================================ list */
export async function workflows(el, params = new URLSearchParams()) {
  const all = await loadWorkflows(), mgr = can("manager");
  const card = (w) => {
    const n = (st) => w.leads.filter((l) => l.status === st).length, live = w.stages.filter((s) => !s.archived_at);
    return `<article class="card wf-card"><div class="wf-card-h"><h2><a href="#/workflow/${attr(w.key)}">${esc(w.name)}</a></h2>
      ${w.status === "archived" ? badge("Archived") : w.sending_enabled ? badge("Sending on", "ok") : badge("Sending off", "warn")}</div>
      <p class="sub">${w.project_id ? esc(projectName(w.project_id)) : "No website listing linked"} · ${live.length} stages</p>
      <div class="kpis"><span class="kpi"><b>${w.leads.length}</b><span>Leads</span></span><span class="kpi"><b>${n("active")}</b><span>Active</span></span>
        <span class="kpi${n("human") ? " hot" : ""}"><b>${n("human")}</b><span>Need a person</span></span><span class="kpi"><b>${n("completed")}</b><span>Completed</span></span></div>
      <p class="wf-flow">${live.map((s) => `<span>${esc(s.name)}</span>`).join("<i aria-hidden=\"true\">→</i>")}</p>
      <div class="row-actions"><a class="btn" href="#/workflow/${attr(w.key)}">Open</a>${mgr ? `<a class="btn" href="#/workflow/${attr(w.key)}?view=stages">Edit stages</a>` : ""}</div></article>`;
  };
  const act_ = all.filter((w) => w.status === "active"), arch = all.filter((w) => w.status === "archived");
  el.innerHTML = `<div class="page-head"><div><h1>Follow-up workflows</h1><p class="sub">Step-by-step WhatsApp follow-ups, one workflow per project. Stages, keywords, intervals and messages are set here.</p></div>
    ${mgr ? `<div class="head-actions"><button class="btn pri" id="wfnew">+ New workflow</button></div>` : ""}</div>
    ${act_.length ? `<div class="wf-grid">${act_.map(card).join("")}</div>` : empty("No follow-up workflows yet.")}
    ${arch.length ? `<details class="card"><summary>Archived workflows (${arch.length})</summary><div class="wf-grid">${arch.map(card).join("")}</div></details>` : ""}`;
  const b = $("#wfnew", el);
  if (b) b.onclick = () => newWorkflowDialog(all);
  if (b && params.get("new") === "1") { history.replaceState(null, "", "#/workflows"); newWorkflowDialog(all); }
}

function newWorkflowDialog(all) {
  const used = new Set(all.filter((w) => w.status === "active" && w.project_id).map((w) => w.project_id));
  const dlg = modal("New follow-up workflow", `<form class="form two" id="wfn">
    <label class="full">Name<input name="name" required maxlength="120" placeholder="e.g. M ARAYA buyers"></label>
    <label>Short name <small>lowercase, used in links</small><input name="key" required pattern="[a-z0-9_]{2,40}" maxlength="40"></label>
    <label>Website listing<select name="project_id">${opt("", "None", "")}${S.projects.filter((p) => !used.has(p.id)).map((p) => opt(p.id, p.name, "")).join("")}</select></label>
    <label class="full">Start from<select name="from">${opt("", "Blank: two stages to fill in", "")}${all.map((w) => opt(w.id, "A copy of " + w.name, "")).join("")}</select></label>
    <p class="note full">A new workflow never sends anything until you switch sending on in its Settings. A copy takes the stages, keywords and messages; change the keywords so buyers of the two projects cannot be confused.</p>
    <div class="actions full"><button class="btn pri" data-busy="Creating…">Create</button></div></form>`);
  const f = $("#wfn", dlg);
  f.name.oninput = () => { if (!f.key.dataset.touched) f.key.value = slug(f.name.value); };
  f.key.oninput = () => { f.key.dataset.touched = "1"; };
  f.onsubmit = (e) => { e.preventDefault(); const v = formData(f);
    const src = all.find((w) => w.id === v.from);
    const base = src ? payloadOf(src) : { stages: [
      { key: "interested", name: "Interested", step_en: "Confirm interest", keywords: [], follow_up_hours: 0, max_follow_ups: 0 },
      { key: "completed", name: "Completed", is_final: true }] };
    const p = { ...base, id: undefined, key: v.key, name: v.name, project_id: v.project_id || "", status: "active", sending_enabled: false,
      stages: base.stages.filter((s) => !s.archived).map((s) => ({ ...s, id: undefined })) };
    const errs = validateWorkflow(p);
    if (errs.length) return toast(errs[0], "err");
    act(f.querySelector("button"), async () => { await save(p); dlg.done(); location.hash = `#/workflow/${v.key}?view=stages`; }, "Workflow created");
  };
}

/* ================================================================ one workflow */
export async function workflow(el, params, key) {
  const all = await loadWorkflows(), w = all.find((x) => x.key === key);
  if (!w) { el.innerHTML = `<p><a class="back" href="#/workflows">← Follow-up workflows</a></p>${empty("This workflow does not exist.")}`; return; }
  const views = [["board", "Board"], ["list", "Leads"], ["stages", "Stages"], ["settings", "Settings"], ["history", "History"]];
  const view = views.some(([k]) => k === params.get("view")) ? params.get("view") : "board";
  const [rows, jobs] = await Promise.all([
    q(SB.from("ai_workflow_leads").select("*, lead:ai_leads(id,lead_code,closed_at,primary_project_id,contact_id,contact:ai_contacts(full_name,phone_e164))").eq("workflow_id", w.id).order("stage_changed_at", { ascending: false }).limit(2000)),
    q(SB.from("ai_automation_jobs").select("lead_id,run_at,seq,stage").eq("kind", "workflow_follow_up").eq("workflow_id", w.id).eq("status", "scheduled").limit(2000)),
  ]);
  const list = rows || [], next = Object.fromEntries((jobs || []).map((j) => [j.lead_id, j]));
  const live = w.stages.filter((s) => !s.archived_at);
  const overdue = (r) => r.status === "human" || (next[r.lead_id] && new Date(next[r.lead_id].run_at) < Date.now() - 3600e3);
  const reload = () => keepPlace(el, () => workflow(el, params, key));

  el.innerHTML = `<p><a class="back" href="#/workflows">← Follow-up workflows</a></p>
  <div class="page-head"><div><h1>${esc(w.name)}</h1><p class="sub">${w.project_id ? esc(projectName(w.project_id)) : "No website listing linked"}${w.description ? " · " + esc(w.description) : ""}</p></div>
    <div class="seg">${views.map(([k, l]) => `<a class="${view === k ? "on" : ""}" href="#/workflow/${attr(key)}?view=${k}">${l}</a>`).join("")}</div></div>
  ${w.status === "archived" ? `<div class="card notice"><div><b>Archived.</b> No reminders are sent and keywords do nothing; leads and history are kept.</div></div>`
    : w.sending_enabled ? "" : `<div class="card notice"><div><b>Sending is off.</b> Leads are tracked and moved by their keywords, but no reminder is sent until you check the messages in <a href="#/workflow/${attr(key)}?view=stages">Stages</a> and switch sending on in <a href="#/workflow/${attr(key)}?view=settings">Settings</a>.</div></div>`}
  <div class="kpis wf-kpis"><span class="kpi"><b>${list.length}</b><span>Leads</span></span>
    ${live.map((s) => `<span class="kpi"><b>${list.filter((r) => r.stage === s.key).length}</b><span>${esc(s.name)}</span></span>`).join("")}
    <span class="kpi${list.some(overdue) ? " hot" : ""}"><b>${list.filter(overdue).length}</b><span>Overdue / need a person</span></span></div>
  <div id="wfv"></div>`;
  const body = $("#wfv", el);
  if (view === "stages") return stagesView(body, w, list, reload);
  if (view === "settings") return settingsView(body, w, all, reload);
  if (view === "history") return historyView(body, w, list);

  const card = (r) => `<article class="kcard${overdue(r) ? " overdue" : ""}"><a href="#/lead/${attr(r.lead_id)}"><b>${esc(who(r.lead))}</b></a>
    <small>${esc(r.lead?.lead_code || "")} · ${esc(WF_SOURCES[r.source] || r.source)}</small>
    <div>${badge(WF_STATUS[r.status], WF_STATUS_KIND[r.status])}${r.status_reason ? ` <small>${esc(r.status_reason)}</small>` : ""}</div>
    <small>In stage ${esc(ago(r.stage_changed_at))}${next[r.lead_id] ? ` · next reminder ${esc(when(next[r.lead_id].run_at))}` : ""}</small></article>`;
  if (view === "board") {
    body.innerHTML = list.length ? `<div class="kanban">${live.map((s) => { const ls = list.filter((r) => r.stage === s.key);
      return `<section class="col-k"><h3>${esc(s.name)} <span>${ls.length}</span></h3>${s.keywords?.[0] ? `<p class="note sm">Buyer replies <b>${esc(s.keywords[0])}</b> when done</p>` : ""}
        ${ls.map(card).join("") || `<p class="empty sm">Empty</p>`}</section>`; }).join("")}</div>`
      : empty("No leads in this workflow yet. They join from the entry rules in Settings, or “Add to workflow” on a lead.");
    return;
  }
  // leads
  const fs = params.get("q") || "", fst = params.get("stage") || "", fstat = params.get("status") || "", needle = fs.toLowerCase(), adv = can("advisor");
  const shown = list.filter((r) => (!fst || r.stage === fst) && (!fstat || (fstat === "overdue" ? overdue(r) : r.status === fstat))
    && (!needle || [who(r.lead), r.lead?.lead_code, r.lead?.contact?.phone_e164].some((v) => String(v || "").toLowerCase().includes(needle))));
  const stageName = (k) => stageOf(w.stages, k)?.name || k;
  body.innerHTML = `<form id="wff" class="filters"><input name="q" type="search" placeholder="Search name, phone or lead code" value="${attr(fs)}">
      <select name="stage"><option value="">All stages</option>${live.map((s) => opt(s.key, s.name, fst)).join("")}</select>
      <select name="status"><option value="">Any automation status</option>${Object.entries(WF_STATUS).map(([k, v]) => opt(k, v, fstat)).join("")}${opt("overdue", "Overdue / need a person", fstat)}</select>
      <button class="btn">Filter</button></form>
    ${shown.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Buyer</th><th>Stage</th><th>Automation</th><th>Source</th><th>Next follow-up</th></tr></thead><tbody>
    ${shown.map((r) => `<tr${overdue(r) ? ` class="overdue"` : ""}><td data-label="Buyer"><a href="#/lead/${attr(r.lead_id)}">${esc(who(r.lead))}</a><small>${esc(r.lead?.lead_code || "")}</small></td>
      <td data-label="Stage">${adv && w.status === "active" ? `<select data-stage="${attr(r.lead_id)}" aria-label="Stage">${live.map((s) => opt(s.key, s.name, r.stage)).join("")}</select>` : esc(stageName(r.stage))}<small>since ${esc(when(r.stage_changed_at))}</small></td>
      <td data-label="Automation">${badge(WF_STATUS[r.status], WF_STATUS_KIND[r.status])}${r.status_reason ? `<small>${esc(r.status_reason)}</small>` : ""}
        ${adv && r.status !== "completed" && w.status === "active" ? (r.status === "paused" ? `<button class="link" data-resume="${attr(r.lead_id)}">Resume</button>` : `<button class="link" data-pause="${attr(r.lead_id)}">Pause</button>`) : ""}</td>
      <td data-label="Source">${esc(WF_SOURCES[r.source] || r.source)}</td>
      <td data-label="Next follow-up">${next[r.lead_id] ? `${esc(when(next[r.lead_id].run_at))}<small>reminder ${esc(next[r.lead_id].seq)}</small>` : "—"}</td></tr>`).join("")}</tbody></table></div>` : empty("No leads match.")}`;
  const f = $("#wff", body);
  f.onsubmit = (e) => { e.preventDefault(); const v = formData(f); const u = new URLSearchParams({ view: "list", ...(v.q ? { q: v.q } : {}), ...(v.stage ? { stage: v.stage } : {}), ...(v.status ? { status: v.status } : {}) }); location.hash = `#/workflow/${key}?` + u; };
  $$("[data-stage]", body).forEach((s) => s.onchange = () => act(null, async () => { await q(SB.rpc("ai_wf_set_stage", { p_wf: w.id, p_lead: s.dataset.stage, p_stage: s.value })); reload(); }, "Stage changed: " + stageName(s.value)));
  $$("[data-pause]", body).forEach((b) => b.onclick = () => { const why = prompt("Pause follow-ups for this buyer. Reason (optional):", ""); if (why === null) return;
    act(b, async () => { await q(SB.rpc("ai_wf_set_status", { p_wf: w.id, p_lead: b.dataset.pause, p_status: "paused", p_reason: why })); reload(); }, "Paused"); });
  $$("[data-resume]", body).forEach((b) => b.onclick = () => act(b, async () => { await q(SB.rpc("ai_wf_set_status", { p_wf: w.id, p_lead: b.dataset.resume, p_status: "active" })); reload(); }, "Resumed"));
}

/* ================================================================ stage builder */
function stagesView(body, w, leads, reload) {
  const mgr = can("manager") && w.status === "active", dis = mgr ? "" : " disabled";
  const saved = payloadOf(w);
  let D;
  try { D = JSON.parse(sessionStorage.getItem(DRAFT(w.key)) || "null"); } catch { D = null; }
  const restored = !!(D && D.id === w.id && mgr);
  if (!restored) D = structuredClone(saved);
  const counts = (k) => leads.filter((l) => l.stage === k).length;
  const projName = w.project_id ? projectName(w.project_id) : w.name;
  let focusTa = null;

  const preview = (s, lang) => fillMessage(lang === "en" ? s.message_en : s.message_ms, messageVars({ name: "Aina", lang, projectName: projName, stages: D.stages.filter((x) => !x.archived), stageKey: s.key }));
  const summary = (s) => [s.keywords[0] ? `reply ${s.keywords[0]}` : "moved by staff or the AI", s.is_final ? "final" : Number(s.follow_up_hours) > 0 && Number(s.max_follow_ups) > 0 ? `every ${s.follow_up_hours} h × ${s.max_follow_ups}` : "no reminders", s.template ? `template ${s.template}` : ""].filter(Boolean).join(" · ");
  const stageCard = (s, i) => {
    const liveStages = D.stages.filter((x) => !x.archived && x.key !== s.key), nx = nextStage(D.stages.filter((x) => !x.archived).map((x, j) => ({ ...x, position: j })), s.key);
    const n = counts(s.key);
    return `<details class="card wf-stage${s.archived ? " archived" : ""}" data-i="${i}"${s._open ? " open" : ""}><summary><span class="wf-n">${i + 1}</span><b>${esc(s.name || "(new stage)")}</b>
        ${s.is_final ? badge("Final", "ok") : ""}${s.active === false && !s.archived ? badge("Inactive", "warn") : ""}${s.human_on_enter ? badge("Person takes over") : ""}${n ? badge(`${n} lead${n === 1 ? "" : "s"}`) : ""}
        <small>${esc(summary(s))}</small></summary>
      <div class="form two">
        <label>Stage name<input data-f="name" value="${attr(s.name)}" maxlength="120"${dis}></label>
        <label>Short name <small>${s.id ? "fixed once saved" : "lowercase letters, digits, _"}</small><input data-f="key" value="${attr(s.key)}" maxlength="40"${s.id ? " disabled" : dis}></label>
        <label>What the buyer does (English)<input data-f="step_en" value="${attr(s.step_en)}" maxlength="200"${dis}></label>
        <label>Langkah pembeli (Bahasa Malaysia)<input data-f="step_ms" value="${attr(s.step_ms)}" maxlength="200"${dis}></label>
        <label class="full">Keywords the buyer replies when done <small>comma separated; the first is shown to buyers, the others are aliases. Matched on letters and digits only, so “Done booked!” = DONE BOOKED.</small>
          <input data-f="keywords" value="${attr((s.keywords || []).join(", "))}" placeholder="e.g. DONE BOOKED, DONE BOOKING"${dis}></label>
        ${s.is_final ? "" : `<label>Remind every (hours, 0 = no reminders)<input data-f="follow_up_hours" type="number" min="0" max="720" value="${attr(s.follow_up_hours)}"${dis}></label>
        <label>Reminders at most<input data-f="max_follow_ups" type="number" min="0" max="10" value="${attr(s.max_follow_ups)}"${dis}></label>
        <div class="full wf-vars"><small>Insert into the message:</small> ${WF_VARIABLES.map(([v, l]) => `<button type="button" class="chip" data-var="${v}" title="${attr(l)}"${dis}>{{${v}}}</button>`).join("")}</div>
        <label class="full">Message (Bahasa Malaysia)<textarea data-f="message_ms" rows="3" maxlength="1000"${dis}>${esc(s.message_ms)}</textarea>
          <span class="wf-preview" data-pv="ms">${esc(preview(s, "ms")) || "<i>No message</i>"}</span></label>
        <label class="full">Message (English)<textarea data-f="message_en" rows="3" maxlength="1000"${dis}>${esc(s.message_en)}</textarea>
          <span class="wf-preview" data-pv="en">${esc(preview(s, "en")) || "<i>No message</i>"}</span></label>
        <label>Approved WhatsApp template after 24 hours <small>name in Templates</small><input data-f="template" value="${attr(s.template)}" placeholder="e.g. ${attr(w.key)}_${attr(s.key)}"${dis}></label>
        <label>Next stage<select data-f="next_stage_key"${dis}>${opt("", `Next in order${nx && !s.next_stage_key ? ` (${nx.name})` : ""}`, s.next_stage_key)}${liveStages.map((x) => opt(x.key, x.name, s.next_stage_key)).join("")}</select></label>`}
        <label class="check"><input type="checkbox" data-f="is_final"${s.is_final ? " checked" : ""}${dis}> Final stage (completes the workflow)</label>
        <label class="check"><input type="checkbox" data-f="active"${s.active !== false ? " checked" : ""}${dis}> Active <small>(inactive: skipped, no reminders)</small></label>
        <label class="check"><input type="checkbox" data-f="human_on_enter"${s.human_on_enter ? " checked" : ""}${dis}> A person takes over when a buyer reaches this stage (follow-up task)</label>
        ${s.is_final ? "" : `<label class="check"><input type="checkbox" data-f="escalate_after_max"${s.escalate_after_max !== false ? " checked" : ""}${dis}> After the last reminder without progress, open a follow-up task</label>`}
        ${s.archived && n ? `<label class="full">Move its ${n} lead${n === 1 ? "" : "s"} to<select data-f="move_to"${dis}>${opt("", "Choose a stage", s.move_to)}${D.stages.filter((x) => !x.archived).map((x) => opt(x.key, x.name, s.move_to)).join("")}</select></label>` : ""}
      </div>
      ${mgr ? `<div class="row-actions">${s.archived ? `<button type="button" class="btn" data-op="restore">Restore</button>` : `<button type="button" class="btn" data-op="up"${i === 0 ? " disabled" : ""}>↑ Move up</button>
        <button type="button" class="btn" data-op="down">↓ Move down</button><button type="button" class="btn" data-op="dup">Duplicate</button>
        <button type="button" class="btn danger" data-op="archive">Archive</button>`}</div>` : ""}</details>`;
  };

  const render = () => {
    const liveIdx = D.stages.map((s, i) => [s, i]).filter(([s]) => !s.archived), archIdx = D.stages.map((s, i) => [s, i]).filter(([s]) => s.archived);
    body.innerHTML = `<form id="wfb" class="wf-builder"${restored || D._dirty ? ` data-draft-key="wf:${attr(w.key)}"` : ""}>
      ${restored ? `<div class="card notice"><div><b>Unsaved changes restored.</b> <button type="button" class="link" id="wfdiscard">Discard them</button></div></div>` : ""}
      <div class="card"><ul class="checks"><li>Stages run top to bottom. A buyer moves on by replying the stage keyword (or saying so clearly to the AI); staff can move anyone on the Leads tab.</li>
        <li>Reminders go out only while sending is on (Settings), never while the buyer is mid-conversation or outside business hours. After 24 hours without a buyer message only the approved template can be sent; without one, a follow-up task is opened.</li>
        <li>Each save is checked as a whole (keywords unique, a final stage, messages for stages with reminders) and recorded in History.</li></ul></div>
      <div id="wferr"></div>
      ${liveIdx.map(([s, i]) => stageCard(s, i)).join("")}
      ${mgr ? `<div class="row-actions"><button type="button" class="btn" id="wfadd">+ Add stage</button></div>` : ""}
      ${archIdx.length ? `<details class="card"${archIdx.some(([s]) => s._open) ? " open" : ""}><summary>Archived stages (${archIdx.length})</summary>${archIdx.map(([s, i]) => stageCard(s, i)).join("")}</details>` : ""}
      ${mgr ? `<div class="card wf-save"><label>Note for the history (optional)<input name="change_note" maxlength="200" placeholder="e.g. shorter reminder for booking"></label>
        <div class="actions"><button class="btn pri" data-busy="Saving…">Save workflow</button></div></div>` : `<p class="note">Managers and owners can change workflows${w.status === "archived" ? " (restore it in Settings first)" : ""}.</p>`}
    </form>`;
    const f = $("#wfb", body);
    if (restored || D._dirty) f.classList.add("has-draft");
    if (!mgr) return;
    const persist = () => { D._dirty = true; f.classList.add("has-draft"); f.dataset.draftKey = "wf:" + w.key; markDirty(true); try { sessionStorage.setItem(DRAFT(w.key), JSON.stringify(D)); } catch { /* drafts are a convenience */ } };
    const read = (card) => {
      const s = D.stages[Number(card.dataset.i)];
      $$("[data-f]", card).forEach((x) => {
        const k = x.dataset.f;
        if (x.disabled && k === "key") return;
        if (x.type === "checkbox") s[k] = x.checked;
        else if (x.type === "number") s[k] = x.value === "" ? 0 : Number(x.value);
        else if (k === "keywords") s[k] = lines(x.value);
        else s[k] = x.value;
      });
      return s;
    };
    // which stages are open is read before a change moves them around, so each one stays as the reader left it
    const keepOpen = () => $$("details.wf-stage", f).forEach((c) => { D.stages[Number(c.dataset.i)]._open = c.open; });
    const rerender = () => { persist(); render(); };
    f.addEventListener("input", (e) => {
      const card = e.target.closest(".wf-stage"); if (!card) return;
      const s = read(card);
      $$("[data-pv]", card).forEach((pv) => { pv.textContent = preview(s, pv.dataset.pv) || "No message"; });
      persist();
    });
    f.addEventListener("change", (e) => { const card = e.target.closest(".wf-stage"); if (!card) return; read(card); if (e.target.type === "checkbox") { keepOpen(); rerender(); } else persist(); });
    f.addEventListener("focusin", (e) => { if (e.target.tagName === "TEXTAREA") focusTa = e.target; });
    $$("[data-var]", f).forEach((b) => b.onclick = () => {
      const card = b.closest(".wf-stage"), ta = focusTa && card.contains(focusTa) ? focusTa : $("textarea", card), ins = `{{${b.dataset.var}}}`;
      const a = ta.selectionStart ?? ta.value.length, z = ta.selectionEnd ?? a;
      ta.value = ta.value.slice(0, a) + ins + ta.value.slice(z); ta.focus(); ta.selectionStart = ta.selectionEnd = a + ins.length;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    $$("[data-op]", f).forEach((b) => b.onclick = () => {
      const card = b.closest(".wf-stage"), i = Number(card.dataset.i), s = read(card), op = b.dataset.op;
      keepOpen();
      const liveOrder = D.stages.map((x, j) => [x, j]).filter(([x]) => !x.archived).map(([, j]) => j), at = liveOrder.indexOf(i);
      if (op === "up" || op === "down") {
        const j = liveOrder[at + (op === "up" ? -1 : 1)];
        if (j === undefined) return;
        [D.stages[i], D.stages[j]] = [D.stages[j], D.stages[i]];
      } else if (op === "dup") {
        let k = s.key + "_copy", n = 2;
        while (D.stages.some((x) => x.key === k)) k = `${s.key}_copy${n++}`;
        D.stages.splice(i + 1, 0, { ...structuredClone(s), id: undefined, key: k.slice(0, 40), name: s.name + " (copy)", keywords: [], is_final: false, _open: true });
      } else if (op === "archive") {
        const n = counts(s.key);
        if (!confirm(n ? `${n} lead${n === 1 ? " is" : "s are"} at “${s.name}”. Archive it? You will choose a stage to move ${n === 1 ? "this lead" : "them"} to before saving.` : `Archive “${s.name}”? Its settings are kept and it can be restored.`)) return;
        if (!s.id) D.stages.splice(i, 1); else { s.archived = true; s._open = !!n; }
      } else if (op === "restore") { s.archived = false; s.move_to = ""; s._open = true; }
      rerender();
    });
    const add = $("#wfadd", f);
    if (add) add.onclick = () => {
      keepOpen();
      let n = D.stages.length + 1, k = "stage_" + n;
      while (D.stages.some((x) => x.key === k)) k = "stage_" + ++n;
      const fin = D.stages.findIndex((x) => x.is_final && !x.archived);
      D.stages.splice(fin < 0 ? D.stages.length : fin, 0, { key: k, name: "", step_en: "", step_ms: "", keywords: [], follow_up_hours: 24, max_follow_ups: 3, template: "", message_ms: "", message_en: "",
        next_stage_key: "", is_final: false, human_on_enter: false, escalate_after_max: true, active: true, archived: false, _open: true });
      rerender();
    };
    const disc = $("#wfdiscard", f);
    if (disc) disc.onclick = () => { if (!confirm("Discard the unsaved changes?")) return; try { sessionStorage.removeItem(DRAFT(w.key)); } catch { /* ignore */ } reload(); };
    f.onsubmit = (e) => {
      e.preventDefault();
      $$("details.wf-stage", f).forEach(read);
      const p = { ...D, change_note: f.change_note.value.trim(), stages: D.stages.map(({ _open, ...s }) => ({ ...s, key: s.key || slug(s.name) })) };
      delete p._dirty;
      const errs = validateWorkflow(p);
      for (const s of p.stages) if (s.archived && counts(s.key) && !s.move_to && saved.stages.find((x) => x.key === s.key && !x.archived)) errs.push(`“${s.name}”: choose where to move its leads before archiving it.`);
      const box = $("#wferr", f);
      if (errs.length) { box.innerHTML = `<div class="card error"><h3>Please fix before saving</h3><ul>${errs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`; box.scrollIntoView({ block: "center" }); return; }
      box.innerHTML = "";
      act(f.querySelector(".btn.pri"), async () => {
        await save(p);
        try { sessionStorage.removeItem(DRAFT(w.key)); } catch { /* ignore */ }
        f.classList.remove("has-draft"); markDirty($$("form.has-draft").length > 0);
        reload();
      }, "Workflow saved");
    };
  };
  render();
}

/* ================================================================ settings: entry, safeguards, sending */
function settingsView(body, w, all, reload) {
  const mgr = can("manager"), dis = mgr ? "" : " disabled", E = { ...payloadOf(w).entry };
  const used = new Set(all.filter((x) => x.status === "active" && x.project_id && x.id !== w.id).map((x) => x.project_id));
  body.innerHTML = `<form id="wfs" class="card form two">
    <h2 class="full">Workflow</h2>
    <label>Name<input name="name" value="${attr(w.name)}" maxlength="120" required${dis}></label>
    <label>Website listing<select name="project_id"${dis}>${opt("", "None", w.project_id || "")}${S.projects.filter((p) => !used.has(p.id)).map((p) => opt(p.id, p.name, w.project_id || "")).join("")}</select></label>
    <label class="full">Description<input name="description" value="${attr(w.description)}" maxlength="300"${dis}></label>
    <h2 class="full">Sending &amp; safeguards</h2>
    <label class="switch full"><input type="checkbox" name="sending_enabled"${w.sending_enabled ? " checked" : ""}${dis}><span><b>Send this workflow's reminders on WhatsApp</b><small>Off until you have checked the messages on the Stages tab. Switching on schedules reminders for every active lead.</small></span></label>
    <label>No reminder while the buyer has talked to us within (hours)<input name="pause_if_active_hours" type="number" min="0" max="72" value="${attr(w.pause_if_active_hours)}"${dis}></label>
    <p class="note">Always on: one reminder waiting per lead; each is re-checked (stage, project, opt-out, business hours, 24-hour window) right before sending; nothing is sent late in a burst.</p>
    <h2 class="full">How leads join</h2>
    <label class="full">Ad phrases <small>a click-to-WhatsApp ad whose headline, text or link contains one of these (comma separated)</small><input name="ad_phrases" value="${attr(E.ad_phrases.join(", "))}" placeholder="e.g. metropolitan kepong"${dis}></label>
    <label class="full">Message phrases <small>a buyer's WhatsApp message containing one of these</small><input name="message_phrases" value="${attr(E.message_phrases.join(", "))}" placeholder="e.g. metropolitan kepong"${dis}></label>
    <label class="check full"><input type="checkbox" name="project_listing"${E.project_listing ? " checked" : ""}${dis}> A lead set to the website listing above joins (website enquiry or staff)</label>
    <label class="check full"><input type="checkbox" name="ai_confirm"${E.ai_confirm ? " checked" : ""}${dis}> The AI may add a buyer once they clearly confirm this project</label>
    <label class="check full"><input type="checkbox" name="exclusive_project"${E.exclusive_project ? " checked" : ""}${dis}> Pause a lead here when it is moved to another project (resumed when set back)</label>
    <label class="full">Guidance for the AI <small>e.g. how to tell this project apart from similar names</small><textarea name="ai_instructions" rows="3" maxlength="1000"${dis}>${esc(w.ai_instructions)}</textarea></label>
    ${mgr ? `<label class="full">Note for the history (optional)<input name="change_note" maxlength="200"></label>
      <div class="actions full"><button class="btn pri" data-busy="Saving…">Save settings</button>
      <button type="button" class="btn ${w.status === "archived" ? "" : "danger"}" id="wfarch">${w.status === "archived" ? "Restore workflow" : "Archive workflow"}</button></div>`
      : `<p class="note full">Managers and owners can change these.</p>`}
  </form>`;
  const f = $("#wfs", body);
  if (!mgr) return;
  const build = (over = {}) => { const v = formData(f);
    return { ...payloadOf(w), name: v.name || "", project_id: v.project_id || "", description: v.description || "", sending_enabled: !!v.sending_enabled,
      pause_if_active_hours: v.pause_if_active_hours ?? 6, ai_instructions: v.ai_instructions || "", change_note: v.change_note || "",
      entry: { ad_phrases: lines(v.ad_phrases), message_phrases: lines(v.message_phrases), project_listing: !!v.project_listing, ai_confirm: !!v.ai_confirm, exclusive_project: !!v.exclusive_project }, ...over }; };
  f.onsubmit = (e) => { e.preventDefault(); const p = build();
    const errs = validateWorkflow(p);
    if (errs.length) return toast(errs[0], "err");
    if (p.sending_enabled && !w.sending_enabled && !confirm(`Switch sending on? Reminders are scheduled for the ${w.leads.filter((l) => l.status === "active").length} active lead(s) at their current stage.`)) return;
    act(f.querySelector(".btn.pri"), async () => { await save(p); reload(); }, "Settings saved");
  };
  $("#wfarch", f).onclick = (e) => {
    const arch = w.status !== "archived";
    if (!confirm(arch ? "Archive this workflow? Its reminders stop and keywords do nothing; leads and history are kept, and it can be restored." : "Restore this workflow? Sending stays as set in these settings.")) return;
    act(e.target, async () => { await save(build({ status: arch ? "archived" : "active", sending_enabled: arch ? false : w.sending_enabled })); reload(); }, arch ? "Workflow archived" : "Workflow restored");
  };
}

/* ================================================================ history */
const FIELD = { name: "name", description: "description", project_id: "website listing", status: "status", sending_enabled: "sending", pause_if_active_hours: "active-conversation pause",
  entry: "how leads join", ai_instructions: "AI guidance", key: "short name", position: "order", step_en: "step (EN)", step_ms: "step (BM)", keywords: "keywords", follow_up_hours: "interval",
  max_follow_ups: "reminder count", template: "template", message_ms: "message (BM)", message_en: "message (EN)", next_stage_key: "next stage", is_final: "final", human_on_enter: "person on entry",
  escalate_after_max: "task after last reminder", active: "active", archived_at: "archived" };
export function diffSummary(before, after) {
  if (!before) return ["Created with " + (after?.stages || []).filter((s) => !s.archived_at).length + " stages"];
  const out = [], same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const top = Object.keys(FIELD).filter((k) => k in (after || {}) && k !== "key" && !same(before[k], after[k]));
  if (top.length) out.push("Workflow: " + top.map((k) => FIELD[k]).join(", "));
  const bs = new Map((before.stages || []).map((s) => [s.id, s]));
  for (const s of after.stages || []) {
    const b = bs.get(s.id);
    if (!b) { out.push(`Stage added: ${s.name}`); continue; }
    if (!b.archived_at && s.archived_at) { out.push(`Stage archived: ${s.name}`); continue; }
    if (b.archived_at && !s.archived_at) { out.push(`Stage restored: ${s.name}`); continue; }
    const ch = Object.keys(FIELD).filter((k) => k !== "archived_at" && k in s && !same(b[k], s[k]));
    if (ch.length) out.push(`${b.name !== s.name ? `${b.name} → ${s.name}` : s.name}: ${ch.map((k) => FIELD[k]).join(", ")}`);
  }
  return out.length ? out : ["No visible change"];
}
async function historyView(body, w, leads) {
  const changes = (await q(SB.from("ai_workflow_changes").select("*").eq("workflow_id", w.id).order("at", { ascending: false }).limit(100))) || [];
  const label = (k) => stageOf(w.stages, k)?.name || k;
  const moves = leads.flatMap((r) => (r.history || []).map((h) => ({ ...h, lead: r.lead, lead_id: r.lead_id }))).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 50);
  body.innerHTML = `<section class="card"><h2>Settings changes</h2>${changes.length ? `<ul class="timeline">${changes.map((c) => `<li><p><b>${esc(c.action)}</b> by ${esc(c.by)}${c.summary ? ` — “${esc(c.summary)}”` : ""}</p>
      <ul>${diffSummary(c.before, c.after).map((x) => `<li>${esc(x)}</li>`).join("")}</ul><small>${esc(fmtDate(c.at))}</small></li>`).join("")}</ul>` : empty("No changes recorded yet.")}</section>
    <section class="card"><h2>Recent lead moves</h2>${moves.length ? `<ul class="timeline">${moves.map((h) => `<li><p><a href="#/lead/${attr(h.lead_id)}">${esc(who(h.lead))}</a>:
      ${h.to ? `${h.from ? esc(label(h.from)) + " → " : "joined at "}${esc(label(h.to))}` : `${esc(WF_STATUS[h.status] || h.status)}${h.reason ? " (" + esc(h.reason) + ")" : ""}`}</p>
      <small>${esc(fmtDate(h.at))} · ${esc(h.via || "")} ${esc(h.by || "")}</small></li>`).join("")}</ul>` : empty("No lead moves yet.")}</section>`;
}

/* ================================================================ lead page card */
export async function leadWorkflowsCard(leadId) {
  const [rows, ws] = await Promise.all([
    q(SB.from("ai_workflow_leads").select("workflow_id,stage,status,status_reason,source,stage_changed_at").eq("lead_id", leadId)),
    q(SB.from("ai_workflows").select("id,key,name,status").order("name")),
  ]);
  const mine = rows || [], all = ws || [];
  const stages = mine.length ? (await q(SB.from("ai_workflow_stages").select("workflow_id,key,name").in("workflow_id", mine.map((r) => r.workflow_id)))) || [] : [];
  const offer = all.filter((w) => w.status === "active" && !mine.some((r) => r.workflow_id === w.id));
  if (!mine.length && (!can("advisor") || !offer.length)) return "";
  return `<section class="card" id="wfc"><h2>Follow-up workflows</h2>
    ${mine.map((r) => { const w = all.find((x) => x.id === r.workflow_id), st = stages.find((s) => s.workflow_id === r.workflow_id && s.key === r.stage);
      return `<p><a href="#/workflow/${attr(w?.key)}?view=list">${esc(w?.name || "Workflow")}</a>: ${esc(st?.name || r.stage)} ${badge(WF_STATUS[r.status], WF_STATUS_KIND[r.status])}<br>
        <small>Since ${esc(fmtDate(r.stage_changed_at))} · source ${esc(WF_SOURCES[r.source] || r.source)}${r.status_reason ? " · " + esc(r.status_reason) : ""}</small></p>`; }).join("")}
    ${can("advisor") && offer.length ? `<form id="wfadd" class="form two"><label>Add to workflow<select name="wf">${offer.map((w) => opt(w.id, w.name, "")).join("")}</select></label>
      <label>Came from<select name="source">${Object.entries(WF_SOURCES).map(([k, v]) => opt(k, v, "whatsapp")).join("")}</select></label>
      <div class="actions full"><button class="btn" data-busy="Adding…">Add to workflow</button></div></form>` : ""}</section>`;
}
export function bindLeadWorkflowsCard(el, leadId, reload) {
  const f = $("#wfadd", el);
  if (!f) return;
  f.onsubmit = (e) => { e.preventDefault(); const v = formData(f), name = f.wf.selectedOptions[0]?.textContent || "the workflow";
    if (!confirm(`Add this buyer to “${name}”? They get that workflow's follow-ups.`)) return;
    act(f.querySelector("button"), async () => { await q(SB.rpc("ai_wf_enroll", { p_wf: v.wf, p_lead: leadId, p_source: v.source })); reload(); }, "Added to " + name);
  };
}
