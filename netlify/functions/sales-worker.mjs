// AI Sales — scheduled worker (every 2 minutes): unanswered WhatsApp messages, due follow-ups, buyer reminders.
// Inert unless AI_SALES_ENABLED is "true" and SUPABASE_SERVICE_ROLE_KEY is set; each part also has its own switch in Settings.
import { moduleEnabled } from "../../ai-sales/lib/server.mjs";
import { liveDeps } from "../../ai-sales/lib/live.mjs";
import { runWorker } from "../../ai-sales/lib/worker.mjs";

export default async () => {
  if (!moduleEnabled()) return new Response("off");
  const deps = liveDeps();
  // the scheduled run has a 30-second limit: Google Maps lookups yes, a web research round no (the AI hands over instead)
  if (deps.research) deps.research.web = false;
  if (!deps.db) return new Response("no service key");
  const r = await runWorker(deps);
  if (r.errors.length) console.error("worker errors:", r.errors.slice(0, 5).join(" | "));
  return new Response(JSON.stringify(r));
};

export const config = { schedule: "*/2 * * * *" };
