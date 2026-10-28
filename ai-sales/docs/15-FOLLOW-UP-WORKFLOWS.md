# Follow-up workflows: built in the dashboard, one per project (2026-10-28)

Dashboard: **☰ → Follow-up workflows**. Every project's step-by-step WhatsApp follow-up is a **workflow** stored in the
database. Stages, keywords, reminder intervals, messages, templates and transitions are all edited on screen, so a new
project needs no code change. RMK is now the first workflow (`#/workflow/rmk`; the old `#/rmk` link still opens it).

## What was moved, and what stayed
- **Copied into the workflow tables unchanged:** RMK's six stages, all its keywords and aliases, intervals (to_book 24 h × 3, to_portal 24 h × 3, loan documents and signing 48 h × 3), template names (`rmk_to_book`, `rmk_to_portal`, `rmk_to_submit_loan`, `rmk_to_sign`), BM/EN messages, the 6-hour active-conversation pause and the sending switch (off).
- **Also unchanged:** the ad, message and listing entry rules, and the behaviour. DB tests T56/T57 (written for RMK) pass unchanged against the new engine, and T58 checks the copy field by field.
- **Kept but no longer read:** `ai_settings.rmk` and `ai_rmk_pipeline`. Nothing was deleted.
- **Still work:** the `ai_rmk_*` functions now act on the RMK workflow.

## Tables (migration 15, additive)
| Table | Holds |
|---|---|
| `ai_workflows` | name, short name, project, description, sending switch, active-conversation pause, entry rules, AI guidance, active/archived |
| `ai_workflow_stages` | order, name, buyer's step (EN/BM), keywords (the first is shown to buyers, the rest are aliases), remind every N h, at most N reminders, BM/EN message, 24-hour template, next stage, final, person takes over on entry, task after the last reminder, active, archived |
| `ai_workflow_leads` | each lead's workflow, stage, automation status (Active / Paused / Completed / Needs a person), source, and history of every move |
| `ai_workflow_changes` | every settings change: who, when, note, and the full before and after |

**Access:** staff read; changes only through functions. Managers and owners use `ai_wf_save`. Advisors use `ai_wf_enroll`, `ai_wf_set_stage` and `ai_wf_set_status`. The worker uses `ai_wf_advance`.

## Builder (Stages tab)
- **Editing stages:** add, edit, duplicate, move up or down, archive or restore. Short names are fixed once saved, so history and jobs keep pointing at the right stage.
- **Message placeholders:** `{{name}}`, `{{project_name}}`, `{{current_stage}}`, `{{next_stage}}`, `{{keyword}}`. The older `{name}` still works. A live preview under each message shows exactly what a buyer called Aina would receive.
- **Next stage:** "Next in order" by default. Choosing a stage jumps there. Inactive and archived stages are skipped.
- **Validated as a whole, in the browser and again in the database, in one transaction:**
  - keywords are unique within the workflow (case and punctuation ignored)
  - there is a final stage and at least one active stage before it
  - every stage with reminders has a message
  - next stages exist
  - placeholders are known
  - one active workflow per project
- **Archiving a stage that has leads:** you must choose where to move them; the move is recorded in each lead's history.
- **Archiving a workflow:** stops its reminders and keywords, and keeps its leads and history. It can be restored.
- **Unsaved edits:** kept in the browser tab (restored after a reload, with a "Discard" option).
- **History tab:** every save with what changed (e.g. "To book unit: interval, message (BM)"), plus recent lead moves.

## How leads join (Settings tab)
- **Ad phrases:** a click-to-WhatsApp ad whose headline, text or link contains a phrase. The webhook sends the ad text to `ai_wf_enroll_from_ad`, which checks every active workflow.
- **Message phrases:** a buyer's WhatsApp message containing a phrase.
- **Website listing:** a lead set to the workflow's project (website enquiry or staff).
- **The AI:** only once the buyer clearly confirms a project. Workflows are offered to the AI as `workflow_offers`, along with each workflow's guidance.
- **Staff:** "Add to workflow" on the lead page.
- **"Pause when moved to another project":** resumes when the lead is set back.

## Sending and safeguards (unchanged from RMK, now per workflow)
- **Job kind** `workflow_follow_up`. At most one reminder waits per lead and workflow (unique index), and every key is unique, so nothing is sent twice.
- **Checked again right before each send:**
  - the workflow is active and sending is on
  - the lead is still at that stage and active
  - the stage is still active with reminders
  - the lead is open and on this project
  - the buyer has a WhatsApp chat and has not opted out
  - WhatsApp sending is on
  - the conversation has been quiet for N hours
  - within business hours
- **After 24 hours** only the stage's approved template; without one, a follow-up task.
- **After the last reminder:** a follow-up task, unless the stage turns that off.
- **"A person takes over":** reaching the stage opens a follow-up task.
- **Jobs that missed their time by over 24 h** are dropped, not sent late.
- **The 12-hour AI follow-up** is skipped only while the buyer is at a workflow stage that sends its own reminders.
- **Telegram:** unchanged. Only follow-up tasks, new clients and appointments.

## Adding a new project's workflow
1. **Create:** Follow-up workflows → **+ New workflow** → name, website listing, and start blank or from a copy of RMK.
2. **Stages tab:** rename stages, set **different keywords** from other projects, and write the messages (check the previews).
3. **Settings:** ad phrases and message phrases (e.g. the project name). Save.
4. **Meta templates:** create and approve one for each stage that should reach buyers after 24 hours, and enter its name on the stage.
5. **Turn it on:** switch **sending on** in Settings.

## Tests
- **DB:** T56–T57 (RMK behaviour), T58 (RMK copied unchanged), T59 (builder: permissions, validation, new workflow end to end, aliases, inactive stage skipped, person on entry, rename, archive stage with move, archive workflow, audit), T60 (ad entry, listing entry and pause, staff moves, viewers read-only).
- **Unit:** sender, isolation and re-checks, waits, templates and tasks, AI enrol/advance from the database, helper functions and validation.
- **Browser:** list and copy, board and leads, builder (preview, add, reorder, archive, validation, one save), archive with move plus a restored draft, settings and history, lead card. Plus the layout audit of every new page at 12 widths.
