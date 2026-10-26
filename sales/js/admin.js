// AI Sales dashboard — settings & flags, pipeline stages, team, integrations, templates & objections,
// follow-up sequences, campaigns, reports, and consent/security/audit.
import { SB, S, can, $, $$, esc, attr, fmtDate, q, act, toast, guardForm, clearDraft, formData, modal, badge, opt, empty, ro, money, api, loadLookups, projectName, sourceName } from "./core.js";
import { DEFAULT_SCORING } from "../shared/scoring.mjs";

const hasDraftChanges = (f) => f.classList.contains("has-draft");

const FLAGS = [
  ["module_enabled", "AI Sales module", "Turns the whole /sales/ workspace on or off for non-owners. The public website is never affected."],
  ["website_lead_import", "Import website enquiries", "Copies enquiries from the website form into the CRM (read-only on the website's own data)."],
  ["ai_auto_reply", "AI auto-reply", "Lets the AI answer customers on WhatsApp. Requires Phase 3–4 and the server switch AI_SALES_ENABLED."],
  ["whatsapp_outbound", "WhatsApp sending", "Allows any outbound WhatsApp message, including human replies from the inbox."],
  ["follow_ups", "Automated follow-ups", "Lets the follow-up engine send scheduled messages (always subject to consent and opt-outs)."],
  ["calendar_booking", "Calendar booking", "Lets the AI offer real calendar slots and create bookings."],
];
const SAFEGUARDS = [
  "The AI always identifies itself as an AI assistant when asked and never claims to be human or to have visited a property.",
  "No invented prices, availability, rebates, rental yields, completion dates or developer promises — verified data only.",
  "No guarantees of loan approval, capital appreciation or rental income; estimates are labelled with their assumptions.",
  "Marketing messages require recorded consent; STOP / opt-out is honoured immediately and cannot be overridden.",
  "Appointments are confirmed only after the calendar confirms them.",
  "Negotiation, special pricing, legal/contract questions and complaints are handed to a human.",
  "Only official WhatsApp Business Platform APIs; WhatsApp template and 24-hour window rules are always applied.",
];

