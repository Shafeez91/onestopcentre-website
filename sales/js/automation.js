// AI Sales dashboard — messaging automation on the Follow-up automation page: who answers buyers, the 12-hour
// follow-up, appointment confirmations/reminders, staff Telegram reminders, and the list of every automation job
// with why it was sent, skipped or cancelled. Jobs are created by the database and run by the server worker.
import { SB, S, can, $, $$, esc, attr, fmtDate, q, act, toast, guardForm, clearDraft, formData, badge, opt, empty, loadLookups } from "./core.js";

export const AUTOMATION_DEFAULTS = { smart_follow_up: true, follow_up_delay_hours: 12, follow_up_template: "follow_up", appointment_confirmations: true,
  appointment_reminders: true, appointment_reminder_minutes: [1440, 120], human_reminders: true, human_reminder_minutes: 60 };
const KIND = { smart_follow_up: "12-hour follow-up", human_reminder: "Reply reminder (retired)", appt_confirmation: "Appointment confirmation", appt_reminder: "Appointment reminder", rmk_follow_up: "RMK stage reminder" };
const STATUS = { scheduled: ["Pending", ""], processing: ["Sending", ""], sent: ["Sent", "ok"], skipped: ["Skipped", "warn"], cancelled: ["Cancelled", ""], failed: ["Failed", "alert"] };
const minutesText = (m) => (m % 1440 === 0 ? m / 1440 + " day" + (m === 1440 ? "" : "s") : m % 60 === 0 ? m / 60 + " h" : m + " min");
const list = (v) => String(v || "").split(",").map((x) => x.trim()).filter(Boolean).map(Number);

export async function loadAutomation() {
  try {
    const jobs = (await q(SB.from("ai_automation_jobs").select("id,kind,status,run_at,sent_at,reason,checks,offset_minutes,conversation_id,lead:ai_leads(id,lead_code,contact:ai_contacts(full_name))").order("run_at", { ascending: false }).limit(200))) || [];
    return { jobs };
  } catch (e) { console.warn("automation jobs unavailable:", e?.message || e); return { jobs: null }; }
}

export function automationHtml(data) {
  const A = { ...AUTOMATION_DEFAULTS, ...(S.settings?.automation || {}) }, F = S.settings?.flags || {}, N = S.settings?.notifications || {};
  const own = can("owner"), dis = own ? "" : " disabled";
  const chk = (name, on, label, help) => `<label class="switch full"><input type="checkbox" name="${name}"${on ? " checked" : ""}${dis}><span><b>${label}</b>${help ? `<small>${help}</small>` : ""}</span></label>`;
  const jobs = data?.jobs;
  return `<section class="card" id="automation"><h2>Who answers buyers, follow-ups &amp; reminders</h2>
    <ul class="checks"><li><b>The AI answers</b> every buyer message until a person replies — then that chat is the person's until someone presses <b>Resume AI</b> in the inbox.</li>
      <li><b>12-hour follow-up:</b> if the buyer goes quiet and nobody has followed up, the AI sends one short check-in about what they asked — only if the chat is still the AI's, the buyer has not opted out, in business hours, and within WhatsApp's 24-hour window (after that only an approved template).</li>
      <li><b>Telegram</b> only for buyers waiting for a person, follow-ups that could not be sent automatically, and appointments — not for every WhatsApp message.</li></ul>
    <form id="fauto" class="form two">
      ${chk("ai_auto_reply", F.ai_auto_reply, "AI auto-replies", "The AI answers buyers on WhatsApp (until a person takes over).")}
      ${chk("follow_ups", F.follow_ups, "Automatic follow-ups (master switch)", "Off: nothing is followed up automatically; staff are reminded on Telegram instead.")}
      ${chk("smart_follow_up", A.smart_follow_up, "12-hour follow-up", "One check-in when the buyer has not replied and nobody followed up.")}
      <label>Follow up after (hours)<input name="follow_up_delay_hours" type="number" min="1" max="72" step="1" value="${attr(A.follow_up_delay_hours)}"${dis}></label>
      <label>Template after 24 hours (approved name)<input name="follow_up_template" value="${attr(A.follow_up_template)}" placeholder="follow_up"${dis}></label>
      ${chk("appointment_confirmations", A.appointment_confirmations, "WhatsApp appointment confirmations", "Sent once an appointment is confirmed (calendar, advisor or lead page).")}
      ${chk("appointment_reminders", A.appointment_reminders, "WhatsApp appointment reminders", "Sent to the buyer before a confirmed appointment, even while a person handles the chat.")}
      <label class="full">Reminder times before the appointment (minutes, comma-separated)<input name="appointment_reminder_minutes" value="${attr((A.appointment_reminder_minutes || []).join(", "))}" placeholder="1440, 120 = 24 h and 2 h"${dis}></label>
      ${chk("human_reminders", A.human_reminders, "Follow-up task when an automatic message cannot be sent", "If the 12-hour follow-up, an appointment confirmation or a reminder cannot go out, a follow-up task is opened on the lead and sent to Telegram once.")}
      ${chk("handover_alerts", N.handover_alerts !== false, "Follow-up task when a buyer needs a person", "When the buyer asks for a person, is ready to buy, negotiates, complains, or needs a legal or financing answer. Other hand-overs wait in the hand-over queue without a Telegram message.")}
      <p class="note full">A buyer simply waiting for a reply is not sent to Telegram: see the inbox. Replying to the buyer completes their open automatic tasks.</p>
      ${chk("appointment_changes", N.appointment_changes, "Telegram: appointment booked, confirmed, rescheduled or cancelled", "")}
      <label class="full">Telegram appointment reminders (minutes before, comma-separated)<input name="tg_appointment_reminder_minutes" value="${attr((N.appointment_reminder_minutes || []).join(", "))}" placeholder="1440, 120"${dis}></label>
      ${own ? `<div class="actions full"><button class="btn pri">Save automation settings</button></div>` : `<p class="note full">Only owners can change these settings.</p>`}
    </form>
    <h3>Automation jobs</h3>
    ${jobs === null ? `<p class="note">Not available yet — the database update for automation has not been applied.</p>` : `
    <div class="filters" id="jf"><label class="sr" for="jstat">Status</label><select id="jstat">${opt("", "All statuses")}${Object.entries(STATUS).map(([k, v]) => opt(k, v[0])).join("")}</select>
      <label class="sr" for="jkind">Type</label><select id="jkind">${opt("", "All types")}${Object.entries(KIND).map(([k, v]) => opt(k, v)).join("")}</select></div>
    <div id="jlist">${jobList(jobs)}</div>`}
  </section>`;
}

