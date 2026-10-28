# Telegram: follow-up means a real follow-up task (2026-10-28)

## Problem
An existing buyer (Izalynn, OSC-000035) sent ordinary messages in a chat a person had taken over, and Telegram sent "🔔 Follow-up needed — the buyer is waiting for your reply". Over two days Telegram also carried 33 "Follow-up needed — <reason>" alerts from AI hand-overs, mostly ordinary questions from existing buyers.

## Root causes
1. **Reply reminders.** The database trigger `ai_message_automation` scheduled a `human_reminder` job for **every** buyer message in a chat handled by a person (or with AI replies off). One hour later, `humanReminder()` sent "the buyer is waiting for your reply". That is a buyer waiting, not a follow-up task.
2. **Hand-over alerts.** `ai_handover_notify` sent a Telegram for **every** AI hand-over (once per buyer while waiting), including "the AI was unsure", which happens for routine questions.
3. **Direct alerts.** Other "Follow-up needed" alerts were sent straight from code (`alertHuman`): automatic follow-up not sendable, appointment message not sendable, reply not delivered. None of them had a task anyone could complete or cancel.

## Rule now
Telegram carries only:

| Category | Kinds | Sent when |
|---|---|---|
| 1 · New clients | `website_lead`, `new_whatsapp_client` | A website enquiry opens a new lead, or a new number's first WhatsApp message creates the client (unchanged; migrations 10 and 11). |
| 2 · Follow-up tasks | `task_reminder` (+ `follow_up_due` for sequence steps to send by hand while automatic sending is off; `ai_cap`; `daily_digest`) | A follow-up **task** (`ai_tasks`) is due. Staff create tasks on the lead; the system opens one only when a person must act. |
| 3 · Appointments | `appointment_change`, `appointment_reminder` | Booked, confirmed, rescheduled, cancelled, no-show, and reminders (unchanged). |

**Tasks the system opens** (`ai_open_human_task`), announced once at creation:
- **A hand-over a person must handle:** the buyer asked for a person, ready to buy, negotiation, legal, complaint, financing, sensitive. Hand-overs because the AI was unsure, conflicting data or "other" wait in the hand-over queue without Telegram.
- **The 12-hour automatic follow-up could not be sent,** e.g. after 24 hours with no approved template.
- **An appointment confirmation or reminder could not be sent** on WhatsApp.
- **The AI's reply could not be delivered,** once per buyer per day.

**Never on Telegram:**
- a buyer's message (AI or person handling the chat)
- a buyer waiting for a reply
- AI replies
- repeat or redelivered messages
- lead updates
- an existing buyer asking about another project

## Duplicate prevention
- **Category gate:** `ai_send_telegram` refuses any kind outside the categories (logged as `skipped`, `blocked:<key>`). `handover` is now refused.
- **One alert per event:** each notification has a unique `dedupe_key`.
  - A task alert uses `task:<id>:<due epoch>`, the same key as the 5-minute reminder run, so it goes out once.
  - New clients: `website-lead:` / `wa-new-client:<contact>`.
  - Appointments: `appt-change:<id>:<status>:<time>`, `appt-rem:<id>:<minutes>`.
- **One open task per cause:**
  - `ai_tasks.source_key` is unique, keyed `<cause>:<event>` (e.g. `handover:<handover id>`, `undelivered:<conversation>:<day>`).
  - While a task of the same cause is open for a buyer, no second one is opened.
  - Webhook redeliveries reuse the WhatsApp message id, so they create nothing new.
- **Completion:**
  - A person replying to the buyer marks that buyer's open **system** tasks done; tasks staff created are left alone.
  - Done or cancelled tasks are never announced (the reminder run only reads open tasks).

## Changes
- `ai-sales/supabase/migrations/20261028000013_ai_sales_followup_tasks_only.sql` (+ `APPLY-FOLLOWUP-TASKS-IN-SQL-EDITOR.sql`):
  - `ai_tasks.source_key`
  - `ai_task_alert()` and `ai_open_human_task()`
  - category map without `handover`
  - new `ai_handover_notify`
  - `ai_message_accept_handovers` completes system tasks
  - `ai_message_automation` no longer creates `human_reminder` jobs; scheduled ones are cancelled
- `ai-sales/lib/automation.mjs`:
  - `openHumanTask` / `openHumanTaskAbout` replace `alertHuman` / `alertHumanAbout`
  - `humanReminder` closes old jobs without Telegram
- `ai-sales/lib/worker.mjs`: an undelivered reply or a dead job opens a task.
- `sales/js/automation.js` and `sales/js/admin.js`: the switches now describe follow-up tasks; the "remind me after N minutes" field is gone.

## Tests
- **Database:**
  - T37: hand-overs, task or queue
  - T43: no reply reminder; a person replying completes system tasks, not staff tasks
  - T55: the Izalynn case sends nothing; legacy kind refused; task announced once; same cause not repeated; appointment and task each alert once
  - T50, T53: new clients (unchanged)
  - T21–T23, T45: appointments (unchanged)
- **Unit:**
  - undelivered reply → one task
  - follow-up not sendable → task
  - old reply-reminder job closed without Telegram
