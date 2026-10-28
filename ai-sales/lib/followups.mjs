// Follow-up rules: business hours (Malaysia time), consent, the WhatsApp 24-hour window and the weekly marketing cap.
// Pure functions only, so every rule is unit-tested without a database or WhatsApp.
import { inWindow } from "./whatsapp.mjs";

const MY_OFFSET_MS = 8 * 3600 * 1000; // Malaysia has no daylight saving: always UTC+8
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const toMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** Malaysian wall-clock parts of a UTC instant. */
export function myParts(d) {
  const l = new Date(d.getTime() + MY_OFFSET_MS);
  return { y: l.getUTCFullYear(), mo: l.getUTCMonth(), day: l.getUTCDate(), dow: l.getUTCDay(), min: l.getUTCHours() * 60 + l.getUTCMinutes() };
}
/** UTC instant for a Malaysian date (y, mo, day) and minute of the day. */
export const myInstant = (y, mo, day, min) => new Date(Date.UTC(y, mo, day, 0, min) - MY_OFFSET_MS);

/** Opening hours of a Malaysian day as [openMin, closeMin], or null when closed. */
export function dayHours(hours, dow) {
  const h = (hours || {})[DAYS[dow]];
  if (!Array.isArray(h) || h.length < 2) return null;
  const o = toMin(h[0]), c = toMin(h[1]);
  return o !== null && c !== null && c > o ? [o, c] : null;
}

export function isOpen(hours, now) {
  const p = myParts(now), h = dayHours(hours, p.dow);
  return !!h && p.min >= h[0] && p.min < h[1];
}

/** The next moment the business is open (now if open), looking up to 14 days ahead; null if never open. */
export function nextOpening(hours, now) {
  if (isOpen(hours, now)) return now;
  const p = myParts(now);
  for (let i = 0; i <= 14; i++) {
    const d = myParts(myInstant(p.y, p.mo, p.day + i, 12 * 60)), h = dayHours(hours, d.dow);
    if (!h) continue;
    const open = myInstant(d.y, d.mo, d.day, h[0]);
    if (open > now) return open;
  }
  return null;
}

/** Latest consent per channel/purpose from ai_consent_current rows. WhatsApp-specific rows win over "any". */
export function consentState(rows = []) {
  const pick = (purpose) => {
    const own = rows.find((r) => r.purpose === purpose && r.channel === "whatsapp");
    return (own || rows.find((r) => r.purpose === purpose && r.channel === "any"))?.status || null;
  };
  return { service: pick("service"), marketing: pick("marketing") };
}

/**
 * Decides what to do with a due follow-up step.
 * @returns {{ action: "send_ai"|"send_template"|"skip"|"cancel"|"defer", reason?: string, runAt?: Date, template?: object }}
 *   skip = this step is not sent but the sequence continues; cancel = the sequence stops for this lead.
 */
export function decideFollowUp({ step, lead, conversation, consent, marketingSentThisWeek = 0, settings = {}, templates = [], now }) {
  if (!lead || lead.closed_at) return { action: "cancel", reason: "lead closed" };
  if (!conversation || !(conversation.contact?.wa_id || conversation.contact?.phone_e164)) return { action: "cancel", reason: "no WhatsApp conversation for this buyer" };
  if (consent.service === "withdrawn") return { action: "cancel", reason: "buyer opted out" };
  // automated messages never interrupt a conversation a person has taken over
  if (lead.ai_paused || conversation.mode !== "ai") return { action: "cancel", reason: "a human is handling this buyer" };
  if (step.purpose === "marketing") {
    if (consent.marketing !== "granted") return { action: "skip", reason: "no marketing consent" };
    const cap = Number(settings.business?.max_marketing_messages_per_week ?? 2);
    if (marketingSentThisWeek >= cap) return { action: "skip", reason: `weekly marketing limit (${cap}) reached` };
  }
  if (!isOpen(settings.business?.hours, now)) {
    const at = nextOpening(settings.business?.hours, now);
    return at ? { action: "defer", reason: "outside business hours", runAt: at } : { action: "skip", reason: "no business hours configured" };
  }
  if (inWindow(conversation.last_inbound_at, now)) return { action: "send_ai" };
  const lang = conversation.lang || (conversation.contact?.preferred_language === "en" ? "en" : "ms");
  const ok = templates.filter((t) => t.active && t.wa_status === "approved" && t.wa_template_name && t.name === step.template);
  const tpl = ok.find((t) => t.lang === lang) || ok[0];
  if (tpl) return { action: "send_template", template: tpl };
  return { action: "skip", reason: step.template ? `template "${step.template}" is not approved by WhatsApp yet` : "more than 24 hours since the buyer's last message and this step has no approved template" };
}

/** Fills {{1}}, {{2}}… in a template body. */
export const renderTemplate = (body, params = []) => String(body || "").replace(/\{\{(\d+)\}\}/g, (_, n) => String(params[Number(n) - 1] ?? ""));

/** Template parameters from the template's declared variables (name, project, …). */
export function templateParams(tpl, { name, project, appointment, location } = {}) {
  const vars = Array.isArray(tpl?.variables) ? tpl.variables : [];
  const lang = tpl?.lang === "en" ? "en" : "ms";
  const fallback = { name: lang === "en" ? "there" : "tuan/puan", project: lang === "en" ? "our projects" : "projek kami",
    location: lang === "en" ? "the place our advisor will confirm" : "lokasi yang akan disahkan oleh penasihat kami" };
  return vars.map((v) => ({ name: name || fallback.name, project: project || fallback.project, appointment: appointment || "", location: location || fallback.location })[v] ?? "");
}