function jobList(jobs) {
  if (!jobs.length) return empty("No automation jobs.");
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Type</th><th>Buyer</th><th>Status</th><th>Why</th></tr></thead><tbody>${jobs.map((j) => {
    const [label, kind] = STATUS[j.status] || [j.status, ""];
    return `<tr><td data-label="When">${esc(fmtDate(j.sent_at || j.run_at))}</td>
      <td data-label="Type">${esc(KIND[j.kind] || j.kind)}${j.offset_minutes ? `<small>${esc(minutesText(j.offset_minutes))} before</small>` : ""}</td>
      <td data-label="Buyer">${j.lead ? `<a href="#/lead/${attr(j.lead.id)}">${esc(j.lead.contact?.full_name || j.lead.lead_code)}</a>` : "—"}${j.conversation_id ? ` <a class="link" href="#/inbox?c=${attr(j.conversation_id)}">chat</a>` : ""}</td>
      <td data-label="Status">${badge(label, kind)}${j.status === "scheduled" && can("advisor") ? ` <button class="link" data-cancel-job="${attr(j.id)}">Cancel</button>` : ""}</td>
      <td data-label="Why">${esc(j.reason || (j.status === "sent" ? "all checks passed" : ""))}${(j.checks || []).length ? `<details><summary>Checks (${j.checks.length})</summary><ul class="checks">${j.checks.map((c) => `<li>${c.ok ? "✅" : "❌"} ${esc(c.check)}</li>`).join("")}</ul></details>` : ""}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

export function bindAutomation(el, data, reload) {
  const f = $("#fauto", el);
  if (f && can("owner")) {
    guardForm(f, "settings:automation");
    f.onsubmit = (e) => {
      e.preventDefault();
      const v = formData(f);
      const rem = list(v.appointment_reminder_minutes), tg = list(v.tg_appointment_reminder_minutes);
      if (![...rem, ...tg].every((m) => Number.isInteger(m) && m >= 10 && m <= 10080)) return toast("Reminder times: whole minutes from 10 to 10080, e.g. 1440, 120.", "err");
      if (!(v.follow_up_delay_hours >= 1 && v.follow_up_delay_hours <= 72)) return toast("Follow up after 1 to 72 hours.", "err");
      const st = S.settings;
      act(f.querySelector("button"), async () => {
        await q(SB.from("ai_settings").update({
          flags: { ...st.flags, ai_auto_reply: v.ai_auto_reply, follow_ups: v.follow_ups },
          automation: { ...(st.automation || {}), smart_follow_up: v.smart_follow_up, follow_up_delay_hours: v.follow_up_delay_hours, follow_up_template: v.follow_up_template || "follow_up",
            appointment_confirmations: v.appointment_confirmations, appointment_reminders: v.appointment_reminders, appointment_reminder_minutes: [...new Set(rem)].sort((a, b) => b - a),
            human_reminders: v.human_reminders },
          notifications: { ...(st.notifications || {}), handover_alerts: v.handover_alerts, appointment_changes: v.appointment_changes, appointment_reminder_minutes: [...new Set(tg)].sort((a, b) => b - a) },
        }).eq("id", 1).select("id"), { expectRows: true });
        clearDraft(f); await loadLookups(); reload();
      }, "Automation settings saved");
    };
  }
  const jl = $("#jlist", el);
  if (!jl || !data?.jobs) return;
  const filter = () => { const s = $("#jstat", el).value, k = $("#jkind", el).value; jl.innerHTML = jobList(data.jobs.filter((j) => (!s || j.status === s) && (!k || j.kind === k))); wire(); };
  const wire = () => $$("[data-cancel-job]", jl).forEach((b) => b.onclick = () => confirm("Cancel this automatic message?") && act(b, async () => {
    const ok = await q(SB.rpc("ai_cancel_automation_job", { p_id: b.dataset.cancelJob }));
    if (!ok) throw new Error("It has already run or been cancelled.");
    reload();
  }, "Cancelled"));
  $("#jstat", el).onchange = filter; $("#jkind", el).onchange = filter;
  wire();
}
