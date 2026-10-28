// AI Sales — appointment calendar: free slots (GET /slots), staff confirmation (POST /confirm) and cancelling
// (POST /cancel, which also removes the Google Calendar event).
// With Google Calendar connected the slot is re-checked and an event is created before anything is marked confirmed.
import { json, getCaller, hasRole, moduleEnabled, disabled, userDb, audit } from "../../ai-sales/lib/server.mjs";
import { inWindow } from "../../ai-sales/lib/whatsapp.mjs";
import { liveDeps } from "../../ai-sales/lib/live.mjs";
import { sendOutbound, loadSettings } from "../../ai-sales/lib/worker.mjs";
import { confirmationText, placeFor, formatWhen } from "../../ai-sales/lib/calendar.mjs";
import { templateParams } from "../../ai-sales/lib/followups.mjs";
import { confirmAppointmentNow } from "../../ai-sales/lib/automation.mjs";
import { buyerLanguage } from "../../ai-sales/lib/outbound.mjs";

const enc = encodeURIComponent;

export default async (req) => {
  if (!moduleEnabled()) return disabled();
  const caller = await getCaller(req);
  if (!caller) return json({ error: "Sign in required" }, 401);
  if (!hasRole(caller.role, "advisor")) return json({ error: "Advisors, managers and owners only" }, 403);
  const deps = liveDeps();
  if (!deps.db) return json({ error: "SUPABASE_SERVICE_ROLE_KEY is not set in Netlify.", setup_needed: "SUPABASE_SERVICE_ROLE_KEY" }, 501);
  const settings = await loadSettings(deps.db);

  if (req.method === "GET") {
    if (!deps.cal) return json({ error: "Google Calendar is not connected yet.", setup_needed: "GOOGLE_CALENDAR" }, 501);
    try { return json({ slots: await deps.cal.slots(settings, new Date()) }); }
    catch (e) { return json({ error: e.message }, e.kind === "config" ? 501 : 502); }
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const db = userDb(caller);
  const appt = (await db.get(`ai_appointments?id=eq.${enc(body?.appointment_id || "")}&select=*,lead:ai_leads(id,contact_id,lead_code,contact:ai_contacts(full_name,phone_e164,wa_id,preferred_language))`))?.[0];
  if (!appt) return json({ error: "Appointment not found" }, 404);

  if (new URL(req.url).pathname.endsWith("/cancel")) {
    if (["cancelled", "completed", "no_show"].includes(appt.status)) return json({ error: `This appointment is already ${appt.status.replace(/_/g, " ")}.` }, 409);
    // the calendar first: if the event cannot be removed, nothing changes and the advisor is told why
    let calendar = false;
    if (appt.calendar_event_id && appt.calendar_provider === "google") {
      if (!deps.cal) return json({ error: "This appointment is on Google Calendar, but the calendar is not connected. Delete the event in Google Calendar, then mark it cancelled on the lead page." }, 501);
      try { calendar = await deps.cal.cancel(appt.calendar_event_id); } catch (e) { return json({ error: e.message }, e.kind === "config" ? 501 : 502); }
    }
    await db.patch(`ai_appointments?id=eq.${enc(appt.id)}`, { status: "cancelled",
      reminders: [...(appt.reminders || []), { type: "cancelled", at: new Date().toISOString(), by: caller.email, calendar_event_deleted: calendar }] });
    await audit(caller, "appointment_cancel", { table: "ai_appointments", id: appt.id, calendar_event_id: appt.calendar_event_id || null });
    return json({ ok: true, calendar });
  }

  if (!["pending_confirmation", "rescheduled"].includes(appt.status)) return json({ error: `This appointment is ${appt.status.replace(/_/g, " ")}.` }, 409);
  if (appt.calendar_event_id) return json({ error: "This appointment is already on the calendar. Change it in Google Calendar." }, 409);
  const start = new Date(body.start_at);
  if (isNaN(start) || start < new Date()) return json({ error: "Choose a date and time in the future." }, 400);
  const dur = Math.max(15, Math.min(480, Number(body.duration_minutes || settings.business?.appointments?.duration_minutes || 60)));
  const end = new Date(start.getTime() + dur * 60e3);
  // an empty location means "the usual place": the project's showroom (with its map link) or the default location
  const place = await placeFor(deps.db, appt, settings);
  const location = (String(body.location ?? "").trim() || place.location).slice(0, 300);
  const map = location === place.location ? place.map : "";
  const c = appt.lead?.contact || {};

  let eventId = null;
  if (deps.cal) {
    try {
      eventId = await deps.cal.book({ start: start.toISOString(), end: end.toISOString(), location,
        summary: `${appt.kind.replace(/_/g, " ")} · ${c.full_name || "+" + (c.wa_id || c.phone_e164 || "")} (${appt.lead?.lead_code || ""})`,
        description: `Confirmed by ${caller.email}.\nhttps://onestopcentreproperty.com/sales/#/lead/${appt.lead?.id}${map ? "\nMap: " + map : ""}` });
    } catch (e) { return json({ error: e.message }, e.kind === "taken" ? 409 : e.kind === "config" ? 501 : 502); }
  }
  await db.patch(`ai_appointments?id=eq.${enc(appt.id)}`, { status: "confirmed", start_at: start.toISOString(), end_at: end.toISOString(), location: location || null,
    advisor_email: body.advisor_email || caller.email, calendar_provider: eventId ? "google" : "manual", calendar_event_id: eventId,
    reminders: [...(appt.reminders || []), { type: "confirmation", at: new Date().toISOString(), by: caller.email }] });
  await audit(caller, "appointment_confirm", { table: "ai_appointments", id: appt.id, calendar_event_id: eventId });

  // tell the buyer on WhatsApp when possible: through the confirmation job the database created on confirming,
  // so the scheduled worker never sends a second one (older databases without jobs: sent directly below)
  let notified = false, note = null;
  if (!body.notify_buyer) {
    await deps.db.patch(`ai_automation_jobs?appointment_id=eq.${enc(appt.id)}&kind=eq.appt_confirmation&status=eq.scheduled`, { status: "cancelled", reason: "the advisor chose not to notify the buyer" }).catch(() => {});
  }
  const viaJob = body.notify_buyer ? await confirmAppointmentNow(deps, settings, appt.id).catch(() => null) : null;
  if (viaJob) { notified = viaJob.status === "sent"; note = notified ? null : viaJob.reason || null; }
  else if (body.notify_buyer) {
    const conv = (await deps.db.get(`ai_conversations?contact_id=eq.${enc(appt.lead.contact_id)}&channel=eq.whatsapp&status=eq.open&select=*`))?.[0];
    const to = c.wa_id || c.phone_e164, lang = await buyerLanguage(deps.db, conv, c);
    if (!settings.flags?.whatsapp_outbound || !deps.wa) note = "WhatsApp sending is off or not connected.";
    else if (!conv || !to) note = "The buyer has no WhatsApp conversation yet.";
    else if (inWindow(conv.last_inbound_at, new Date())) {
      const s = await sendOutbound(deps, { conversation: conv, to, text: confirmationText({ kind: appt.kind, start, location, map, lang }), senderType: "system", senderEmail: caller.email, purpose: "service" });
      notified = s.sent; note = s.error || null;
    } else {
      const t = ((await deps.db.get("ai_message_templates?name=eq.appointment_confirmation&wa_status=eq.approved&active=is.true&select=*")) || []).filter((x) => x.wa_template_name);
      const tpl = t.find((x) => x.lang === lang) || t[0];
      if (!tpl) note = "More than 24 hours since the buyer's last message and no approved \"appointment_confirmation\" template.";
      else {
        const when = formatWhen(start, tpl.lang);
        const s = await sendOutbound(deps, { conversation: conv, to, template: { ...tpl, params: templateParams(tpl, { name: c.full_name, appointment: when, location: [location, map].filter(Boolean).join(" ") }) }, senderType: "system", senderEmail: caller.email, purpose: "service" });
        notified = s.sent; note = s.error || null;
      }
    }
  }
  return json({ ok: true, calendar: !!eventId, buyer_notified: notified, note });
};

export const config = { path: ["/api/sales/appointments/slots", "/api/sales/appointments/confirm", "/api/sales/appointments/cancel"], method: ["GET", "POST"] };