/* ======================= Settings ======================= */
export async function settings(el, params) {
  const sub = params.get("tab") || "flags";
  const st = S.settings;
  const tabs = [["flags", "Feature switches"], ["persona", "AI persona"], ["ai", "AI model & limits"], ["scoring", "Lead scoring"], ["business", "Business hours & rules"], ["notifications", "Telegram notifications"], ["compliance", "Compliance"]];
  const own = can("owner");
  el.innerHTML = `<div class="page-head"><h1>AI agent settings</h1>${own ? "" : `<p class="sub">Read-only — only owners can change settings.</p>`}</div>
  <div class="seg">${tabs.map(([k, l]) => `<a class="${sub === k ? "on" : ""}" href="#/settings?tab=${k}">${l}</a>`).join("")}<a href="#/settings/pipeline">Pipeline stages</a></div><div id="sbody" class="card"></div>`;
  const body = $("#sbody", el);
  const dis = own ? "" : " disabled";
  const save = async (col, value, form) => {
    await q(SB.from("ai_settings").update({ [col]: value }).eq("id", 1).select("id"), { expectRows: true });
    if (form) clearDraft(form);
    await loadLookups();
  };
  if (sub === "flags") {
    let health = null;
    if (can("manager")) { try { health = await api("/api/sales/health"); } catch { health = null; } }
    body.innerHTML = `<h2>Feature switches</h2>
      <div class="card notice"><div>Server switch <code>AI_SALES_ENABLED</code>: ${health ? (health.server_enabled ? badge("On", "ok") : badge("Off", "warn")) : badge("Unknown (functions not deployed yet)", "warn")} — when off, no AI, WhatsApp or calendar action can run, whatever is set below.</div></div>
      <form id="sf" class="form">${FLAGS.map(([k, l, d]) => `<label class="switch"><input type="checkbox" name="${k}"${st.flags[k] ? " checked" : ""}${dis}><span><b>${esc(l)}</b><small>${esc(d)}</small></span></label>`).join("")}
      ${own ? `<div class="actions"><button class="btn pri">Save switches</button></div>` : ""}</form>`;
    const f = $("#sf", body);
    if (own) f.onsubmit = (e) => { e.preventDefault(); const v = formData(f);
      if (!v.module_enabled && !confirm("Switch the AI Sales workspace off for all non-owners?")) return;
      act(f.querySelector("button"), () => save("flags", { ...st.flags, ...v }, f), "Switches saved"); };
    return;
  }
  if (sub === "persona") {
    const p = st.persona;
    body.innerHTML = `<h2>AI persona</h2><form id="sf" class="form two">
      <label>Assistant name<input name="name" value="${attr(p.name)}"${dis}></label>
      <label class="check"><input type="checkbox" checked disabled> Discloses it is an AI (mandatory)</label>
      <label class="check"><input type="checkbox" name="allow_manglish"${p.allow_manglish ? " checked" : ""}${dis}> Mirror Manglish when the buyer uses it</label>
      <label class="full">Tone guidance<textarea name="tone" rows="2"${dis}>${esc(p.tone)}</textarea></label>
      <label class="full">Greeting (English)<textarea name="greeting_en" rows="2"${dis}>${esc(p.greeting_en)}</textarea></label>
      <label class="full">Greeting (Bahasa Malaysia)<textarea name="greeting_ms" rows="2"${dis}>${esc(p.greeting_ms)}</textarea></label>
      ${own ? `<div class="actions full"><button class="btn pri">Save persona</button></div>` : ""}</form>`;
    const f = $("#sf", body); if (own) { guardForm(f, "settings:persona");
      f.onsubmit = (e) => { e.preventDefault(); const v = formData(f); act(f.querySelector("button"), () => save("persona", { ...p, ...v, discloses_ai: true }, f), "Persona saved"); }; }
    return;
  }
  if (sub === "ai") {
    const a = st.ai;
    body.innerHTML = `<h2>AI model &amp; limits</h2><form id="sf" class="form two">
      <label>Provider<select name="provider"${dis}>${opt("anthropic", "Anthropic Claude", a.provider)}${opt("openai", "OpenAI (adapter planned)", a.provider)}</select></label>
      <label>Model ID<input name="model" value="${attr(a.model)}" placeholder="Blank = recommended default"${dis}></label>
      <label>Confidence threshold for handover (0–1)<input name="confidence_threshold" type="number" min="0" max="1" step="0.05" value="${attr(a.confidence_threshold)}"${dis}></label>
      <label>Max reply length (characters)<input name="max_reply_chars" type="number" min="200" max="2000" step="50" value="${attr(a.max_reply_chars)}"${dis}></label>
      <p class="note full">API keys are never stored here. They live only in Netlify environment variables (see Integrations).</p>
      ${own ? `<div class="actions full"><button class="btn pri">Save</button></div>` : ""}</form>`;
    const f = $("#sf", body); if (own) { guardForm(f, "settings:ai");
      f.onsubmit = (e) => { e.preventDefault(); const v = formData(f); act(f.querySelector("button"), () => save("ai", { ...a, ...v }, f), "Saved"); }; }
    return;
  }
  if (sub === "scoring") {
    const sc = { weights: { ...DEFAULT_SCORING.weights, ...(st.scoring.weights || {}) }, thresholds: { ...DEFAULT_SCORING.thresholds, ...(st.scoring.thresholds || {}) } };
    body.innerHTML = `<h2>Lead scoring</h2><p class="note">Weights are relative; the score is always 0–100. Unknown information scores 0 and is shown as unknown. A score is never a guarantee of purchase or financing approval.</p>
      <form id="sf" class="form two">${Object.entries(sc.weights).map(([k, v]) => `<label>Weight: ${esc(k)}<input name="w_${k}" type="number" min="0" max="100" value="${attr(v)}"${dis}></label>`).join("")}
      ${Object.entries(sc.thresholds).map(([k, v]) => `<label>Threshold: ${esc(k)} ≥<input name="t_${k}" type="number" min="0" max="100" value="${attr(v)}"${dis}></label>`).join("")}
      ${own ? `<div class="actions full"><button class="btn pri">Save scoring</button></div>` : ""}</form>`;
    const f = $("#sf", body); if (own) { guardForm(f, "settings:scoring");
      f.onsubmit = (e) => { e.preventDefault(); const v = formData(f); const w = {}, t = {};
        Object.entries(v).forEach(([k, x]) => { if (k.startsWith("w_")) w[k.slice(2)] = Number(x) || 0; if (k.startsWith("t_")) t[k.slice(2)] = Number(x) || 0; });
        if (!(t.hot > t.warm && t.warm > t.nurture)) return toast("Thresholds must be hot > warm > nurture.", "err");
        if (!Object.values(w).some((x) => x > 0)) return toast("At least one weight must be above 0.", "err");
        act(f.querySelector("button"), () => save("scoring", { weights: w, thresholds: t }, f), "Scoring saved (applies when leads are next rescored)"); }; }
    return;
  }
  if (sub === "business") {
    const b = st.business; const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    body.innerHTML = `<h2>Business hours &amp; rules</h2><form id="sf" class="form two">
      <label>Time zone<input name="timezone" value="${attr(b.timezone)}"${dis}></label><span></span>
      ${days.map((d) => { const h = (b.hours || {})[d]; return `<label>${d.toUpperCase()} open<input name="o_${d}" type="time" value="${attr(h ? h[0] : "")}"${dis}></label><label>${d.toUpperCase()} close<input name="c_${d}" type="time" value="${attr(h ? h[1] : "")}"${dis}></label>`; }).join("")}
      <label>Max marketing messages / week<input name="max_marketing_messages_per_week" type="number" min="0" max="7" value="${attr(b.max_marketing_messages_per_week)}"${dis}></label>
      <label>Inventory freshness (hours)<input name="inventory_max_age_hours" type="number" min="1" max="720" value="${attr(b.inventory_max_age_hours)}"${dis}></label>
      <label>Price freshness (days)<input name="price_max_age_days" type="number" min="1" max="365" value="${attr(b.price_max_age_days)}"${dis}></label>
      <p class="note full">Leave both times empty for a closed day. Automated messages are only sent within business hours.</p>
      ${own ? `<div class="actions full"><button class="btn pri">Save</button></div>` : ""}</form>`;
    const f = $("#sf", body); if (own) { guardForm(f, "settings:business");
      f.onsubmit = (e) => { e.preventDefault(); const v = formData(f); const hours = {};
        for (const d of days) { const o = v["o_" + d], c = v["c_" + d]; if (!!o !== !!c) return toast(`${d.toUpperCase()}: enter both open and close, or neither.`, "err"); if (o && c <= o) return toast(`${d.toUpperCase()}: close must be after open.`, "err"); hours[d] = o ? [o, c] : null; }
        act(f.querySelector("button"), () => save("business", { ...b, timezone: v.timezone || "Asia/Kuala_Lumpur", hours, max_marketing_messages_per_week: v.max_marketing_messages_per_week, inventory_max_age_hours: v.inventory_max_age_hours, price_max_age_days: v.price_max_age_days }, f), "Saved"); }; }
    return;
  }
  if (sub === "notifications") {
    const n = st.notifications || {};
    let log = [];
    if (can("manager")) { try { log = (await q(SB.from("ai_notifications").select("kind,status,error,created_at,message").order("created_at", { ascending: false }).limit(30))) || []; } catch { log = []; } }
    const KIND = { appointment_change: "Appointment alert", appointment_reminder: "Appointment reminder", task_reminder: "Follow-up reminder", follow_up_due: "Follow-up step due", daily_digest: "Daily digest", test: "Test" };
    body.innerHTML = `<h2>Telegram notifications</h2>
      <p class="note">Sent to staff only, through the same Telegram bot that already alerts you about website enquiries. Checked every 5 minutes. Messages include the buyer's name and phone number, so use a private chat or a staff-only group.</p>
      <form id="sf" class="form two">
      <label class="switch full"><input type="checkbox" name="telegram_enabled"${n.telegram_enabled ? " checked" : ""}${dis}><span><b>Send Telegram notifications</b><small>Master switch for everything on this page.</small></span></label>
      <label class="full">Telegram chat ID<input name="telegram_chat_id" value="${attr(n.telegram_chat_id)}" inputmode="numeric" placeholder="e.g. 8821015679, or -100… for a group"${dis}></label>
      <label class="switch full"><input type="checkbox" name="appointment_changes"${n.appointment_changes ? " checked" : ""}${dis}><span><b>Appointment alerts</b><small>Instantly when an appointment is requested, confirmed, rescheduled, cancelled or a buyer doesn't show up.</small></span></label>
      <label class="full">Appointment reminders (minutes before, comma-separated)<input name="appointment_reminder_minutes" value="${attr((n.appointment_reminder_minutes || []).join(", "))}" placeholder="1440, 120 = 24 h and 2 h before"${dis}></label>
      <label class="switch full"><input type="checkbox" name="task_reminders"${n.task_reminders ? " checked" : ""}${dis}><span><b>Follow-up reminders</b><small>For every open follow-up task with a due time (and follow-up sequence steps while automatic sending is off).</small></span></label>
      <label>Remind this many minutes before a follow-up is due<input name="task_lead_minutes" type="number" min="0" max="1440" value="${attr(n.task_lead_minutes ?? 30)}"${dis}></label><span></span>
      <label class="switch"><input type="checkbox" name="daily_digest"${n.daily_digest ? " checked" : ""}${dis}><span><b>Daily digest</b><small>Today's appointments, follow-ups due, overdue, hot leads.</small></span></label>
      <label>Digest time (hour, Malaysia time)<input name="digest_hour" type="number" min="0" max="23" value="${attr(n.digest_hour ?? 8)}"${dis}></label>
      ${own ? `<div class="actions full"><button class="btn pri" type="submit">Save</button><button class="btn" type="button" id="tgtest" data-busy="Sending…">Send test message</button></div>` : ""}</form>
      ${can("manager") ? `<h3>Recent notifications</h3>${log.length ? `<ul class="list">${log.map((x) => `<li>${esc(KIND[x.kind] || x.kind)} ${badge(x.status, x.status === "sent" ? "ok" : x.status === "failed" ? "alert" : "warn")}<small>${esc(fmtDate(x.created_at))}${x.error ? " · " + esc(x.error) : ""}</small><details><summary>Message</summary><pre class="content">${esc(x.message)}</pre></details></li>`).join("")}</ul>` : empty("Nothing sent yet.")}` : ""}`;
    const f = $("#sf", body);
    if (own) {
      guardForm(f, "settings:notifications");
      f.onsubmit = (e) => { e.preventDefault(); const v = formData(f);
        const mins = String(v.appointment_reminder_minutes || "").split(/[,\s]+/).filter(Boolean).map(Number);
        if (mins.some((m) => !Number.isInteger(m) || m < 1 || m > 20160)) return toast("Reminder minutes must be whole numbers between 1 and 20160 (14 days).", "err");
        if (v.telegram_enabled && !/^-?\d{5,20}$/.test(v.telegram_chat_id || "")) return toast("Enter a valid Telegram chat ID (numbers only).", "err");
        act(f.querySelector("button[type=submit]"), () => save("notifications", { ...n, ...v, appointment_reminder_minutes: [...new Set(mins)].sort((a, b) => b - a), task_lead_minutes: v.task_lead_minutes ?? 30, digest_hour: v.digest_hour ?? 8 }, f), "Notification settings saved");
      };
      $("#tgtest", body).onclick = (e) => act(e.currentTarget, async () => {
        if (hasDraftChanges(f)) throw new Error("Save your changes first, then send the test.");
        const r = await q(SB.rpc("ai_telegram_test"));
        if (r.status === "sent") toast("Test message sent — check Telegram. Delivery is confirmed in the log within 5 minutes.");
        else throw new Error(r.error || (r.queued === false ? "Notifications are switched off." : "Not sent"));
        settings(el, params);
      });
    }
    return;
  }
  const c = st.compliance;
  body.innerHTML = `<h2>Compliance</h2>
    <h3>Mandatory safeguards (cannot be switched off)</h3><ul class="checks">${SAFEGUARDS.map((s) => `<li>✔ ${esc(s)}</li>`).join("")}</ul>
    <form id="sf" class="form"><label class="check"><input type="checkbox" checked disabled> Marketing requires recorded consent (mandatory)</label>
    <label>PDPA notice (English)<textarea name="pdpa_notice_en" rows="2"${dis}>${esc(c.pdpa_notice_en)}</textarea></label>
    <label>PDPA notice (Bahasa Malaysia)<textarea name="pdpa_notice_ms" rows="2"${dis}>${esc(c.pdpa_notice_ms)}</textarea></label>
    ${own ? `<div class="actions"><button class="btn pri">Save</button></div>` : ""}</form>`;
  const f = $("#sf", body); if (own) { guardForm(f, "settings:compliance");
    f.onsubmit = (e) => { e.preventDefault(); const v = formData(f); act(f.querySelector("button"), () => save("compliance", { ...c, ...v, require_marketing_consent: true }, f), "Saved"); }; }
}

