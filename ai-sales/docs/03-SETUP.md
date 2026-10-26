# AI Sales — setup, rollout and recovery

## 1. Database (one time)
Apply, in order, through Supabase → SQL editor (or the Supabase MCP / CLI):
1. `ai-sales/supabase/migrations/20261026000001_ai_sales_foundation.sql`
2. `ai-sales/supabase/migrations/20261026000002_ai_sales_seed_content.sql`
3. `ai-sales/supabase/migrations/20261026000003_ai_sales_telegram_reminders.sql` — Telegram staff notifications. Enables Supabase's `pg_cron` extension and schedules `ai_run_reminders()` every 5 minutes (job name `ai-sales-reminders`).

Both are additive: they only create `ai_*` tables/functions/views, the private `ai-docs` bucket and its four storage policies. They do not touch `projects`, `settings`, `leads`, `admins`, the `photos` bucket or any existing function/trigger. Verified on a local replica by `ai-sales/tests/db/run-db-tests.sh` (20 tests).

Check after applying (should return 0 rows of changes to existing data):
```sql
select count(*) from public.projects; select count(*) from public.leads;   -- same as before
select tablename, count(*) from pg_policies where schemaname='public' and tablename in ('projects','settings','leads','admins') group by 1; -- 8 policies total
```

## 2. Deploy
Merging this branch deploys:
- `/sales/` (static dashboard, `noindex`, own CSP)
- `/api/sales/health`, `/api/sales/team/invite` (Netlify Functions, zero dependencies)
No build command or `package.json` is introduced; the site remains a static publish.

## 3. Environment variables (Netlify → Site configuration → Environment variables, scope: Functions)
See `ai-sales/.env.example`. **Impact:** these are read only by the new `sales-*` functions; the existing website and edge function never read them. Values apply after the next deploy.
- `AI_SALES_ENABLED=true` — turns the server functions on (leave `false` until you want invitations / later the AI).
- `SUPABASE_SERVICE_ROLE_KEY` — lets owners send staff invitations from the dashboard. Without it, add staff in Supabase → Authentication → Invite user, then set their role in `/sales/` → Team.

## 4. First sign-in
Go to `https://onestopcentreproperty.com/sales/` and sign in with your existing website-admin account (you are an owner automatically). Then:
1. Overview → **Import into CRM** to copy existing website enquiries (read-only on `public.leads`; safe to repeat).
2. Property projects → add verified facts, units, prices and promotions per project.
3. Knowledge base → upload brochures / price lists, review and approve extracted entries.
4. Team → add advisors.

## 4b. Telegram notifications
Staff-only messages through the existing Telegram bot (token already in Supabase Vault as `telegram_bot_token`, chat `8821015679` by default — change it in `/sales/` → Settings → Telegram notifications):
- **Appointment alerts** instantly on request, confirmation, reschedule, cancellation, no-show.
- **Appointment reminders** 24 h and 2 h before (configurable); pending appointments are flagged "STILL PENDING CONFIRMATION".
- **Follow-up reminders** for open tasks with a due time (30 min before by default), plus follow-up sequence steps due while automatic sending is off.
- **Daily digest** at 8 am Malaysia time.
Every message is sent once (dedupe key), logged in `ai_notifications` with Telegram's HTTP status, and never blocks saving data. Turn it off with the master switch, or pause the schedule: `select cron.unschedule('ai-sales-reminders');`.
Note: messages contain buyer names and phone numbers — keep the chat private or staff-only.

## 5. Switching the module off
- Instantly, for staff: `/sales/` → Settings → Feature switches → untick *AI Sales module* (owners still get in).
- Server side: set `AI_SALES_ENABLED=false` and redeploy.
- Completely: revert the merge commit. The website is unaffected either way; the `ai_*` tables can stay.

## 6. Recovery
- Bad data edits: every change to settings, contacts, leads, prices, promotions, knowledge, templates, team and consent is in `ai_audit_logs` (who, when, before/after).
- Supabase daily backups / PITR cover the `ai_*` tables like the rest of the database.
- Full removal of the module's database objects (only if you decide to abandon it; **deletes all CRM data**):
  `drop table ... ai_*` in reverse dependency order, `delete from storage.buckets where id='ai-docs'` after emptying it, drop the `ai-docs*` storage policies and `ai_*` functions. Do not run without a backup.

## 7. Integrations (Phases 3–4 — not yet active)
- **WhatsApp (Meta Cloud API):** Meta Business account (verified), a WhatsApp Business phone number not in use on the WhatsApp app, a System User token with `whatsapp_business_messaging`, app secret, approved templates for messages outside the 24-hour window. Webhook URL will be `/api/sales/whatsapp/webhook`.
- **LLM:** Anthropic API key.
- **Google Calendar:** a Google Cloud service account shared on the showroom/advisor calendar(s). The private key will be stored in Supabase Vault rather than Netlify env (4 KB limit).
