# AI Sales — setup, rollout and recovery

## 1. Database (one time)
Apply, in order, through Supabase → SQL editor (or the Supabase MCP / CLI):
1. `ai-sales/supabase/migrations/20261026000001_ai_sales_foundation.sql`
2. `ai-sales/supabase/migrations/20261026000002_ai_sales_seed_content.sql`
3. `ai-sales/supabase/migrations/20261026000003_ai_sales_telegram_reminders.sql` — Telegram staff notifications. Enables Supabase's `pg_cron` extension and schedules `ai_run_reminders()` every 5 minutes (job name `ai-sales-reminders`).

All are additive: they only create `ai_*` tables/functions/views, the private `ai-docs` bucket and its four storage policies. They do not touch `projects`, `settings`, `leads`, `admins`, the `photos` bucket or any existing function/trigger. Verified on a local replica by `ai-sales/tests/db/run-db-tests.sh` (28 tests).

Check after applying (should return 0 rows of changes to existing data):
```sql
select count(*) from public.projects; select count(*) from public.leads;   -- same as before
select tablename, count(*) from pg_policies where schemaname='public' and tablename in ('projects','settings','leads','admins') group by 1; -- 8 policies total
```

## 2. Deploy
Merging this branch deploys:
- `/sales/` (static dashboard, `noindex`, own CSP)
- `/api/sales/health`, `/api/sales/team/invite`, `/api/sales/ai/simulate` (Netlify Functions, zero dependencies)
- Phase 4: `/api/sales/whatsapp/webhook` (Meta calls this), `/api/sales/whatsapp/send`, `/api/sales/appointments/slots|confirm`, and the scheduled `sales-worker` (every 2 minutes; about 22,000 short runs a month, well inside Netlify's free allowance). All stay inert until their credentials and switches are set.
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

## 4c. AI assistant (Phase 3)
Set in Netlify (Functions scope) and redeploy: `ANTHROPIC_API_KEY`, `AI_SALES_ENABLED=true` (optional `SUPABASE_SERVICE_ROLE_KEY` for the run log).
Then open `/sales/` → **AI test console** and chat as a buyer. Replies are simulated: nothing is sent and no lead changes.
Cost control: a daily cap on AI replies (default 200) in `/sales/` → Settings → AI model & limits, plus a spend limit in your Anthropic account (Settings → Limits) and prepaid credits with auto-reload off.
Live evaluation (calls the API, costs money): `ANTHROPIC_API_KEY=… node ai-sales/tests/eval/run-eval.mjs`.

## 5. Switching the module off
- Instantly, for staff: `/sales/` → Settings → Feature switches → untick *AI Sales module* (owners still get in).
- Server side: set `AI_SALES_ENABLED=false` and redeploy.
- Completely: revert the merge commit. The website is unaffected either way; the `ai_*` tables can stay.

## 6. Recovery
- Bad data edits: every change to settings, contacts, leads, prices, promotions, knowledge, templates, team and consent is in `ai_audit_logs` (who, when, before/after).
- Supabase daily backups / PITR cover the `ai_*` tables like the rest of the database.
- Full removal of the module's database objects (only if you decide to abandon it; **deletes all CRM data**):
  `drop table ... ai_*` in reverse dependency order, `delete from storage.buckets where id='ai-docs'` after emptying it, drop the `ai-docs*` storage policies and `ai_*` functions. Do not run without a backup.

## 7. WhatsApp, follow-ups and Google Calendar (Phase 4)
Everything below is off until you switch it on. Order matters: database → credentials → test → switches.

### 7a. Database (one time)
Supabase → SQL Editor → paste `ai-sales/supabase/APPLY-PHASE-4-IN-SQL-EDITOR.sql` → **Run** (choose "Run without RLS" if asked; the script sets its own permissions). Additive only.

### 7b. WhatsApp Business Platform (Meta Cloud API)
You need: a Meta Business account (verified for higher limits), and a phone number **not** currently used in the WhatsApp or WhatsApp Business app (it moves to the API; the app can no longer use it).
1. developers.facebook.com → My Apps → **Create app** → type *Business* → add the **WhatsApp** product.
2. WhatsApp → API Setup: add and verify your business phone number. Copy the **Phone number ID**.
3. Business Settings → Users → **System users** → add one (Admin) → *Generate new token* for the app with permissions `whatsapp_business_messaging` and `whatsapp_business_management`, expiry *Never*. Copy the token.
4. App settings → Basic → copy the **App secret**.
5. Netlify → Project configuration → Environment variables (tick *Contains secret values*): `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` (any long random text you choose), `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API keys → secret key). Redeploy.
6. Meta → WhatsApp → Configuration → **Webhook**: Callback URL `https://onestopcentreproperty.com/api/sales/whatsapp/webhook`, Verify token = your `WHATSAPP_VERIFY_TOKEN` → Verify and save → subscribe to the **messages** field.
7. Send a WhatsApp message to the number from your own phone. It appears in `/sales/` → WhatsApp inbox, and (with *AI auto-reply* still off) you get a Telegram alert.

### 7c. Message templates (needed outside the 24-hour window)
WhatsApp allows free text only within 24 hours of the buyer's last message. After that, only templates approved by Meta (WhatsApp Manager → Message templates) can be sent. Create them there, then record each in `/sales/` → Templates & objections → Message templates with the exact Meta name, language, variables and status *approved*. Used automatically:
- `appointment_reminder` (Utility) — variables `name, appointment`, e.g. "Hi {{1}}, a reminder of your appointment on {{2}}. Reply to this message if you need to change the time."
- `appointment_confirmation` (Utility) — variables `name, appointment`.
- Any template you attach to a follow-up step (e.g. a polite check-in). Marketing-category templates are only sent to buyers with recorded marketing consent.

### 7d. Google Calendar
1. console.cloud.google.com → create a project → enable **Google Calendar API**.
2. IAM & Admin → Service accounts → create one → Keys → *Add key* → JSON. From the file you need `client_email` and `private_key`.
3. In Google Calendar, open the showroom/advisor calendar → Settings and sharing → *Share with specific people* → add the service account email with **Make changes to events**. Copy the **Calendar ID** (Integrate calendar section).
4. Netlify (Functions scope): `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_CALENDAR_ID`, and the key either as `GOOGLE_PRIVATE_KEY` (secret) or, if Netlify reports its 4 KB variable limit, in Supabase → Project Settings → Vault as secret **google_private_key**. Redeploy.
5. `/sales/` → Settings → Business hours & rules: check opening hours and the Appointments section (length, notice, days ahead, default location).
6. Test: Appointments → *Confirm…* on a request → **Show free calendar slots**.

### 7e. Switch on (Settings → Feature switches), one at a time
1. **WhatsApp sending** — staff can reply from the inbox.
2. **AI auto-reply** — the AI answers buyers. Test from your own phone first; watch the inbox and Telegram.
3. **Calendar booking** — the AI offers free slots and books the one a buyer picks; the buyer gets a confirmation only after the event exists.
4. **Automated follow-ups** — activate the sequences you want under Follow-up automation (all start inactive).
Turning any switch off stops that part within 2 minutes; `AI_SALES_ENABLED=false` stops everything.

### 7f. Rules the code always applies
STOP / opt-out is honoured at once (even while a person handles the chat) and blocks further automated messages; marketing needs recorded consent and respects the weekly cap; automated messages go out only in business hours; nothing is sent outside the 24-hour window except approved templates; a buyer's reply cancels pending follow-ups; a person taking over a chat pauses the AI and follow-ups; redelivered webhooks and retried jobs never send twice.
