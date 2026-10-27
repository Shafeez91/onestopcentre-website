# Telegram: three alert types only (2026-10-27)

## Rule
Every Telegram message goes through one database function, `public.ai_send_telegram()`. It sends only these categories:

| Category | Sent for |
|---|---|
| `new_website_lead` | A website enquiry that opens a **new** CRM lead. |
| `human_followup_reminder` | A buyer needs a person: an AI or staff handover (once while it waits), no reply from a person after the set time, a follow-up task or step due, a reply that could not be delivered (once per buyer per day), the daily AI limit, and the daily digest. |
| `appointment_notification` | An appointment booked, confirmed, rescheduled, cancelled or a no-show, and the reminders before it. |

- **Anything else is refused.** That includes the old per-WhatsApp-message kind and any unknown kind. The refusal is logged as `skipped` with "blocked: not one of the Telegram categories", so a legacy trigger, worker, retry or future code cannot get round it.
- Each category has its own switch in **Settings → Telegram notifications**. All three are on by default.
- **Duplicates:** every message has a unique key, so a retried event cannot send twice.

## Old triggers: what happened to each
| Old trigger | Where | Now |
|---|---|---|
| "New WhatsApp message" when a person handles the chat or AI replies are off (hourly per chat) | `worker.mjs` | Removed. A person is reminded only if nobody answers in time (`human_reminder` job). |
| "AI draft (not sent)" when WhatsApp sending is off | `worker.mjs` | Removed. |
| "The AI reply could not be sent" (once per message) | `worker.mjs` | Now a follow-up reminder, once per buyer per day. |
| "Could not be answered after N tries" | `worker.mjs` | Now a follow-up reminder, once per buyer per day (same key). |
| "Buyer needs a person" (once per handover, so once per message when the AI kept handing over) | `ai_handover_notify` | Once per buyer while a handover is open. A person replying marks open handovers *accepted*, so the next request alerts again. |
| Website enquiry alert, `leads_notify` → `notify_new_lead` | the website's own trigger | Replaced by `ai_leads_website_notify` (see below). The old function is kept for rollback. |
| `ai_send_telegram` kinds `whatsapp_message` / unknown | the database | Blocked. |

## Website leads
When the enquiry form is submitted, the enquiry is filed in the CRM immediately (the same rules as the Import button, which then skips it).
- **If that opens a new lead:** one alert with name, phone, email, project, message, source, time, the lead code, a link to the lead and a wa.me link.
- **If the person already has an open lead:** the enquiry is added to that lead (a double submit, or another project) and no "new lead" alert is sent. The CRM keeps one open lead per person.
- **If their earlier lead was closed:** a new lead is opened, and an alert is sent.
- **Updates to an enquiry** never alert.
- **If filing fails** (e.g. no phone or email): the alert is still sent, with a dashboard link.
- **Rollback**, back to the old website alert: `drop trigger ai_leads_website_notify on public.leads; create trigger leads_notify after insert on public.leads for each row execute function notify_new_lead();`

## Appointments
Alerts and reminders now also include the showroom map link.

## Files
- `ai-sales/supabase/migrations/20261027000010_ai_sales_telegram_categories.sql`, plus `APPLY-TELEGRAM-RULES-IN-SQL-EDITOR.sql`
- `ai-sales/lib/worker.mjs`, `ai-sales/lib/automation.mjs` (`alertHumanAbout`)
- `sales/js/admin.js` (Telegram settings: the three switches; the per-message option removed)
- tests: `ai-sales/tests/db/01-existing-schema.sql` (now includes the website's alert trigger), `10-tests.sql` T48–T52, `ai-sales/tests/unit/phase4.test.mjs`, `ai-sales/tests/e2e/*`

## Tests (all passing: regression 40, unit 153, database T01–T52, browser 22 + layout 12)
1. Existing, new and repeat WhatsApp buyers, redelivered webhooks, an image, AI replies and qualification updates: no Telegram (T49, plus the unit tests).
2. A legacy call with kind `whatsapp_message`, or an unknown kind: blocked and logged (T48).
3. A new website lead: one alert with a lead link, and the old website alert no longer fires (T50).
4. A second enquiry from the same person, an update to an enquiry, or the import run later: no new alert (T50).
5. A closed lead enquiring again: a new alert. A category switched off: nothing (T48, T50).
6. Three handovers for one buyer: one alert. A person replies, then a new request: alerted (T51).
7. A reply that cannot be delivered twice: one reminder (unit test).
8. Appointment alerts and reminders: existing T21–T23, plus the map link (T52).
9. Follow-up reminders when due, and cancelled when a person replies: T24, T37, plus the unit tests from the previous change.
10. Settings: the three switches save, and the old option is gone (browser test).

**Not verified here:** real delivery to your Telegram chat. Run *Send test message* after this is applied, then submit one website enquiry.
