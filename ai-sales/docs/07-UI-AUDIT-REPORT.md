# UI audit and fixes — /sales/ dashboard (2026-10-27)

Scope: the AI Sales dashboard at `/sales/` (static ES modules in `sales/js/`, one stylesheet `sales/app.css`, Supabase backend). The public website, its pages, SEO, sitemap and admin were not touched (regression suite 40/40).

## A. Pages audited
Every route in the dashboard, each with all collapsible sections opened, at 12 widths (below):
overview · inbox (list and an open chat) · AI test console · leads · lead detail · pipeline · appointments · handover queue · property projects · property detail (website listing, verified facts, FAQs & documents, unit inventory + add/import, verified prices + history + add/import, promotions + add) · knowledge base (documents, entries, FAQs, search) · templates & objections (both tabs) · follow-up automation · campaigns · reports · settings (feature switches, persona, AI model & limits, lead scoring, business hours & rules, compliance, Telegram notifications, pipeline stages) · team & permissions · integrations · consent, security & audit (audit log, consent, retention).
Dialogs: new lead, flag for handover, confirm appointment, add/edit objection, add/edit template, new sequence, new/edit campaign, edit knowledge entry.

## B. Bugs found (causes, not symptoms)
1. **Date and time fields sticking out of their column on iPad/iPhone** (Property projects: completion date, valid from/to, effective from; Settings → Business hours). Safari draws `type=date/time` boxes at their own native width and ignores `width:100%`; as grid items with the default `min-width:auto`, their labels were also stretched past the column.
2. **Saving did not refresh the screen.** Each page was built in an off-screen container whose *children* were then moved on screen, but the page code kept a reference to that container and re-rendered into it after a save. "Saved" appeared, but new promotions, units, notes, stages, etc. only showed after leaving and returning. (The earlier Integrations-button bug had the same cause.)
3. **Page jumped after saving** (once 2 was fixed, this became visible): re-rendering closed every "Add …" section, the page got shorter and the browser snapped up — measured 500 px on the property page.
4. **Tabs and filters blanked the page** with "Loading…" before showing the new content, collapsing it and throwing the reader to the top; and a newly opened page could start part-way down (the code reset `#view.scrollTop`, but the window is what scrolls).
5. **Unsent WhatsApp reply lost** when tapping Take over / Hand back (the chat re-renders; the reply box had no draft protection, unlike other forms).
6. **Long unbroken text pushed pages sideways on phones**: web links, file names, emails, WhatsApp template names (Team, Templates, Knowledge, FAQs, Property). No wrapping rule existed for words longer than the column.
7. **Cramped two-column layout on iPad landscape**: the property page switched to one column only below a 1100 px *screen*, but with the menu visible the content area at 1180 px is ~900 px, giving two 440 px columns, two-column forms with ~200 px fields, and tables crushed letter by letter.
8. **Integrations at 320 px**: the label column of the key/value list took its full text width and pushed the values out of the card.
9. Accessibility: the lead note box and both CSV file pickers had no label; text links were ~24 px tall on touch screens.
10. Safety: "Run retention clean-up now" deleted data without asking.

## C. Fixes (files)
- `sales/app.css` (shared — fixes every page at once):
  - date/time inputs without the native look so they size like other fields
  - `.form>*{min-width:0}`
  - two-column forms follow the width of their own card/dialog (container query, single column under 440 px) instead of the screen
  - the property/lead detail layout goes side by side only when the content area is ≥ 1000 px
  - long text wraps (`overflow-wrap:anywhere`); tables keep whole words and scroll inside their card instead
  - key/value lists cap the label column
  - finger-sized links/chips on touch screens
  - `dvh` heights for iPad/iPhone toolbars
  - dimmed content while a tab loads
- `sales/js/app.js` (router):
  - the page container itself goes on screen, so re-renders after a save update what you see (bug 2)
  - a new page starts at the top
  - a tab or filter change keeps the current content and position until the new one is ready
- `sales/js/core.js`: new `keepPlace(el, render)` — re-renders after a save keeping scroll position and the sections that were open.
- `sales/js/crm.js`, `knowledge.js`, `admin.js`:
  - every post-save refresh uses `keepPlace`
  - the WhatsApp reply box keeps an unsent draft
  - labels added
  - confirmation before the retention clean-up; its note now says it runs daily at ~3 am MYT
- Tests: `ai-sales/tests/e2e/harness.mjs` (shared local server + fake Supabase, extracted from the browser tests; also fixes a race where a check could run before the new page had rendered), `layout.test.mjs` (new), 3 new regression tests in `browser.test.mjs`.

No database, environment variable, security policy or server-function change.

## D. Responsive testing (actually run, headless Chromium)
The layout audit loads realistic long content and checks, for every page and dialog:
- no sideways page scroll
- no control or text outside its card/dialog
- every field inside its own column and at least 150 px wide
- no overlapping fields or buttons
- no text spilling out of its box
- no JavaScript errors

| Width (px) | 320 | 375 | 390 | 430 | 600 | 768 | 820 | 1024 | 1180 | 1280 | 1440 | 1600 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Before fixes (findings) | 23 | 18 | 18 | 17 | 8 | 0 | 0 | 0 | 5 | 5 | 5 | 2 |
| After | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

The audit was checked against a deliberately reintroduced overflow on the date fields (it reported 12 findings at 1180 px). Screenshots of property detail (390/820/1180), business hours (1180), inbox (820) and templates (390) were inspected by eye.

## E. Functional testing
- **Passed (automated, fake backend):**
  - sign-in and mobile menu
  - unsaved drafts survive navigation
  - new lead validation and de-duplication
  - rescoring
  - Telegram settings and test message
  - AI settings
  - AI test console
  - WhatsApp inbox: thread, reply, take over, 24-hour rule on phones
  - appointment confirmation with calendar slots
  - WhatsApp connection check
  - the public website enquiry form still writes to `public.leads`
- **Save flows clicked one by one, all showing their success message with no JavaScript error:**
  - facts, add unit, add price
  - contact, note, task, qualification
  - business hours, persona, switches, compliance, scoring
  - knowledge entry, lead source, pipeline stage
- **No dead buttons:** no visible button lacks an action, and no helper button inside a form submits it by accident.
- **New regression tests:**
  - "saving keeps your place": fails without the fix (2006 → 1503 px jump)
  - "unsent reply survives Take over": fails without the fix
  - "date/time fields size like other fields"

## F. Backend and data safety
- All tests run against an in-memory fake. Nothing touched production data.
- No schema, row-level-security, environment or function change.
- Saves still use the same Supabase calls with `expectRows` checks.
- A failed save still keeps the form and its draft.

## G. Not verified / needs you
- **Real iPad and iPhone Safari.** Only Chromium is available here, and the date/time fix targets Safari's own behaviour. Please open Property projects (the Verified facts and Add promotion forms) and Settings → Business hours on the iPad, in portrait and landscape, and confirm the fields line up.
- **Real data and roles.** The live dashboard with your real data, and roles other than owner (advisor/viewer views are rendered in code paths already covered, but not clicked through with a real advisor account).
- **Screen reader.** Screen-reader use was not tested end to end; labels and focus handling were checked in code and by the automated label check.

## H. Status
- **Fully verified (automated):** items 2–8, 10, and the label part of item 9 — all 12 widths clean, all suites green (regression 40, unit 109, database all, browser 18 + layout 12).
- **Partially verified:** item 1 (fix applied and guarded by a test; needs a look on a real iPad), and touch-target sizes (CSS only).
- **Outstanding:** none known in the dashboard; per-project showroom locations in confirmations and per-project slot hours are a separate request still to be scoped.
