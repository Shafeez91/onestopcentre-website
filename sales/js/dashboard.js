// AI Sales dashboard — command centre: what needs a person today, live WhatsApp, pipeline, follow-up workflows and AI
// activity. Every number is counted from CRM records at load time and links to the list it was counted from.
import { SB, S, can, $, esc, attr, fmtDate, ago, q, act, toast, badge, empty, projectName } from "./core.js";
import { kindLabel, apptBadge } from "./crm.js";
import { icon } from "./icons.js";
import { WF_STATUS } from "../shared/workflow.mjs";

const KL = "Asia/Kuala_Lumpur";
const dayKey = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: KL });
const greeting = () => { const h = Number(new Date().toLocaleString("en-GB", { timeZone: KL, hour: "2-digit", hour12: false })); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
const firstName = () => { const m = S.team.find((t) => t.email === S.email); return (m?.display_name || "").split(" ")[0] || ""; };
const who = (c) => c?.full_name || (c?.phone_e164 ? "+" + c.phone_e164 : "(no name)");
const head = (t) => SB.from(t).select("id", { count: "exact", head: true });
const safe = (p, d) => q(p).catch(() => d);

export async function dashboard(el) {
  const now = new Date(), in7 = new Date(Date.now() + 7 * 864e5).toISOString(), since14 = new Date(Date.now() - 13 * 864e5);
  since14.setHours(0, 0, 0, 0);
  const todayStart = new Date(dayKey(now) + "T00:00:00+08:00").toISOString();   // Malaysia has no daylight saving
  const [open, newLeads, handovers, tasks, appts, convs, wfs, wfStages, wfLeads, aiToday, hoToday, usage] = await Promise.all([
    safe(SB.from("ai_leads").select("id,temperature,stage_id").is("closed_at", null).limit(5000), []),
    safe(SB.from("ai_leads").select("created_at").gte("created_at", since14.toISOString()).limit(5000), []),
    safe(SB.from("ai_handover_events").select("id,reason,created_at,lead_id,lead:ai_leads(id,lead_code,contact:ai_contacts(full_name,phone_e164))").eq("status", "open").order("created_at").limit(20), []),
    safe(SB.from("ai_tasks").select("id,title,due_at,lead_id,assignee_email,source_key").eq("status", "open").lte("due_at", in7).order("due_at").limit(40), []),
    safe(SB.from("ai_appointments").select("id,kind,status,start_at,preferred_text,lead_id,lead:ai_leads(id,lead_code,contact:ai_contacts(full_name,phone_e164))").is("archived_at", null).in("status", ["pending_confirmation", "confirmed", "rescheduled"]).or(`start_at.is.null,start_at.lte.${in7}`).order("start_at", { nullsFirst: true }).limit(12), []),
    safe(SB.from("ai_conversations").select("id,mode,status,unread_count,last_inbound_at,last_outbound_at,contact:ai_contacts(full_name,phone_e164),lead:ai_leads(id,lead_code)").eq("channel", "whatsapp").eq("status", "open").order("last_inbound_at", { ascending: false, nullsFirst: false }).limit(6), []),
    safe(SB.from("ai_workflows").select("id,key,name,sending_enabled,project_id").eq("status", "active").order("name"), []),
    safe(SB.from("ai_workflow_stages").select("workflow_id,key,name,position,is_final,active,archived_at").is("archived_at", null).order("position"), []),
    safe(SB.from("ai_workflow_leads").select("workflow_id,stage,status").limit(10000), []),
    safe(head("ai_messages").eq("sender_type", "ai").eq("direction", "outbound").gte("created_at", todayStart), 0),
    safe(head("ai_handover_events").gte("created_at", todayStart), 0),
    safe(SB.from("ai_usage_daily").select("ai_messages,capped").eq("day", dayKey(now)).limit(1), []),
  ]);
  const unread = (await safe(head("ai_conversations").eq("channel", "whatsapp").eq("status", "open").gt("unread_count", 0), 0)) || 0;

  const t = { hot: 0, warm: 0, nurture: 0, unqualified: 0 };
  open.forEach((l) => { t[l.temperature] = (t[l.temperature] || 0) + 1; });
  const new7 = newLeads.filter((l) => new Date(l.created_at) >= new Date(Date.now() - 7 * 864e5)).length;
  const days = {}; for (let i = 13; i >= 0; i--) days[dayKey(Date.now() - i * 864e5)] = 0;
  newLeads.forEach((l) => { const k = dayKey(l.created_at); if (k in days) days[k]++; });
  const maxDay = Math.max(1, ...Object.values(days));
  const mineOrTeam = tasks.filter((x) => !x.assignee_email || x.assignee_email === S.email || can("manager"));
  const overdue = mineOrTeam.filter((x) => new Date(x.due_at) < now);
  const toConfirm = appts.filter((a) => a.status === "pending_confirmation");
  const wfHuman = wfLeads.filter((l) => l.status === "human").length;
  const cap = Number(S.settings?.ai?.daily_message_cap) || 200, used = usage?.[0]?.ai_messages || 0;

  // today's priorities: people waiting first, then overdue tasks, visits to confirm, workflow leads needing a person
  const prio = [
    ...handovers.map((h) => ({ at: h.created_at, i: "flag", kind: "alert", tag: "Waiting for a person", title: `${who(h.lead?.contact)} · ${String(h.reason || "").replace(/_/g, " ")}`, sub: `waiting ${ago(h.created_at).replace(" ago", "")}`, href: `#/lead/${h.lead_id}` })),
    ...overdue.map((x) => ({ at: x.due_at, i: "task", kind: "warn", tag: "Overdue task", title: x.title, sub: `due ${fmtDate(x.due_at)}${x.assignee_email && x.assignee_email !== S.email ? " · " + x.assignee_email : ""}`, href: `#/lead/${x.lead_id}` })),
    ...toConfirm.map((a) => ({ at: a.start_at || "", i: "calendar", kind: "warn", tag: "Confirm visit", title: `${who(a.lead?.contact)} · ${kindLabel(a.kind)}`, sub: a.start_at ? fmtDate(a.start_at) : "Preferred: " + (a.preferred_text || "—"), href: `#/lead/${a.lead_id}` })),
  ];
  const prioHtml = prio.length || wfHuman ? `<ul class="prio">${prio.slice(0, 8).map((p) => `<li><a href="${attr(p.href)}"><span class="pi ${p.kind}">${icon(p.i, { size: 18 })}</span>
      <span class="pt"><b>${esc(p.title)}</b><small>${esc(p.tag)} · ${esc(p.sub)}</small></span><span class="go" aria-hidden="true">›</span></a></li>`).join("")}
      ${wfHuman ? `<li><a href="#/workflows"><span class="pi alert">${icon("workflow", { size: 18 })}</span><span class="pt"><b>${wfHuman} workflow lead${wfHuman === 1 ? "" : "s"} need${wfHuman === 1 ? "s" : ""} a person</b><small>Follow-up workflows · no progress after the last reminder, or no WhatsApp chat</small></span><span class="go" aria-hidden="true">›</span></a></li>` : ""}
      ${prio.length > 8 ? `<li class="more"><a href="#/handover">${prio.length - 8} more…</a></li>` : ""}</ul>`
    : `<div class="allclear">${icon("shield", { size: 28 })}<b>All clear</b><span>No buyer is waiting, no task is overdue and every visit is confirmed.</span></div>`;

  const stageCounts = S.stages.filter((s) => s.active && !s.is_won && !s.is_lost).map((s) => [s, open.filter((l) => l.stage_id === s.id).length]);
  const maxStage = Math.max(1, ...stageCounts.map(([, n]) => n));
  const flags = S.settings.flags || {};

  let pendingWeb = null;
  if (can("advisor")) {
    try {
      const [{ count: web }, { count: done }] = await Promise.all([SB.from("leads").select("id", { count: "exact", head: true }), head("ai_activities").eq("kind", "website_enquiry")]);
      if (web !== null && done !== null) pendingWeb = Math.max(0, web - done);
    } catch { /* staff who are not website admins cannot count website enquiries */ }
  }

  const name = firstName();
  el.innerHTML = `
  <div class="page-head dash-head"><div><p class="eyebrow">${esc(new Date().toLocaleDateString("en-MY", { timeZone: KL, weekday: "long", day: "numeric", month: "long", year: "numeric" }))}</p>
      <h1>Dashboard</h1><p class="sub">${esc(greeting())}${name ? ", " + esc(name) : ""}. Every figure below is counted from your CRM records just now.</p></div>
    <div class="head-actions">${can("advisor") ? `<a class="btn" href="#/leads?new=1">${icon("plus", { size: 18 })}New lead</a>` : ""}<a class="btn pri" href="#/inbox">${icon("inbox", { size: 18 })}Open inbox${unread ? ` <span class="cnt">${unread}</span>` : ""}</a></div></div>
  ${pendingWeb ? `<div class="card notice"><div><b>${pendingWeb} website enquir${pendingWeb === 1 ? "y" : "ies"}</b> not yet in the CRM.</div>
     <button class="btn pri" id="imp"${flags.website_lead_import ? "" : " disabled title='Switched off in Settings'"}>Import into CRM</button></div>` : ""}
  <div class="kpis dash-kpis">
    <a class="kpi" href="#/leads?status=open"><span class="ki">${icon("users", { size: 18 })}</span><b>${open.length}</b><span>Open leads</span></a>
    <a class="kpi hot" href="#/leads?temp=hot"><span class="ki">${icon("sparkle", { size: 18 })}</span><b>${t.hot}</b><span>Hot · ${t.warm} warm</span></a>
    <a class="kpi" href="#/leads?since=7"><span class="ki">${icon("chart", { size: 18 })}</span><b>${new7}</b><span>New in 7 days</span></a>
    <a class="kpi${handovers.length ? " alert" : ""}" href="#/handover"><span class="ki">${icon("flag", { size: 18 })}</span><b>${handovers.length}</b><span>Waiting for a person</span></a>
    <a class="kpi" href="#/inbox"><span class="ki">${icon("inbox", { size: 18 })}</span><b>${unread}</b><span>Unread WhatsApp chats</span></a>
    <a class="kpi" href="#/appointments"><span class="ki">${icon("calendar", { size: 18 })}</span><b>${appts.filter((a) => a.start_at).length}</b><span>Visits in 7 days${toConfirm.length ? ` · ${toConfirm.length} to confirm` : ""}</span></a>
  </div>
  <div class="dash-grid">
    <section class="card span2"><div class="card-h"><h2>Today's priorities</h2><a class="link" href="#/handover">Handover queue</a></div>${prioHtml}</section>
    <section class="card"><div class="card-h"><h2>Live WhatsApp</h2><a class="link" href="#/inbox">Inbox</a></div>
      ${convs.length ? `<ul class="convs">${convs.map((c) => `<li><a href="#/inbox?c=${attr(c.id)}"><span class="av">${esc(who(c.contact)[0] || "?")}</span><span class="pt"><b>${esc(who(c.contact))}</b><small>${c.mode === "ai" ? "AI handling" : "A person handling"}${c.last_inbound_at ? " · " + esc(ago(c.last_inbound_at)) : ""}</small></span>${c.unread_count ? `<span class="cnt">${esc(c.unread_count)}</span>` : ""}</a></li>`).join("")}</ul>` : empty("No open WhatsApp chats.")}</section>
    <section class="card"><div class="card-h"><h2>Upcoming visits</h2><a class="link" href="#/appointments">All</a></div>
      ${appts.length ? `<ul class="list">${appts.slice(0, 6).map((a) => `<li><a href="#/lead/${attr(a.lead_id)}">${esc(who(a.lead?.contact))}</a> ${apptBadge(a.status)}<small>${esc(kindLabel(a.kind))} · ${a.start_at ? esc(fmtDate(a.start_at)) : "Preferred: " + esc(a.preferred_text || "—")}</small></li>`).join("")}</ul>` : empty("No visits in the next 7 days.")}</section>
    <section class="card"><div class="card-h"><h2>Pipeline</h2><a class="link" href="#/pipeline">Board</a></div>
      ${stageCounts.length ? `<ul class="bars">${stageCounts.map(([s, n]) => `<li><a href="#/leads?stage=${attr(s.id)}">${esc(s.name)}</a><i style="--w:${(n / maxStage) * 100}%"></i><b>${n}</b></li>`).join("")}</ul>` : empty("No pipeline stages.")}</section>
    <section class="card"><div class="card-h"><h2>New leads · 14 days</h2><a class="link" href="#/reports?days=30">Reports</a></div>
      <div class="spark" role="img" aria-label="New leads per day for 14 days">${Object.entries(days).map(([d, v]) => `<i title="${attr(d)}: ${v}" style="--h:${(v / maxDay) * 100}%"></i>`).join("")}</div>
      <p class="note">${newLeads.length} in 14 days · ${new7} in the last 7</p></section>
    <section class="card"><div class="card-h"><h2>Follow-up workflows</h2><a class="link" href="#/workflows">All</a></div>
      ${wfs.length ? wfs.map((w) => { const ls = wfLeads.filter((l) => l.workflow_id === w.id), st = wfStages.filter((s) => s.workflow_id === w.id && s.active !== false);
        return `<div class="wf-mini"><a href="#/workflow/${attr(w.key)}"><b>${esc(w.name)}</b></a> ${w.sending_enabled ? badge("Sending on", "ok") : badge("Sending off", "warn")}
          <small>${ls.length} lead${ls.length === 1 ? "" : "s"}${ls.some((l) => l.status === "human") ? ` · ${ls.filter((l) => l.status === "human").length} ${WF_STATUS.human.toLowerCase()}` : ""}${w.project_id ? " · " + esc(projectName(w.project_id)) : ""}</small>
          <div class="wf-steps">${st.map((s) => { const n = ls.filter((l) => l.stage === s.key).length; return `<span title="${attr(s.name)}: ${n}" class="${n ? "has" : ""}"><b>${n}</b>${esc(s.name)}</span>`; }).join("")}</div></div>`; }).join("")
        : empty("No follow-up workflows yet.")}</section>
    <section class="card"><div class="card-h"><h2>AI today</h2><a class="link" href="#/settings">Settings</a></div>
      <div class="mini-kpis"><div><b>${aiToday || 0}</b><span>AI replies sent</span></div><div><b>${hoToday || 0}</b><span>Handed to a person</span></div><div><b>${used}/${cap}</b><span>Daily AI limit${usage?.[0]?.capped ? ` · ${usage[0].capped} over` : ""}</span></div></div>
      <div class="meter" role="img" aria-label="${used} of ${cap} AI replies used today"><i style="--w:${Math.min(100, (used / Math.max(1, cap)) * 100)}%"></i></div>
      <div class="flags">${[["ai_auto_reply", "AI auto-reply"], ["whatsapp_outbound", "WhatsApp sending"], ["follow_ups", "Follow-ups"], ["calendar_booking", "Calendar booking"]]
        .map(([k, l]) => `<span class="flag ${flags[k] ? "on" : ""}">${flags[k] ? "●" : "○"} ${esc(l)}</span>`).join("")}</div></section>
  </div>`;
  const b = $("#imp", el);
  if (b) b.onclick = () => act(b, async () => {
    const r = await q(SB.rpc("ai_import_website_leads", { max_rows: 500 }));
    toast(`Imported ${r.imported} enquir${r.imported === 1 ? "y" : "ies"}${r.skipped_no_contact ? ` · ${r.skipped_no_contact} skipped (no phone or email)` : ""}`);
    dashboard(el);
  });
}