/* ======================= Pipeline stages ======================= */
export async function stages(el) {
  const rows = (await q(SB.from("ai_pipeline_stages").select("*").order("position"))) || [];
  const m = can("manager");
  el.innerHTML = `<div class="page-head"><div><a class="back" href="#/settings">← Settings</a><h1>Pipeline stages</h1></div></div>
  <section class="card"><ol class="stages">${rows.map((s, i) => `<li><form class="inline" data-stage="${attr(s.id)}"><input name="name" value="${attr(s.name)}" aria-label="Stage name"${ro("manager")}>
    ${s.is_won ? badge("Won", "ok") : s.is_lost ? badge("Lost", "alert") : ""}<label class="check"><input type="checkbox" name="active"${s.active ? " checked" : ""}${ro("manager")}> Active</label>
    ${m ? `<button class="btn" type="submit">Save</button><button class="icon" type="button" data-up="${i}" aria-label="Move up"${i ? "" : " disabled"}>↑</button><button class="icon" type="button" data-down="${i}" aria-label="Move down"${i < rows.length - 1 ? "" : " disabled"}>↓</button>` : ""}</form></li>`).join("")}</ol>
  ${m ? `<form id="ns" class="inline"><input name="name" required placeholder="New stage name" aria-label="New stage name"><select name="kind" aria-label="Kind">${opt("open", "Open stage")}${opt("won", "Closes as won")}${opt("lost", "Closes as lost")}</select><button class="btn pri">Add stage</button></form>` : ""}
  <p class="note">Stages in use cannot be deleted — deactivate them instead. Moving a lead into a Won or Lost stage closes it.</p></section>`;
  const reload = async () => { await loadLookups(); stages(el); };
  if (!m) return;
  $$("form[data-stage]", el).forEach((f) => f.onsubmit = (e) => { e.preventDefault(); const v = formData(f);
    act(f.querySelector("button[type=submit]"), async () => { await q(SB.from("ai_pipeline_stages").update({ name: v.name, active: v.active }).eq("id", f.dataset.stage).select("id"), { expectRows: true }); reload(); }, "Stage saved"); });
  const swap = (i, j) => act(null, async () => {
    const a = rows[i], b = rows[j];
    await q(SB.from("ai_pipeline_stages").update({ position: -1 }).eq("id", a.id).select("id"), { expectRows: true });
    await q(SB.from("ai_pipeline_stages").update({ position: a.position }).eq("id", b.id).select("id"), { expectRows: true });
    await q(SB.from("ai_pipeline_stages").update({ position: b.position }).eq("id", a.id).select("id"), { expectRows: true });
    reload();
  }, "Order saved");
  $$("[data-up]", el).forEach((b) => b.onclick = () => swap(+b.dataset.up, +b.dataset.up - 1));
  $$("[data-down]", el).forEach((b) => b.onclick = () => swap(+b.dataset.down, +b.dataset.down + 1));
  const ns = $("#ns", el);
  ns.onsubmit = (e) => { e.preventDefault(); const v = formData(ns);
    act(ns.querySelector("button"), async () => { await q(SB.from("ai_pipeline_stages").insert({ name: v.name, position: Math.max(0, ...rows.map((r) => r.position)) + 1, is_won: v.kind === "won", is_lost: v.kind === "lost" })); reload(); }, "Stage added"); };
}

