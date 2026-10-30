// Wires the worker to the real services from Netlify environment variables. Anything not configured is null,
// and the worker then skips that part (no WhatsApp → nothing is sent; no calendar → no booking).
import { env, serviceDb } from "./server.mjs";
import { callClaude, researchClaude } from "./llm.mjs";
import { mapsService } from "./maps.mjs";
import { waConfig, sendWhatsApp } from "./whatsapp.mjs";
import { calConfig, busy, freeSlots, bookSlot, cancelEvent, CalendarError } from "./calendar.mjs";
import { docStorage } from "./documents.mjs";

/**
 * Calendar service, or null when the calendar is not configured. The private key comes from GOOGLE_PRIVATE_KEY,
 * or else from Supabase Vault (secret "google_private_key"), read once on first use.
 */
export function calendarService(db, cfg = calConfig(env)) {
  const email = env("GOOGLE_SERVICE_ACCOUNT_EMAIL"), calendarId = env("GOOGLE_CALENDAR_ID");
  if (!cfg && !(email && calendarId && db)) return null;
  let ready = cfg ? Promise.resolve(cfg) : null;
  const config = () => (ready ||= db.rpc("ai_vault_secret", { p_name: "google_private_key" }).then((key) => {
    if (!key) throw new CalendarError("Google private key not found: set GOOGLE_PRIVATE_KEY in Netlify or google_private_key in Supabase Vault.", { kind: "config" });
    return { email, calendarId, key: String(key).replace(/\\n/g, "\n") };
  }).catch((e) => { ready = null; throw e; }));
  return {
    async slots(settings, now) {
      const c = await config(), a = settings.business?.appointments || {};
      const until = new Date(now.getTime() + (Math.min(30, Number(a.days_ahead || 7)) + 1) * 864e5);
      return freeSlots({ hours: settings.business?.hours, appointments: a, busy: await busy(c, now, until), now });
    },
    book: async (details) => bookSlot(await config(), details),
    cancel: async (eventId) => cancelEvent(await config(), eventId),
  };
}

export function liveDeps() {
  const wa = waConfig(env), db = serviceDb();
  return {
    db,
    llm: (p) => callClaude(p),
    wa: wa ? { send: (to, msg) => sendWhatsApp(wa, to, msg) } : null,
    cal: calendarService(db),
    research: researchDeps(db),
    storage: db ? docStorage() : null,
    knowledgeFiles: db ? docStorage(undefined, "ai-docs") : null,   // files staff marked shareable (Knowledge → Documents)
    now: () => new Date(),
  };
}

/**
 * Research tools for the AI: Google Maps (when GOOGLE_MAPS_API_KEY is set; results cached through the service-role
 * database) and Claude web search (needs web search allowed for the organisation in the Claude Console).
 */
export function researchDeps(db, { web = true } = {}) {
  const key = env("GOOGLE_MAPS_API_KEY");
  // web research may take up to 20 s; whether it fits is decided per request from its time budget (Netlify stops a
  // request at 30 s): the test console runs it as a separate step, the WhatsApp worker does not run it
  return { maps: mapsService({ key, db }), research: (q) => researchClaude(q), web, webStartWithinMs: 18000, webTimeoutMs: 20000 };
}
