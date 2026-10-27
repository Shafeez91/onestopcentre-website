// Google Calendar adapter (service account). Zero dependencies: the OAuth token is a self-signed RS256 JWT.
// Free slots come from the calendar's free/busy data inside business hours; a slot is re-checked right before booking.
import { createSign } from "node:crypto";
import { myParts, myInstant, dayHours } from "./followups.mjs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const TZ = "Asia/Kuala_Lumpur";

export class CalendarError extends Error {
  constructor(message, { kind = "error", status = null } = {}) { super(message); this.kind = kind; this.status = status; }
}

/** Calendar settings from the environment; null when not configured. The private key may use literal "\n". */
export function calConfig(env) {
  const email = env("GOOGLE_SERVICE_ACCOUNT_EMAIL"), key = env("GOOGLE_PRIVATE_KEY"), calendarId = env("GOOGLE_CALENDAR_ID");
  if (!email || !key || !calendarId) return null;
  return { email, key: key.replace(/\\n/g, "\n"), calendarId };
}

const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
let cached = null; // { email, token, exp }

/** Signed JWT assertion for the service account (exported for tests). */
export function signAssertion(cfg, nowSec) {
  const head = b64url({ alg: "RS256", typ: "JWT" });
  const claims = b64url({ iss: cfg.email, scope: "https://www.googleapis.com/auth/calendar", aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 });
  const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(cfg.key).toString("base64url");
  return `${head}.${claims}.${sig}`;
}

async function accessToken(cfg, { fetchImpl = fetch, now = new Date() } = {}) {
  const sec = Math.floor(now.getTime() / 1000);
  if (cached && cached.email === cfg.email && cached.exp - 60 > sec) return cached.token;
  let assertion;
  try { assertion = signAssertion(cfg, sec); } catch (e) { throw new CalendarError("GOOGLE_PRIVATE_KEY could not be read: " + e.message, { kind: "config" }); }
  const r = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new CalendarError(`Google sign-in failed (${r.status}): ${d.error_description || d.error || "unknown"}`, { kind: "config", status: r.status });
  cached = { email: cfg.email, token: d.access_token, exp: sec + Number(d.expires_in || 3600) };
  return cached.token;
}
export const _resetTokenCache = () => { cached = null; };

