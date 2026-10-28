# Property knowledge: what the AI knows, and why it sometimes escalated (2026-10-28)

## The problem
On 28 Oct a buyer asked *"Parking klu dua bilik ada berapa ye?"*. The AI answered that the number of car parks "belum ada dalam rekod yang disahkan" and handed the chat to an advisor. The website states it for every layout: M NOVA Type A 1–2, M ASPIRA Type A 1, M AZURA Type A 1–2.

## How property information flows
`projects` table (website CMS, one JSON record per listing) → `ai-sales/lib/context.mjs` (`loadContext`, every buyer message) → `ai-sales/lib/prompt.mjs` (`renderContext` + system prompt) → Claude → `sales/shared/validator.mjs` (business-rule check) → WhatsApp.

- **No other source is in use.** `ai_project_facts`, `ai_project_prices`, `ai_project_units`, promotions and the knowledge base are all empty. There is no vector database; the knowledge base uses Postgres full-text search.
- **No website requests per message.** The listing JSON is read from the database, so a CMS edit is used from the next message.

## Root causes found
1. **Car parks were dropped.** Every published layout has `types[].carparks`, but `context.mjs` copied only name, size, bedrooms, bathrooms and price. The AI never saw a single car-park figure.
2. **Other published details were dropped or cut short:**
   - towers, floors and units per tower
   - the bedroom count for projects without layouts (`b`)
   - the station type (LRT / MRT / KTM)
   - per-layout maintenance fees
   - facilities cut to the first 15 of 43–58, so "Visitor Parking", "EV Charging" and "Gym" were usually lost
   - description cut to 800 characters and surroundings to 1,500
   - nearby places marked hidden on the website were still sent
3. **The prompt over-escalated.** All website data was labelled INDICATIVE, with the rule *"If something is missing, say an advisor will confirm it"*. So even fixed specifications got "perlu disahkan advisor", and a missing field always meant a hand-over.
4. **No project resolution.** Every project was sent with the same detail every turn. A follow-up such as "parking berapa?" had no marker of which project the buyer meant.

## What changed
- **`sales/shared/listing.mjs` (new), one reading of a listing for the AI and the audit:**
  - `projectSpecs()` reads every field the property page shows, with the page's own rules: layouts merged from `types` and `layouts`, hidden nearby places left out, placeholder addresses such as "M MIRA" ignored, and the project-wide `carpark.bays` filling layouts that have none.
  - `mentionedProjects()` and `resolveFocus()` work out which project is meant: named now, else the most recent message that named one, else the lead's project in the CRM. If several remain, focus is marked *ambiguous*.
  - `coverage()` and `conflicts()` give a per-field status for the audit. Conflicts include the listing contradicting itself, e.g. "Unfurnished" with furnished items listed.
- **`context.mjs`:**
  - full details (all facilities, towers, description, surroundings up to 4,000 characters) for the project(s) in focus, and a compact summary for the others
  - `not_on_record`, `partial` and `conflicts` per focused project
  - per-layout maintenance fees added to the indicative figures the checker accepts
- **`prompt.mjs`:**
  - `conversation_focus`
  - `layouts_PUBLISHED` with car parks
  - `specs_PUBLISHED`, `money_INDICATIVE`, `not_on_record`, `conflicts`
  - new answering rules:
    - search before escalating
    - answer published specifications directly
    - give per-layout values, and keep ranges such as "1-2" as ranges
    - money figures stay indicative but are still answered
    - say exactly which detail is missing
    - never borrow from another project
    - a conflict is not stated and is handed over
    - hand over only when the detail is genuinely absent or conflicting
- **`orchestrator.mjs`:** every AI run logs `retrieval`: the project(s) in focus, the details missing from them and any conflicts. It contains project data only, no buyer details.
- **Dashboard → Property projects:**
  - a **"What the AI knows"** table with each project's gaps and conflicts
  - a per-field **coverage card** on each project page, with statuses On website / Verified / Some layouts / Stale / Conflict / N/A / Not provided
  - a Car parks column in the layout table

