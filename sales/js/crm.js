// AI Sales dashboard — overview, leads/CRM, lead detail, pipeline, appointments, handover queue, inbox.
import { SB, S, can, $, $$, esc, attr, fmtDate, ago, q, act, toast, guardForm, clearDraft, formData, modal, tempBadge, badge, opt, empty, ro,
  projectName, stageName, sourceName, projectPriceFrom, toLocalInput, fromLocalInput, flag, errText, api, keepPlace } from "./core.js";
import { normalizePhone, formatPhone } from "../shared/phone.mjs";
import { calendar, tasks, scheduleTabs } from "./schedule.js";

const openStages = () => S.stages.filter((s) => s.active && !s.is_won && !s.is_lost);
export const teamOptions = (sel) => opt("", "— Unassigned —", sel) + [...new Set([...S.team.filter((m) => m.active).map((m) => m.email), S.email])].map((e) => opt(e, e, sel)).join("");
export const projectOptions = (sel, blank = "— None —") => opt("", blank, sel) + S.projects.map((p) => opt(p.id, p.name + (p.area ? " · " + p.area : "") + (p.published ? "" : " (unpublished)"), sel)).join("");
const stageChip = (id) => { const s = S.stages.find((x) => x.id === id) || {}; return `<span class="stage-chip c-${attr(s.color || "slate")}">${esc(s.name || "—")}</span>`; };
const contactName = (c) => (c && (c.full_name || (c.phone_e164 ? formatPhone(c.phone_e164) : c.email))) || "(no name)";

