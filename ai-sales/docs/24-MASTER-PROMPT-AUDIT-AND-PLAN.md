# Master prompt v2 (Hafizan Hanis — Elite Malaysian AI Property Advisor): audit, gap analysis and plan

30 Oct 2026 · Phases 1–3 only. **Nothing has been changed yet.** Every stage below needs the owner's go-ahead.

## Phase 1 — Audit of the existing system (verified in code and the live database today)

### Architecture
- **Website:** static site on Netlify (unchanged by the AI Sales module; protected by regression tests).
- **CRM:** `/sales/` single-page dashboard (`sales/js/*`) on Supabase (Postgres + RLS + Storage).
- **Server:** 12 Netlify Functions (`netlify/functions/sales-*`), with a scheduled worker every 2 minutes.
- **AI:** Claude via `ai-sales/lib/llm.mjs` (structured outputs; 23–26 s budgets inside Netlify's 30 s limit).

### AI persona and prompt
| Item | Live value / behaviour |
|---|---|
| Persona name | `Hafiz_Ai`; `discloses_ai: true` (the AI says it is an AI assistant) |
| Tone guidance | 37,791 characters: the **previous master prompt** ("Mah Sing Property Advisor · 10+ years experience") |
| Reply style | **`short`** (7–10 words a message, at most 15; 1–3 messages) |
| Manglish | on; languages ms, en |
| Greeting fields | "Hi! I'm Hafizan 😊😇 …" / "Saya Hafizan …": **not used by the code**, and they would contradict the AI disclosure |
| Built-in rules (`ai-sales/lib/prompt.mjs`) | answer first; one discovery question; verified facts only (prices, distances, promotions); no guarantees; hand-over rules; objection guidance (`ai_objections`); attachments; files to send; business-rule validator (`sales/shared/validator.mjs`) blocks invented amounts, URLs, guarantees, disputed distances |

### Language
- **Detection:** `guard.mjs` (`detectLanguage`, `replyLanguage`) picks BM or English from the buyer's recent messages and their saved `preferred_language`.
- **Requested language:** `requestedLanguage` ("Saya nk speak in English") is saved to the contact.
- **Manglish:** allowed when the buyer writes it.

### Salutation (the current state)
- `ai_contacts.salutation`: a free-text field ("Encik / Puan / Mr / Ms") on the lead's Profile tab. **Only 2 of 120 contacts have one.**
- The prompt uses "tuan/puan" in BM unless the buyer's preference is known, and the buyer's name when known.
- **No gender field, no confidence, no source, no name recognition, no English-title rules.**

### Emojis (measured on live replies, last 3 days)
- **49% of AI messages contain an emoji** (83 of 168). Average message: 36 words, 220 characters.
- No emoji rule exists in code. The saved greetings use two emojis each.

### Customer discovery and memory
- `discovery.mjs`: 9-step order (name → area familiarity → purpose → living/work area → commute → first home → marital status → household → showroom).
  - Own-stay, investment, both and unknown pathways; a showroom request jumps to step 9.
- Client profile (`ai_leads.profile` with evidence statuses), AI summary, next action and field history.
  - Updated by a separate insights job after each buyer message.
  - A person's entry is never overwritten; a different value is flagged as a conflict.

### Property knowledge
- Website listings plus staff-verified facts, prices and units.
- Approved knowledge entries and FAQs.
- Google Maps routes (needs `GOOGLE_MAPS_API_KEY`, **not set**).
- Web research (test console only).
- Brochure files sent on WhatsApp; Read with AI for image-only brochures.

### Financing (preserve; no formula changes planned)
- `sales/shared/finance.mjs` is used by the AI on WhatsApp and by the lead-page calculator.
- `sales/shared/calc/*` (exact decimals) is used by the Financing tools pages (LPPSA, bank, comparison, document auto-fill).
- **Live owner settings:**
  - bank: **3.65%**, 35 years, **100% margin**, variable income counted at 70%, DSR 60/70/80
  - website calculator: 3.65%, 100%, 35 years
  - LPPSA: 60/50%, 80%, 20%, 4%/4.5% weighted, RM1M; **not marked verified**
- The master prompt's "3.6% / 35 years" matches the existing 3.65% / 35 years. **Nothing to change.**

### WhatsApp automation
- **Inbound and replies:**
  - Webhook → `ai_wa_inbound`, which handles username (BSUID) buyers.
  - Reply job → 1–3 messages, sent idempotently.
  - Reactions and stickers get no reply; media gets a fixed reply.
  - A retry after a timeout.
- **Follow-ups:**
  - 12-hour smart follow-up (`ai_automation_jobs`, kind `smart_follow_up`).
  - Workflow follow-ups (RMK, M MIRA).
  - Templates outside the 24-hour window; consent and opt-out respected.
- **Appointments:** Google Calendar slots, booking and reminders (24 h and 2 h).

### Human takeover (verified)
- A reply from the inbox, or from the WhatsApp phone app (echo), sets the chat to `human` and pauses the lead.
- `ai_apply_takeover` then:
  - cancels automation jobs
  - closes queued reply jobs
  - cancels follow-ups
- Every AI message is checked again just before sending (`aiMaySend`), so a queued AI message is skipped once a person has replied.
- **Resume AI:** an explicit button (`ai_resume_ai`).

### Telegram (verified live)
- Categories on: `new_website_lead`, `human_followup_reminder`, `appointment_notification`. Matches §14 of the master prompt.
- No Telegram messages for routine WhatsApp.

### Data available for learning
- **946 human messages** sent to buyers (inbox and phone app) and 251 AI messages, across 119 conversations.

### Security
- Supabase RLS by role (viewer < advisor < manager < owner); service role for server jobs only.
- Audit trail on settings and leads.
- PDPA erase and retention purge.
- Private storage for financing documents; 30-day retention.

## Phase 2 — Gap analysis

| Master prompt section | Exists | Gap |
|---|---|---|
| §2 Identity (Hafizan Hanis, 12 yrs, 500+ buyers) | Persona text (says **10+ years**) | **Conflict:** figures differ. **Conflict:** "represents Hafizan" vs the legal AI disclosure (the AI must not claim to be Hafizan himself). Needs an owner decision. |
| §3 Personality, three languages | Yes (prompt + persona) | Small: humour and tone adaptation guidance only. |
| §4 Smart Salutation | Free-text salutation only | **Missing:** gender / confidence / source fields, a name-recognition list with a neutral default, per-language title rules, a customer-confirmed override, advisor override UI, tests 1–13. |
| §4.5 Language detection | Yes | Small: keep one title family per conversation (never Mr then Encik). |
| §5 WhatsApp reply art (20–60 words, 1–3 segments, ANSWER→EXPLAIN→PERSONALISE→ENGAGE) | Answer-first and 1–3 messages exist | **Conflict:** the live reply style is "short" (7–10 words). Needs a new "adaptive" style; the existing word checks (`checkTurn`) must be re-tuned. |
| §5.6 / rule 7 Emojis sparingly | None (49% of replies have emojis) | **Missing:** an emoji policy (at most 1 per turn, often none; none in financing, complaints, objections or hand-overs) plus a check in code. |
| §6 Sales psychology (SPIN, value, mirroring, ethical urgency) | Partly (objections, no false urgency via the validator) | Prompt guidance to add; ethical urgency is already enforced (promotions need verification). |
| §7 Discovery | 9 steps + pathways + showroom override | Small: employment, income, commitments and timeline only when financing comes up (the loan engine already asks for these). |
| §8 Knowledge / location | Yes (verified facts, Maps, disputes) | Owner data gaps (Maps key, showroom details, promotions) — configuration, not code. |
| §9–10 Objections, closing | Yes (5-stage guidance, hand-over for booking/pay/sign) | Small prompt refinements. |
| §11 Financing | Yes (two engines, calculators, document reader) | None. **Preserve.** (LPPSA verification by the owner is pending.) |
| §12 Follow-ups | Yes (12 h, workflows, 24 h window) | Small: follow-up wording uses context (already does). |
| §13 Takeover + memory | Yes | Add: the salutation preference in memory. |
| §14 Telegram | Yes, matches | None. |
| §15 Continuous learning / Teach My AI | **None** | **Missing:** labels, pattern extraction, anonymisation, approval queue, retrieval of approved patterns, version history. |
| §16 Sales Intelligence dashboard | Reports page (leads, appointments, hand-overs) | **Missing:** learning and communication sections. |
| §17 Decision engine | Intent / agent / decision + hand-over rules | Documented mapping; no rebuild. |
| §18 Privacy | RLS, audit, erase, retention | Extend to the learning tables (manager+, anonymised, retention). |
| §19 Admin settings | Settings tabs exist | Add Salutation, Emoji / reply style, Learning, Prompt versions. |
| §15.7 / §16E Prompt version control + rollback | Settings changes are audited, but there is no versions view or rollback | **Missing.** |

## Phase 3 — Implementation plan (stages, each its own PR, tested before merge)

**Stage 0 — Back-ups (before anything else)**
- Export the live `ai_settings` (persona and settings) into a version record.
- Commit an SQL back-up file with rollback scripts.

**Stage 1 — Smart Salutation and language**
- **Migration 20 (additive only)** on `ai_contacts`:
  - `gender` (male / female / unknown / not_provided)
  - `salutation_confidence` (confirmed / high / uncertain)
  - `salutation_source` (customer / advisor / name_recognition / not_set)
  - Rollback: drop the three columns.
  - The existing `salutation` column becomes "preferred salutation".
- **`sales/shared/salutation.mjs`:**
  - a short, **high-confidence** name list (e.g. Muhammad, Ahmad, David → male; Siti, Nurul, Jessica → female)
  - everything else (Nur, Lee, Alex, unknown names) stays **uncertain → neutral**
  - per-language address: EN Mr / Ms / name; BM Encik / Puan / Tuan/Puan; Manglish follows the conversation language
  - never Miss or Mrs automatically
  - a customer- or advisor-confirmed title always wins
- **Context:** the reply AI gets `address_as` (exact words to use) and `salutation_rule`. The reply schema does not grow (it is at its size limit).
- **Recording preferences:** the insights job records a title the buyer states ("panggil saya Puan Aina", "call me Mr Tan") as **customer-confirmed**.
- **UI:** the lead Profile tab gets Gender, Preferred salutation, Confidence and Source fields. An advisor's change applies immediately.
- **Tests:** the 13 salutation cases, language consistency, preserving a preference after resume.

**Stage 2 — WhatsApp reply intelligence and emojis**
- A new reply style **"adaptive"**: 20–60 words usually, 1–3 messages, ANSWER → EXPLAIN → PERSONALISE → ENGAGE.
  - "short" and "standard" stay selectable.
  - The owner switches it in Settings → AI persona → Reply style.
- **Emoji policy in the prompt, plus a code check:**
  - at most 1 emoji per turn
  - none in financing, complaint, objection, hand-over or legal replies
  - the validator asks for one rewrite if it is exceeded, never blocks
- Prompt sections for emotional intelligence, SPIN, value selling, mirroring and ethical urgency (short, actionable).
- Remove the unused "I'm Hafizan" greetings from Settings, or reword them to "Hafiz_Ai, Hafizan's AI assistant".
- **Tests:** word and emoji checks, regression of the multi-message tests, live checks in the test console.

**Stage 3 — Persona version control**
- **Migration 21:** `ai_prompt_versions` table (persona snapshot, author, approver, note, time), manager+ read, owner-only approve.
- **Settings → AI persona → Versions:** list, compare, approve, roll back.
- The current persona becomes **v1**. The new master prompt is saved as a **v2 draft for owner approval**. It is not live until approved.
- Recommendation: v2 keeps the advisor-facing parts (identity, style, salutation, sales psychology). Developer instructions (test lists, implementation steps) are left out, because they cost time and money on every reply and the AI cannot act on them.

**Stage 4 — Continuous learning (Teach My AI)**
- **Migration 22:**
  - `ai_conversation_labels` (conversation, label EXCELLENT / AVERAGE / POOR / NEEDS_REVIEW, advisor, note)
  - `ai_learning_patterns` (pattern, anonymised example, category, language, source conversation, advisor attribution, support count, quality score, confidence, status pending / approved / rejected, approved_by, version)
  - RLS: advisors label; managers and owners review and approve. Learning data is excluded from viewers.
- **Inbox → "Teach My AI"** buttons on a conversation.
- **Extraction job:** one AI call per EXCELLENT conversation.
  - Anonymised: names, phone and IC numbers, amounts tied to a person, addresses removed. An anonymisation check runs in code too.
  - It produces pattern candidates. POOR conversations produce "do not imitate" notes.
- **Approval queue:** only approved patterns reach the reply AI, as a small "approved communication examples" block (size-limited). They never override rules.
- **Hafizan's own replies are weighted higher** (his phone echoes and his account); other advisors' replies are used for technique only, never their identity.
- Every approval or rejection is recorded, and an approved pattern can be withdrawn.
- **No model training:** this is retrieval of approved examples; the model itself is not retrained.

**Stage 5 — Continuous Sales Intelligence dashboard**
- A new page (A–E): communication examples by language, learning performance, common questions and objections (from intents / objection keys), appointment and follow-up conversion, manual controls, and version history.
- Built from existing tables plus the Stage 4 tables. Mobile, iPad and desktop.

**Stage 6 — Small prompt refinements**
- Discovery: employment, income, commitments and timeline only in the financing context.
- Closing and buying signals; follow-up wording.
- The financing disclaimer wording (estimate vs official vs approval).

**Not changing:**
- the financing engines and their settings
- the webhook and reply pipeline
- takeover, resume, follow-ups, appointments and Telegram rules
- the database relationships
- the website

### Risks and how they are handled
- **Prompt size and latency:** the persona is already 37,791 characters and is sent with every reply. Adding the new prompt verbatim would slow replies and raise cost. Stage 3 keeps it lean and version-controlled.
- **Reply schema size:** the API refused a larger schema before ("grammar too large"). No new reply fields; salutation and learning data come through context and the insights job.
- **Wrong gender titles:** a short high-confidence list only; everything else neutral; confirmed preferences win. There is a test for each master-prompt case.
- **Emoji check causing slower replies:** the rewrite happens at most once and only when over the limit; timing is measured in the console.
- **PDPA / learning:** only staff messages are used, anonymised before storage; examples are approved by a person; manager+ access; retention follows the contact's erase / purge.
- **Migrations:** additive only, with a rollback script each, tested on a throwaway database (`run-db-tests.sh`) first. Applied by you in the SQL Editor or with an approved `apply_migration`.

## Owner decisions needed before Stage 1
1. **Identity:** should the AI speak as "Hafiz_Ai, Hafizan Hanis's AI assistant" (recommended; keeps the AI disclosure the persona and the law require), with Hafizan's credentials described as his? Or something else, keeping the disclosure?
2. **Credentials:** the saved persona says "10+ years"; the new prompt says "12 years" and "more than 500 purchasers". Which is correct to state?
3. **Reply style:** switch live replies from "short" (7–10 words) to the new "adaptive" (20–60 words)?
4. **Learning sources:** may the 946 existing staff messages (mostly from your phone) be used for learning, after anonymisation? Are other advisors' messages in scope?
5. **Order:** proceed with Stages 0–2 first (salutation, reply style, emojis), then 3–5?

## Implemented: Stages 0–2 (this PR)

**Stage 0 – backup.** Live persona and settings snapshotted to the audit log (#5347) before any change.

**Stage 1 – identity, salutation, emojis**
- Identity: "Hafiz_Ai, the AI assistant of Hafizan Hanis". The advisor's name and credentials (12 years, Klang Valley, 500+ purchasers) are Settings → AI persona fields, stated as the advisor's credentials, never the AI's.
- Smart Salutation (`sales/shared/salutation.mjs`). Order of authority: customer-stated preference → advisor-confirmed title/gender → high-confidence name recognition (bin/binti, a/l, a/p, known names) → neutral (name only, or "Tuan/Puan"). A wrong gendered title in a draft is corrected before sending. "Call me Ms David" / "panggil saya Encik Ali" is saved as the customer's confirmed preference (and is no longer mistaken for a human-callback request).
- Migration 20 adds `gender`, `salutation_source`, `salutation_confidence` to `ai_contacts` (additive, nullable; PDPA erase clears them). Rollback: `ROLLBACK-SMART-SALUTATION.sql`. Code runs with or without it.
- Emojis (`sales/shared/emoji.mjs`): at most 1 per turn; none for complaints, legal, negotiation, objections, opt-outs, hand-overs and financing figures.

**Stage 2 – adaptive reply style.** New "Adaptive (recommended)" reply style: answer → explain → personalise → engage, 20–60 words, max 60 per message and ~100 per turn. Existing styles unchanged; live style is switched only in Settings.

**Unchanged:** LPPSA and bank calculation engines, human takeover, follow-ups, reminders, Telegram rules.

**Manual steps after merge:** run `APPLY-SMART-SALUTATION-IN-SQL-EDITOR.sql`; set Reply style to Adaptive; reword saved greetings that say "I'm Hafizan".

## Implemented: discovery steps 1–2 — name and area familiarity

Live audit (14 days, 251 AI messages): the name was asked 0 times and area familiarity 9 times; familiarity was saved for 3 of 125 leads. Cause: any WhatsApp profile name (emojis, usernames, stylised letters, business names) counted as a known name.

- `nameStatus()` (`sales/shared/salutation.mjs`): `confirmed` (the buyer or an advisor gave it) / `declined` / `to_confirm` (a clean WhatsApp or form name: the AI checks it once, "Blh sy panggil Aina ya?") / `unknown` (emoji, initials, stylised letters, business name: the AI asks, and never addresses them by it). Text in brackets is dropped and ALL CAPS is written normally.
- `nextDiscovery()` sets `ask_now` for the name from the AI's second reply, and for area familiarity once a project is being discussed. A showroom question, an upset buyer or a buyer ready to book still comes first.
- `readDiscoveryAnswer()` reads the buyer's reply to the question the AI just asked (a name, a confirmation, another name, "tak nak bagi"; familiarity in BM, English and Manglish). It is saved at once through `ai_lead_profile_set` (source ai, so an advisor's entry is never overwritten) and used in the same reply.
- No database change. Test data uses made-up names only (the repository is public).
