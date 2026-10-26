# AI Sales module — architecture and implementation plan

## Guiding rule
The AI Sales module is **additive and isolated**. It never edits the existing pages, edge function, tables, policies, triggers or storage bucket. If it is switched off or removed, the website behaves exactly as before.

## Where things live

| Concern | Location | Why it is safe |
|---|---|---|
| Admin app (CRM, inbox, settings…) | `/sales/` → `sales/index.html`, `sales/js/*.js`, `sales/shared/*.mjs`, `sales/app.css` | New URL. Not matched by the edge function or any existing redirect. `noindex` via meta tag + `X-Robots-Tag` header; own Content-Security-Policy. |
| Server API, webhooks, schedulers | `netlify/functions/sales-*.mjs` | New Netlify Functions directory. Zero npm dependencies (plain `fetch` + `node:crypto`), so no `package.json` is introduced and Netlify's build stays a static publish. |
| Shared server logic | `ai-sales/lib/*.mjs` | Imported by functions; bundled by Netlify. Blocked from public download by a forced `404!` rule. |
| Database | New `public.ai_*` tables via migrations in `ai-sales/supabase/migrations/` | Purely additive. No FKs to existing tables (see audit §6.4). RLS on every table. |
| Documents | New **private** bucket `ai-docs` | Separate from the public `photos` bucket. |
| Tests / docs / env example | `ai-sales/` | Blocked from public download. |

Changes to existing files are limited to **appending** lines to `_redirects` (block `/ai-sales/*` and `/netlify/functions/*` source from being served) and `_headers` (noindex, no-cache and a CSP for `/sales/*`; JS MIME type for `/sales/shared/*`). `robots.txt` is deliberately left untouched. The regression suite enforces that the original lines stay first and unchanged.

## Feature flags (three layers)

1. **Server kill switch** — Netlify env `AI_SALES_ENABLED`. Unset/`false` → every `sales-*` function returns 503 (the WhatsApp webhook still answers `200` so Meta does not disable it, but does not process). *Default: off.*
2. **Database flags** — `ai_settings.flags` (`module_enabled`, `ai_auto_reply`, `whatsapp_outbound`, `follow_ups`, `calendar_booking`, `website_lead_import`). Owners toggle them in `/sales/` → Settings; every change is audited.
3. **Per-conversation** — `ai_conversations.mode` (`ai` / `human` / `paused`) for human takeover.

## Authentication and permissions
- Same Supabase Auth accounts as the existing admin. Everyone in `public.admins` is automatically an **owner** of the AI module (read-only use of the existing `is_admin()`).
- Additional staff go into `ai_team_members` with role `owner | manager | advisor | viewer`.
- Role checks in SQL: `ai_role()`, `ai_has_role(min)`. RLS: viewers read; advisors work leads/conversations/tasks/appointments; managers edit knowledge, templates, sequences, pipeline; owners manage team, flags and integrations.
- Netlify Functions verify the caller's Supabase JWT and role server-side; provider secrets exist only in Netlify env vars — never in the browser or in readable tables.

## Data model (Phase 2 migration `20261026000001_ai_sales_foundation.sql`)

| Group | Tables |
|---|---|
| Team & config | `ai_settings` (singleton), `ai_team_members`, `ai_pipeline_stages`, `ai_lead_sources`, `ai_campaigns` |
| CRM | `ai_contacts` (unique normalised phone / WhatsApp id), `ai_leads` (one *open* lead per contact, `lead_code` OSC-000001), `ai_lead_interests`, `ai_activities` (timeline + notes), `ai_tasks`, `ai_consent_records` (append-only) |
| Property knowledge | `ai_project_facts` (verified extras keyed by existing `projects.id`), `ai_project_units` (inventory), `ai_project_prices` (current + history), `ai_promotions`, `ai_faqs`, `ai_documents`, `ai_knowledge_chunks` (full-text search, BM + EN) |
| Messaging (schema now, logic Phase 4) | `ai_conversations`, `ai_messages`, `ai_message_templates`, `ai_objections` |
| Automation (schema now, logic Phase 3–4) | `ai_follow_up_sequences`, `ai_follow_up_jobs`, `ai_appointments`, `ai_jobs` (work queue) |
| AI & audit | `ai_agent_runs`, `ai_agent_tool_calls`, `ai_handover_events`, `ai_audit_logs`, `ai_integration_accounts`, `ai_webhook_events` |

The existing `public.projects` remains the single source of truth for listing data (name, location, layouts, indicative prices, facilities…). The AI tables only hold what the website does not have (verified unit prices, inventory, promotions with validity dates, booking fees, showroom hours, approved FAQs) and every fact carries `verified_at` / `source`.

Website enquiries (`public.leads`) are **copied** into the CRM by `ai_import_website_leads()` (idempotent, read-only on the source). No trigger is added to `public.leads`, so the enquiry form cannot be affected.

Retention: `ai_purge_expired()` (webhook payloads 90 days, agent-run payloads 180 days); `ai_erase_contact()` for PDPA erasure requests (anonymises, keeps consent proof).

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Audit, baseline, regression suite, plan | **Done** |
| 2 | Schema + RLS + roles, `/sales/` admin shell, CRM (contacts, leads, pipeline, timeline, tasks, consent), project knowledge base (verified facts, units, prices, promotions, FAQs, documents, search), team & permissions, flags, audit log, website-lead import, health endpoint | **Done** |
| 3 | LLM provider adapter (Claude by default, configurable), orchestrator, agents A–J, response validator (price/promo/availability/guarantee rules), lead scoring from conversation, handover summaries, offline evaluation suite (BM/EN/Manglish scenarios) | **Done** |
| 4 | WhatsApp Cloud API webhook (verify, HMAC signature, idempotency), outbound send with 24-h window + template rules, delivery statuses, follow-up scheduler (Netlify scheduled function), Google Calendar availability + booking + reminders | **This delivery** (see `06-PHASE-4-REPORT.md`) |
| 5 | Unified inbox UI with human takeover, follow-up sequence editor, appointment calendar UI, reports & analytics, campaign attribution | After 4 |
| 6 | End-to-end tests against sandbox accounts, security review, production runbook, controlled go-live | Last |

## Decisions and accounts needed from you (none block Phase 2)

1. **WhatsApp provider**: Meta WhatsApp Cloud API (recommended: no per-message markup) or Twilio. Needs a Meta Business account, a verified business, a phone number not currently used on the WhatsApp app, and approved message templates.
2. **LLM provider**: Anthropic Claude recommended; needs an API key (`ANTHROPIC_API_KEY`) in Netlify env.
3. **Calendar**: which Google account/calendar holds showroom & advisor availability; a Google Cloud service account with access to it.
4. **Business rules**: showroom address and opening hours, follow-up timing and maximum contacts per week, whether Manglish is allowed in first replies, who receives handover alerts (Telegram chat already used for website leads?).
5. **Supabase service-role key** stored in Netlify env (`SUPABASE_SERVICE_ROLE_KEY`, Functions scope only) — required from Phase 3.