/* ======================= Leads list ======================= */
export async function leads(el, params) {
  const f = { status: params.get("status") || "", temp: params.get("temp") || "", stage: params.get("stage") || "", owner: params.get("owner") || "", since: params.get("since") || "", q: params.get("q") || "" };
  const queue = params.get("view") === "queue";
  // a lead in a won or lost stage is always closed, and one in any other stage always open: the status follows the
  // stage chosen, so "Open" + "LO, SPA & LA Signed" never shows an empty list by mistake
  const stageOf = (id) => S.stages.find((x) => x.id === id);
  const closingStage = (id) => !!(stageOf(id)?.is_won || stageOf(id)?.is_lost);
  if (!f.status || (f.stage && f.status !== "all")) f.status = f.stage ? (closingStage(f.stage) ? "closed" : "open") : f.status || "open";
  let query = SB.from("ai_leads").select("id,lead_code,temperature,score,stage_id,owner_email,source_id,primary_project_id,handover_status,ai_paused,created_at,updated_at,last_contact_at,closed_at,ai_summary,contact:ai_contacts(id,full_name,phone_e164,email)").order("updated_at", { ascending: false }).limit(1000);
  if (f.status === "open") query = query.is("closed_at", null);
  if (f.status === "closed") query = query.not("closed_at", "is", null);
  if (f.temp) query = query.eq("temperature", f.temp);
  if (f.stage) query = query.eq("stage_id", f.stage);
  if (f.owner === "me") query = query.eq("owner_email", S.email);
  if (f.owner === "none") query = query.is("owner_email", null);
  if (f.since) query = query.gte("created_at", new Date(Date.now() - Number(f.since) * 864e5).toISOString());
  let rows = (await q(query)) || [];
  // follow-up queue: leads where someone has to act now (waiting for a person, overdue task, stuck in a workflow,
  // or an open AI recommendation due today)
  const why = {};
  if (queue) {
    const nowIso = new Date().toISOString(), today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
    const [late, wfh] = await Promise.all([
      q(SB.from("ai_tasks").select("lead_id,title,due_at").eq("status", "open").lte("due_at", nowIso).limit(2000)).catch(() => []),
      q(SB.from("ai_workflow_leads").select("lead_id").eq("status", "human").limit(2000)).catch(() => []),
    ]);
    const add = (lid, r) => { (why[lid] ||= []).push(r); };
    rows.forEach((l) => { if (l.handover_status === "requested") add(l.id, "Waiting for a person");
      const na = l.ai_summary?.next_action; if (na?.status === "open" && (na.priority === "high" || (na.due_at && na.due_at <= today))) add(l.id, "Next action: " + na.action); });
    (late || []).forEach((t) => add(t.lead_id, "Overdue: " + t.title));
    (wfh || []).forEach((w) => add(w.lead_id, "Workflow needs a person"));
    rows = rows.filter((l) => why[l.id]);
  }
  if (f.q) {
    const needle = f.q.toLowerCase(), digits = normalizePhone(f.q);
    rows = rows.filter((l) => [l.lead_code, l.contact?.full_name, l.contact?.email, projectName(l.primary_project_id)].some((v) => String(v || "").toLowerCase().includes(needle)) || (digits && String(l.contact?.phone_e164 || "").includes(digits)));
  }
  el.innerHTML = `
  <div class="page-head"><h1>Leads &amp; CRM</h1>${can("advisor") ? `<button class="btn pri" id="new">＋ New lead</button>` : ""}</div>
  <div class="seg"><a class="${queue ? "" : "on"}" href="#/leads">All leads</a><a class="${queue ? "on" : ""}" href="#/leads?view=queue">Follow-up queue</a><a href="#/pipeline">Pipeline board</a></div>
  <form class="filters" id="flt">
    <input type="search" name="q" placeholder="Search name, phone, email, OSC code, project" value="${attr(f.q)}" aria-label="Search leads">
    <select name="status" aria-label="Status">${opt("open", "Open", f.status)}${opt("closed", "Closed", f.status)}${opt("all", "All", f.status)}</select>
    <select name="temp" aria-label="Temperature">${opt("", "Any temperature", f.temp)}${["hot", "warm", "nurture", "unqualified"].map((t) => opt(t, t[0].toUpperCase() + t.slice(1), f.temp)).join("")}</select>
    <select name="stage" aria-label="Stage">${opt("", "Any stage", f.stage)}${S.stages.map((s) => opt(s.id, s.name, f.stage)).join("")}</select>
    <select name="owner" aria-label="Owner">${opt("", "Anyone", f.owner)}${opt("me", "Mine", f.owner)}${opt("none", "Unassigned", f.owner)}</select>
  </form>
  <p class="sub">${rows.length} lead${rows.length === 1 ? "" : "s"}${rows.length >= 1000 ? " (showing the latest 1,000)" : ""}</p>
  ${queue ? `<p class="note">Leads where someone has to act now: waiting for a person, an overdue follow-up task, stuck in a follow-up workflow, or an AI recommendation due today.</p>` : ""}
  ${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Lead</th><th>Contact</th><th>Project</th><th>Stage</th><th>Temp</th><th>Owner</th><th>Updated</th></tr></thead><tbody>
  ${rows.map((l) => `<tr data-href="#/lead/${attr(l.id)}" tabindex="0">
    <td data-label="Lead"><a href="#/lead/${attr(l.id)}"><b>${esc(l.lead_code)}</b></a>${l.handover_status === "requested" ? " " + badge("Needs human", "alert") : ""}${l.ai_paused ? " " + badge("AI paused") : ""}${why[l.id] ? `<small class="why-q">${why[l.id].map(esc).join(" · ")}</small>` : ""}</td>
    <td data-label="Contact">${esc(contactName(l.contact))}<small>${esc(l.contact?.phone_e164 ? formatPhone(l.contact.phone_e164) : l.contact?.email || "")}</small></td>
    <td data-label="Project">${esc(projectName(l.primary_project_id)) || "—"}</td>
    <td data-label="Stage">${stageChip(l.stage_id)}</td>
    <td data-label="Temp">${tempBadge(l.temperature)}${l.score !== null ? ` <small>${l.score}</small>` : ""}</td>
    <td data-label="Owner">${esc(l.owner_email || "—")}</td>
    <td data-label="Updated">${esc(ago(l.updated_at))}</td></tr>`).join("")}
  </tbody></table></div>` : empty(queue ? "Nothing needs action right now." : "No leads match these filters.")}`;
  const form = $("#flt", el);
  const apply = (e) => {
    if (e?.target?.name === "stage" && form.stage.value && form.status.value !== "all") form.status.value = closingStage(form.stage.value) ? "closed" : "open";
    const d = formData(form); const p = new URLSearchParams(queue ? { view: "queue" } : {}); Object.entries(d).forEach(([k, v]) => v && p.set(k, v)); if (!d.status) p.set("status", "open"); location.hash = "#/leads?" + p.toString(); };
  form.onchange = apply;
  form.onsubmit = (e) => { e.preventDefault(); apply(); };
  $$("tr[data-href]", el).forEach((tr) => { tr.onclick = (e) => { if (!e.target.closest("a")) location.hash = tr.dataset.href; }; tr.onkeydown = (e) => { if (e.key === "Enter") location.hash = tr.dataset.href; }; });
  const nb = $("#new", el);
  if (nb) nb.onclick = () => newLeadModal();
  // quick add (top bar): open the form straight away
  if (nb && params.get("new") === "1") { history.replaceState(null, "", "#/leads"); newLeadModal(); }
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
export const KIND = { showroom_visit: "Showroom visit", property_viewing: "Property viewing", phone_call: "Phone consultation", video_call: "Video consultation", financing_discussion: "Financing discussion" };
const kindLabel = (k) => KIND[k] || k;
export const APPT = { pending_confirmation: ["Pending confirmation", "warn"], confirmed: ["Confirmed", "ok"], rescheduled: ["Rescheduled", "warn"], cancelled: ["Cancelled", ""], completed: ["Completed", "ok"], no_show: ["No-show", "alert"] };
export const apptBadge = (s) => badge((APPT[s] || [s])[0], (APPT[s] || [, ""])[1]);

/* ======================= Pipeline ======================= */
export async function pipeline(el) {
  // open stages, then the closing stages (won / lost) at the end: leads there are closed, so they are fetched apart
  // (the most recent per stage) and a link opens the full list; moving one back to an open stage reopens it
  const closing = S.stages.filter((s) => s.active && (s.is_won || s.is_lost));
  const [rows, closedRows] = await Promise.all([
    q(SB.from("ai_leads").select("id,lead_code,temperature,score,stage_id,owner_email,primary_project_id,updated_at,contact:ai_contacts(full_name,phone_e164,email)").is("closed_at", null).order("updated_at", { ascending: false }).limit(2000)),
    closing.length ? q(SB.from("ai_leads").select("id,lead_code,temperature,score,stage_id,owner_email,primary_project_id,updated_at,closed_at,contact:ai_contacts(full_name,phone_e164,email)").not("closed_at", "is", null).in("stage_id", closing.map((s) => s.id)).order("closed_at", { ascending: false }).limit(1000)) : [],
  ]);
  const open = rows || [], closed = closedRows || [];
  const SHOW = 50;
  const card = (l) => `<article class="kcard"><a href="#/lead/${attr(l.id)}"><b>${esc(contactName(l.contact))}</b></a><small>${esc(l.lead_code)} · ${esc(projectName(l.primary_project_id) || "No project")}</small>
      <div>${tempBadge(l.temperature)} <small>${esc(l.owner_email || "Unassigned")}</small>${l.closed_at ? ` <small>· closed ${esc(fmtDate(l.closed_at, false))}</small>` : ""}</div>
      ${can("advisor") ? `<select data-move="${attr(l.id)}" aria-label="Move ${attr(l.lead_code)}">${S.stages.filter((x) => x.active).map((x) => opt(x.id, x.name, l.stage_id)).join("")}</select>` : ""}</article>`;
  const column = (s, ls, isClosing) => `<section class="col-k${isClosing ? " col-closing " + (s.is_won ? "won" : "lost") : ""}"><h3>${esc(s.name)} <span>${ls.length}</span></h3>
    ${isClosing ? `<p class="note sm">${s.is_won ? "Won" : "Lost"} · closed leads${ls.length > SHOW ? ` · latest ${SHOW} shown` : ""}</p>` : ""}
    ${ls.slice(0, isClosing ? SHOW : undefined).map(card).join("") || `<p class="empty sm">Empty</p>`}
    ${isClosing && ls.length ? `<a class="link sm" href="#/leads?status=closed&stage=${attr(s.id)}">View all ${ls.length} in Leads & CRM</a>` : ""}</section>`;
  el.innerHTML = `<div class="page-head"><h1>Sales pipeline</h1><p class="sub">${open.length} open leads · ${closed.length} closed (won / lost) · move a lead with its stage menu</p>${can("manager") ? `<a class="btn" href="#/settings/pipeline">Edit stages</a>` : ""}</div>
  <div class="kanban">${openStages().map((s) => column(s, open.filter((l) => l.stage_id === s.id), false)).join("")}${closing.map((s) => column(s, closed.filter((l) => l.stage_id === s.id), true)).join("")}</div>`;
  $$("[data-move]", el).forEach((s) => s.onchange = () => act(null, async () => {
    await q(SB.from("ai_leads").update({ stage_id: s.value }).eq("id", s.dataset.move).select("id"), { expectRows: true });
    pipeline(el);
  }, "Moved to " + stageName(s.value)));
}

/* ======================= Appointments ======================= */
export async function appointments(el, params) {
  const view = params.get("view");
  if (view === "calendar") return calendar(el, params);
  if (view === "tasks") return tasks(el, params);
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
  el.innerHTML = `<div class="page-head"><div><h1>Tasks &amp; appointments</h1><p class="sub">Visits, calls and viewings with buyers.</p></div>${scheduleTabs("list")}</div>
  <div class="seg">${seg("upcoming", "Upcoming &amp; pending")}${seg("all", "All")}${seg("archived", "Archived")}</div>
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