Validator, guards, financing, takeover, appointments, follow-ups, WhatsApp and Telegram are unchanged.

## Coverage of the 7 live listings (28 Oct)
✓ on the website · ½ some layouts · ✗ not provided · n/a not applicable · ⚠ conflict

| Project | Developer | Location | Full address | Property type | Tenure | Lease years | Project status | Completion | Unit types | Built-up sizes | Bedrooms | Bathrooms | Car parks | Price from | Maintenance fee | Furnishing | Facilities | Towers / units | Public transport | Brochure |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| M ARAYA | ✓ | ✓ | ✓ | ✓ | ✓ | n/a | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ |
| M ARIA | ✓ | ✓ | ✗ | ✓ | ✓ | n/a | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| M ASPIRA | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| M AURORA | ✓ | ✓ | ✗ | ✓ | ✓ | n/a | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| M AZURA | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ⚠ | ✓ | ✓ | ✓ | ✓ |
| M MIRA | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| M NOVA | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

**Totals:** 7 projects × 20 listing fields = 140 audited, with 15 gaps or conflicts. The **staff-only** fields (booking fee, sinking fund, title type, showroom address) are not provided for any project, because there are no verified facts yet.

**Gaps you can fix in the website admin:**
- **M ARAYA:** no layouts, so no car parks, bathrooms or maintenance fee; also no furnishing or brochure.
- **M MIRA:** no towers and no brochure.
- **Six projects** have a placeholder address (e.g. "M MIRA").
- **M AZURA conflict:** furnishing is set to "No" but 12 furnished items are listed. Until this is fixed, the AI will not state whether it is furnished.

## Tests
- **`ai-sales/tests/unit/knowledge.test.mjs`**, on a snapshot of the 7 real listings (`helpers/live-projects.mjs`):
  1. exact specification
  2. per-layout values
  3. missing information
  4. several projects
  5. other specifications
  6. long descriptions
  7. CRM and conversation memory, including the production case of 28 Oct
  8. conflicts
  9. answer rules
  - plus project-name matching, the coverage audit and layout merging
- **Browser:** the coverage table and card.
- **Live model:** seven scenarios added to `tests/eval/run-eval.mjs`: car parks per layout, car parks differing by layout, car parks stated only in the description, project remembered, bedrooms and size, tenure, and a missing figure not guessed. These need `ANTHROPIC_API_KEY`, so they were **not run** here.

## Known limits
- **Cross-project figures:** the business-rule checker matches RM figures across all projects. A missing maintenance fee answered with another project's figure would not be caught by the checker; the prompt forbids it.
- **AI-generated area conclusion:** the website's AI-generated "area conclusion" text (`near.concl`) is not given to the AI.

## Follow-up: monthly instalment per layout (28 Oct)
- **Problem:** asked "Type C berapa bulanan?", the AI asked LPPSA or bank and then age and salary, instead of giving the figure the website's loan calculator shows.
- **Causes:**
  - The loan engine produced one example per project, for its **lowest price only**.
  - Monthly figures may come only from the engine, so the AI had no Type C figure.
  - The engine used its own bank rate (3.65%), not the website calculator's settings (100% financing, 3.7%, 35 years).
- **Fix:**
  - `instalmentIllustration()` in `sales/shared/finance.mjs`.
  - `attachFinancing` builds `instalment_examples` for **every priced layout** of the project(s) in focus, using the website calculator's own settings (`settings.data.loan`). Each row has the LPPSA equivalent, the maintenance per month (size × psf) and the total.
  - The prompt says to answer with these at once, as an illustration, and offer the eligibility check afterwards.
- **Result:** M AURORA Type C (RM517,000) gives RM2,197 a month, the same as the website, plus RM283 maintenance, RM2,480 in total. The LPPSA figure is RM2,289.
