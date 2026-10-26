# Phase 4 report — WhatsApp, follow-up engine and Google Calendar (2026-10-27)

Everything in this phase is **off by default**. Nothing reaches a buyer until you add the credentials and turn each part on in `/sales/` → Settings → Feature switches. The public website, its pages, SEO, sitemap, enquiry form and admin are unchanged (regression suite 40/40).

## 1. What was built
**WhatsApp Business Platform (official Meta Cloud API only)**
- Webhook `/api/sales/whatsapp/webhook`: Meta's verification handshake; every event's `X-Hub-Signature-256` is checked against the app secret (unsigned or tampered requests are rejected and nothing is stored); events for other phone numbers are ignored.
- Each incoming message creates or updates, in one database transaction: contact → open lead (source "WhatsApp (direct)") → conversation → message → reply job. Redelivered webhooks (same message id) change nothing.
- Delivery statuses (sent / delivered / read / failed with Meta's reason) are recorded on each message and only move forward.
- Sending: free text only within 24 hours of the buyer's last message; after that only templates approved by Meta (Meta's own "outside the window" refusal is recognised too).

**Live AI replies** (when *AI auto-reply* and *WhatsApp sending* are on)
- The same pipeline as the test console (guards → verified context → Claude → business-rule checker → decision), now applied for real: reply sent, CRM updated (qualification, score, interests, handover, consent), run logged.
- Several quick messages are answered together, once; messages sent in the same second are handled consistently.
- A retried job never sends twice and never calls the AI again (the reply row is keyed to the job).
- Voice notes, images and other media: polite holding reply and a handover (the AI does not guess what they contain).
- STOP is honoured at once, even while a person is handling the chat: consent withdrawn, follow-ups cancelled, AI paused, one confirmation sent.
- AI off, or a person has taken over: no AI reply; staff get a Telegram alert (at most one per chat per hour).
- Daily AI cap from Phase 3 applies to every live reply and follow-up.

**Follow-up engine**
- After each AI reply the active sequence for the situation starts ("new enquiry", or "appointment pending" when a request is open). The buyer's next message cancels it; so do opt-out, a person taking over, a confirmed appointment and lead closure.
- Each step: sent only in business hours (otherwise moved to the next opening); marketing steps need recorded marketing consent and respect the weekly cap; inside the 24-hour window the AI writes the step from its instruction and the business-rule checker must pass; outside the window only the step's approved template is sent, otherwise the step is skipped with the reason recorded.
- While *Automated follow-ups* is off, due steps keep being announced to staff on Telegram (Phase 2 behaviour).

**Google Calendar** (service account; key in Netlify or Supabase Vault)
- Free slots are calculated from the calendar's busy times inside your business hours (length, minimum notice, days ahead, at most two a day).
- With *Calendar booking* on, the AI offers those slots. When the buyer clearly picks one, the slot is re-checked and the event is created; only then does the buyer get the fixed confirmation message. A slot taken in the meantime stays pending, the buyer gets an apology, and an advisor is alerted. The AI cannot book a time it did not offer.
- Staff can confirm any pending request from Appointments → *Confirm…* (with "Show free calendar slots"); the event is created when the calendar is connected and the buyer can be messaged.
- Buyer reminder on WhatsApp about 24 hours before a confirmed appointment (not straight after booking), plus the existing staff Telegram reminders.

**Dashboard**
- WhatsApp inbox: conversations, full thread with delivery ticks and failure reasons, reply as staff (optionally pausing the AI), *Take over* / *Hand back to AI*, template sending after 24 hours. Works on phone, iPad and desktop.
- Appointments: *Confirm…* dialog. Follow-ups: template per step. Templates: variables. Settings: appointment rules, alerts for handovers and unanswered WhatsApp messages. Integrations: webhook URL and calendar instructions.
- Telegram: new alert when a buyer needs a person.

## 2. Files and database
New: `ai-sales/lib/{whatsapp,followups,calendar,worker,live}.mjs`; functions `sales-whatsapp-webhook`, `sales-whatsapp-send`, `sales-appointments`, `sales-worker` (scheduled every 2 minutes); migration `20261027000006_ai_sales_whatsapp_followups_calendar.sql` and `APPLY-PHASE-4-IN-SQL-EDITOR.sql`; tests `phase4.test.mjs`, `phase4-functions.test.mjs`, `helpers/memdb.mjs`.
Changed (AI module only): `prompt.mjs`, `orchestrator.mjs`, `context.mjs`, `sales-health.mjs`, `sales/js/{crm,admin,app}.js`, `sales/app.css`, docs, `.env.example`.
Database (additive): functions `ai_wa_inbound`, `ai_wa_status`, `ai_follow_up_start`, `ai_claim_follow_ups`, `ai_vault_secret` (server only); triggers that stop follow-ups on a confirmed appointment and alert on handovers; columns `ai_messages.purpose` and `source_job_id`; follow-up status "processing"; settings defaults (existing values kept). **Not yet applied to the live database.**

## 3. Tests (actual results)
| Suite | Result |
|---|---|
| Existing-website regression | 40 / 40 |
| Unit (incl. 42 new — 33 Phase 4 tests plus syntax checks for the 9 new files: webhook signature/parsing, 24-hour window, sending shapes and errors, business hours, every follow-up rule, free slots, service-account signing, booking re-check, Vault key, the worker end-to-end with an in-memory database, the four new endpoints) | 103 / 103 |
| Database (incl. T32–T39: inbound idempotency, permissions, status ordering, follow-up start/claim/cancel, appointment stop, handover alert, settings, Vault reader) | 39 / 39 |
| Browser (incl. inbox thread and reply, phone layout and 24-hour rule, appointment confirmation) | 14 / 14 |
| Combined SQL files on throwaway databases (fresh install; live-style upgrade; second run refused without changes) | Pass |

Bugs found by the new tests and fixed before release: a reminder would have followed a same-day booking confirmation immediately; two messages sent in the same second could both be treated as "not the newest" and get no reply; a calendar error would have told the AI there were no free times instead of falling back to collecting a preferred time.

## 4. Not tested yet / limits
- No real WhatsApp, Meta or Google account was used: those calls are tested against the documented request/response formats. The first real check is your own test message after setup (03-SETUP.md §7).
- Rescheduling or cancelling an appointment that is already on Google Calendar is done in Google Calendar for now (Phase 5).
- Inbox updates when you open or reload a chat (no live push yet — Phase 5).
- Graph API version defaults to v23.0 (`WHATSAPP_API_VERSION` to change).

## 5. Needed from you
1. Apply `ai-sales/supabase/APPLY-PHASE-4-IN-SQL-EDITOR.sql` (or let me apply it).
2. `SUPABASE_SERVICE_ROLE_KEY` in Netlify (now required).
3. WhatsApp: Meta Business account and a phone number for the API (see §7b about numbers already on the WhatsApp Business app), then the steps in 03-SETUP.md §7b; templates `appointment_reminder` / `appointment_confirmation` submitted to Meta.
4. Google Calendar: which calendar holds showroom/advisor availability, a service account shared on it (§7d).
5. Business rules: confirm showroom hours, appointment length and default location, and which follow-up sequences to activate.

## 6. Next phase
Phase 5 — inbox live updates and assignment, follow-up sequence editor improvements, calendar view with reschedule/cancel synced to Google, reports and campaign attribution.
