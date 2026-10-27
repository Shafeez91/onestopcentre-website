# Human takeover, 12-hour follow-up & appointment reminders (2026-10-27)

## 1. What changed for you
- **The AI answers every buyer message, not only the first, until a person replies.** It replies to the latest messages (several quick messages are answered together, once) using the conversation history and CRM context.
- **When you reply, the chat becomes yours.** This applies to a reply from the inbox or from the WhatsApp Business app on your phone. From that moment:
  - the AI sends nothing more in that chat: no reply and no follow-up
  - anything the AI had prepared or queued is cancelled
  - nothing hands the chat back automatically, not the buyer writing again and not time passing
- **Resume AI** (in the inbox) is the only way back. It:
  - resolves the open handovers
  - drops stale queued work
  - lets the AI answer the buyer's *next* message
- **12-hour follow-up.** If the buyer has gone quiet for 12 hours (configurable) and nobody followed up, the AI sends **one** short check-in about what they actually asked.
- **Telegram is now only for:**
  - a buyer waiting for a person
  - a follow-up or reminder that could not be sent automatically
  - appointments: changes and the reminder schedule
  - "buyer asks for a person / AI hands over"

  Routine message alerts are switched off (16 were sent in the last 3 days).
- **Appointments.** The buyer gets a WhatsApp confirmation once the appointment is confirmed, plus reminders 24 h and 2 h before (configurable).

## 2. Files
| File | What |
|---|---|
| `ai-sales/supabase/migrations/20261027000009_ai_sales_ownership_automation.sql` (new) | The database change (section 3). |
| `ai-sales/lib/automation.mjs` (new) | Runs the four job types and records every check. |
| `ai-sales/lib/outbound.mjs` (new) | `sendOutbound`, moved from `worker.mjs` and re-exported from it. It now checks, just before sending, that the AI still owns the conversation. |
| `ai-sales/lib/worker.mjs` | Runs automation jobs every 2 minutes, replacing the old 24-hour reminder scan. Routine Telegram alerts are only sent if switched on. STOP / "talk to a person" replies are sent as system messages. AI-booked confirmations go through their job. |
| `ai-sales/lib/calendar.mjs` | Confirmations and reminders show the project; reminders ask "masih boleh datang?" until the buyer confirms they are coming. |
| `ai-sales/lib/orchestrator.mjs` | Opt-out and handover also cancel the 12-hour follow-up. |
| `netlify/functions/sales-whatsapp-send.mjs` | Every staff reply takes over the chat. |
| `netlify/functions/sales-appointments.mjs` | Staff confirmation sends through the confirmation job, or cancels it if "notify buyer" is off. It is sent as a system message, so it does not count as a takeover. |
| `sales/js/crm.js` | Inbox: ownership badge, who took over and when, **Take over** / **Resume AI** (asks to confirm), per-buyer **Automatic follow-up** and **Appointment reminders** switches. Lead page: a per-appointment WhatsApp-reminders switch, and "buyer confirmed they are coming". |
| `sales/js/automation.js` (new), `sales/js/admin.js` | Follow-up automation page: all the settings from your brief, plus the list of every automation job with its status and checks, filters and **Cancel**. |
| `sales/app.css` | Inbox styles. Switch rows now sit beside their label, which also fixes the Feature switches page. |

## 3. Database (migration 9, additive)
- **`ai_settings.automation`**: follow-up on/off, delay, template, confirmations, reminders and their times, staff reminders and their delay. `notifications.whatsapp_alerts` is set to off.
- **`ai_conversations`**:
  - `human_takeover_at`, `takeover_by`, `ai_resumed_at`, `last_human_reply_at`, `last_follow_up_at`
  - `automation` (per-buyer switches)
  - Existing rows are backfilled from the message history.
- **`ai_appointments`**: `wa_reminders` (per appointment) and `attendance_confirmed_at`.
- **`ai_automation_jobs`** (new): one row per scheduled follow-up, staff reminder, confirmation or reminder. Each row has:
  - when it runs, its status, why it was skipped or cancelled, and each check it made
  - the message it sent
  - a unique key, so the same event is never scheduled twice

  Viewers and above can read it. Only the server and the triggers write to it; staff cancel through a function.
