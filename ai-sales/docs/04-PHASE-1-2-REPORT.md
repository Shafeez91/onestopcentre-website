# Phase 1 + 2 report — 2026-10-26

## 1. Features implemented
**Phase 1:** full audit (`01-BASELINE-AUDIT.md`), architecture and plan (`02-IMPLEMENTATION-PLAN.md`), regression suite that locks the existing site.

**Phase 2:** AI Sales foundation as an isolated module at `/sales/`:
- Sign-in with the existing Supabase accounts; website admins are owners; roles owner / manager / advisor / viewer enforced in the database (RLS) and the UI.
- Three-layer feature flags (server kill switch, database switches, per-lead AI pause).
- CRM: contacts with Malaysian phone de-duplication, one open lead per contact, `OSC-000001` codes, pipeline with editable stages, Kanban board, qualification form with transparent configurable scoring, projects of interest, tasks, notes/call timeline, advisor-recorded appointments, append-only consent records, human-handover flag and queue, PDPA erasure.
- Website enquiries → CRM import (idempotent, read-only on `public.leads`).
- Property knowledge: existing listings shown read-only; verified facts, unit inventory (with freshness), price history (new price closes the old one), promotions with approval + validity, FAQs, document upload to a private bucket with in-browser text extraction (PDF/XLSX/CSV/TXT), draft→approved knowledge entries, BM/EN full-text search tester.
- Objection library (15 Malaysian objections seeded, BM + EN guidance), message templates with WhatsApp approval status, follow-up sequences (seeded inactive as examples), campaigns and lead sources, measured-only reports, team management with invitations, integrations status, audit log viewer, retention clean-up.
- Server: `/api/sales/health`, `/api/sales/team/invite` (zero-dependency Netlify Functions).

## 2. Files and database changes
- New: `sales/**`, `netlify/functions/sales-*.mjs`, `ai-sales/**` (lib, migrations, tests, docs, `.env.example`, `run-tests.sh`).
- Existing files: only **appended** lines to `_redirects` (hide source folders) and `_headers` (`/sales/*` noindex + CSP). Every other original file is byte-identical (enforced by test).
- Database: two migration files, **not yet applied to production** (the Supabase tool's confirmation prompt timed out). Production was verified unchanged afterwards.

## 3. Tests executed (actual results)
| Suite | Result |
|---|---|
| Existing-site regression (file hashes, edge function: home, BM, property SEO pages, 301/404, sitemap, /admin, DB-down fallback) | 40 / 40 pass (also 40/40 on the untouched baseline before any change) |
| Unit (scoring, phone, CSV, chunking, server functions incl. auth/role checks and secret non-disclosure) | 14 / 14 pass |
| Database (local Postgres 16 with Supabase stand-in + replica of existing schema) | 20 / 20 pass |
| Browser (Playwright; 29 sections × phone 390px / iPad 820px / desktop 1366px, real CSP, login, drafts survive navigation, new-lead dedupe flow, rescoring, existing homepage + enquiry form) | 8 / 8 pass |

Not tested: the live production database after migration (not applied yet), real Netlify deployment, real email invitations.

## 4. Remaining issues / limits
- Lead search filters the latest 1,000 leads in the browser; move to server-side search when volume grows.
- Scanned (image-only) PDFs have no extractable text; key facts must be entered manually (OCR could be added later).
- Inbox, AI replies, WhatsApp, calendar booking and the follow-up engine are Phases 3–5; their screens say so and nothing is sent to customers.
- Pre-existing advisories left untouched for your decision: `is_admin()` callable by anon, `pg_net` in `public`, leaked-password protection off.

## 5. Needed from you
1. **Approve applying the two migrations** to the production database (additive only).
2. Merge/deploy this branch when ready (or review a deploy preview first).
3. Optional now, required for Phase 3+: `SUPABASE_SERVICE_ROLE_KEY`, `AI_SALES_ENABLED`, `ANTHROPIC_API_KEY` in Netlify (Functions scope).
4. Decisions listed in `02-IMPLEMENTATION-PLAN.md` (WhatsApp provider/number, calendar, showroom hours, follow-up limits).

## 6. Next phase
Phase 3 — LLM adapter (Claude by default), orchestrator with the specialised agents, response validator (verified prices/promotions/availability only, no guarantees, AI disclosure), automatic qualification and scoring from conversations, handover summaries, and an offline BM/EN/Manglish evaluation suite — all testable before WhatsApp is connected.
