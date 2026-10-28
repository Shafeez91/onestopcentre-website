// AI Sales dashboard — RMK (Residensi Metropolitan Kepong): its own pipeline, lead list and stage follow-ups.
// Leads join through the RMK ad, the project's name in a WhatsApp message, the RMK website listing, the AI (when the
// buyer confirms) or staff. Stage changes and reminders are handled by the database functions of migration 14.
import { SB, S, can, $, $$, esc, attr, fmtDate, ago, q, act, toast, guardForm, clearDraft, formData, badge, opt, empty, keepPlace, loadLookups } from "./core.js";
import { RMK_STAGES, RMK_STAGE, RMK_STATUS, RMK_SOURCES, rmkSettings } from "../shared/rmk.mjs";

const STATUS_KIND = { active: "ok", paused: "warn", completed: "", human: "alert" };
const name = (l) => l?.contact?.full_name || (l?.contact?.phone_e164 ? "+" + l.contact.phone_e164 : "(no name)");
const when = (d) => (d ? fmtDate(d) : "—");

export async function rmk(el, params) {
  const view = ["board", "list", "settings"].includes(params.get("view")) ? params.get("view") : "board";
  const [rows, jobs] = await Promise.all([
    q(SB.from("ai_rmk_pipeline").select("*, lead:ai_leads(id,lead_code,closed_at,primary_project_id,contact_id,contact:ai_contacts(full_name,phone_e164))").order("stage_changed_at", { ascending: false }).limit(2000)),
    q(SB.from("ai_automation_jobs").select("lead_id,run_at,seq,stage").eq("kind", "rmk_follow_up").eq("status", "scheduled").limit(2000)),
  ]);
  const list = rows || [], next = Object.fromEntries((jobs || []).map((j) => [j.lead_id, j]));
  const contactIds = list.map((r) => r.lead?.contact_id).filter(Boolean);
  const convs = contactIds.length ? (await q(SB.from("ai_conversations").select("contact_id,last_inbound_at,last_outbound_at").in("contact_id", contactIds).eq("channel", "whatsapp"))) || [] : [];
  const lastWa = (r) => { const c = convs.find((x) => x.contact_id === r.lead?.contact_id); const t = [c?.last_inbound_at, c?.last_outbound_at].filter(Boolean).sort().pop(); return t || null; };
  const now = Date.now();
  const overdue = (r) => r.status === "human" || (next[r.lead_id] && new Date(next[r.lead_id].run_at) < now - 3600e3);
  const R = rmkSettings(S.settings?.rmk);
  const count = (st) => list.filter((r) => r.stage === st).length;

  el.innerHTML = `<div class="page-head"><div><h1>RMK — Residensi Metropolitan Kepong</h1><p class="sub">Its own pipeline and WhatsApp follow-ups, separate from every other project.</p></div>
    <div class="seg">${[["board", "Board"], ["list", "Leads"], ["settings", "Settings"]].map(([k, l]) => `<a class="${view === k ? "on" : ""}" href="#/rmk?view=${k}">${l}</a>`).join("")}</div></div>
  ${R.enabled ? "" : `<div class="card notice"><div><b>RMK follow-ups are off.</b> Leads are tracked and moved by their keywords, but no reminder is sent until you check the messages in <a href="#/rmk?view=settings">Settings</a> and switch them on.</div></div>`}
  <div class="kpis rmk-kpis">
    <span class="kpi"><b>${list.length}</b><span>RMK leads</span></span>
    ${RMK_STAGES.map((st) => `<span class="kpi"><b>${count(st)}</b><span>${esc(RMK_STAGE[st].label)}</span></span>`).join("")}
    <span class="kpi${list.some(overdue) ? " hot" : ""}"><b>${list.filter(overdue).length}</b><span>Overdue / need a person</span></span>
  </div>
  <div id="rmkv"></div>`;
  const body = $("#rmkv", el);
  const reload = () => keepPlace(el, () => rmk(el, params));
  if (view === "settings") return settingsView(body, R, reload);

  const card = (r) => `<article class="kcard${overdue(r) ? " overdue" : ""}"><a href="#/lead/${attr(r.lead_id)}"><b>${esc(name(r.lead))}</b></a>
    <small>${esc(r.lead?.lead_code || "")} · ${esc(RMK_SOURCES[r.source] || r.source)}</small>
    <div>${badge(RMK_STATUS[r.status], STATUS_KIND[r.status])}${r.status_reason ? ` <small>${esc(r.status_reason)}</small>` : ""}</div>
    <small>In stage ${esc(ago(r.stage_changed_at))}${next[r.lead_id] ? ` · next reminder ${esc(when(next[r.lead_id].run_at))}` : ""}</small></article>`;

  if (view === "board") {
    body.innerHTML = list.length ? `<div class="kanban">${RMK_STAGES.map((st) => { const ls = list.filter((r) => r.stage === st);
      return `<section class="col-k"><h3>${esc(RMK_STAGE[st].label)} <span>${ls.length}</span></h3>${RMK_STAGE[st].keyword ? `<p class="note sm">Buyer replies <b>${esc(RMK_STAGE[st].keyword)}</b> when done</p>` : ""}
        ${ls.map(card).join("") || `<p class="empty sm">Empty</p>`}</section>`; }).join("")}</div>`
      : empty("No RMK leads yet. They join from the RMK ad, a WhatsApp message naming Residensi Metropolitan Kepong, the RMK website listing, the AI when a buyer confirms, or “Add to RMK” on a lead.");
    return;
  }

  // list
  const fs = params.get("q") || "", fst = params.get("stage") || "", fstat = params.get("status") || "";
  const needle = fs.toLowerCase();
  const shown = list.filter((r) => (!fst || r.stage === fst) && (!fstat || (fstat === "overdue" ? overdue(r) : r.status === fstat))
    && (!needle || [name(r.lead), r.lead?.lead_code, r.lead?.contact?.phone_e164].some((v) => String(v || "").toLowerCase().includes(needle))));
  const adv = can("advisor");
  body.innerHTML = `<form id="rmkf" class="filters"><input name="q" type="search" placeholder="Search name, phone or lead code" value="${attr(fs)}">
      <select name="stage"><option value="">All stages</option>${RMK_STAGES.map((st) => opt(st, RMK_STAGE[st].label, fst)).join("")}</select>
      <select name="status"><option value="">Any automation status</option>${Object.entries(RMK_STATUS).map(([k, v]) => opt(k, v, fstat)).join("")}${opt("overdue", "Overdue / need a person", fstat)}</select>
      <button class="btn">Filter</button></form>
    ${shown.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Buyer</th><th>Stage</th><th>Automation</th><th>Source</th><th>Next follow-up</th><th>Last WhatsApp</th></tr></thead><tbody>
    ${shown.map((r) => `<tr${overdue(r) ? ` class="overdue"` : ""}><td data-label="Buyer"><a href="#/lead/${attr(r.lead_id)}">${esc(name(r.lead))}</a><small>${esc(r.lead?.lead_code || "")}</small></td>
      <td data-label="Stage">${adv ? `<select data-stage="${attr(r.lead_id)}" aria-label="Stage">${RMK_STAGES.map((st) => opt(st, RMK_STAGE[st].label, r.stage)).join("")}</select>` : esc(RMK_STAGE[r.stage].label)}<small>since ${esc(when(r.stage_changed_at))}</small></td>
      <td data-label="Automation">${badge(RMK_STATUS[r.status], STATUS_KIND[r.status])}${r.status_reason ? `<small>${esc(r.status_reason)}</small>` : ""}
        ${adv && r.stage !== "all_signed" ? (r.status === "paused" ? `<button class="link" data-resume="${attr(r.lead_id)}">Resume</button>` : `<button class="link" data-pause="${attr(r.lead_id)}">Pause</button>`) : ""}</td>
      <td data-label="Source">${esc(RMK_SOURCES[r.source] || r.source)}</td>
      <td data-label="Next follow-up">${next[r.lead_id] ? `${esc(when(next[r.lead_id].run_at))}<small>reminder ${esc(next[r.lead_id].seq)}</small>` : "—"}</td>
      <td data-label="Last WhatsApp">${lastWa(r) ? esc(ago(lastWa(r))) : "—"}</td></tr>`).join("")}</tbody></table></div>` : empty("No RMK leads match.")}`;
  const f = $("#rmkf", body);
  f.onsubmit = (e) => { e.preventDefault(); const v = formData(f); const u = new URLSearchParams({ view: "list", ...(v.q ? { q: v.q } : {}), ...(v.stage ? { stage: v.stage } : {}), ...(v.status ? { status: v.status } : {}) }); location.hash = "#/rmk?" + u; };
  $$("[data-stage]", body).forEach((s) => s.onchange = () => act(null, async () => {
    await q(SB.rpc("ai_rmk_set_stage", { p_lead: s.dataset.stage, p_stage: s.value })); reload();
  }, "Stage changed: " + RMK_STAGE[s.value].label));
  $$("[data-pause]", body).forEach((b) => b.onclick = () => { const why = prompt("Pause RMK follow-ups for this buyer. Reason (optional):", ""); if (why === null) return;
    act(b, async () => { await q(SB.rpc("ai_rmk_set_status", { p_lead: b.dataset.pause, p_status: "paused", p_reason: why })); reload(); }, "Paused"); });
  $$("[data-resume]", body).forEach((b) => b.onclick = () => act(b, async () => { await q(SB.rpc("ai_rmk_set_status", { p_lead: b.dataset.resume, p_status: "active" })); reload(); }, "Resumed"));
}

function settingsView(body, R, reload) {
  const mgr = can("manager"), dis = mgr ? "" : " disabled";
  const stages = RMK_STAGES.slice(0, -1);
  body.innerHTML = `<section class="card"><h2>RMK follow-ups</h2>
    <ul class="checks"><li>Only leads on the RMK board get these messages. Each reminder checks the buyer's stage and project again right before it is sent.</li>
      <li>A buyer moves on by replying the stage keyword (or saying so clearly to the AI). The old stage's reminders stop at once.</li>
      <li>No reminder while the buyer is in a conversation; none outside business hours; after 24 hours without a buyer message only an approved template can be sent (else a follow-up task is opened for you).</li>
      <li>After the last reminder of a stage with no progress, a follow-up task is opened (Telegram: follow-up task). Stage changes and RMK messages are not sent to Telegram.</li></ul>
    <form id="rmks" class="form two">
      <label class="switch full"><input type="checkbox" name="enabled"${R.enabled ? " checked" : ""}${dis}><span><b>Send RMK follow-ups on WhatsApp</b><small>Off until you have checked the messages below.</small></span></label>
      <label>RMK listing on the website<select name="project_id"${dis}>${opt("", "Not on the website yet", R.project_id || "")}${S.projects.map((p) => opt(p.id, p.name, R.project_id || "")).join("")}</select></label>
      <label>No reminder while the buyer has talked to us within (hours)<input name="pause_if_active_hours" type="number" min="0" max="72" value="${attr(R.pause_if_active_hours)}"${dis}></label>
      ${stages.map((st) => { const c = R.stages[st]; return `<fieldset class="full rmk-stage"><legend>${esc(RMK_STAGE[st].label)} <small>buyer replies ${esc(RMK_STAGE[st].keyword)}</small></legend>
        <label>Remind every (hours, 0 = no reminders)<input name="${st}__follow_up_hours" type="number" min="0" max="720" value="${attr(c.follow_up_hours)}"${dis}></label>
        <label>Reminders at most<input name="${st}__max_follow_ups" type="number" min="0" max="10" value="${attr(c.max_follow_ups)}"${dis}></label>
        <label class="full">Message (Bahasa Malaysia) <small>{name} = the buyer's name</small><textarea name="${st}__message_ms" rows="3" maxlength="900"${dis}>${esc(c.message_ms)}</textarea></label>
        <label class="full">Message (English)<textarea name="${st}__message_en" rows="3" maxlength="900"${dis}>${esc(c.message_en)}</textarea></label>
        <label class="full">Approved WhatsApp template after 24 hours (name in Templates)<input name="${st}__template" value="${attr(c.template)}" placeholder="e.g. rmk_${st}"${dis}></label></fieldset>`; }).join("")}
      ${mgr ? `<div class="actions full"><button class="btn pri" data-busy="Saving…">Save RMK settings</button></div>` : `<p class="note full">Managers and owners can change these.</p>`}
    </form></section>`;
  const f = $("#rmks", body);
  if (!mgr) return;
  guardForm(f, "rmk:settings");
  f.onsubmit = (e) => { e.preventDefault(); const v = formData(f);
    const st = Object.fromEntries(stages.map((s) => [s, { follow_up_hours: Number(v[`${s}__follow_up_hours`]) || 0, max_follow_ups: Number(v[`${s}__max_follow_ups`]) || 0,
      message_ms: String(v[`${s}__message_ms`] || "").trim(), message_en: String(v[`${s}__message_en`] || "").trim(), template: String(v[`${s}__template`] || "").trim() }]));
    for (const s of stages) {
      const c = st[s];
      if (c.follow_up_hours < 0 || c.follow_up_hours > 720 || c.max_follow_ups < 0 || c.max_follow_ups > 10) return toast(`${RMK_STAGE[s].label}: hours 0–720 and at most 10 reminders.`, "err");
      if (c.follow_up_hours > 0 && c.max_follow_ups > 0 && !c.message_ms && !c.message_en) return toast(`${RMK_STAGE[s].label}: write a message or set no reminders.`, "err");
    }
    const pauseH = Number(v.pause_if_active_hours);
    if (!(pauseH >= 0 && pauseH <= 72)) return toast("Active-conversation pause: 0 to 72 hours.", "err");
    act(f.querySelector("button"), async () => {
      const rmk = { ...(S.settings.rmk || {}), enabled: !!v.enabled, project_id: v.project_id || null, pause_if_active_hours: pauseH, stages: st };
      await q(SB.from("ai_settings").update({ rmk }).eq("id", 1).select("id"), { expectRows: true });
      if (rmk.enabled) await q(SB.rpc("ai_rmk_reschedule_all"));
      clearDraft(f); await loadLookups(); reload();
    }, "RMK settings saved");
  };
}

/** Small card for the lead page: the buyer's RMK stage, or "Add to RMK". */
export async function rmkLeadCard(leadId) {
  const p = (await q(SB.from("ai_rmk_pipeline").select("stage,status,status_reason,source,stage_changed_at").eq("lead_id", leadId).limit(1)))?.[0];
  if (p) return `<section class="card" id="rmkc"><h2>RMK pipeline</h2><p>${esc(RMK_STAGE[p.stage].label)} ${badge(RMK_STATUS[p.status], STATUS_KIND[p.status])}</p>
    <small>Since ${esc(fmtDate(p.stage_changed_at))} · source ${esc(RMK_SOURCES[p.source] || p.source)}${p.status_reason ? " · " + esc(p.status_reason) : ""}</small>
    <p><a href="#/rmk?view=list">Open the RMK leads</a></p></section>`;
  if (!can("advisor")) return "";
  return `<section class="card" id="rmkc"><h2>RMK pipeline</h2><p class="note">Only for buyers of Residensi Metropolitan Kepong.</p>
    <form id="rmkadd" class="form two"><label>Came from<select name="source">${Object.entries(RMK_SOURCES).map(([k, v]) => opt(k, v, "whatsapp")).join("")}</select></label>
    <div class="actions"><button class="btn" data-busy="Adding…">Add to RMK</button></div></form></section>`;
}
export function bindRmkLeadCard(el, leadId, reload) {
  const f = $("#rmkadd", el);
  if (!f) return;
  f.onsubmit = (e) => { e.preventDefault(); const v = formData(f);
    if (!confirm("Add this buyer to the RMK pipeline? RMK follow-ups apply only to Residensi Metropolitan Kepong buyers.")) return;
    act(f.querySelector("button"), async () => { await q(SB.rpc("ai_rmk_enroll", { p_lead: leadId, p_source: v.source })); reload(); }, "Added to RMK");
  };
}