/* ======================= Team ======================= */
export async function team(el) {
  const rows = (await q(SB.from("ai_team_members").select("*").order("role").order("email"))) || [];
  const own = can("owner");
  el.innerHTML = `<div class="page-head"><h1>Team &amp; permissions</h1></div>
  <section class="card"><h2>Roles</h2><dl class="kv"><dt>Owner</dt><dd>Everything, incl. settings, team, integrations and PDPA erasure. Website admins are owners automatically.</dd><dt>Manager</dt><dd>Projects, knowledge, templates, follow-ups, pipeline, campaigns, reports and audit log.</dd><dt>Advisor</dt><dd>Leads, conversations, tasks, appointments, consent and handover.</dd><dt>Viewer</dt><dd>Read-only.</dd></dl></section>
  <section class="card"><h2>Members</h2>
  ${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Active</th><th></th></tr></thead><tbody>${rows.map((m) => `<tr><td data-label="Email">${esc(m.email)}</td>
    <td data-label="Name">${esc(m.display_name || "")}</td><td data-label="Role">${own ? `<select data-role="${attr(m.email)}" aria-label="Role">${["owner", "manager", "advisor", "viewer"].map((r) => opt(r, r, m.role)).join("")}</select>` : esc(m.role)}</td>
    <td data-label="Active">${own ? `<input type="checkbox" data-active="${attr(m.email)}"${m.active ? " checked" : ""} aria-label="Active">` : m.active ? "Yes" : "No"}</td><td>${own ? `<button class="link" data-invite="${attr(m.email)}" data-r="${attr(m.role)}">Send invitation</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : empty("No team members yet. Website admins can already sign in as owners.")}
  ${own ? `<form id="nm" class="form two"><h3 class="full">Add a member</h3><label>Email<input name="email" type="email" required></label><label>Name<input name="display_name"></label>
    <label>Role<select name="role">${["advisor", "manager", "viewer", "owner"].map((r) => opt(r, r)).join("")}</select></label><label class="check"><input type="checkbox" name="invite" checked> Email an invitation to set a password</label>
    <div class="actions full"><button class="btn pri">Add member</button></div></form>` : ""}</section>`;
  if (!own) return;
  const reload = async () => { await loadLookups(); team(el); };
  $$("[data-role]", el).forEach((s) => s.onchange = () => act(null, async () => { await q(SB.from("ai_team_members").update({ role: s.value }).eq("email", s.dataset.role).select("email"), { expectRows: true }); reload(); }, "Role updated"));
  $$("[data-active]", el).forEach((c) => c.onchange = () => act(null, async () => { await q(SB.from("ai_team_members").update({ active: c.checked }).eq("email", c.dataset.active).select("email"), { expectRows: true }); reload(); }, c.checked ? "Activated" : "Deactivated — they lose access immediately"));
  const invite = async (email, role, name) => { const r = await api("/api/sales/team/invite", { method: "POST", body: JSON.stringify({ email, role, display_name: name }) }); toast(r.invited ? "Invitation sent to " + email : r.note || "Saved", r.invited ? "ok" : "warn"); };
  $$("[data-invite]", el).forEach((b) => b.onclick = () => act(b, () => invite(b.dataset.invite, b.dataset.r)));
  const nm = $("#nm", el);
  nm.onsubmit = (e) => { e.preventDefault(); const v = formData(nm); const email = v.email.toLowerCase();
    act(nm.querySelector("button"), async () => {
      await q(SB.from("ai_team_members").upsert({ email, display_name: v.display_name, role: v.role, active: true }));
      if (v.invite) { try { await invite(email, v.role, v.display_name); } catch (x) { toast("Member saved. Invitation not sent: " + x.message, "warn"); } } else toast("Member saved");
      reload(); }); };
}

/* ======================= Integrations ======================= */
export async function integrations(el) {
  const rows = (await q(SB.from("ai_integration_accounts").select("*").order("provider"))) || [];
  let h = null, herr = "";
  try { h = await api("/api/sales/health"); } catch (x) { herr = x.message; }
  const yes = (v) => v ? badge("Set", "ok") : badge("Missing", "warn");
  const NAMES = { whatsapp_cloud: "WhatsApp Business Platform (Meta Cloud API)", anthropic: "Anthropic Claude (LLM)", google_calendar: "Google Calendar", openai: "OpenAI", twilio_whatsapp: "Twilio WhatsApp", telegram: "Telegram alerts" };
  el.innerHTML = `<div class="page-head"><h1>Integrations</h1><p class="sub">Secrets are only ever stored as Netlify environment variables. This page shows whether they are set, never their values.</p></div>
  <section class="card"><h2>Server</h2>${h ? `<dl class="kv"><dt>Server switch AI_SALES_ENABLED</dt><dd>${h.server_enabled ? badge("On", "ok") : badge("Off", "warn")}</dd><dt>Database from server</dt><dd>${esc(h.database)}</dd>
    ${Object.entries(h.configured).map(([k, v]) => `<dt>${esc(k.replace(/_/g, " "))}</dt><dd>${yes(v)}</dd>`).join("")}<dt>Checked</dt><dd>${esc(fmtDate(h.checked_at))}</dd></dl>` : `<p class="note">Server functions not reachable: ${esc(herr)}. They become available after this branch is deployed.</p>`}</section>
  <section class="card"><h2>Accounts</h2><ul class="list">${rows.map((r) => `<li><b>${esc(NAMES[r.provider] || r.provider)}</b> ${badge(r.status.replace("_", " "), r.status === "healthy" ? "ok" : r.status === "error" ? "alert" : "")}<small>${r.last_checked_at ? "Checked " + esc(fmtDate(r.last_checked_at)) : "Not checked yet"}${r.last_error ? " · " + esc(r.last_error) : ""}</small></li>`).join("")}</ul>
  <p class="note">Connection steps for each provider are in <code>ai-sales/docs/03-SETUP.md</code>. WhatsApp, LLM and calendar connections are built in Phases 3–4.</p></section>`;
}

/* ======================= Templates & objections ======================= */
export async function templates(el, params) {
  const tab = params.get("tab") || "objections";
  el.innerHTML = `<div class="page-head"><h1>Templates &amp; objection library</h1></div><div class="seg"><a class="${tab === "objections" ? "on" : ""}" href="#/templates?tab=objections">Objection library</a><a class="${tab === "templates" ? "on" : ""}" href="#/templates?tab=templates">Message templates</a></div><div id="tb"></div>`;
  const body = $("#tb", el);
  const m = can("manager");
  if (tab === "objections") {
    const rows = (await q(SB.from("ai_objections").select("*").order("key"))) || [];
    body.innerHTML = `${m ? `<div class="actions"><button class="btn pri" id="no">＋ Add objection</button></div>` : ""}
    ${rows.map((o) => `<article class="card entry ${o.active ? "" : "draft"}"><div class="ho-h"><b>${esc(o.key.replace(/_/g, " "))}</b> ${o.escalate ? badge("Escalates to human", "alert") : ""} ${o.active ? "" : badge("Inactive")}</div>
      <p class="examples">${o.examples.map((x) => `<q>${esc(x)}</q>`).join(" ")}</p>
      <details><summary>Guidance</summary><p><b>EN:</b> ${esc(o.guidance_en)}</p><p><b>BM:</b> ${esc(o.guidance_ms)}</p>${o.clarifying_question_en ? `<p class="note">Clarifying question: ${esc(o.clarifying_question_en)} / ${esc(o.clarifying_question_ms || "")}</p>` : ""}</details>
      ${m ? `<div class="actions"><button class="link" data-edit="${attr(o.id)}">Edit</button></div>` : ""}</article>`).join("") || empty("No objections.")}`;
    const edit = (o = {}) => { const dlg = modal(o.id ? "Edit objection" : "Add objection", `<form id="fo" class="form two">
      <label>Key<input name="key" required pattern="[a-z0-9_]+" value="${attr(o.key)}" title="lowercase_with_underscores"></label><label class="check"><input type="checkbox" name="escalate"${o.escalate ? " checked" : ""}> Always escalate to a human</label>
      <label class="full">Example phrases (one per line)<textarea name="examples" rows="3">${esc((o.examples || []).join("\n"))}</textarea></label>
      <label class="full">Guidance (English)<textarea name="guidance_en" rows="3" required>${esc(o.guidance_en)}</textarea></label>
      <label class="full">Guidance (Bahasa Malaysia)<textarea name="guidance_ms" rows="3" required>${esc(o.guidance_ms)}</textarea></label>
      <label>Clarifying question (EN)<input name="clarifying_question_en" value="${attr(o.clarifying_question_en)}"></label><label>Clarifying question (BM)<input name="clarifying_question_ms" value="${attr(o.clarifying_question_ms)}"></label>
      <label class="check full"><input type="checkbox" name="active"${o.active !== false ? " checked" : ""}> Active</label>
      <div class="actions full"><button class="btn pri">Save</button></div></form>`, { wide: true });
      const f = $("#fo", dlg); guardForm(f, "obj:" + (o.id || "new"));
      f.onsubmit = (e) => { e.preventDefault(); const v = formData(f); const rec = { ...v, examples: String(v.examples || "").split("\n").map((s) => s.trim()).filter(Boolean) };
        act(f.querySelector("button"), async () => { if (o.id) await q(SB.from("ai_objections").update(rec).eq("id", o.id).select("id"), { expectRows: true }); else await q(SB.from("ai_objections").insert(rec)); clearDraft(f); dlg.done(); templates(el, params); }, "Saved"); }; };
    if (m) { $("#no", body).onclick = () => edit(); $$("[data-edit]", body).forEach((b) => b.onclick = () => edit(rows.find((r) => r.id === b.dataset.edit))); }
    return;
  }
  const rows = (await q(SB.from("ai_message_templates").select("*").order("name").order("lang"))) || [];
  body.innerHTML = `<div class="card notice"><div>Messages sent outside WhatsApp's 24-hour customer-service window must use a template <b>approved by Meta</b>. Record the approved template name here once Meta approves it.</div></div>
  ${m ? `<div class="actions"><button class="btn pri" id="nt">＋ Add template</button></div>` : ""}
  ${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Lang</th><th>Category</th><th>WhatsApp status</th><th>Text</th><th></th></tr></thead><tbody>${rows.map((t) => `<tr><td data-label="Name"><b>${esc(t.name)}</b>${t.active ? "" : badge("Inactive")}</td><td data-label="Lang">${esc(t.lang.toUpperCase())}</td><td data-label="Category">${esc(t.category)}</td>
    <td data-label="WhatsApp">${badge(t.wa_status.replace("_", " "), t.wa_status === "approved" ? "ok" : t.wa_status === "rejected" ? "alert" : "")}${t.wa_template_name ? `<small>${esc(t.wa_template_name)}</small>` : ""}</td><td data-label="Text"><small>${esc(t.body.slice(0, 140))}${t.body.length > 140 ? "…" : ""}</small></td><td>${m ? `<button class="link" data-edit="${attr(t.id)}">Edit</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : empty("No templates yet.")}`;
  const edit = (t = {}) => { const dlg = modal(t.id ? "Edit template" : "Add template", `<form id="ftp" class="form two">
    <label>Name<input name="name" required value="${attr(t.name)}" placeholder="e.g. appointment_reminder"></label><label>Language<select name="lang">${opt("ms", "Bahasa Malaysia", t.lang)}${opt("en", "English", t.lang)}</select></label>
    <label>Category<select name="category">${["utility", "marketing", "service_reply", "authentication"].map((c) => opt(c, c.replace("_", " "), t.category)).join("")}</select></label>
    <label>WhatsApp status<select name="wa_status">${["not_submitted", "pending", "approved", "rejected", "paused"].map((c) => opt(c, c.replace("_", " "), t.wa_status)).join("")}</select></label>
    <label class="full">Approved WhatsApp template name<input name="wa_template_name" value="${attr(t.wa_template_name)}"></label>
    <label class="full">Text (use {{1}}, {{2}} for variables)<textarea name="body" rows="5" required>${esc(t.body)}</textarea></label>
    <label class="check full"><input type="checkbox" name="active"${t.active !== false ? " checked" : ""}> Active</label><div class="actions full"><button class="btn pri">Save</button></div></form>`, { wide: true });
    const f = $("#ftp", dlg); guardForm(f, "tpl:" + (t.id || "new"));
    f.onsubmit = (e) => { e.preventDefault(); const v = formData(f);
      act(f.querySelector("button"), async () => { if (t.id) await q(SB.from("ai_message_templates").update(v).eq("id", t.id).select("id"), { expectRows: true }); else await q(SB.from("ai_message_templates").insert(v)); clearDraft(f); dlg.done(); templates(el, params); }, "Saved"); }; };
  if (m) { $("#nt", body).onclick = () => edit(); $$("[data-edit]", body).forEach((b) => b.onclick = () => edit(rows.find((r) => r.id === b.dataset.edit))); }
}

/* ======================= Follow-up automation ======================= */
export async function followups(el) {
  const [seqs, jobs] = await Promise.all([
    q(SB.from("ai_follow_up_sequences").select("*").order("name")),
    q(SB.from("ai_follow_up_jobs").select("*, lead:ai_leads(lead_code)").order("run_at", { ascending: false }).limit(100)),
  ]);
  const m = can("manager");
  el.innerHTML = `<div class="page-head"><h1>Follow-up automation</h1>${m ? `<button class="btn pri" id="ns">＋ New sequence</button>` : ""}</div>
  <div class="card notice"><div>The follow-up engine is built in Phase 4. Sequences can be prepared now; nothing is sent until the engine is deployed <b>and</b> "Automated follow-ups" is switched on. Messages always stop on reply, opt-out, booking, human request or lead closure.</div></div>
  ${(seqs || []).map((s) => `<article class="card entry ${s.active ? "" : "draft"}"><div class="ho-h"><b>${esc(s.name)}</b> ${badge(s.lead_type.replace(/_/g, " "))} ${s.active ? badge("Active", "ok") : badge("Inactive")}</div>
    <ol class="steps">${(s.steps || []).map((st) => `<li><b>after ${esc(st.delay_hours >= 24 ? st.delay_hours / 24 + " day(s)" : st.delay_hours + " h")}</b> ${badge(st.purpose, st.purpose === "marketing" ? "warn" : "")} ${esc(st.instruction || "")}</li>`).join("")}</ol>
    <p class="note">Stops on: ${esc((s.stop_on || []).join(", ").replace(/_/g, " "))}</p>${m ? `<div class="actions"><button class="link" data-edit="${attr(s.id)}">Edit</button></div>` : ""}</article>`).join("") || empty("No sequences.")}
  <section class="card"><h2>Recent follow-up jobs</h2>${(jobs || []).length ? `<ul class="list">${jobs.map((j) => `<li>${esc(j.lead?.lead_code || "")} · step ${j.step_index + 1} ${badge(j.status)}<small>${esc(fmtDate(j.run_at))}${j.reason ? " · " + esc(j.reason) : ""}</small></li>`).join("")}</ul>` : empty("No jobs yet — the engine arrives in Phase 4.")}</section>`;
  const STOPS = ["customer_reply", "opt_out", "appointment_booked", "human_requested", "lead_closed"];
  const edit = (s = { steps: [], stop_on: STOPS }) => {
    const stepRow = (st = {}) => `<div class="steprow"><input name="delay_hours" type="number" min="1" max="2160" value="${attr(st.delay_hours)}" placeholder="Hours" aria-label="Delay in hours" required><select name="purpose" aria-label="Purpose">${opt("service", "Service", st.purpose)}${opt("marketing", "Marketing (needs consent)", st.purpose)}</select><input name="instruction" value="${attr(st.instruction)}" placeholder="What should this message do?" aria-label="Instruction" required><button type="button" class="icon" data-rm aria-label="Remove step">✕</button></div>`;
    const dlg = modal(s.id ? "Edit sequence" : "New sequence", `<form id="fs" class="form two"><label>Name<input name="name" required value="${attr(s.name)}"></label>
      <label>Lead type<select name="lead_type">${["new_enquiry", "price_list", "brochure", "financing", "undecided", "appointment_pending", "appointment_confirmation", "missed_appointment", "reactivation", "post_viewing"].map((t) => opt(t, t.replace(/_/g, " "), s.lead_type)).join("")}</select></label>
      <div class="full"><b>Steps</b> <small>(delay counted from the previous message)</small><div id="steps">${(s.steps.length ? s.steps : [{}]).map(stepRow).join("")}</div><button type="button" class="btn" id="addstep">＋ Step</button></div>
      <fieldset class="full"><legend>Stop when</legend>${STOPS.map((x) => `<label class="check"><input type="checkbox" name="stop_${x}"${(s.stop_on || []).includes(x) ? " checked" : ""}${["opt_out"].includes(x) ? " disabled checked" : ""}> ${esc(x.replace(/_/g, " "))}${x === "opt_out" ? " (mandatory)" : ""}</label>`).join("")}</fieldset>
      <label class="check full"><input type="checkbox" name="active"${s.active ? " checked" : ""}> Active</label><div class="actions full"><button class="btn pri" type="submit">Save</button></div></form>`, { wide: true });
    const f = $("#fs", dlg), box = $("#steps", dlg);
    const wireRm = () => $$("[data-rm]", box).forEach((b) => b.onclick = () => { if ($$(".steprow", box).length > 1) b.parentElement.remove(); });
    $("#addstep", dlg).onclick = () => { box.insertAdjacentHTML("beforeend", stepRow()); wireRm(); }; wireRm();
    f.onsubmit = (e) => { e.preventDefault();
      const steps = $$(".steprow", box).map((r) => ({ delay_hours: Number(r.querySelector("[name=delay_hours]").value), purpose: r.querySelector("[name=purpose]").value, instruction: r.querySelector("[name=instruction]").value.trim() }));
      const stop_on = STOPS.filter((x) => x === "opt_out" || f.querySelector(`[name=stop_${x}]`).checked);
      const rec = { name: f.name.value.trim(), lead_type: f.lead_type.value, steps, stop_on, active: f.active.checked };
      act(f.querySelector("button[type=submit]"), async () => { if (s.id) await q(SB.from("ai_follow_up_sequences").update(rec).eq("id", s.id).select("id"), { expectRows: true }); else await q(SB.from("ai_follow_up_sequences").insert(rec)); dlg.done(); followups(el); }, "Sequence saved"); };
  };
  if (m) { $("#ns", el).onclick = () => edit(); $$("[data-edit]", el).forEach((b) => b.onclick = () => edit((seqs || []).find((x) => x.id === b.dataset.edit))); }
}

/* ======================= Campaigns ======================= */
export async function campaigns(el) {
  const leads = (await q(SB.from("ai_leads").select("campaign_id,source_id,closed_at,stage_id").limit(10000))) || [];
  const m = can("manager");
  const won = new Set(S.stages.filter((s) => s.is_won).map((s) => s.id));
  el.innerHTML = `<div class="page-head"><h1>Campaign attribution</h1>${m ? `<button class="btn pri" id="nc">＋ New campaign</button>` : ""}</div>
  <section class="card"><h2>Campaigns</h2>${S.campaigns.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Campaign</th><th>Source</th><th>Project</th><th>Leads</th><th>Won</th><th>Spend</th><th>Cost / lead</th></tr></thead><tbody>
  ${S.campaigns.map((c) => { const ls = leads.filter((l) => l.campaign_id === c.id); const w = ls.filter((l) => won.has(l.stage_id)).length; return `<tr><td data-label="Campaign"><b>${esc(c.name)}</b>${c.tracking_code ? `<small>Code: ${esc(c.tracking_code)}</small>` : ""}${m ? ` <button class="link" data-edit="${attr(c.id)}">Edit</button>` : ""}</td>
    <td data-label="Source">${esc(sourceName(c.source_id))}</td><td data-label="Project">${esc(projectName(c.project_id)) || "—"}</td><td data-label="Leads">${ls.length}</td><td data-label="Won">${w}</td>
    <td data-label="Spend">${c.spend_myr !== null ? esc(money(c.spend_myr)) : "<small>not entered</small>"}</td><td data-label="Cost/lead">${c.spend_myr !== null && ls.length ? esc(money(Math.round(c.spend_myr / ls.length))) : "—"}</td></tr>`; }).join("")}</tbody></table></div>` : empty("No campaigns yet.")}
  <p class="note">Cost per lead is calculated only from spend you enter (or later sync); it is never estimated.</p></section>
  <section class="card"><h2>Lead sources</h2><ul class="list">${S.sources.map((s) => `<li>${esc(s.name)} ${badge(s.channel)} <small>${leads.filter((l) => l.source_id === s.id).length} leads</small></li>`).join("")}</ul>
  ${m ? `<form id="nsrc" class="inline"><input name="name" required placeholder="New source name" aria-label="Source name"><select name="channel" aria-label="Channel">${["website", "whatsapp", "facebook", "instagram", "google", "tiktok", "portal", "referral", "walk_in", "event", "other"].map((c) => opt(c, c)).join("")}</select><button class="btn">Add source</button></form>` : ""}</section>`;
  if (!m) return;
  const reload = async () => { await loadLookups(); campaigns(el); };
  const edit = (c = {}) => { const dlg = modal(c.id ? "Edit campaign" : "New campaign", `<form id="fcp" class="form two">
    <label class="full">Name<input name="name" required value="${attr(c.name)}"></label>
    <label>Source<select name="source_id">${opt("", "—", c.source_id)}${S.sources.map((s) => opt(s.id, s.name, c.source_id)).join("")}</select></label>
    <label>Project<select name="project_id">${opt("", "—", c.project_id)}${S.projects.map((p) => opt(p.id, p.name, c.project_id)).join("")}</select></label>
    <label>Tracking code<input name="tracking_code" value="${attr(c.tracking_code)}" placeholder="e.g. FB-ARIA-OCT"></label><label>UTM campaign<input name="utm_campaign" value="${attr(c.utm_campaign)}"></label>
    <label>Starts<input name="starts_on" type="date" value="${attr(c.starts_on)}"></label><label>Ends<input name="ends_on" type="date" value="${attr(c.ends_on)}"></label>
    <label>Budget (RM)<input name="budget_myr" type="number" min="0" step="0.01" value="${attr(c.budget_myr)}"></label><label>Actual spend (RM)<input name="spend_myr" type="number" min="0" step="0.01" value="${attr(c.spend_myr)}"></label>
    <label class="check full"><input type="checkbox" name="active"${c.active !== false ? " checked" : ""}> Active</label><div class="actions full"><button class="btn pri">Save</button></div></form>`, { wide: true });
    const f = $("#fcp", dlg); guardForm(f, "camp:" + (c.id || "new"));
    f.onsubmit = (e) => { e.preventDefault(); const v = formData(f);
      act(f.querySelector("button"), async () => { if (c.id) await q(SB.from("ai_campaigns").update(v).eq("id", c.id).select("id"), { expectRows: true }); else await q(SB.from("ai_campaigns").insert(v)); clearDraft(f); dlg.done(); reload(); }, "Campaign saved"); }; };
  $("#nc", el).onclick = () => edit();
  $$("[data-edit]", el).forEach((b) => b.onclick = () => edit(S.campaigns.find((c) => c.id === b.dataset.edit)));
  const ns = $("#nsrc", el);
  ns.onsubmit = (e) => { e.preventDefault(); const v = formData(ns); act(ns.querySelector("button"), async () => { await q(SB.from("ai_lead_sources").insert(v)); reload(); }, "Source added"); };
}

/* ======================= Reports ======================= */
export async function reports(el, params) {
  const days = Math.min(365, Math.max(7, Number(params.get("days")) || 30));
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const [leads, appts, handovers] = await Promise.all([
    q(SB.from("ai_leads").select("id,created_at,closed_at,stage_id,source_id,temperature,lost_reason,first_response_at").gte("created_at", since).limit(20000)),
    q(SB.from("ai_appointments").select("status,lead_id,created_at").gte("created_at", since).limit(20000)),
    q(SB.from("ai_handover_events").select("lead_id").gte("created_at", since).limit(20000)),
  ]);
  const L = leads || [], A = appts || [];
  const won = new Set(S.stages.filter((s) => s.is_won).map((s) => s.id)), lost = new Set(S.stages.filter((s) => s.is_lost).map((s) => s.id));
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + "%" : "—");
  const byDay = {};
  for (let i = days - 1; i >= 0; i--) byDay[new Date(Date.now() - i * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" })] = 0;
  L.forEach((l) => { const k = new Date(l.created_at).toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }); if (k in byDay) byDay[k]++; });
  const maxDay = Math.max(1, ...Object.values(byDay));
  const qualified = L.filter((l) => ["hot", "warm"].includes(l.temperature)).length;
  const withAppt = new Set(A.map((a) => a.lead_id)).size;
  const attended = A.filter((a) => a.status === "completed").length, noShow = A.filter((a) => a.status === "no_show").length;
  const wonN = L.filter((l) => won.has(l.stage_id)).length, lostN = L.filter((l) => lost.has(l.stage_id)).length;
  const frt = L.filter((l) => l.first_response_at).map((l) => (new Date(l.first_response_at) - new Date(l.created_at)) / 60000).sort((a, b) => a - b);
  const reasons = {}; L.filter((l) => lost.has(l.stage_id)).forEach((l) => { const r = (l.lost_reason || "Not recorded").trim(); reasons[r] = (reasons[r] || 0) + 1; });
  const bySource = {}; L.forEach((l) => { const s = sourceName(l.source_id) || "Unknown"; bySource[s] = (bySource[s] || 0) + 1; });
  const byStage = {}; L.filter((l) => !l.closed_at).forEach((l) => { const s = S.stages.find((x) => x.id === l.stage_id)?.name || "?"; byStage[s] = (byStage[s] || 0) + 1; });
  const bars = (o) => { const mx = Math.max(1, ...Object.values(o)); return `<ul class="bars">${Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<li><span>${esc(k)}</span><i style="--w:${(v / mx) * 100}%"></i><b>${v}</b></li>`).join("")}</ul>`; };
  el.innerHTML = `<div class="page-head"><h1>Reports &amp; analytics</h1><div class="seg">${[7, 30, 90, 365].map((d) => `<a class="${days === d ? "on" : ""}" href="#/reports?days=${d}">${d} days</a>`).join("")}</div></div>
  <p class="sub">All figures are <b>measured</b> from CRM records for leads created in the last ${days} days. Nothing here is estimated.</p>
  <div class="kpis">
    <div class="kpi"><b>${L.length}</b><span>Total leads</span></div>
    <div class="kpi"><b>${pct(qualified, L.length)}</b><span>Qualified (hot/warm)</span></div>
    <div class="kpi"><b>${pct(withAppt, L.length)}</b><span>Booked an appointment</span></div>
    <div class="kpi"><b>${pct(attended, attended + noShow)}</b><span>Appointment attendance</span></div>
    <div class="kpi"><b>${pct(wonN, L.length)}</b><span>Lead → won</span></div>
    <div class="kpi"><b>${pct(new Set((handovers || []).map((h) => h.lead_id)).size, L.length)}</b><span>Human handover rate</span></div>
    <div class="kpi"><b>${frt.length ? Math.round(frt[Math.floor(frt.length / 2)]) + " min" : "—"}</b><span>Median first response${frt.length ? "" : " (needs WhatsApp, Phase 4)"}</span></div>
    <div class="kpi"><b>—</b><span>AI resolution rate (Phase 3)</span></div>
  </div>
  <section class="card"><h2>New leads per day</h2><div class="spark" role="img" aria-label="New leads per day">${Object.entries(byDay).map(([d, v]) => `<i title="${attr(d)}: ${v}" style="--h:${(v / maxDay) * 100}%"></i>`).join("")}</div></section>
  <div class="grid2"><section class="card"><h2>By source</h2>${Object.keys(bySource).length ? bars(bySource) : empty("No leads.")}</section>
  <section class="card"><h2>Open leads by stage</h2>${Object.keys(byStage).length ? bars(byStage) : empty("No open leads.")}</section></div>
  <section class="card"><h2>Reasons for lost leads</h2>${lostN ? bars(reasons) : empty("No lost leads in this period.")}</section>`;
}

/* ======================= Consent, security & audit ======================= */
export async function audit(el, params) {
  const tab = params.get("tab") || (can("manager") ? "audit" : "consent");
  el.innerHTML = `<div class="page-head"><h1>Consent, security &amp; audit</h1></div><div class="seg">${can("manager") ? `<a class="${tab === "audit" ? "on" : ""}" href="#/audit?tab=audit">Audit log</a>` : ""}<a class="${tab === "consent" ? "on" : ""}" href="#/audit?tab=consent">Consent records</a><a class="${tab === "retention" ? "on" : ""}" href="#/audit?tab=retention">Retention &amp; PDPA</a></div><div id="ab"></div>`;
  const body = $("#ab", el);
  if (tab === "audit" && can("manager")) {
    const tbl = params.get("table") || "";
    let query = SB.from("ai_audit_logs").select("*").order("created_at", { ascending: false }).limit(300);
    if (tbl) query = query.eq("table_name", tbl);
    const rows = (await q(query)) || [];
    body.innerHTML = `<form class="filters" id="af"><input name="table" value="${attr(tbl)}" placeholder="Filter by table, e.g. ai_settings" aria-label="Table filter"></form>
    ${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Changes</th></tr></thead><tbody>${rows.map((r) => `<tr><td data-label="When">${esc(fmtDate(r.created_at))}</td><td data-label="Who">${esc(r.actor)}</td><td data-label="Action">${esc(r.action)}</td><td data-label="Record">${esc(r.table_name || "")}<small>${esc(r.record_id || "")}</small></td><td data-label="Changes"><details><summary>View</summary><pre class="content">${esc(JSON.stringify(r.changes, null, 1))}</pre></details></td></tr>`).join("")}</tbody></table></div>` : empty("No audit entries.")}`;
    $("#af", body).onsubmit = (e) => { e.preventDefault(); location.hash = "#/audit?tab=audit&table=" + encodeURIComponent(e.target.table.value.trim()); };
    return;
  }
  if (tab === "consent") {
    const rows = (await q(SB.from("ai_consent_records").select("*, contact:ai_contacts(full_name,phone_e164)").order("recorded_at", { ascending: false }).limit(300))) || [];
    body.innerHTML = `<p class="note">Consent history is append-only. The latest record per contact, channel and purpose is the current state; an opt-out always wins for marketing.</p>
    ${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Contact</th><th>Purpose</th><th>Channel</th><th>Status</th><th>Source / evidence</th></tr></thead><tbody>${rows.map((r) => `<tr><td data-label="When">${esc(fmtDate(r.recorded_at))}</td><td data-label="Contact">${esc(r.contact?.full_name || "")}<small>${esc(r.contact?.phone_e164 || "")}</small></td><td data-label="Purpose">${esc(r.purpose)}</td><td data-label="Channel">${esc(r.channel)}</td><td data-label="Status">${badge(r.status, r.status === "granted" ? "ok" : "alert")}</td><td data-label="Source">${esc(r.source)}<small>${esc(r.evidence || "")} · ${esc(r.recorded_by)}</small></td></tr>`).join("")}</tbody></table></div>` : empty("No consent records yet.")}`;
    return;
  }
  body.innerHTML = `<section class="card"><h2>Retention rules</h2><ul class="checks"><li>Webhook payloads: deleted after 90 days.</li><li>AI run inputs/outputs: removed after 180 days (the decision log is kept).</li><li>Finished background jobs: deleted after 30 days.</li><li>Contacts: kept until erased on request (PDPA). Erasure is done from the lead page by an owner.</li></ul>
    ${can("owner") ? `<button class="btn" id="purge">Run retention clean-up now</button>` : ""}<p class="note">The clean-up also runs daily once the Phase 4 scheduler is deployed.</p></section>`;
  const pb = $("#purge", body);
  if (pb) pb.onclick = () => act(pb, async () => { const r = await q(SB.rpc("ai_purge_expired")); toast(`Clean-up done: ${r.webhook_events_deleted} webhook events, ${r.agent_runs_trimmed} AI runs trimmed`); });
}