- **Triggers:**
  - *Buyer message:* restarts the follow-up timer and (if a person must answer) the staff reminder. Records "ok / ya / jumpa" after a reminder as attendance confirmed.
  - *Person's message* (inbox or phone app): takeover, which pauses the AI and cancels its queued replies, its follow-ups and the staff reminder. If the message is itself a visit reminder, the next automatic reminder is cancelled.
  - *Appointment change:* confirmed → confirmation + reminders. Rescheduled → old ones cancelled, new ones scheduled. Cancelled or switched off → all cancelled. A reminder due within an hour of booking is not scheduled; the confirmation covers it.
- **Functions:** `ai_take_over`, `ai_resume_ai` (advisor and above, audited), `ai_cancel_automation_job`, `ai_claim_automation_jobs` (server only, `SKIP LOCKED`).
- **Backfill:** reminders are created for confirmed appointments that are still ahead. A 24-hour reminder already sent is not repeated.

## 4. Scheduling
- Jobs are rows in the database. The scheduled Netlify worker (every 2 minutes) claims due jobs with `SKIP LOCKED`, so two workers never get the same job.
- A job left in "processing" by a crash is retried after 10 minutes. A failed send is retried (5 attempts) without sending twice: the message row is unique per job, and a retried follow-up re-sends the same text without calling the AI again.
- No browser timers are involved. Jobs survive restarts and redeploys.
- A job that could not run on time is dropped ("too late to send") instead of being sent late in a burst. The limit is 6 h late for a follow-up, 12 h for a staff reminder, 3 h for an appointment reminder and 24 h for a confirmation.

## 5. How human takeover is enforced
1. **At the database:** the message a person sends is recorded *before* it goes to WhatsApp. The trigger switches the conversation to the person in that same transaction and cancels the AI's queued reply jobs and scheduled follow-ups.
2. **At job start:** the AI reply job only runs while the conversation is the AI's.
3. **Just before sending:** every AI-written message (reply or follow-up) re-reads the owner immediately before calling WhatsApp. If a person took over while the AI was writing, the message is stored as *skipped* ("a person took over before it was sent") and never sent, even by a retry.
4. **Remaining race:** if a person replies within the same fraction of a second as the AI's final check (between the check and WhatsApp accepting the message, about the time of one HTTP call), both messages can go out. This cannot be closed further because WhatsApp sending is outside the database.

## 6. The 12-hour follow-up: exact conditions (checked when it runs; each is recorded)
It is scheduled from each buyer message: buyer message time + 12 h, and a newer buyer message replaces it. It is only scheduled while the AI owns the chat and the buyer's "Automatic follow-up" switch is on.

When it runs:

**Cancelled if any of these is true:**
- the conversation or lead is closed
- follow-ups are switched off for this buyer
- a person has taken over
- the buyer wrote again
- a person replied or followed up after the buyer's message
- it was already followed up for that message
- the buyer opted out

**Skipped if any of these is true:**
- a confirmed appointment is coming up (the reminders handle it)
- another follow-up sequence is due within 12 hours

**Skipped, and you are reminded on Telegram instead, if:**
- follow-ups are switched off (master or 12-hour switch)
- WhatsApp sending is off
- the AI judged that a person should follow up
- it is outside the 24-hour window with no approved template

**Waits** until business hours open (your Mon–Sun hours).

**How it is sent:**
- Inside WhatsApp's 24-hour window: an AI-written message (same persona, verified facts and reply checker), about what the buyer asked. It contains no urgency, scarcity or unverified promotions.
- After 24 hours: only an approved template (name set in settings, default `follow_up`), never a marketing template.

## 7. Telegram conditions
**Human follow-up reminder (new):**
- When a buyer writes while a person owns the chat, or while AI replies are off, and nobody has replied 60 minutes later (configurable, held until business hours):
  - one reminder per unanswered message
  - cancelled if a person replies, or if the AI answered
- Also sent when a follow-up or WhatsApp appointment message could not be sent automatically.
- Contents:
  - name, lead code, temperature and score
  - project
  - the buyer's last message and how long ago it was sent
  - a wa.me link
  - a link to the chat in the inbox

