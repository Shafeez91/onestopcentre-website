# 18 · Research and real distances (Google Maps + web search)

## Why the AI used to give up

1. **No tools.** The AI could only use what was in its context: the website listing, staff-checked facts and the
   approved knowledge base. Nothing in the code called a map or a search engine.
2. **Instructions to escalate.** The prompt said "the context is your only source of truth" and "anything not in the
   context → an advisor will confirm".
3. **Inconsistent listings.** For M MIRA, the transit list said 2.4 km while the brochure text said 650 m. The
   conflict rule (PR #38) correctly stopped the AI from quoting either, so it handed over.

## What happens now

| Question | Tool | Where |
|---|---|---|
| Distance, route, walking / driving / train time, "nearest LRT", follow-ups like "kalau jalan kaki?" | Google Maps: Places API (New) + Routes API | `lib/maps.mjs`, `lib/research.mjs` |
| Anything our data does not cover that the AI would otherwise hand to an advisor (transport lines, schools, infrastructure, developer background) | Claude web search + web fetch (max 3 searches, 2 fetches, 20 s) | `lib/llm.mjs` `researchClaude`, `lib/research.mjs` |
| Prices, layouts, promotions, availability, booking terms | Our data only (website, staff-checked facts, approved knowledge); never researched | unchanged |

**Distances.**
- A cheap word check spots distance questions. A small planning call then names the project, the destination and
  the modes; it reads the recent conversation, so follow-ups work.
- The project's location comes, in order of authority, from:
  1. coordinates typed in the editor (`latlng`);
  2. the project's own Google Maps pin link (`mapUrl`, resolved to the pin);
  3. a place search, labelled *approximate*.

  A broad area is never used.
- Destinations come from a Places search biased to the project's area. For LRT / MRT / KTM / station questions,
  only transit-station results count, so "Sri Rampai Mart" is never mistaken for the station.
- Routes:
  - walking;
  - driving (a typical time *without live traffic*, stated as such);
  - public transport;
  - plus straight-line distance, which is never called a walking or road distance.
- The AI gets rounded figures, the kind of distance, the location source, the date and a Google Maps link, but no
  coordinates.
- Results are cached in `ai_geo_cache` (migration 17): project pins 90 days, places 30 days, routes 14 days.

**Web research.**
- It runs only when the first draft hands a factual, non-sensitive question to an advisor because the data is
  missing. It never runs for price, instalment, promotion, availability, negotiation, legal questions, complaints or
  requests for a person.
- Findings (bullets with source URLs) go into the context as `EXTERNAL (web search)`, and the AI writes the reply
  again. If nothing verifiable is found, the hand-over stands.
- Web pages are information, never instructions. The research prompt also says to distinguish operational, under
  construction, planned and proposed infrastructure.

**Checks that still apply (business rules, blocking):**
- `unverified_distance`: any distance or travel time in a reply must match one in the context (map lookups, listing,
  research, the buyer's own words), within rounding.
- `unverified_check`: "I checked Google Maps" or "I searched online" is only allowed when it actually happened for
  that reply.
- The existing price, layout-price, guarantee, availability and promotion rules are unchanged.

**Budgets.**
- A web research round starts only if the first draft took under 18 s, and is limited to 20 s, so a reply stays
  within Netlify's 60 s.
- The scheduled 2-minute worker (30 s limit) uses maps but no web research.
- The daily AI limit is charged once per reply.

**Switches.** Settings → AI: "Measure distances with Google Maps" and "Research the web when our data has no
answer" (both on by default).

**Test console.** "Why the AI did this" shows:
- what the answer is based on (our data / Google Maps / web research);
- each lookup: project → place, mode, distance, time, location source, date and link;
- the web research outcome and its sources;
- any errors.

Simulation writes only the map cache, never leads or messages.

## Setup (owner)

1. **Database:** run `ai-sales/supabase/APPLY-GEO-CACHE-IN-SQL-EDITOR.sql` in the Supabase SQL Editor. Without it
   everything still works, just without caching.
2. **Google Maps key** (Google Cloud console):
   1. Use a project with **billing enabled**.
   2. Enable **Places API (New)** and **Routes API**.
   3. Create an API key, then under *API restrictions* allow only those two APIs.
   4. In Netlify → Site configuration → Environment variables, add `GOOGLE_MAPS_API_KEY` (scope: Functions), then
      redeploy.
   5. Press **Integrations → Test Google Maps** in the dashboard.
3. **Web search:** in the Claude Console (console.anthropic.com) → Settings → Privacy / Features, allow **web search**
   (and web fetch) for the organisation. Web search is billed per search on top of tokens.
4. **Map pins:** every project's "Google Maps link" in the website editor should point at the project itself, not
   the area. Typed coordinates (`latlng`, "3.2051, 101.7312") override it.

## Costs (rough)

- Google: Places Text Search and Routes are billed per request after Google's monthly free usage. Each distance
  question is about 1 place search + 1–3 route requests, much less with the cache.
- Claude web search: billed per search (max 3 per research round) plus tokens.
- The planning call for distance questions is one small extra AI call.

## Tests

- `tests/regression/research.test.mjs`: the 15 scenarios, with Google and the web mocked using the documented response
  shapes.
- `tests/unit/functions.test.mjs`: the Integrations "Test Google Maps" endpoint.
- `tests/db` T64: the cache table is server-only.
- Browser e2e: the console research rows.

Not verifiable in CI: live Google and live web search. Use "Test Google Maps" and the AI test console after setup.
