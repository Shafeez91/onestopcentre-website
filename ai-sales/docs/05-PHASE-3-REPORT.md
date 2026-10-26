# Phase 3 report — AI orchestrator, agents and safety checks (2026-10-27)

## 1. What was built
- **AI pipeline** (`ai-sales/lib/orchestrator.mjs`): for each buyer message
  1. **Deterministic guards** (`sales/shared/guard.mjs`): "STOP"/opt-out and "I want a person" are honoured without the AI (fixed BM/EN replies, consent withdrawn, follow-ups cancelled, AI paused, human alerted).
  2. **Verified context** (`ai-sales/lib/context.mjs`): website listings (labelled *indicative*), staff-verified facts, current prices (stale after the configured days), unit inventory (stale after the configured hours), approved in-date promotions, approved knowledge and FAQs found by full-text search, the lead's known qualification and open appointments.
  3. **AI draft** with Claude Opus 5.5 (`claude-opus-5-5`, effort `low`, structured JSON output, server-side refusal fallback `fallbacks: "default"`), one system prompt covering the reception, knowledge, qualification, recommendation, objection, appointment and handover roles plus the objection library.
  4. **Business-rule checker** (`sales/shared/validator.mjs`), independent of the AI: blocks unverified or unlabelled prices, guarantees, unverified availability, unapproved promotions, "confirmed" appointments without a calendar booking, impersonation, missing AI disclosure on the first reply, over-long replies and unknown links. A failing draft gets one corrected retry with the checker's feedback; if it still fails, a safe holding reply is used and a human is alerted.
  5. **Decision**: reply / handover (AI asked for it, or confidence below the threshold) / blocked / opt-out / paused / error (AI unavailable → safe reply + human alert).
  6. **CRM actions** it would take: qualification merge (keeps known answers), transparent re-score, project interest, pending appointment request (never confirmed), handover with summary and next action, follow-up cancellation. `applyActions()` performs them for live channels (Phase 4) with idempotent keys.
- **AI test console** (`/sales/#/ai-test`): chat as a buyer (new buyer or an existing lead), see the reply, the decision, the checker's verdict on each draft, the facts used and the CRM changes it *would* make. Simulation only; nothing is sent or saved. Rate-limited to 20 messages per minute.
- **Settings → AI model & limits**: model (default `claude-opus-5-5`), effort, confidence threshold, reply length.
- **Daily cost cap** (migration `20261027000005`, applied to production 2026-10-27): every buyer message the AI answers reserves one slot in a per-day counter (Malaysia time) inside the database before the model is called; the cap (default 200, 0 = AI off) is read from settings in the database, so it can't be bypassed. At the cap the AI is not called, the buyer gets the holding reply, an advisor is alerted, and one Telegram message goes out that day. If usage can't be checked, it fails closed. Settings → AI model & limits shows today's usage.
- **Run log**: every simulated run is written to `ai_agent_runs` when `SUPABASE_SERVICE_ROLE_KEY` is set.

## 2. Files
New: `ai-sales/lib/{llm,prompt,context,orchestrator}.mjs`, `sales/shared/{guard,validator}.mjs`, `netlify/functions/sales-ai.mjs`, `sales/js/aitest.js`, `ai-sales/tests/unit/{ai,syntax}.test.mjs`, `ai-sales/tests/eval/run-eval.mjs`.
Database: `ai_usage_daily` table and `ai_reserve_ai_call()` (migration 5).
Changed: `ai-sales/lib/server.mjs` (DB adapters), `sales/js/app.js` (route), `sales/js/admin.js` (effort setting), `sales/app.css`, browser tests. 

The Claude API is called over raw HTTPS rather than the official SDK because the site has no `package.json`/build step (adding one would change how Netlify publishes the live site). The request follows the documented Messages API shape and is covered by a test that checks headers and body.

## 3. Tests (actual results)
| Suite | Result |
|---|---|
| Existing-site regression | 40 / 40 |
| Unit (incl. 25 new AI tests: guards, validator, context freshness, prompt/schema, orchestrator decisions, retry/block, opt-out, handover, appointments, failures, API adapter; 19 ES-module syntax checks) | 59 / 59 |
| Database (incl. daily cap: exact count, refusal, one alert, per-day reset, permissions) | 31 / 31 |
| Browser (incl. the AI test console and AI limit settings) | 11 / 11 |
| **Live AI evaluation** (15 BM/EN/Manglish scenarios against the real model) | **Not run — no API key in this environment.** Dry run with a stub confirmed the grader works (a one-size reply fails 7/15). |

Bugs found and fixed by the new tests before release: "speak with an advisor" not recognised as a human request; "visited the showroom" missed by the impersonation check; "belum disahkan" (not yet confirmed) wrongly blocked; offering to check availability wrongly blocked; a shadowed `URL` constant broke link checking; a template typo that stopped the dashboard loading; console handlers reading a detached container.

## 4. Remaining limits
- Quality of real replies is unmeasured until the live evaluation runs with a key.
- The AI never sends anything yet: WhatsApp is Phase 4. `ai_auto_reply` stays off.
- Knowledge search is keyword-based (Postgres full text, BM + EN); no semantic search yet.

## 5. Needed from you
1. Netlify → Site configuration → Environment variables (scope **Functions**), then redeploy:
   - `ANTHROPIC_API_KEY` — your Anthropic API key
   - `AI_SALES_ENABLED` = `true`
   - optional `SUPABASE_SERVICE_ROLE_KEY` — enables the run log and staff invitations
2. Approve running the live evaluation (15 scenarios ≈ 30 model calls per run): `ANTHROPIC_API_KEY=… node ai-sales/tests/eval/run-eval.mjs`.

## 6. Next phase
Phase 4 — WhatsApp Cloud API webhook (signature check, idempotent events), outbound sending with the 24-hour window and approved templates, delivery statuses, the follow-up engine, Google Calendar availability and booking with reminders.
