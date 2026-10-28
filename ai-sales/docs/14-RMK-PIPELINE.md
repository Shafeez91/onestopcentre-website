# RMK — Residensi Metropolitan Kepong: its own pipeline and WhatsApp follow-ups (2026-10-28)

Dashboard: **☰ → RMK pipeline**, with **Board**, **Leads** and **Settings** tabs. Each lead page also has an **RMK pipeline** card ("Add to RMK" for advisors).

## Stages
| # | Stage | Buyer replies when done | Next |
|---|---|---|---|
| 1 | New RMK enquiry | **RMK** | To book unit |
| 2 | To book unit | **DONE BOOKED** | To apply portal (RUMAWIP) |
| 3 | To apply portal (RUMAWIP) | **DONE PORTAL** | To submit loan documents |
| 4 | To submit loan documents | **DONE SUBMIT LOAN** | To sign LO, SPA & LA |
| 5 | To sign LO, SPA & LA | **DONE SIGNED** | All signed |
| 6 | All signed | — | Every RMK reminder stops; the lead and the chat stay |

- **Keywords:** the database moves the lead on when the buyer's whole message is the keyword. Case and punctuation don't matter, and DONE BOOKING, DONE SUBMIT and DONE SIGN are also accepted.
- **Order:** a keyword only works from its own stage. A repeated, out-of-order or redelivered keyword changes nothing.
- **Own words:** "dah booking", "portal dah daftar", "semua dah sign" are judged by the AI, which may move the buyer on **only from the current stage**. If unsure, it asks.
- **Staff:** can set any stage, or pause and resume, on the Leads tab.

## Who joins the RMK pipeline (stage "New")
- **A click-to-WhatsApp ad** whose headline or text names RMK or Residensi Metropolitan Kepong. The source becomes Facebook or Instagram, taken from the ad link.
- **A WhatsApp message containing "Metropolitan Kepong".** Use this in the RMK campaign link's pre-filled text, e.g. `https://wa.me/60…?text=Saya%20berminat%20RMK%20(Residensi%20Metropolitan%20Kepong)`.
- **A website enquiry for the RMK listing,** once it exists and is chosen in Settings → RMK listing.
- **A lead whose main project is set to the RMK listing** by staff.
- **The AI,** when the buyer clearly confirms they mean Residensi Metropolitan Kepong.
- **Staff,** with "Add to RMK" on the lead page.

A bare "RMK" from someone not in the pipeline does **not** enrol them: the AI asks whether they mean Residensi Metropolitan Kepong. Existing leads are never moved in automatically.

## Follow-ups (Settings tab; off until switched on)
- **Configurable per stage:** remind every N hours, at most N reminders, the message in BM and English (`{name}` = buyer's name), and the approved WhatsApp template used after 24 hours.
  - **Defaults:** New has no reminders (follow-ups start after the buyer replies RMK). To book and To portal: every 24 h, 3 times. Loan documents and Signing: every 48 h, 3 times.
- **Checked again right before every reminder:**
  - sending is switched on
  - the lead is in the pipeline, still at that stage, and its automation is active
  - the lead is open and its project is still RMK
  - the buyer has a WhatsApp chat and has not opted out
  - WhatsApp sending is on
  - the conversation has been quiet for *N hours* (default 6), so a buyer who is talking to the AI or a person is not interrupted
  - within business hours (Malaysia time)
- **WhatsApp rules:** within 24 hours of the buyer's last message, the stage message is sent as normal text. After that, only the stage's **approved template**. Without one, a **follow-up task** is opened for a person.
- **Stage change:** the old stage's reminders are cancelled at once and the new stage's first one is scheduled. At most one RMK reminder can be waiting per lead (unique index).
- **No progress after the last reminder:** a follow-up task is opened and the lead shows **Needs a person**.
- **No WhatsApp chat** (e.g. a website lead): a follow-up task to contact them.
- **The 12-hour AI follow-up** is skipped for active RMK leads past "New", so the RMK reminders are the only follow-ups. Other projects keep theirs unchanged.
- **Telegram:** none for RMK messages or stage moves. Only the follow-up tasks above (category 2), new clients and appointments, as before.

## Isolation
- **Only leads in `ai_rmk_pipeline`** get `rmk_follow_up` jobs.
- **Every job re-checks** pipeline, stage, status and project before sending.
- **Project change:** changing a lead's main project to another project pauses its RMK automation ("project changed to …") and cancels its reminders. Setting it back to RMK resumes it.
- **AI context:** RMK steps and keywords are given to the AI only for buyers in the pipeline. The prompt forbids using them for other projects.

## Changes
- **Migration 14** (`20261028000014_ai_sales_rmk_pipeline.sql`, `APPLY-RMK-IN-SQL-EDITOR.sql`), additive:
  - `ai_settings.rmk`
  - `ai_rmk_pipeline`
  - `ai_automation_jobs.stage` / `seq` and kind `rmk_follow_up`
  - functions `ai_rmk_enroll / advance / set_stage / set_status / schedule / reschedule_all / cfg / next`
  - triggers on `ai_messages` (keywords, project name) and `ai_leads` (project change)
- **Code:**
  - `sales/shared/rmk.mjs` (stages, keywords, labels)
  - `ai-sales/lib/automation.mjs` (`rmkFollowUp`; 12-hour follow-up skips RMK leads)
  - `context.mjs` / `prompt.mjs` / `orchestrator.mjs` (RMK context, reply field `rmk`, actions `rmk_enroll` / `rmk_advance`)
  - `netlify/functions/sales-whatsapp-webhook.mjs` (RMK ad referral)
  - `sales/js/rmk.js` (page, settings, lead card)
  - `app.js`, `crm.js`, `automation.js`, `app.css`
- **Tests:**
  - database T56: full journey by keyword, order, redelivery, scheduling, all signed, no Telegram
  - database T57: isolation, project change, staff roles, website lead
  - unit: reminder sent, isolation re-checks, active-conversation wait, 24-hour template or task, after last reminder, no chat, AI stage moves, ad recognition, webhook
  - browser: board, list, stage change, pause, search, settings, lead card, layout at 12 widths

## Needs live testing / your input
- **Message wording:** the defaults in Settings are a starting point. Check them, then switch sending on.
- **WhatsApp templates:** for reminders after 24 hours, create and get approved in Meta `rmk_to_book`, `rmk_to_portal`, `rmk_to_submit_loan`, `rmk_to_sign` (Utility, {{1}} = name), then add them in Templates. Until then those reminders become follow-up tasks.
- **RMK listing:** if RMK gets a website listing, choose it under Settings → RMK listing so website enquiries join automatically. The AI only knows RMK facts from that listing or your knowledge base entries.
- **Ads:** check one real click-to-WhatsApp ad: the ad headline or text must name RMK or Residensi Metropolitan Kepong.
