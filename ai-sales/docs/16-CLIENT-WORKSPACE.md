# Lead workspace: client profile, AI summary, next action, embedded WhatsApp (2026-10-29)

Click a lead anywhere and everything about that client is on one page: **Leads & CRM → a lead**.

## Layout
- **Header:** name, lead code, stage (coloured), temperature, AI status (AI active / a person is handling / no WhatsApp chat), waiting-for-a-person flag, main project, owner, last contact. Buttons: WhatsApp, Call, Appointment, Flag for human.
- **Tabs (in the same page; the URL keeps the tab, e.g. `#/lead/<id>?tab=profile`):**
  - **Summary:**
    - AI Conversation Summary, with five sections: property interest, personal profile, lifestyle & location, purchase intent, current progress. Each field shows its status: Confirmed / Inferred / Conflict / Not provided. Unknown fields are folded away under "N not provided".
    - AI Recommended Next Action.
    - Needs your review (conflicts).
    - Qualification & score, with the factors behind it and the details still unknown.
  - **Conversation:** the WhatsApp chat (the inbox's own view and composer, so there is one history). On screens wide enough (desktop, iPad landscape) it sits beside every tab instead.
  - **Profile:**
    - Contact
    - Client profile (grouped fields)
    - Property interests: several per client, each with priority, status, unit type, budget and next action
    - Qualification
  - **Sales:**
    - Lead: stage with "why / how confirmed", owner, source, campaign, main project, AI pause
    - Follow-ups & tasks
    - Appointments
    - Follow-up workflows
    - Financing check
    - Human handover
    - Consent
    - PDPA erase
  - **Activity:** timeline with filters (stages, profile, tasks & appointments, notes & calls, AI), internal notes (never sent to the client), and the field change history.
- **Follow-up queue:** **Leads & CRM → Follow-up queue** lists the leads where someone must act now, each with the reason:
  - waiting for a person
  - an overdue task
  - stuck in a follow-up workflow
  - an AI recommendation that is high priority or due today

## How the AI keeps it up to date
- **Every answered buyer message:** the AI also returns `insights`:
  - profile updates, each marked confirmed (the client said it) or inferred (needs confirmation)
  - a summary (rewritten only when the message changes the picture; greetings and thanks don't)
  - the last client question and what is outstanding
  - the next best action, with its reason and priority
  - rarely, a sales milestone the buyer explicitly confirmed
- **Chats a person is handling:** the AI reads each new buyer message (and sends nothing) to keep the profile current. You can switch this off in AI agent settings. **Refresh** on the summary does the same on demand. Both count towards the daily AI limit.
- **Database rules (`ai_lead_profile_set`), not just the prompt:**
  - A person's entry is never overwritten by the AI. A different value from the conversation appears under **Needs your review**: *Keep entered* or *Use the client's*.
  - A guess (inferred) never replaces what the client said (confirmed). The client's own correction does, and the old value stays in the history.
  - The same buyer message never updates a field twice (redeliveries, retries). The AI never clears a field.
  - Every change is stored in `ai_lead_field_history` (old → new, AI or who, which message, note) and shown on the Activity tab.
- **What is never recorded:**
  - invented or assumed personal details: marital status, occupation or interests are not inferred from a name, language or demographics
  - income, creditworthiness or loan eligibility as facts
  - a full home address

## Sales pipeline
- **Stages:** structured (stable `key`, colour, meaning) and still editable in **Settings → Pipeline stages** (rename, reorder, add, deactivate, colour, "the AI may move a lead here").
- **The existing stages were renamed and extended, not replaced.** Every lead keeps its stage:

  | Before | Now |
  |---|---|
  | New Lead | New Enquiry |
  | Qualified | Interested / Qualified |
  | Follow-Up | Follow-Up Required |
  | Appointment Confirmed | Appointment Booked |
  | Visited Showroom | Appointment Attended |
  | Booking / Reservation | Unit Booked |
  | Pending Document | Documents Pending |
  | Pending Approval | Loan Submitted |
  | SPA Signing | LO Signed |
  | Won | LO, SPA & LA Signed (closes as won) |
  | Lost | Cancelled / Lost |

  - **New:** No Response, Loan Approved, Loan Declined.
  - **Kept as they were:** Contacted, Appointment Pending, Pending SPA Signing.
- **Who moves a lead:**
  - **Staff:** to any stage, with an optional reason. The reason, who did it and when go on the timeline. A manual change cancels the automatic check-ins scheduled for the old situation; the buyer's next message schedules fresh ones. Closing a lead stops its automatic messages.
  - **AI:** forward only, never closing a lead, and only to stages marked "the AI may move a lead here" (by default: Interested / Qualified, Unit Booked, Loan Submitted). It needs the buyer's own words as evidence, checked against their message. Asking about a step, intending to do it, or a scheduled appointment is not completion. Loan approval or decline, and signing, are left to a person.
  - **Appointments:** a confirmed appointment moves the lead to Appointment Booked, and a completed one to Appointment Attended (forward only).
- **Flags are not stages.** Follow-up due, waiting for a person and AI paused stay separate flags and tasks, so a lead can be Interested and also have a follow-up due.

## Database (migration 16, additive)
- **`ai_leads` columns:** `profile`, `profile_meta`, `ai_summary`.
- **New table:** `ai_lead_field_history`, with RLS so staff can read it and changes go through functions.
- **`ai_lead_interests` columns:** `priority`, `unit_type`, `budget_text`, `next_action`, `updated_at`. Existing main projects are marked primary.
- **`ai_pipeline_stages` columns:** `key`, `color`, `ai_settable`, `description`.
- **Functions:**
  - `ai_lead_profile_set`, `ai_lead_profile_resolve`
  - `ai_lead_summary_set`, `ai_lead_next_action`
  - `ai_lead_set_stage`; the timeline trigger now records the reason
  - an appointment → stage trigger
- **PDPA:** the PDPA erase also clears the profile, summary, field history and interest notes.

## Tests
- **DB:**
  - T61: profile rules (evidence, a person's entry protected and flagged, once per message, never cleared by the AI, resolve)
  - T62: summary and next action (a dismissed one is not brought back; staff edits)
  - T63: pipeline renamed with every lead kept; AI moves only forward, with evidence and to allowed stages; staff moves cancel stale check-ins; appointments move forward only
- **Unit:**
  - field cleaning
  - writes go through the rules, tied to the buyer's message
  - stage evidence must be the buyer's own words
  - the AI's view of the profile
  - a person's qualification entry is rerouted to review
  - chats handled by a person get insights but no reply
- **Browser:**
  - the workspace on desktop: summary, statuses, conflict resolution, next action → task, refresh, profile save of changed fields only, stage change with reason
  - iPad portrait: conversation tab, no sideways scrolling on any tab
  - the follow-up queue
  - the 12-width layout audit

## Incident, 29 Oct 2026: every AI reply fell back to the safe message

**What happened.** After this release went live (01:17 UTC), every AI call failed with
`HTTP 400: The compiled grammar is too large`. This hit both the test console and live WhatsApp. The insights schema
had an enum of every profile field key (about 45 values) inside an array item. Nested in the reply schema, that made
the API's structured-output grammar too large. The orchestrator then sent the fixed safe reply and alerted a human,
and the console showed "AI unavailable · 0% sure".

**Fix**
- `insights.profile_updates[].field` is now plain text. The keys are listed in the instructions, and `cleanUpdates()`
  drops anything that is not a known field.
- `llm.mjs` classifies a schema refusal as `kind: "schema"`, separate from an outage.
- If the API refuses the full schema again, the orchestrator retries once without insights (`REPLY_SCHEMA_CORE`).
  The buyer still gets a real AI reply, and the run log stores `output.degraded` with the reason.
- Follow-up messages use the core schema (they never used insights).
- Failures are labelled by kind in the console, and confidence is `null` ("not available") when the model gave no
  answer.
- Regression test: `ai-sales/tests/regression/ai-console-outage.test.mjs`. It fails if a large enum is placed inside
  an array again, or if the reply schema grows far beyond the core schema.

**Checking it in production.** Run
`select created_at, decision, error, output->>'degraded' from ai_agent_runs order by created_at desc limit 20;`.
`decision = 'error'` with a grammar or schema message means the schema needs trimming again.

### Update, 29 Oct 2026 (later the same day)

Making `field` plain text was not enough. After that fix the AI log showed every reply call still refused with the same
error. The fallback added then (retry without insights) kept buyers getting real replies, but insights from those
replies were never written.

**Final fix:** insights are no longer part of the reply call at all.
- After each buyer message the AI answers, the worker queues a `lead_insights` job in `ai_jobs` (dedupe key
  `insights:<message id>`, no database change).
- The job runs `summarizeLead`: the separate, smaller insights call already used for chats a person handles, which is
  proven to work in production.
- The reply schema is back to the size known to compile (76 enum values, 59 properties).
- The switch "Keep client profiles up to date from buyer messages" (`ai.auto_insights`) turns both paths off.