export async function thread(box, c, pendingFollowUp, reload, { embedded = false } = {}) {
  if (!c) { box.innerHTML = empty("Conversation not found or closed."); return; }
  const msgs = (await q(SB.from("ai_messages").select("id,direction,sender_type,sender_email,provider,body,media,status,status_reason,template_name,created_at").eq("conversation_id", c.id).order("created_at", { ascending: false }).limit(200))) || [];
  msgs.reverse();
  const adv = can("advisor");
  const aiOn = c.mode === "ai" && !c.lead?.ai_paused;
  const [label, kind] = ownership(c, pendingFollowUp);
  const auto = c.automation || {};
  const open = c.last_inbound_at && Date.now() - new Date(c.last_inbound_at) < WINDOW_MS;
  const tpls = adv && !open ? (await q(SB.from("ai_message_templates").select("id,name,lang,category").eq("wa_status", "approved").eq("active", true).not("wa_template_name", "is", null).order("name"))) || [] : [];
  box.innerHTML = `<div class="ho-h"><div>${embedded ? `<b>WhatsApp</b> <small>+${esc(c.contact?.wa_id || c.contact?.phone_e164 || "")}</small>` : `<a class="link back" href="#/inbox">← All</a> <b>${esc(contactName(c.contact))}</b> <small>+${esc(c.contact?.wa_id || c.contact?.phone_e164 || "")}</small>
      ${c.lead ? `<a href="#/lead/${attr(c.lead.id)}"><small>${esc(c.lead.lead_code)}</small></a>` : ""}`}</div>
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