**Kept:**
- buyer asked for a person / AI handover (switchable)
- appointment booked, confirmed, rescheduled or cancelled
- appointment reminders at the configured minutes (default 24 h and 2 h; obsolete ones are dropped automatically when rescheduled or cancelled)
- daily digest
- send failures that left a buyer unanswered

**Off:** every incoming message, every AI reply, drafts.

## 8. WhatsApp appointment messages
- **Confirmation:** sent as soon as an appointment is confirmed (AI calendar booking, advisor "Confirm", or a confirmed appointment saved on the lead page). It is never sent before the confirmation exists.
- **Reminders:** 24 h and 2 h before by default, configurable.
- **Before every send it checks:**
  - the appointment still exists, is confirmed and is at the same time
  - it is still ahead
  - the switches for this appointment and this buyer are on
  - the buyer has not opted out
  - the buyer has a WhatsApp number
  - sending is on
- **A person handling the chat does not stop appointment messages** (they are operational, not sales).
- **Attendance:** a "ya / ok / boleh / jumpa…" after a confirmation or reminder is recorded, and later reminders stop asking "masih boleh datang?".

## 9. WhatsApp policy handling
- **24-hour window:** free text only inside it. After it, an approved template or nothing.
- **Approved templates expected:**
  - `appointment_confirmation`
  - `appointment_reminder`
  - `follow_up` (utility, not marketing)
- **Opt-outs:** STOP cancels everything. Its confirmation is still sent as a system message even during a takeover.
- **Honest statuses:** a message that cannot be sent is recorded *skipped* or *failed* with the reason, never marked sent.
- **Duplicates:** webhook redeliveries are ignored, using the unique WhatsApp message id.

## 10. Tests (all run here, all passing)
- **Unit tests** (150), including these new ones:
  - a second message is answered again
  - a takeover means no AI reply and no Telegram alert
  - an AI reply is blocked when a person takes over mid-reply (proven to fail without the check)
  - the 12-hour follow-up: sent once with its checks; cancelled when a person replied, took over, the buyer wrote again, they opted out, or it is switched off; waits for business hours; template after 24 h; skipped with a Telegram reminder
  - the Telegram staff reminder: sent, or cancelled when a person replied or the AI answered
  - confirmation and reminder texts, the attendance question, sent during a takeover
  - reminders cancelled when the appointment is cancelled, rescheduled, switched off per appointment or buyer, the buyer opted out, or it is outside the window with no template
  - the booking confirmation is not sent twice
  - the AI answers again after Resume AI
- **Database tests** (T42–T47):
  - the follow-up timer and its restart, redelivery, the per-buyer switch
  - a person's reply takes over and cancels the AI's work
  - take over / resume: permissions, audit, stale jobs
  - appointment jobs: schedule, reschedule, switch off and on, cancel, late booking
  - a reminder sent by hand, attendance
  - concurrent claim, recovery after a restart, permissions, cancel
  - routine alerts off
- **Telegram appointment schedule:** existing T21–T23.
- **Browser tests:**
  - ownership badges, Take over, Resume AI with confirmation, per-buyer switches
  - the automation settings page: validation and save
  - job list, filter, cancel
- **Layout audit:** 12 widths, 0 findings.
- **Full suite:** regression 40, unit 150, database T01–T47, browser 22 + layout 12.

**Not testable here (needs real credentials):**
- live WhatsApp delivery and the phone-app echo of your replies
- live Telegram delivery
- the live Supabase triggers (tested on a local Postgres copy of the schema)

## 11. Limitations and setup needed
- **Templates:** create and record the `follow_up`, `appointment_confirmation` and `appointment_reminder` templates (Malay and English). Without them, nothing automatic can be sent after 24 hours, and you get a Telegram reminder instead.
- **Detecting a human reply:** replies are detected from the inbox, and from the WhatsApp Business app through Meta's message echoes (coexistence). A reply from any other device or number cannot be detected.
- **Detecting a reminder sent by hand:** this uses keywords (e.g. "peringatan", "jangan lupa", "temujanji", "lawatan", "appointment") or a reminder template, within 24 h of the reminder.
- **Attendance:** recorded from common short replies only; the AI still reads and answers the message normally.
- **The race in section 5.4.**
- **Takeover scope:** taking over pauses the AI for the lead (all of that buyer's chats), as before.
