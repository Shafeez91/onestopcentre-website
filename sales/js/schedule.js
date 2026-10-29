// AI Sales dashboard — Tasks & appointments: a month calendar (appointments and follow-up tasks, as an agenda on
// phones) and one list of open follow-up tasks across all leads. The appointment list itself stays in crm.js.
import { SB, S, can, $$, esc, attr, fmtDate, q, act, badge, empty, keepPlace, projectName } from "./core.js";
import { contactName, kindLabel, apptBadge } from "./crm.js";
import { icon } from "./icons.js";

const KL = "Asia/Kuala_Lumpur";
const dayKey = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: KL });
const timeOf = (d) => new Date(d).toLocaleTimeString("en-MY", { timeZone: KL, hour: "numeric", minute: "2-digit" });
const monthOf = (s) => (/^\d{4}-\d{2}$/.test(s || "") ? s : dayKey(Date.now()).slice(0, 7));
const shift = (m, n) => { const [y, mo] = m.split("-").map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const APPT_CLASS = { pending_confirmation: "pend", confirmed: "conf", rescheduled: "pend", completed: "done", no_show: "miss", cancelled: "cxl" };

export function scheduleTabs(view) {
  const t = (k, label, i) => `<a class="${view === k ? "on" : ""}" href="#/appointments${k === "list" ? "" : "?view=" + k}">${icon(i, { size: 16 })}${label}</a>`;
  return `<div class="seg sched-tabs">${t("list", "Appointments", "calendar")}${t("calendar", "Calendar", "dashboard")}${t("tasks", "Follow-up tasks", "task")}</div>`;
}

export async function calendar(el, params) {
  const m = monthOf(params.get("m")), withTasks = params.get("tasks") !== "0";
  const [y, mo] = m.split("-").map(Number);
  // the visible grid: from the Monday on or before the 1st to the Sunday on or after the last day
  const first = new Date(Date.UTC(y, mo - 1, 1)), startDow = (first.getUTCDay() + 6) % 7;
  const gridStart = new Date(first.getTime() - startDow * 864e5), days = Math.ceil((startDow + new Date(Date.UTC(y, mo, 0)).getUTCDate()) / 7) * 7;
  const from = new Date(gridStart.getTime() - 8 * 3600e3).toISOString(), to = new Date(gridStart.getTime() + days * 864e5).toISOString();
  const [appts, tasks, pending] = await Promise.all([
    q(SB.from("ai_appointments").select("id,kind,status,start_at,lead_id,project_id,advisor_email,lead:ai_leads(id,lead_code,contact:ai_contacts(full_name,phone_e164))").is("archived_at", null).gte("start_at", from).lt("start_at", to).order("start_at").limit(1000)),
    withTasks ? q(SB.from("ai_tasks").select("id,title,due_at,lead_id,assignee_email,lead:ai_leads(id,lead_code,contact:ai_contacts(full_name,phone_e164))").eq("status", "open").gte("due_at", from).lt("due_at", to).order("due_at").limit(1000)) : [],
    q(SB.from("ai_appointments").select("id,kind,preferred_text,lead_id,lead:ai_leads(id,lead_code,contact:ai_contacts(full_name,phone_e164))").is("archived_at", null).is("start_at", null).in("status", ["pending_confirmation", "rescheduled"]).limit(50)),
  ]);
  const byDay = {};
  for (const a of appts || []) (byDay[dayKey(a.start_at)] ||= []).push({ at: a.start_at, html: `<a class="ev ${APPT_CLASS[a.status] || ""}" href="#/lead/${attr(a.lead_id)}?tab=sales" title="${attr(kindLabel(a.kind) + " · " + (a.status || "").replace(/_/g, " "))}"><time>${esc(timeOf(a.start_at))}</time> ${esc(contactName(a.lead?.contact))}<small>${esc(kindLabel(a.kind))}${a.project_id ? " · " + esc(projectName(a.project_id)) : ""}</small></a>` });
  for (const t of tasks || []) (byDay[dayKey(t.due_at)] ||= []).push({ at: t.due_at, html: `<a class="ev task${new Date(t.due_at) < Date.now() ? " late" : ""}" href="#/lead/${attr(t.lead_id)}?tab=sales" title="Follow-up task"><time>${esc(timeOf(t.due_at))}</time> ${esc(t.title)}<small>${esc(contactName(t.lead?.contact))}</small></a>` });
  const today = dayKey(Date.now());
  const cells = Array.from({ length: days }, (_, i) => { const d = new Date(gridStart.getTime() + i * 864e5), k = d.toISOString().slice(0, 10), items = (byDay[k] || []).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return `<div class="cal-day${k.slice(0, 7) !== m ? " out" : ""}${k === today ? " today" : ""}${items.length ? "" : " none"}"><div class="cal-d"><b>${d.getUTCDate()}</b><span>${esc(d.toLocaleDateString("en-MY", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }))}</span></div>${items.map((x) => x.html).join("")}</div>`; }).join("");
  const label = new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-MY", { month: "long", year: "numeric", timeZone: "UTC" });
  const nav = (n, txt, aria) => `<a class="btn sm" href="#/appointments?view=calendar&m=${shift(m, n)}${withTasks ? "" : "&tasks=0"}" aria-label="${aria}">${txt}</a>`;
  el.innerHTML = `<div class="page-head"><div><h1>Tasks &amp; appointments</h1><p class="sub">Calendar of visits, calls and follow-up tasks, in Malaysia time.</p></div>${scheduleTabs("calendar")}</div>
  <section class="card cal"><div class="cal-bar"><div class="row-actions">${nav(-1, "‹", "Previous month")}<a class="btn sm" href="#/appointments?view=calendar${withTasks ? "" : "&tasks=0"}">Today</a>${nav(1, "›", "Next month")}</div><h2>${esc(label)}</h2>
      <div class="cal-legend"><span class="ev conf">Confirmed</span><span class="ev pend">To confirm</span><span class="ev done">Done</span><span class="ev cxl">Cancelled / no-show</span>
        <a class="ev task" href="#/appointments?view=calendar&m=${m}${withTasks ? "&tasks=0" : ""}">${withTasks ? "Hide" : "Show"} tasks</a></div></div>
    <div class="cal-grid"><div class="cal-h">Mon</div><div class="cal-h">Tue</div><div class="cal-h">Wed</div><div class="cal-h">Thu</div><div class="cal-h">Fri</div><div class="cal-h">Sat</div><div class="cal-h">Sun</div>${cells}</div>
    ${Object.keys(byDay).length ? "" : `<p class="note cal-none">Nothing scheduled in ${esc(label)}.</p>`}</section>
  ${(pending || []).length ? `<section class="card"><h2>Waiting for a time</h2><p class="note">Requests without a confirmed time are not on the calendar until confirmed under Appointments.</p>
    <ul class="list">${pending.map((a) => `<li><a href="#/lead/${attr(a.lead_id)}?tab=sales">${esc(contactName(a.lead?.contact))}</a> ${badge(kindLabel(a.kind))}<small>Preferred: ${esc(a.preferred_text || "—")}</small></li>`).join("")}</ul>
    <p><a class="btn sm" href="#/appointments">Confirm in Appointments</a></p></section>` : ""}`;
}

export async function tasks(el, params) {
  const who = params.get("who") === "all" || !can("advisor") ? "all" : params.get("who") === "mine" ? "mine" : can("manager") ? "all" : "mine";
  let query = SB.from("ai_tasks").select("id,title,details,due_at,status,assignee_email,source_key,lead_id,lead:ai_leads(id,lead_code,stage_id,contact:ai_contacts(full_name,phone_e164))").eq("status", "open").order("due_at", { nullsFirst: false }).limit(1000);
  if (who === "mine") query = query.eq("assignee_email", S.email);
  const rows = (await q(query)) || [];
  const now = Date.now(), today = dayKey(now), weekEnd = Date.now() + 7 * 864e5;
  const groups = [
    ["Overdue", rows.filter((t) => t.due_at && new Date(t.due_at) < now), "late"],
    ["Today", rows.filter((t) => t.due_at && new Date(t.due_at) >= now && dayKey(t.due_at) === today), ""],
    ["Next 7 days", rows.filter((t) => t.due_at && dayKey(t.due_at) > today && new Date(t.due_at) <= weekEnd), ""],
    ["Later", rows.filter((t) => t.due_at && new Date(t.due_at) > weekEnd), ""],
    ["No due date", rows.filter((t) => !t.due_at), ""],
  ];
  const adv = can("advisor");
  el.innerHTML = `<div class="page-head"><div><h1>Tasks &amp; appointments</h1><p class="sub">${rows.length} open follow-up task${rows.length === 1 ? "" : "s"}. Tasks the system opens (a buyer needs a person, a message could not be sent) are marked “automatic”; they close when someone replies to the buyer.</p></div>${scheduleTabs("tasks")}</div>
  ${adv ? `<div class="seg"><a class="${who === "mine" ? "on" : ""}" href="#/appointments?view=tasks&who=mine">Mine</a><a class="${who === "all" ? "on" : ""}" href="#/appointments?view=tasks&who=all">Everyone</a></div>` : ""}
  ${rows.length ? groups.filter(([, list]) => list.length).map(([title, list, cls]) => `<section class="card"><h2>${esc(title)} <span class="cnt${cls ? "" : " soft"}">${list.length}</span></h2><ul class="list tasks-l">${list.map((t) => `<li>
      ${adv ? `<button class="link" data-done="${attr(t.id)}" aria-label="Mark done">☐</button>` : ""}<div><b>${esc(t.title)}</b>${t.source_key ? " " + badge("automatic") : ""}
      <small><a href="#/lead/${attr(t.lead_id)}">${esc(contactName(t.lead?.contact))} · ${esc(t.lead?.lead_code || "")}</a>${t.due_at ? ` · <span class="${cls}">${esc(fmtDate(t.due_at))}</span>` : ""}${t.assignee_email ? " · " + esc(t.assignee_email) : ""}</small>
      ${t.details ? `<small class="task-det">${esc(String(t.details).slice(0, 240))}</small>` : ""}</div></li>`).join("")}</ul></section>`).join("")
    : empty(who === "mine" ? "No open tasks assigned to you." : "No open follow-up tasks.")}`;
  $$("[data-done]", el).forEach((b) => b.onclick = () => act(b, async () => { await q(SB.from("ai_tasks").update({ status: "done" }).eq("id", b.dataset.done).select("id"), { expectRows: true }); keepPlace(el, () => tasks(el, params)); }, "Task done"));
}