async function gcal(cfg, path, body, opts) {
  const token = await accessToken(cfg, opts);
  const r = await (opts?.fetchImpl || fetch)(API + path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new CalendarError(`Google Calendar error (${r.status}): ${d.error?.message || "unknown"}`, { kind: r.status === 403 || r.status === 404 ? "config" : "error", status: r.status });
  return d;
}

/** Busy periods [{start, end}] (Date objects) between two instants. */
export async function busy(cfg, from, to, opts = {}) {
  const d = await gcal(cfg, "/freeBusy", { timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: TZ, items: [{ id: cfg.calendarId }] }, opts);
  const cal = d.calendars?.[cfg.calendarId];
  if (!cal || cal.errors?.length) throw new CalendarError("Calendar not accessible: " + (cal?.errors?.[0]?.reason || "not found") + ". Share it with the service account.", { kind: "config" });
  return (cal.busy || []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

const overlaps = (a0, a1, list) => list.some((b) => a0 < b.end && b.start < a1);
const fmt = (d, lang) => new Intl.DateTimeFormat(lang === "en" ? "en-MY" : "ms-MY", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(d);
const slotId = (d) => { const p = new Date(d.getTime() + 8 * 3600e3).toISOString(); return p.slice(0, 16); }; // Malaysian local "YYYY-MM-DDTHH:MM"

/**
 * Free appointment slots inside business hours, spread across days (at most 2 per day).
 * @param o { hours, appointments: { duration_minutes, min_notice_hours, days_ahead, max_slots_offered }, busy, now }
 */
export function freeSlots({ hours, appointments = {}, busy: busyList = [], now }) {
  const dur = Math.max(15, Number(appointments.duration_minutes || 60));
  const earliest = new Date(now.getTime() + Math.max(0, Number(appointments.min_notice_hours ?? 3)) * 3600e3);
  const days = Math.min(30, Math.max(1, Number(appointments.days_ahead || 7)));
  const max = Math.min(12, Math.max(1, Number(appointments.max_slots_offered || 6)));
  const p = myParts(now), out = [];
  for (let i = 0; i <= days && out.length < max; i++) {
    const d = myParts(myInstant(p.y, p.mo, p.day + i, 12 * 60)), h = dayHours(hours, d.dow);
    if (!h) continue;
    let perDay = 0;
    for (let m = h[0]; m + dur <= h[1] && perDay < 2 && out.length < max; m += dur) {
      const start = myInstant(d.y, d.mo, d.day, m), end = new Date(start.getTime() + dur * 60e3);
      if (start < earliest || overlaps(start, end, busyList)) continue;
      out.push({ id: slotId(start), start: start.toISOString(), end: end.toISOString(), label_ms: fmt(start, "ms"), label_en: fmt(start, "en") });
      perDay++;
      m += dur; // leave a gap so the two slots of a day are not back to back
    }
  }
  return out;
}

/** Re-checks that the slot is still free, then creates the event. Throws CalendarError kind "taken" if it is not. */
export async function bookSlot(cfg, { start, end, summary, description, location }, opts = {}) {
  const s = new Date(start), e = new Date(end);
  const b = await busy(cfg, s, e, opts);
  if (overlaps(s, e, b)) throw new CalendarError("That time is no longer free on the calendar.", { kind: "taken" });
  const ev = await gcal(cfg, `/calendars/${encodeURIComponent(cfg.calendarId)}/events`, {
    summary: String(summary || "Appointment").slice(0, 200), description: String(description || "").slice(0, 4000), location: location || undefined,
    start: { dateTime: s.toISOString(), timeZone: TZ }, end: { dateTime: e.toISOString(), timeZone: TZ },
  }, opts);
  if (!ev.id) throw new CalendarError("Google Calendar returned no event id");
  return ev.id;
}

export const KIND_LABEL = {
  ms: { showroom_visit: "Lawatan showroom", property_viewing: "Lawatan hartanah", phone_call: "Panggilan telefon", video_call: "Panggilan video", financing_discussion: "Perbincangan pembiayaan" },
  en: { showroom_visit: "Showroom visit", property_viewing: "Property viewing", phone_call: "Phone call", video_call: "Video call", financing_discussion: "Financing discussion" },
};
const pin = (map) => (map ? `\n📍 ${map}` : "");
/** The fixed confirmation sent to the buyer only after the calendar event exists. `map` adds a map link line. */
export function confirmationText({ kind, start, location, map = "", lang }) {
  const L = lang === "en" ? "en" : "ms", what = KIND_LABEL[L][kind] || KIND_LABEL[L].showroom_visit, when = fmt(new Date(start), L);
  return (L === "en"
    ? `✅ Your appointment is confirmed: ${what} on ${when}${location ? ` at ${location}` : ""}. Reply to this message if you need to change the time.`
    : `✅ Temujanji anda telah disahkan: ${what} pada ${when}${location ? ` di ${location}` : ""}. Balas mesej ini jika perlu menukar masa.`) + pin(map);
}
export function reminderText({ kind, start, location, map = "", lang }) {
  const L = lang === "en" ? "en" : "ms", what = KIND_LABEL[L][kind] || KIND_LABEL[L].showroom_visit, when = fmt(new Date(start), L);
  return (L === "en"
    ? `Reminder: your ${what.toLowerCase()} is on ${when}${location ? ` at ${location}` : ""}. Reply to this message if you need to change the time.`
    : `Peringatan: ${what.toLowerCase()} anda pada ${when}${location ? ` di ${location}` : ""}. Balas mesej ini jika perlu menukar masa.`) + pin(map);
}

const IN_PERSON = new Set(["showroom_visit", "property_viewing"]);
/**
 * Where an appointment takes place: for a showroom visit or viewing, the project's showroom address and map link
 * (Property projects → Verified facts), else the default location from Settings. Calls have no place.
 */
export async function placeFor(db, appt, settings) {
  if (!IN_PERSON.has(appt.kind)) return { location: "", map: "" };
  const f = appt.project_id ? (await db.get(`ai_project_facts?project_id=eq.${encodeURIComponent(appt.project_id)}&select=showroom_address,showroom_map_url`))?.[0] : null;
  if (f?.showroom_address) return { location: f.showroom_address, map: f.showroom_map_url || "" };
  return { location: settings.business?.appointments?.location || "", map: "" };
}
