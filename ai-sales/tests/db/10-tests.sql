-- Database tests for the AI Sales migration, run on a throwaway local Postgres by run-db-tests.sh.
-- Each block runs in its own transaction and rolls back, so tests are independent.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create or replace function public.t_login(p_email text) returns void language sql security definer as $$
  select set_config('request.jwt.claims',
    json_build_object('email', p_email, 'role', 'authenticated',
      'sub', (select id from auth.users where email = p_email))::text, true)
$$;
grant execute on function public.t_login(text) to authenticated;

-- shared setup: staff accounts
insert into public.ai_team_members (email, role) values
  ('advisor@test.local','advisor'), ('viewer@test.local','viewer'),
  ('unconfirmed@test.local','advisor'), ('manager@test.local','manager');

\echo 'T01 existing website: anon can still read listings/settings and send an enquiry'
begin;
set local role anon;
do $$ begin
  assert (select count(*) from public.projects) = 2, 'anon reads published projects';
  assert (select count(*) from public.settings) = 1, 'anon reads settings';
end $$;
insert into public.leads (name, phone, consent) values ('Anon Buyer', '0123456789', true);
rollback;

\echo 'T02 anon has no privilege on any ai_ table, view or function'
do $$ declare r record; begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname like 'ai\_%' and c.relkind in ('r','v') loop
    assert not has_table_privilege('anon', 'public.' || r.relname, 'select'), 'anon can select ' || r.relname;
    assert not has_table_privilege('anon', 'public.' || r.relname, 'insert'), 'anon can insert ' || r.relname;
  end loop;
  for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'ai\_%' loop
    assert not has_function_privilege('anon', r.sig, 'execute'), 'anon can execute ' || r.sig;
  end loop;
end $$;

\echo 'T03 every ai_ table has row-level security enabled'
do $$ begin
  assert not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname like 'ai\_%' and c.relkind = 'r' and not c.relrowsecurity), 'table without RLS';
end $$;

\echo 'T04 roles: admins are owners; staff need a confirmed account; strangers get nothing'
begin;
set local role authenticated;
select public.t_login('owner@test.local');      do $$ begin assert public.ai_role() = 'owner', 'owner'; end $$;
select public.t_login('advisor@test.local');    do $$ begin assert public.ai_role() = 'advisor', 'advisor'; end $$;
select public.t_login('unconfirmed@test.local');do $$ begin assert public.ai_role() is null, 'unconfirmed has no role'; end $$;
select public.t_login('stranger@test.local');   do $$ begin
  assert public.ai_role() is null, 'stranger has no role';
  assert (select count(*) from public.ai_settings) = 0, 'stranger cannot read settings';
  assert (select count(*) from public.ai_pipeline_stages) = 0, 'stranger cannot read stages';
end $$;
rollback;

\echo 'T05 only owners change settings/flags, and every change is audited'
begin;
set local role authenticated;
select public.t_login('manager@test.local');
update public.ai_settings set flags = flags || '{"ai_auto_reply":true}';
do $$ begin assert (select flags ->> 'ai_auto_reply' from public.ai_settings) = 'false', 'manager must not change flags'; end $$;
select public.t_login('owner@test.local');
update public.ai_settings set flags = flags || '{"ai_auto_reply":true}';
do $$ begin
  assert (select flags ->> 'ai_auto_reply' from public.ai_settings) = 'true', 'owner changes flags';
  assert exists (select 1 from public.ai_audit_logs where table_name = 'ai_settings' and actor = 'owner@test.local'
                 and changes ? 'flags'), 'flag change audited';
end $$;
rollback;

\echo 'T06 Malaysian phone normalisation'
do $$ begin
  assert public.ai_normalize_phone('012-345 6789') = '60123456789';
  assert public.ai_normalize_phone('+60 12-345 6789') = '60123456789';
  assert public.ai_normalize_phone('0060123456789') = '60123456789';
  assert public.ai_normalize_phone('123456789') = '60123456789';
  assert public.ai_normalize_phone('011-2345 6789') = '601123456789';
  assert public.ai_normalize_phone('03-2345 6789') = '60323456789';
  assert public.ai_normalize_phone('+65 9123 4567') = '6591234567';
  assert public.ai_normalize_phone('abc') is null;
  assert public.ai_normalize_phone('123') is null;
end $$;

\echo 'T07 duplicate contact prevention and one open lead per contact'
begin;
set local role authenticated;
select public.t_login('advisor@test.local');
do $$ declare a uuid; b uuid; c uuid; l1 uuid; l2 uuid; begin
  a := public.ai_upsert_contact('012-345 6789', 'Aisyah', null);
  b := public.ai_upsert_contact('+60123456789', null, 'aisyah@example.test');
  c := public.ai_upsert_contact(null, 'Other', 'other@example.test');
  assert a = b, 'same phone in two formats = same contact';
  assert a <> c;
  assert (select email from public.ai_contacts where id = a) = 'aisyah@example.test', 'missing email filled in';
  assert (select full_name from public.ai_contacts where id = a) = 'Aisyah', 'existing name kept';
  l1 := public.ai_open_lead(a, 'WhatsApp (direct)', 't1');
  l2 := public.ai_open_lead(a, 'WhatsApp (direct)', 't2');
  assert l1 = l2, 'second enquiry reuses the open lead';
  assert (select count(*) from public.ai_lead_interests where lead_id = l1) = 2, 'both projects recorded as interests';
  assert (select lead_code from public.ai_leads where id = l1) ~ '^OSC-\d{6}$', 'lead code format';
  assert (select s.name from public.ai_leads l join public.ai_pipeline_stages s on s.id = l.stage_id where l.id = l1) = 'New Enquiry';
end $$;
rollback;

\echo 'T08 viewers cannot create or change CRM data'
begin;
set local role authenticated;
select public.t_login('viewer@test.local');
do $$ begin
  begin perform public.ai_upsert_contact('0123456789'); assert false, 'viewer created a contact';
  exception when raise_exception then null; end;
  begin insert into public.ai_contacts (phone_e164) values ('60111111111'); assert false, 'viewer inserted';
  exception when insufficient_privilege then null; end;
end $$;
rollback;

\echo 'T09 website enquiries import into the CRM idempotently and public.leads is untouched'
begin;
-- enquiries from before automatic filing (T50 covers new ones, filed as they arrive)
alter table public.leads disable trigger ai_leads_website_notify;
insert into public.leads (name, phone, email, project, message, consent) values
  ('Farid', '012-999 8888', null, 'Test Residence', 'Berapa harga?', true),
  ('Mei Ling', null, 'mei@example.test', 'Unknown Project', 'Price list please', true),
  ('No Contact', null, '-', null, 'hi', true);
alter table public.leads enable trigger ai_leads_website_notify;
create temp table t_before on commit drop as select * from public.leads;
grant select on t_before to authenticated;
set local role authenticated;
select public.t_login('advisor@test.local');
do $$ declare r jsonb; begin
  r := public.ai_import_website_leads();
  assert (r ->> 'imported')::int = 2, 'two enquiries imported: ' || r;
  assert (r ->> 'skipped_no_contact')::int = 1, 'one skipped';
  r := public.ai_import_website_leads();
  assert (r ->> 'imported')::int = 0, 'second run imports nothing';
  assert (select count(*) from public.ai_contacts) = 2;
  assert (select primary_project_id from public.ai_leads l join public.ai_contacts c on c.id = l.contact_id where c.phone_e164 = '60129998888') = 't1',
    'project name matched to listing';
  assert (select count(*) from public.ai_consent_records where purpose = 'service' and source = 'website_form') = 2;
  assert not exists (select 1 from public.ai_consent_records where purpose = 'marketing'), 'never assumes marketing consent';
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.leads) = 3, 'no website enquiry added or removed';
  assert not exists (select * from public.leads except select * from t_before), 'public.leads rows unchanged';
end $$;
rollback;

\echo 'T10 import respects the feature flag'
begin;
update public.ai_settings set flags = flags || '{"website_lead_import":false}';
set local role authenticated;
select public.t_login('advisor@test.local');
do $$ begin
  begin perform public.ai_import_website_leads(); assert false, 'import ran while disabled';
  exception when raise_exception then null; end;
end $$;
rollback;

\echo 'T11 stage changes are logged on the timeline and closing stages close the lead'
begin;
set local role authenticated;
select public.t_login('advisor@test.local');
do $$ declare c uuid; l uuid; begin
  c := public.ai_upsert_contact('0177777777');
  l := public.ai_open_lead(c);
  update public.ai_leads set stage_id = (select id from public.ai_pipeline_stages where key = 'interested') where id = l;
  assert exists (select 1 from public.ai_activities where lead_id = l and kind = 'stage_change' and body = 'New Enquiry → Interested / Qualified');
  update public.ai_leads set stage_id = (select id from public.ai_pipeline_stages where key = 'signed_all'), owner_email = 'advisor@test.local' where id = l;
  assert (select closed_at from public.ai_leads where id = l) is not null, 'won closes the lead';
  assert exists (select 1 from public.ai_activities where lead_id = l and kind = 'assignment');
  assert public.ai_open_lead(c) <> l, 'a returning buyer after closing gets a new lead';
end $$;
rollback;

\echo 'T12 price history: a new current price closes the previous one'
begin;
set local role authenticated;
select public.t_login('manager@test.local');
insert into public.ai_project_prices (project_id, unit_type, price_myr, effective_from, source) values ('t1','Type A',450000,'2026-01-01','price list Jan');
insert into public.ai_project_prices (project_id, unit_type, price_myr, effective_from, source) values ('t1','Type A',465000,'2026-06-01','price list Jun');
do $$ begin
  assert (select count(*) from public.ai_project_prices where project_id='t1' and effective_to is null) = 1, 'one current price';
  assert (select price_myr from public.ai_project_prices where project_id='t1' and effective_to is null) = 465000;
  assert (select effective_to from public.ai_project_prices where price_myr = 450000) = '2026-05-31', 'old price kept as history';
end $$;
rollback;

\echo 'T13 consent records are append-only and opt-out is the current state'
begin;
set local role authenticated;
select public.t_login('advisor@test.local');
do $$ declare c uuid; begin
  c := public.ai_upsert_contact('0166666666');
  insert into public.ai_consent_records (contact_id, channel, purpose, status, source, recorded_at) values (c,'whatsapp','marketing','granted','whatsapp_optin', now() - interval '1 day');
  insert into public.ai_consent_records (contact_id, channel, purpose, status, source) values (c,'whatsapp','marketing','withdrawn','whatsapp_stop');
  assert (select status from public.ai_consent_current where contact_id = c and purpose = 'marketing') = 'withdrawn';
end $$;
reset role;
do $$ begin
  begin update public.ai_consent_records set status = 'granted'; assert false, 'consent updated';
  exception when raise_exception then null; end;
end $$;
rollback;

\echo 'T14 knowledge search returns approved content only (BM + EN)'
begin;
set local role authenticated;
select public.t_login('manager@test.local');
insert into public.ai_knowledge_chunks (project_id, lang, title, content, approved) values
  ('t1','ms','Yuran','Yuran penyelenggaraan ialah RM0.35 kps, disahkan oleh pemaju.', true),
  ('t1','en','Draft','Maintenance fee draft not yet checked.', false);
insert into public.ai_faqs (project_id, lang, question, answer, approved) values ('t1','en','What is the maintenance fee?','RM0.35 psf (verified).', true);
do $$ begin
  assert (select count(*) from public.ai_search_knowledge('yuran penyelenggaraan', 't1')) = 1, 'BM search';
  assert (select count(*) from public.ai_search_knowledge('maintenance fee', 't1')) = 1, 'EN search finds only the approved FAQ';
  assert (select count(*) from public.ai_search_knowledge('maintenance fee', 't1', false)) = 2, 'drafts visible when asked';
  assert (select count(*) from public.ai_search_knowledge('maintenance fee', 't2')) = 0, 'scoped to project';
end $$;
rollback;

\echo 'T15 an appointment cannot be "confirmed" without a real time slot'
begin;
set local role authenticated;
select public.t_login('advisor@test.local');
do $$ declare l uuid; begin
  l := public.ai_open_lead(public.ai_upsert_contact('0155555555'));
  insert into public.ai_appointments (lead_id, kind, preferred_text) values (l, 'showroom_visit', 'Sabtu petang');
  begin insert into public.ai_appointments (lead_id, kind, status) values (l, 'showroom_visit', 'confirmed'); assert false, 'confirmed without slot';
  exception when check_violation then null; end;
end $$;
rollback;

\echo 'T16 PDPA erasure: owners only, removes personal data, keeps consent proof, scrubs audit'
begin;
set local role authenticated;
select public.t_login('owner@test.local');
do $$ declare c uuid; begin
  c := public.ai_upsert_contact('0144444444', 'Erase Me', 'erase@example.test');
  perform public.ai_open_lead(c);
  insert into public.ai_consent_records (contact_id, channel, purpose, status, source) values (c,'any','service','granted','advisor_recorded');
  perform public.ai_erase_contact(c, 'customer request by WhatsApp');
  assert (select phone_e164 is null and email is null and full_name = '[erased]' from public.ai_contacts where id = c);
  assert (select count(*) from public.ai_consent_records where contact_id = c) = 1, 'consent proof kept';
  assert not exists (select 1 from public.ai_audit_logs where table_name = 'ai_contacts' and record_id = c::text and changes::text like '%0144444444%'), 'audit scrubbed';
end $$;
select public.t_login('advisor@test.local');
do $$ begin
  begin perform public.ai_erase_contact((select id from public.ai_contacts limit 1), 'x'); assert false, 'advisor erased';
  exception when raise_exception then null; end;
end $$;
rollback;

\echo 'T17 the job queue claim function is server-only'
do $$ begin
  assert not has_function_privilege('authenticated', 'public.ai_claim_jobs(int, interval)', 'execute');
  assert has_function_privilege('service_role', 'public.ai_claim_jobs(int, interval)', 'execute');
end $$;
begin;
insert into public.ai_jobs (kind, dedupe_key) values ('process_inbound','m1'),('process_inbound','m2');
do $$ begin
  assert (select count(*) from public.ai_claim_jobs(1)) = 1;
  assert (select count(*) from public.ai_claim_jobs(10)) = 1, 'already-claimed job is not handed out twice';
  begin insert into public.ai_jobs (kind, dedupe_key) values ('process_inbound','m1'); assert false, 'duplicate job';
  exception when unique_violation then null; end;
end $$;
rollback;

\echo 'T18 storage: ai-docs is private and manager-only; photos bucket rules unchanged'
begin;
set local role authenticated;
select public.t_login('advisor@test.local');
do $$ begin
  begin insert into storage.objects (bucket_id, name) values ('ai-docs','x.pdf'); assert false, 'advisor uploaded';
  exception when insufficient_privilege then null; end;
end $$;
select public.t_login('manager@test.local');
insert into storage.objects (bucket_id, name) values ('ai-docs','brochure.pdf');
do $$ begin
  begin insert into storage.objects (bucket_id, name) values ('photos','x.jpg'); assert false, 'non-admin manager wrote to photos';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin assert (select not public from storage.buckets where id = 'ai-docs'), 'ai-docs must be private'; end $$;
rollback;

\echo 'T19 existing CMS can still delete a project that the CRM references (no foreign keys)'
begin;
set local role authenticated;
select public.t_login('owner@test.local');
do $$ declare l uuid; begin
  l := public.ai_open_lead(public.ai_upsert_contact('0133333333'), null, 't2');
  insert into public.ai_project_facts (project_id, booking_fee) values ('t2', 'RM1,000');
  delete from public.projects where id = 't2';
  assert not exists (select 1 from public.projects where id = 't2'), 'CMS delete works';
  assert (select primary_project_id from public.ai_leads where id = l) = 't2', 'CRM history kept';
end $$;
rollback;

\echo 'T20 existing objects unchanged: policies on projects/settings/leads/admins/photos'
do $$ begin
  assert (select count(*) from pg_policies where schemaname = 'public' and tablename in ('projects','settings','leads','admins')) = 8;
  assert (select count(*) from pg_policies where schemaname = 'storage' and policyname not like 'ai-docs%') = 2;
  -- the website's own triggers are kept; its enquiry alert (leads_notify) is deliberately replaced by
  -- ai_leads_website_notify (files the enquiry in the CRM, alerts only for a new lead — migration 10)
  assert (select string_agg(c.relname || '.' || t.tgname, ',' order by c.relname, t.tgname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where c.relname in ('projects','settings','leads') and not t.tgisinternal)
         = 'leads.ai_leads_website_notify,leads.leads_guard,projects.projects_touch,settings.settings_touch', 'only the agreed change on existing tables';
  assert exists (select 1 from pg_proc where proname = 'notify_new_lead'), 'old alert function kept for rollback';
end $$;

\echo 'T21 Telegram: new appointment sends one alert with buyer, time and link; no duplicates on re-save'
begin;
set local role authenticated;
select public.t_login('advisor@test.local');
do $$ declare l uuid; ap uuid; begin
  l := public.ai_open_lead(public.ai_upsert_contact('0123334444', 'Aminah'), null, 't1');
  insert into public.ai_appointments (lead_id, kind, project_id, status, start_at, advisor_email)
  values (l, 'showroom_visit', 't1', 'confirmed', now() + interval '3 days', 'advisor@test.local') returning id into ap;
  update public.ai_appointments set notes = 'bring IC' where id = ap;            -- not a status/time change
end $$;
reset role;
do $$ declare m text; begin
  assert (select count(*) from net.calls) = 1, 'exactly one Telegram call, got ' || (select count(*) from net.calls);
  m := (select body ->> 'text' from net.calls);
  assert m like '%New appointment (confirmed)%' and m like '%Aminah%' and m like '%Test Residence%' and m like '%+60123334444%' and m like '%/sales/#/lead/%', m;
  assert (select url from net.calls) = 'https://api.telegram.org/botTEST-TOKEN/sendMessage';
  assert (select body ->> 'chat_id' from net.calls) = '8821015679';
  assert (select status from public.ai_notifications) = 'sent';
end $$;
rollback;

\echo 'T22 Telegram: reschedule and cancellation each alert once'
begin;
set local role authenticated;
select public.t_login('advisor@test.local');
do $$ declare l uuid; ap uuid; begin
  l := public.ai_open_lead(public.ai_upsert_contact('0123335555'));
  insert into public.ai_appointments (lead_id, kind, preferred_text) values (l, 'phone_call', 'Sabtu pagi') returning id into ap;
  update public.ai_appointments set start_at = now() + interval '2 days', status = 'confirmed' where id = ap;
  update public.ai_appointments set start_at = now() + interval '4 days', status = 'rescheduled' where id = ap;
  update public.ai_appointments set status = 'cancelled' where id = ap;
end $$;
reset role;
do $$ begin
  assert (select count(*) from net.calls) = 4, 'request + confirm + reschedule + cancel, got ' || (select count(*) from net.calls);
  assert exists (select 1 from net.calls where body ->> 'text' like '%pending confirmation%Preferred: Sabtu pagi (not confirmed)%');
  assert exists (select 1 from net.calls where body ->> 'text' like '%rescheduled%');
  assert exists (select 1 from net.calls where body ->> 'text' like '%cancelled%');
end $$;
rollback;

\echo 'T23 appointment reminders: 24 h and 2 h before, smallest window only, never twice, none after cancel'
begin;
update public.ai_settings set notifications = notifications || '{"appointment_changes": false, "daily_digest": false}';
do $$ declare l uuid; ap uuid; ap2 uuid; t0 timestamptz := '2026-11-02 02:00+00'; r jsonb; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  l := public.ai_open_lead(public.ai_upsert_contact('0129990000', 'Reminder Test'));
  insert into public.ai_appointments (lead_id, kind, status, start_at) values (l, 'showroom_visit', 'confirmed', t0 + interval '30 hours') returning id into ap;
  r := public.ai_run_reminders(t0);                                        -- 30 h before: nothing yet
  assert (r ->> 'appointment_reminders')::int = 0, r::text;
  r := public.ai_run_reminders(t0 + interval '7 hours');                  -- 23 h before: 24 h reminder
  assert (r ->> 'appointment_reminders')::int = 1, r::text;
  r := public.ai_run_reminders(t0 + interval '7 hours 5 minutes');        -- re-run: no duplicate
  assert (r ->> 'appointment_reminders')::int = 0, r::text;
  r := public.ai_run_reminders(t0 + interval '28 hours 30 minutes');      -- 1.5 h before: 2 h reminder
  assert (r ->> 'appointment_reminders')::int = 1, r::text;
  assert (select count(*) from net.calls where body ->> 'text' like '%Appointment in 1 day(s)%') = 1;
  assert (select count(*) from net.calls where body ->> 'text' like '%Appointment in 2 hour(s)%') = 1;
  -- booked 1 hour ahead: only the 2 h reminder fires, not both
  insert into public.ai_appointments (lead_id, kind, status, start_at) values (l, 'video_call', 'pending_confirmation', t0 + interval '50 hours') returning id into ap2;
  r := public.ai_run_reminders(t0 + interval '49 hours');
  assert (r ->> 'appointment_reminders')::int = 1, r::text;
  assert exists (select 1 from net.calls where body ->> 'text' like '%2 hour(s) — STILL PENDING CONFIRMATION%');
  update public.ai_appointments set status = 'cancelled' where id = ap2;
  perform public.ai_run_reminders(t0 + interval '49 hours 30 minutes');
  assert (select count(*) from net.calls) = 3, 'nothing for cancelled appointments';
end $$;
rollback;

\echo 'T24 follow-up reminders: task due soon is announced once; done/old tasks are not'
begin;
update public.ai_settings set notifications = notifications || '{"appointment_changes": false, "daily_digest": false}';
do $$ declare l uuid; t0 timestamptz := '2026-11-02 02:00+00'; r jsonb; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  l := public.ai_open_lead(public.ai_upsert_contact('0128880000', 'Follow Me'));
  insert into public.ai_tasks (lead_id, title, due_at, assignee_email) values
    (l, 'Send floor plan Type B', t0 + interval '20 minutes', 'advisor@test.local'),
    (l, 'Call back about LPPSA', t0 + interval '3 hours', null),
    (l, 'Already done', t0 + interval '10 minutes', null),
    (l, 'Ancient overdue', t0 - interval '3 days', null);
  update public.ai_tasks set status = 'done' where title = 'Already done';
  r := public.ai_run_reminders(t0);
  assert (r ->> 'task_reminders')::int = 1, r::text;
  assert exists (select 1 from net.calls where body ->> 'text' like '%Follow-up due%Send floor plan Type B%Follow Me%advisor@test.local%');
  r := public.ai_run_reminders(t0 + interval '1 minute');
  assert (r ->> 'task_reminders')::int = 0, 'no duplicate';
  r := public.ai_run_reminders(t0 + interval '2 hours 40 minutes');
  assert (r ->> 'task_reminders')::int = 1, 'second task when its time comes';
end $$;
rollback;

\echo 'T25 follow-up sequence steps due are announced for manual sending while automation is off'
begin;
update public.ai_settings set notifications = notifications || '{"appointment_changes": false, "daily_digest": false}';
do $$ declare l uuid; s uuid; t0 timestamptz := '2026-11-02 02:00+00'; r jsonb; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  l := public.ai_open_lead(public.ai_upsert_contact('0127770000', 'Seq Buyer'));
  select id into s from public.ai_follow_up_sequences where name = 'New enquiry (example)';
  insert into public.ai_follow_up_jobs (lead_id, sequence_id, step_index, run_at, idempotency_key) values (l, s, 1, t0, 'k1');
  r := public.ai_run_reminders(t0);
  assert (r ->> 'follow_ups_due')::int = 1, r::text;
  assert exists (select 1 from net.calls where body ->> 'text' like '%send manually%step 2%Share one useful verified fact%');
  update public.ai_settings set flags = flags || '{"follow_ups": true}';
  insert into public.ai_follow_up_jobs (lead_id, sequence_id, step_index, run_at, idempotency_key) values (l, s, 2, t0, 'k2');
  r := public.ai_run_reminders(t0);
  assert (r ->> 'follow_ups_due')::int = 0, 'engine on: no manual reminder';
end $$;
rollback;

\echo 'T26 daily digest: once per Malaysian day, after the configured hour'
begin;
update public.ai_settings set notifications = notifications || '{"appointment_changes": false}';
do $$ declare r jsonb; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_run_reminders('2026-11-02 23:00+00');   -- 07:00 in KL: too early
  assert (r ->> 'digest')::int = 0, r::text;
  r := public.ai_run_reminders('2026-11-03 00:05+00');   -- 08:05 in KL
  assert (r ->> 'digest')::int = 1, r::text;
  r := public.ai_run_reminders('2026-11-03 05:00+00');   -- later the same day
  assert (r ->> 'digest')::int = 0, r::text;
  assert exists (select 1 from net.calls where body ->> 'text' like '%AI Sales — Tue 03 Nov%Appointments today: 0%Overdue follow-ups%');
end $$;
rollback;

\echo 'T27 notifications switched off: nothing is sent; missing token is logged as skipped'
begin;
update public.ai_settings set notifications = notifications || '{"telegram_enabled": false}';
set local role authenticated;
select public.t_login('advisor@test.local');
do $$ declare l uuid; begin
  l := public.ai_open_lead(public.ai_upsert_contact('0126660000'));
  insert into public.ai_appointments (lead_id, kind, status, start_at) values (l, 'phone_call', 'confirmed', now() + interval '1 hour');
end $$;
reset role;
do $$ begin
  assert (select count(*) from net.calls) = 0;
  assert (public.ai_run_reminders() ->> 'skipped') = 'telegram disabled';
end $$;
update public.ai_settings set notifications = notifications || '{"telegram_enabled": true}';
delete from vault.decrypted_secrets;
set local role authenticated;
select public.t_login('owner@test.local');
do $$ begin
  assert (public.ai_telegram_test() ->> 'status') = 'skipped';
end $$;
rollback;

\echo 'T28 permissions: staff cannot call the sender or the scheduler; only owners can send a test'
do $$ begin
  assert not has_function_privilege('authenticated', 'public.ai_send_telegram(text,text,text,text)', 'execute');
  assert not has_function_privilege('authenticated', 'public.ai_run_reminders(timestamptz)', 'execute');
  assert not has_function_privilege('anon', 'public.ai_telegram_test()', 'execute');
  assert not has_table_privilege('anon', 'public.ai_notifications', 'select');
end $$;
begin;
set local role authenticated;
select public.t_login('advisor@test.local');
do $$ begin
  begin perform public.ai_telegram_test(); assert false, 'advisor sent a test';
  exception when raise_exception then null; end;
  assert (select count(*) from public.ai_notifications) = 0, 'advisors cannot read the notification log';
end $$;
select public.t_login('owner@test.local');
do $$ begin
  assert (public.ai_telegram_test() ->> 'status') = 'sent';
  assert (select count(*) from public.ai_notifications where kind = 'test') = 1;
end $$;
rollback;

\echo 'T29 daily AI cap: exact count, refusal after the cap, one Telegram alert, counter per day'
begin;
update public.ai_settings set ai = ai || '{"daily_message_cap": 3}';
set local role authenticated;
select public.t_login('advisor@test.local');
do $$ declare r jsonb; i int; begin
  for i in 1..3 loop r := public.ai_reserve_ai_call(); assert (r ->> 'allowed')::boolean, 'call ' || i || ' allowed'; end loop;
  assert (r ->> 'used')::int = 3;
  r := public.ai_reserve_ai_call(); assert not (r ->> 'allowed')::boolean, 'fourth call refused';
  r := public.ai_reserve_ai_call(); assert not (r ->> 'allowed')::boolean, 'fifth call refused';
end $$;
reset role;
do $$ begin
  assert (select ai_messages from public.ai_usage_daily) = 3, 'never counts past the cap';
  assert (select capped from public.ai_usage_daily) = 2;
  assert (select count(*) from net.calls where body ->> 'text' like '%AI daily limit reached (3 replies today)%') = 1, 'one alert per day';
  -- yesterday's usage does not count today
  update public.ai_usage_daily set day = day - 1;
end $$;
set local role authenticated;
select public.t_login('advisor@test.local');
do $$ begin assert (public.ai_reserve_ai_call() ->> 'allowed')::boolean, 'new day starts at zero'; end $$;
rollback;

\echo 'T30 daily AI cap of 0 switches the AI off; viewers cannot spend; anon cannot call it'
begin;
update public.ai_settings set ai = ai || '{"daily_message_cap": 0}';
set local role authenticated;
select public.t_login('advisor@test.local');
do $$ begin assert not (public.ai_reserve_ai_call() ->> 'allowed')::boolean, 'cap 0 = AI off'; end $$;
select public.t_login('viewer@test.local');
do $$ begin
  begin perform public.ai_reserve_ai_call(); assert false, 'viewer reserved an AI call';
  exception when raise_exception then null; end;
end $$;
reset role;
do $$ begin assert not has_function_privilege('anon', 'public.ai_reserve_ai_call()', 'execute'); end $$;
rollback;

\echo 'T31 existing settings get the default cap of 200'
do $$ begin assert (select (ai ->> 'daily_message_cap')::int from public.ai_settings) = 200; end $$;

\echo 'T32 WhatsApp inbound: contact, lead, conversation, message and reply job in one call; redelivery is a no-op'
begin;
do $$ declare r jsonb; r2 jsonb; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456701', 'Aina', 'wamid.A1', 'text', 'Salam, boleh info M Mira?', now() - interval '5 seconds');
  assert not (r ->> 'duplicate')::boolean;
  assert (select phone_e164 from public.ai_contacts where id = (r ->> 'contact_id')::uuid) = '60123456701';
  assert (select s.channel from public.ai_leads l join public.ai_lead_sources s on s.id = l.source_id where l.id = (r ->> 'lead_id')::uuid) = 'whatsapp';
  assert (select unread_count from public.ai_conversations where id = (r ->> 'conversation_id')::uuid) = 1;
  assert (select last_inbound_at is not null from public.ai_conversations where id = (r ->> 'conversation_id')::uuid);
  assert (select count(*) from public.ai_jobs where kind = 'wa_reply' and payload ->> 'message_id' = r ->> 'message_id') = 1;
  -- Meta redelivers the same webhook
  r2 := public.ai_wa_inbound('60123456701', 'Aina', 'wamid.A1', 'text', 'Salam, boleh info M Mira?');
  assert (r2 ->> 'duplicate')::boolean, 'redelivery recognised';
  assert (select count(*) from public.ai_messages where provider_message_id = 'wamid.A1') = 1;
  assert (select count(*) from public.ai_jobs where kind = 'wa_reply') = 1;
  -- second message: same contact, lead and conversation
  r2 := public.ai_wa_inbound('60123456701', 'Aina', 'wamid.A2', 'image', '[image]');
  assert r2 ->> 'conversation_id' = r ->> 'conversation_id' and r2 ->> 'lead_id' = r ->> 'lead_id';
  assert (select unread_count from public.ai_conversations where id = (r ->> 'conversation_id')::uuid) = 2;
  assert (select media -> 0 ->> 'type' from public.ai_messages where provider_message_id = 'wamid.A2') = 'image';
  assert (select count(*) from public.ai_leads) = 1 and (select count(*) from public.ai_contacts) = 1;
end $$;
rollback;

\echo 'T33 WhatsApp functions are server-only (staff and anon cannot call them)'
do $$ begin
  assert not has_function_privilege('anon', 'public.ai_wa_inbound(text, text, text, text, text, timestamptz)', 'execute');
  assert not has_function_privilege('authenticated', 'public.ai_wa_inbound(text, text, text, text, text, timestamptz)', 'execute');
  assert not has_function_privilege('authenticated', 'public.ai_wa_status(text, text, text)', 'execute');
  assert not has_function_privilege('authenticated', 'public.ai_claim_follow_ups(int)', 'execute');
  assert not has_function_privilege('anon', 'public.ai_follow_up_start(uuid, text, timestamptz)', 'execute');
  assert has_function_privilege('service_role', 'public.ai_wa_inbound(text, text, text, text, text, timestamptz)', 'execute');
end $$;

\echo 'T34 delivery statuses only move forward; failures are recorded with the reason'
begin;
do $$ declare r jsonb; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456702', null, 'wamid.B1', 'text', 'hi');
  insert into public.ai_messages (conversation_id, direction, sender_type, body, provider_message_id, status, purpose)
  values ((r ->> 'conversation_id')::uuid, 'outbound', 'ai', 'Hai!', 'wamid.OUT1', 'sent', 'reply');
  assert public.ai_wa_status('wamid.OUT1', 'read');
  assert not public.ai_wa_status('wamid.OUT1', 'delivered'), 'late "delivered" does not undo "read"';
  assert (select status from public.ai_messages where provider_message_id = 'wamid.OUT1') = 'read';
  assert public.ai_wa_status('wamid.OUT1', 'failed', 'Re-engagement message');
  assert (select status_reason from public.ai_messages where provider_message_id = 'wamid.OUT1') = 'Re-engagement message';
  assert not public.ai_wa_status('wamid.B1', 'read'), 'inbound messages are not touched';
  assert not public.ai_wa_status('wamid.UNKNOWN', 'sent');
end $$;
rollback;

\echo 'T35 follow-ups: start schedules step 1 of the active sequence; inbound reply cancels; claim is exclusive'
begin;
update public.ai_follow_up_sequences set active = true where lead_type = 'new_enquiry';
do $$ declare r jsonb; lid uuid; j uuid; j2 uuid; n int; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456703', 'Ben', 'wamid.C1', 'text', 'hello');
  lid := (r ->> 'lead_id')::uuid;
  j := public.ai_follow_up_start(lid, 'new_enquiry', now() - interval '25 hours');
  assert j is not null;
  assert (select step_index from public.ai_follow_up_jobs where id = j) = 0;
  assert public.ai_follow_up_start(lid, 'no_such_type') is null, 'no active sequence → nothing scheduled';
  -- restart replaces the old step
  j2 := public.ai_follow_up_start(lid, 'new_enquiry', now() - interval '25 hours' + interval '1 second');
  assert (select status from public.ai_follow_up_jobs where id = j) = 'cancelled';
  -- due step is claimed once only
  select count(*) into n from public.ai_claim_follow_ups(10);
  assert n = 1, 'claimed ' || n;
  select count(*) into n from public.ai_claim_follow_ups(10);
  assert n = 0, 'claimed twice';
  update public.ai_follow_up_jobs set status = 'scheduled' where id = j2;
  -- buyer replies → scheduled steps are cancelled
  perform public.ai_wa_inbound('60123456703', 'Ben', 'wamid.C2', 'text', 'ok thanks');
  assert (select status || '/' || reason from public.ai_follow_up_jobs where id = j2) = 'cancelled/customer replied';
  -- paused (human handling) leads get no sequence
  update public.ai_leads set ai_paused = true where id = lid;
  assert public.ai_follow_up_start(lid, 'new_enquiry') is null;
end $$;
rollback;

\echo 'T36 confirming an appointment stops follow-ups'
begin;
update public.ai_follow_up_sequences set active = true where lead_type = 'appointment_pending';
do $$ declare r jsonb; lid uuid; j uuid; a uuid; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456704', 'Chen', 'wamid.D1', 'text', 'nak datang sabtu');
  lid := (r ->> 'lead_id')::uuid;
  insert into public.ai_appointments (lead_id, kind, preferred_text) values (lid, 'showroom_visit', 'Sabtu') returning id into a;
  j := public.ai_follow_up_start(lid, 'appointment_pending');
  update public.ai_appointments set status = 'confirmed', start_at = now() + interval '2 days', end_at = now() + interval '2 days 1 hour' where id = a;
  assert (select status || '/' || reason from public.ai_follow_up_jobs where id = j) = 'cancelled/appointment booked';
end $$;
rollback;

\echo 'T37 hand-overs: a follow-up task (announced once) only when a person must act; "AI unsure" stays in the queue; can be switched off'
begin;
do $$ declare r jsonb; h uuid; t public.ai_tasks; n0 bigint; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456705', 'Dina', 'wamid.E1', 'text', 'nak cakap dengan orang');
  n0 := (select count(*) from net.calls);
  -- the AI was unsure: hand-over queue only, nothing on Telegram
  insert into public.ai_handover_events (lead_id, conversation_id, reason) values ((r ->> 'lead_id')::uuid, (r ->> 'conversation_id')::uuid, 'low_confidence');
  assert (select count(*) from net.calls) = n0, 'no Telegram for an unsure AI';
  assert not exists (select 1 from public.ai_tasks where lead_id = (r ->> 'lead_id')::uuid), 'no task';
  -- the buyer asked for a person: one follow-up task, announced once as a task
  insert into public.ai_handover_events (lead_id, conversation_id, reason, summary)
  values ((r ->> 'lead_id')::uuid, (r ->> 'conversation_id')::uuid, 'customer_request', '{"text":"Buyer asked for a person","next_action":"Call her"}') returning id into h;
  select * into t from public.ai_tasks where lead_id = (r ->> 'lead_id')::uuid;
  assert t.source_key = 'handover:' || h and t.status = 'open' and t.created_by = 'system' and t.title = 'Buyer needs a person: customer request';
  assert (select count(*) from public.ai_notifications where kind = 'task_reminder' and ref_id = t.id::text) = 1;
  assert (select count(*) from net.calls where body ->> 'text' like '%Follow-up task%Buyer needs a person: customer request%Dina%Next: Call her%#/inbox?c=%') = 1;
  assert not exists (select 1 from public.ai_notifications where kind = 'handover'), 'the old hand-over alert is gone';
  -- the reminder run does not announce it again
  perform public.ai_run_reminders(now());
  assert (select count(*) from public.ai_notifications where ref_id = t.id::text) = 1, 'once';
  -- a second request while the task is open: no second task
  insert into public.ai_handover_events (lead_id, reason) values ((r ->> 'lead_id')::uuid, 'complaint');
  assert (select count(*) from public.ai_tasks where lead_id = (r ->> 'lead_id')::uuid) = 1;
  -- switched off: no task
  update public.ai_settings set notifications = notifications || '{"handover_alerts": false}';
  update public.ai_tasks set status = 'done' where id = t.id;
  insert into public.ai_handover_events (lead_id, reason) values ((r ->> 'lead_id')::uuid, 'ready_to_buy');
  assert (select count(*) from public.ai_tasks where lead_id = (r ->> 'lead_id')::uuid) = 1, 'switched off';
end $$;
rollback;

\echo 'T38 Phase 4 settings defaults are added without overwriting'
do $$ begin
  assert (select (business -> 'appointments' ->> 'duration_minutes')::int from public.ai_settings) = 60;
  assert (select business -> 'hours' -> 'sat' ->> 0 from public.ai_settings) = '10:00', 'business hours kept';
  assert (select (notifications ->> 'handover_alerts')::boolean from public.ai_settings);
  assert (select notifications ->> 'telegram_chat_id' from public.ai_settings) = '8821015679', 'telegram settings kept';
end $$;

\echo 'T39 Vault secret reader: server only, Google key only'
begin;
insert into vault.decrypted_secrets values ('google_private_key', 'PEM');
do $$ begin
  assert not has_function_privilege('authenticated', 'public.ai_vault_secret(text)', 'execute');
  assert not has_function_privilege('anon', 'public.ai_vault_secret(text)', 'execute');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  assert public.ai_vault_secret('google_private_key') = 'PEM';
  begin perform public.ai_vault_secret('telegram_bot_token'); assert false, 'read another secret';
  exception when raise_exception then null; end;
end $$;
rollback;

\echo 'T40 replies sent from the WhatsApp Business app: stored, AI paused, follow-ups cancelled; repeats and own messages ignored'
begin;
update public.ai_follow_up_sequences set active = true where lead_type = 'new_enquiry';
do $$ declare r jsonb; e jsonb; lid uuid; j uuid; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456706', 'Eva', 'wamid.F1', 'text', 'Ada unit lagi?');
  lid := (r ->> 'lead_id')::uuid;
  j := public.ai_follow_up_start(lid, 'new_enquiry');
  e := public.ai_wa_echo('60123456706', 'wamid.ECHO1', 'text', 'Ada, saya call sekarang', now());
  assert not (e ->> 'duplicate')::boolean;
  assert e ->> 'conversation_id' = r ->> 'conversation_id', 'same conversation';
  assert (select sender_type || '/' || provider || '/' || status from public.ai_messages where provider_message_id = 'wamid.ECHO1') = 'human/whatsapp_app/sent';
  assert (select mode from public.ai_conversations where id = (r ->> 'conversation_id')::uuid) = 'human';
  assert (select ai_paused from public.ai_leads where id = lid);
  assert (select status from public.ai_follow_up_jobs where id = j) = 'cancelled';
  assert (public.ai_wa_echo('60123456706', 'wamid.ECHO1', 'text', 'Ada, saya call sekarang') ->> 'duplicate')::boolean, 'redelivery';
  -- an echo of a message this system sent changes nothing
  insert into public.ai_messages (conversation_id, direction, sender_type, body, provider_message_id, status) values ((r ->> 'conversation_id')::uuid, 'outbound', 'ai', 'Hai', 'wamid.OWN', 'sent');
  assert (public.ai_wa_echo('60123456706', 'wamid.OWN', 'text', 'Hai') ->> 'duplicate')::boolean;
  -- a phone reply to someone new starts a conversation already handled by a person
  e := public.ai_wa_echo('60123456707', 'wamid.ECHO2', 'text', 'Hi, follow up dari showroom');
  assert (select mode from public.ai_conversations where id = (e ->> 'conversation_id')::uuid) = 'human';
  assert not has_function_privilege('authenticated', 'public.ai_wa_echo(text, text, text, text, timestamptz)', 'execute');
end $$;
rollback;

\echo 'T41 financing figures: advisors only, history is append-only, erased with the contact, purged after retention'
begin;
set local role authenticated;
select public.t_login('advisor@test.local');
do $$ declare c uuid; l uuid; a uuid; begin
  c := public.ai_upsert_contact('0145555555', 'Fin Test');
  l := public.ai_open_lead(c);
  insert into public.ai_financing_profiles (lead_id, route, inputs, outcome) values (l, 'lppsa', '{"basic_salary": 4321}', 'insufficient_information');
  insert into public.ai_financing_assessments (lead_id, route, inputs, result, outcome) values (l, 'lppsa', '{"basic_salary": 4321}', '{}', 'potentially_affordable') returning id into a;
  assert (select updated_by from public.ai_financing_profiles where lead_id = l) = 'advisor@test.local';
  update public.ai_financing_assessments set outcome = 'potentially_challenging' where id = a;
  assert (select outcome from public.ai_financing_assessments where id = a) = 'potentially_affordable', 'history cannot be edited';
  begin insert into public.ai_financing_profiles (lead_id, route) values (l, 'bank'); assert false, 'two profiles for one lead';
  exception when unique_violation then null; end;
  begin insert into public.ai_financing_assessments (lead_id, route, inputs, result, outcome) values (l, 'cash', '{}', '{}', 'potentially_affordable'); assert false, 'bad route';
  exception when check_violation then null; end;
end $$;
select public.t_login('viewer@test.local');
do $$ begin
  assert (select count(*) from public.ai_financing_profiles) = 0, 'viewer sees income figures';
  assert (select count(*) from public.ai_financing_assessments) = 0, 'viewer sees assessments';
end $$;
select public.t_login('owner@test.local');
do $$ declare c uuid; begin
  c := (select id from public.ai_contacts where full_name = 'Fin Test');
  assert exists (select 1 from public.ai_audit_logs where table_name = 'ai_financing_profiles' and changes::text like '%4321%'), 'audited';
  perform public.ai_erase_contact(c, 'customer request');
  assert not exists (select 1 from public.ai_financing_profiles p join public.ai_leads l on l.id = p.lead_id where l.contact_id = c);
  assert not exists (select 1 from public.ai_financing_assessments a join public.ai_leads l on l.id = a.lead_id where l.contact_id = c);
  assert not exists (select 1 from public.ai_audit_logs where table_name like 'ai_financing%' and changes::text like '%4321%'), 'audit scrubbed';
end $$;
reset role;
do $$ declare c uuid; l uuid; r jsonb; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  c := public.ai_upsert_contact('0145555556', 'Old Fin');
  l := public.ai_open_lead(c);
  insert into public.ai_financing_assessments (lead_id, route, inputs, result, outcome, created_at) values
    (l, 'bank', '{"basic_salary": 9876}', '{}', 'potentially_affordable', now() - interval '400 days'),
    (l, 'bank', '{"basic_salary": 5555}', '{}', 'potentially_affordable', now() - interval '10 days');
  r := public.ai_purge_expired();
  assert (r ->> 'financing_deleted')::int = 1, r::text;
  assert (select count(*) from public.ai_financing_assessments where lead_id = l) = 1, 'recent one kept';
  assert not exists (select 1 from public.ai_audit_logs where table_name = 'ai_financing_assessments' and changes::text like '%9876%'), 'expired figures scrubbed from audit';
  assert (select (compliance ->> 'financing_retention_days')::int from public.ai_settings) = 365;
  assert (select financing from public.ai_settings) = '{}'::jsonb;
end $$;
rollback;

\echo 'T42 buyer messages: a 12-hour follow-up is scheduled from the latest message; a newer message restarts it'
begin;
update public.ai_settings set flags = flags || '{"ai_auto_reply": true}';
do $$ declare r jsonb; r2 jsonb; m timestamptz; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456801', 'Hafiz', 'wamid.S1', 'text', 'Info M Mira?', now() - interval '5 minutes');
  m := (select created_at from public.ai_messages where id = (r ->> 'message_id')::uuid);
  assert (select run_at from public.ai_automation_jobs where kind = 'smart_follow_up' and anchor_message_id = (r ->> 'message_id')::uuid) = m + interval '12 hours';
  assert not exists (select 1 from public.ai_automation_jobs where kind = 'human_reminder'), 'the AI is answering: no human reminder';
  r2 := public.ai_wa_inbound('60123456801', 'Hafiz', 'wamid.S2', 'text', 'Ada 3 bilik?');
  assert (select status || '/' || reason from public.ai_automation_jobs where anchor_message_id = (r ->> 'message_id')::uuid) = 'cancelled/superseded by a newer buyer message';
  assert (select count(*) from public.ai_automation_jobs where kind = 'smart_follow_up' and status = 'scheduled') = 1;
  -- a redelivered webhook changes nothing
  perform public.ai_wa_inbound('60123456801', 'Hafiz', 'wamid.S2', 'text', 'Ada 3 bilik?');
  assert (select count(*) from public.ai_automation_jobs where kind = 'smart_follow_up') = 2;
  -- per-conversation switch
  update public.ai_conversations set automation = '{"follow_ups": false}' where id = (r ->> 'conversation_id')::uuid;
  perform public.ai_wa_inbound('60123456801', 'Hafiz', 'wamid.S3', 'text', 'ok');
  assert (select count(*) from public.ai_automation_jobs where kind = 'smart_follow_up' and status = 'scheduled') = 0;
end $$;
rollback;

\echo 'T43 a person replies: the conversation is theirs — AI replies, follow-ups and queued AI work are cancelled'
begin;
update public.ai_settings set flags = flags || '{"ai_auto_reply": true}';
do $$ declare r jsonb; conv uuid; lid uuid; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456802', 'Aina', 'wamid.H1', 'text', 'Boleh call saya?');
  conv := (r ->> 'conversation_id')::uuid; lid := (r ->> 'lead_id')::uuid;
  insert into public.ai_follow_up_jobs (lead_id, run_at, idempotency_key) values (lid, now() + interval '1 day', 'seq-test');
  insert into public.ai_messages (conversation_id, direction, sender_type, sender_email, body, status) values (conv, 'outbound', 'human', 'advisor@test.local', 'Hi Puan, saya call sekejap lagi', 'queued');
  assert (select mode || '/' || takeover_by from public.ai_conversations where id = conv) = 'human/advisor@test.local';
  assert (select human_takeover_at is not null and last_human_reply_at is not null from public.ai_conversations where id = conv);
  assert (select ai_paused from public.ai_leads where id = lid);
  assert (select status || '/' || reason from public.ai_automation_jobs where kind = 'smart_follow_up') = 'cancelled/a person replied';
  assert (select status from public.ai_jobs where id = (r ->> 'job_id')::uuid) = 'done', 'the pending AI reply is cancelled';
  assert (select status from public.ai_follow_up_jobs where idempotency_key = 'seq-test') = 'cancelled';
  -- the buyer writes again: no AI follow-up, and no "waiting for your reply" reminder (migration 13): the inbox shows it
  r := public.ai_wa_inbound('60123456802', 'Aina', 'wamid.H2', 'text', 'Ok bila?');
  assert not exists (select 1 from public.ai_automation_jobs where kind = 'smart_follow_up' and status = 'scheduled');
  assert not exists (select 1 from public.ai_automation_jobs where kind = 'human_reminder'), 'no reply reminder';
  assert (select mode from public.ai_conversations where id = conv) = 'human', 'not handed back by a buyer message';
  -- a person replying completes the buyer's open automatic follow-up tasks; a task staff created stays open
  perform public.ai_open_human_task(lid, 'Message the buyer', null, 'appointment:x1');
  insert into public.ai_tasks (lead_id, title, due_at) values (lid, 'Send the floor plan', now() + interval '1 day');
  insert into public.ai_messages (conversation_id, direction, sender_type, sender_email, body, status) values (conv, 'outbound', 'human', 'advisor@test.local', 'Petang ni', 'queued');
  assert (select status from public.ai_tasks where source_key = 'appointment:x1') = 'done';
  assert (select status from public.ai_tasks where title = 'Send the floor plan') = 'open';
  -- AI and system messages never count as a human reply
  update public.ai_conversations set mode = 'ai' where id = conv; update public.ai_leads set ai_paused = false where id = lid;
  insert into public.ai_messages (conversation_id, direction, sender_type, body, status) values (conv, 'outbound', 'ai', 'Baik', 'queued'), (conv, 'outbound', 'system', 'Peringatan', 'queued');
  assert (select mode from public.ai_conversations where id = conv) = 'ai';
end $$;
rollback;

\echo 'T44 Take over and Resume AI: advisors only; resume resolves handovers and drops stale work; the AI owns the next message'
begin;
update public.ai_settings set flags = flags || '{"ai_auto_reply": true}';
do $$ declare r jsonb; conv uuid; lid uuid; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456803', 'Klaus', 'wamid.R1', 'text', 'Hello');
  conv := (r ->> 'conversation_id')::uuid; lid := (r ->> 'lead_id')::uuid;
  insert into public.ai_handover_events (lead_id, conversation_id, reason) values (lid, conv, 'negotiation');
  perform public.t_login('viewer@test.local');
  begin perform public.ai_take_over(conv); assert false, 'viewer took over'; exception when raise_exception then null; end;
  begin perform public.ai_resume_ai(conv); assert false, 'viewer resumed'; exception when raise_exception then null; end;
  perform public.t_login('advisor@test.local');
  perform public.ai_take_over(conv);
  assert (select mode || '/' || takeover_by from public.ai_conversations where id = conv) = 'human/advisor@test.local';
  assert (select status from public.ai_jobs where id = (r ->> 'job_id')::uuid) = 'done';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456803', 'Klaus', 'wamid.R2', 'text', 'Hello?');
  perform public.t_login('advisor@test.local');
  perform public.ai_resume_ai(conv);
  assert (select mode = 'ai' and ai_resumed_at is not null from public.ai_conversations where id = conv);
  assert not (select ai_paused from public.ai_leads where id = lid);
  assert (select status from public.ai_handover_events where lead_id = lid) = 'resolved';
  assert (select status from public.ai_jobs where id = (r ->> 'job_id')::uuid) = 'done', 'the old message is not answered after resuming';
  assert not exists (select 1 from public.ai_automation_jobs where kind = 'human_reminder' and conversation_id = conv and status = 'scheduled');
  assert exists (select 1 from public.ai_audit_logs where action = 'resume_ai' and record_id = conv::text);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.ai_wa_inbound('60123456803', 'Klaus', 'wamid.R3', 'text', 'Still there?');
  assert exists (select 1 from public.ai_automation_jobs where conversation_id = conv and kind = 'smart_follow_up' and status = 'scheduled');
end $$;
rollback;

\echo 'T45 appointments: confirmation and reminders scheduled; reschedule replaces them; cancel stops them; late bookings get no stale reminder'
begin;
do $$ declare r jsonb; lid uuid; a uuid; t0 timestamptz := date_trunc('minute', now()) + interval '3 days'; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456804', 'Hafiz', 'wamid.A1', 'text', 'Nak datang Sabtu');
  lid := (r ->> 'lead_id')::uuid;
  insert into public.ai_appointments (lead_id, kind, status, start_at) values (lid, 'showroom_visit', 'confirmed', t0) returning id into a;
  assert (select count(*) from public.ai_automation_jobs where appointment_id = a and kind = 'appt_confirmation' and status = 'scheduled') = 1;
  assert (select array_agg(offset_minutes order by offset_minutes) from public.ai_automation_jobs where appointment_id = a and kind = 'appt_reminder' and status = 'scheduled') = '{120,1440}';
  assert (select run_at from public.ai_automation_jobs where appointment_id = a and offset_minutes = 1440) = t0 - interval '1 day';
  assert (select conversation_id from public.ai_automation_jobs where appointment_id = a and offset_minutes = 120) = (r ->> 'conversation_id')::uuid;
  -- rescheduled: old reminders cancelled, new ones for the new time, a new confirmation
  update public.ai_appointments set start_at = t0 + interval '1 day' where id = a;
  assert (select count(*) from public.ai_automation_jobs where appointment_id = a and status = 'cancelled' and reason = 'appointment rescheduled') = 3;
  assert (select count(*) from public.ai_automation_jobs where appointment_id = a and status = 'scheduled' and ref_time = t0 + interval '1 day') = 3;
  -- switched off for this appointment, then on again
  update public.ai_appointments set wa_reminders = false where id = a;
  assert not exists (select 1 from public.ai_automation_jobs where appointment_id = a and status = 'scheduled');
  update public.ai_appointments set wa_reminders = true where id = a;
  assert (select count(*) from public.ai_automation_jobs where appointment_id = a and kind = 'appt_reminder' and status = 'scheduled') = 2;
  -- cancelled: nothing more goes out
  update public.ai_appointments set status = 'cancelled' where id = a;
  assert not exists (select 1 from public.ai_automation_jobs where appointment_id = a and status = 'scheduled');
  assert exists (select 1 from public.ai_automation_jobs where appointment_id = a and reason = 'appointment cancelled');
  -- booked 90 minutes ahead: the confirmation only (both reminder times have passed)
  insert into public.ai_appointments (lead_id, kind, status, start_at) values (lid, 'showroom_visit', 'confirmed', now() + interval '90 minutes') returning id into a;
  assert (select array_agg(kind) from public.ai_automation_jobs where appointment_id = a) = '{appt_confirmation}';
  -- a pending request schedules nothing
  insert into public.ai_appointments (lead_id, kind, status, preferred_text) values (lid, 'showroom_visit', 'pending_confirmation', 'Sabtu') returning id into a;
  assert not exists (select 1 from public.ai_automation_jobs where appointment_id = a);
end $$;
rollback;

\echo 'T46 a person sends the reminder themselves → the automatic one is cancelled; a buyer "ok" after a reminder records attendance'
begin;
do $$ declare r jsonb; conv uuid; lid uuid; a uuid; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456805', 'Aina', 'wamid.P1', 'text', 'Ok jumpa esok');
  conv := (r ->> 'conversation_id')::uuid; lid := (r ->> 'lead_id')::uuid;
  insert into public.ai_appointments (lead_id, kind, status, start_at) values (lid, 'showroom_visit', 'confirmed', now() + interval '20 hours') returning id into a;
  assert (select count(*) from public.ai_automation_jobs where appointment_id = a and kind = 'appt_reminder' and status = 'scheduled') = 1, 'only the 2-hour one is still ahead';
  insert into public.ai_messages (conversation_id, direction, sender_type, sender_email, body, status) values (conv, 'outbound', 'human', 'advisor@test.local', 'Jangan lupa lawatan showroom esok jam 11 ya Puan', 'queued');
  assert (select status || '/' || reason from public.ai_automation_jobs where appointment_id = a and kind = 'appt_reminder') = 'cancelled/a person already reminded the buyer';
  -- the confirmation was sent; the buyer answers "ok"
  update public.ai_automation_jobs set status = 'sent', sent_at = now() where appointment_id = a and kind = 'appt_confirmation';
  perform public.ai_wa_inbound('60123456805', 'Aina', 'wamid.P2', 'text', 'Ok, insyaAllah datang');
  assert (select attendance_confirmed_at is not null from public.ai_appointments where id = a);
end $$;
rollback;

\echo 'T47 automation jobs: claimed once by concurrent workers, server-only claim, staff can cancel, routine Telegram alerts off'
begin;
update public.ai_settings set flags = flags || '{"ai_auto_reply": true}';
do $$ declare r jsonb; j uuid; n int; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456806', 'Ben', 'wamid.C1', 'text', 'Hi');
  update public.ai_automation_jobs set run_at = now() - interval '1 minute' where conversation_id = (r ->> 'conversation_id')::uuid returning id into j;
  select count(*) into n from public.ai_claim_automation_jobs(10);
  assert n = 1;
  select count(*) into n from public.ai_claim_automation_jobs(10);
  assert n = 0, 'a job being processed is not handed out twice';
  -- the worker died mid-job (restart): after 10 minutes the job is handed out again, nothing is lost
  alter table public.ai_automation_jobs disable trigger ai_automation_jobs_touch;
  update public.ai_automation_jobs set updated_at = now() - interval '11 minutes' where id = j;
  alter table public.ai_automation_jobs enable trigger ai_automation_jobs_touch;
  select count(*) into n from public.ai_claim_automation_jobs(10, j);
  assert n = 1, 'stuck job reclaimed';
  assert not has_function_privilege('authenticated', 'public.ai_claim_automation_jobs(int, uuid)', 'execute');
  assert not has_function_privilege('anon', 'public.ai_take_over(uuid)', 'execute');
  assert coalesce((select (notifications ->> 'whatsapp_alerts')::boolean from public.ai_settings), false) = false;
  assert (select (automation ->> 'follow_up_delay_hours')::int from public.ai_settings) = 12;
  update public.ai_automation_jobs set status = 'scheduled' where id = j;
  perform public.t_login('advisor@test.local');
  assert public.ai_cancel_automation_job(j);
  assert (select status from public.ai_automation_jobs where id = j) = 'cancelled';
end $$;
set local role authenticated;
select public.t_login('viewer@test.local');
do $$ begin assert (select count(*) from public.ai_automation_jobs) >= 1, 'viewers can see the job list'; end $$;
do $$ begin
  begin update public.ai_automation_jobs set status = 'scheduled'; exception when insufficient_privilege then null; end;
  assert not exists (select 1 from public.ai_automation_jobs where status = 'scheduled'), 'no direct writes';
end $$;
rollback;

\echo 'T48 Telegram: only the three categories get through; per-WhatsApp-message alerts are blocked wherever they come from'
begin;
do $$ declare n0 bigint := (select count(*) from net.calls); begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- a legacy handler trying to announce a WhatsApp message
  assert not public.ai_send_telegram('whatsapp_message', 'x', 'wa:legacy:1', '💬 New WhatsApp message');
  assert (select count(*) from net.calls) = n0, 'nothing sent';
  assert (select status || '/' || error from public.ai_notifications where dedupe_key = 'blocked:wa:legacy:1') like 'skipped/blocked: not one of the Telegram categories%';
  assert not public.ai_send_telegram('anything_else', 'x', 'k:2', 'x');
  -- approved categories are sent once per key
  assert public.ai_send_telegram('follow_up_due', 'x', 'fu:1', '🔔 Follow-up needed');
  assert not public.ai_send_telegram('follow_up_due', 'x', 'fu:1', '🔔 Follow-up needed'), 'same key: once';
  assert public.ai_send_telegram('appointment_reminder', 'x', 'ap:1', '⏰');
  assert (select count(*) from net.calls) = n0 + 2;
  -- a category switched off
  update public.ai_settings set notifications = jsonb_set(notifications, '{categories,appointment_notification}', 'false');
  assert not public.ai_send_telegram('appointment_change', 'x', 'ap:2', '📅');
  assert (select error from public.ai_notifications where dedupe_key = 'blocked:ap:2') like '%"appointment_notification" category is switched off';
  assert not ((select notifications from public.ai_settings) ? 'whatsapp_alerts'), 'old switch removed';
  assert not has_function_privilege('authenticated', 'public.ai_send_telegram(text,text,text,text)', 'execute');
end $$;
rollback;

\echo 'T49 WhatsApp messages (new buyer, returning buyer, repeats, redelivery) and AI replies never reach Telegram'
begin;
update public.ai_settings set flags = flags || '{"ai_auto_reply": true}';
do $$ declare n0 bigint := (select count(*) from net.calls); r jsonb; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456901', 'New Buyer', 'wamid.T1', 'text', 'Hi');
  perform public.ai_wa_inbound('60123456901', 'New Buyer', 'wamid.T2', 'text', 'Info M Mira?');
  perform public.ai_wa_inbound('60123456901', 'New Buyer', 'wamid.T2', 'text', 'Info M Mira?');   -- redelivered
  perform public.ai_wa_inbound('60123456901', 'New Buyer', 'wamid.T3', 'image', '[image]');
  insert into public.ai_messages (conversation_id, direction, sender_type, body, status) values ((r ->> 'conversation_id')::uuid, 'outbound', 'ai', 'Hai!', 'sent');
  update public.ai_leads set qualification = '{"purpose":"own_stay"}' where id = (r ->> 'lead_id')::uuid;
  -- only the one-off "new WhatsApp client" alert (T53); none for the messages themselves, repeats, media or AI replies
  assert (select count(*) from net.calls) = n0 + 1, 'no Telegram for WhatsApp traffic beyond the new-client alert';
  assert (select count(*) from public.ai_notifications where status = 'sent' and created_at >= now() and kind <> 'new_whatsapp_client') = 0;
end $$;
rollback;

\echo 'T50 website enquiry: filed in the CRM at once and announced once as a NEW lead; repeats and existing leads are not'
begin;
do $$ declare n0 bigint := (select count(*) from net.calls); lid uuid; w uuid; begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  insert into public.leads (name, phone, email, project, message, consent) values ('Ahmad', '012-777 8888', 'a@example.test', 'Test Residence', 'Nak tahu harga', true);
  reset role;
  assert (select count(*) from net.calls) = n0 + 1, 'exactly one alert (the old website trigger no longer fires)';
  select a.lead_id into lid from public.ai_activities a where a.kind = 'website_enquiry' and a.body = 'Nak tahu harga';
  assert lid is not null, 'filed in the CRM straight away';
  assert (select primary_project_id from public.ai_leads where id = lid) = 't1';
  assert (select body ->> 'text' from net.calls order by id desc limit 1) like '🆕 NEW WEBSITE LEAD%Ahmad · OSC-%012-777 8888%a@example.test%Test Residence%Nak tahu harga%Website enquiry form%Open lead: https://onestopcentreproperty.com/sales/#/lead/' || lid || '%wa.me/60127778888%';
  -- the same person submits again (double submit, or another project): the CRM keeps one open lead → no new-lead alert
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  insert into public.leads (name, phone, project, message, consent) values ('Ahmad', '0127778888', 'Test Heights', 'Yang ni pula', true);
  reset role;
  assert (select count(*) from net.calls) = n0 + 1;
  assert (select count(*) from public.ai_activities where lead_id = lid and kind = 'website_enquiry') = 2, 'recorded on the existing lead';
  -- an update to a website enquiry is not a new lead
  update public.leads set status = 'contacted' where name = 'Ahmad';
  assert (select count(*) from net.calls) = n0 + 1;
  -- the import button later does not file them twice
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  assert (public.ai_import_website_leads(100) ->> 'imported')::int = 0;
  -- a buyer whose earlier lead was closed gets a new lead, and an alert
  update public.ai_leads set closed_at = now() where id = lid;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  insert into public.leads (name, phone, project, consent) values ('Ahmad', '0127778888', 'Test Residence', true);
  reset role;
  assert (select count(*) from net.calls) = n0 + 2;
  -- website lead alerts can be switched off on their own
  update public.ai_settings set notifications = jsonb_set(notifications, '{categories,new_website_lead}', 'false');
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  insert into public.leads (name, phone, consent) values ('Siti', '0139998888', true);
  reset role;
  assert (select count(*) from net.calls) = n0 + 2;
end $$;
rollback;

\echo 'T51 handovers: one alert per buyer while it waits; a person replying takes it, so the next one alerts again'
begin;
do $$ declare n0 bigint; r jsonb; lid uuid; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456902', 'Lim', 'wamid.HV1', 'text', 'nak discount');
  n0 := (select count(*) from net.calls);   -- after the one-off new-client alert (T53)
  lid := (r ->> 'lead_id')::uuid;
  insert into public.ai_handover_events (lead_id, conversation_id, reason, summary) values (lid, (r ->> 'conversation_id')::uuid, 'negotiation', '{"text":"asked for discount"}');
  insert into public.ai_handover_events (lead_id, conversation_id, reason) values (lid, (r ->> 'conversation_id')::uuid, 'low_confidence');
  insert into public.ai_handover_events (lead_id, conversation_id, reason) values (lid, (r ->> 'conversation_id')::uuid, 'other');
  assert (select count(*) from net.calls) = n0 + 1, 'one alert for the waiting buyer';
  insert into public.ai_messages (conversation_id, direction, sender_type, sender_email, body, status) values ((r ->> 'conversation_id')::uuid, 'outbound', 'human', 'advisor@test.local', 'Hi Lim', 'queued');
  assert (select count(*) from public.ai_handover_events where lead_id = lid and status = 'accepted' and accepted_by = 'advisor@test.local') = 3;
  insert into public.ai_handover_events (lead_id, conversation_id, reason) values (lid, (r ->> 'conversation_id')::uuid, 'customer_request');
  assert (select count(*) from net.calls) = n0 + 2, 'a new request after the person replied is announced';
end $$;
rollback;

\echo 'T52 appointment alerts show the showroom map link'
begin;
do $$ declare r jsonb; a public.ai_appointments; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456903', 'Aina', 'wamid.MP1', 'text', 'Sabtu ok');
  insert into public.ai_project_facts (project_id, showroom_address, showroom_map_url) values ('t1', 'Test Gallery, Cheras', 'https://maps.app.goo.gl/x');
  insert into public.ai_appointments (lead_id, kind, status, start_at, project_id, location) values ((r ->> 'lead_id')::uuid, 'showroom_visit', 'confirmed', now() + interval '2 days', 't1', 'Test Gallery, Cheras') returning * into a;
  assert public.ai_appt_text(a) like '%📍 Test Gallery, Cheras%🗺 https://maps.app.goo.gl/x%#/lead/%';
end $$;
rollback;

\echo 'T53 a brand-new WhatsApp client is announced once; their next messages, redeliveries and known clients are not'
begin;
do $$ declare n0 bigint := (select count(*) from net.calls); r jsonb; cid uuid; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123457001', 'Dee', 'wamid.N1', 'text', 'Hi, nak tanya pasal M Mira');
  assert (select count(*) from net.calls) = n0 + 1, 'one alert for the new client';
  assert (select body ->> 'text' from net.calls order by id desc limit 1) like '🆕 NEW WHATSAPP CLIENT%Dee · OSC-%+60123457001%nak tanya pasal M Mira%#/inbox?c=' || (r ->> 'conversation_id') || '%wa.me/60123457001%';
  perform public.ai_wa_inbound('60123457001', 'Dee', 'wamid.N2', 'text', 'Ada unit lagi?');
  perform public.ai_wa_inbound('60123457001', 'Dee', 'wamid.N1', 'text', 'Hi, nak tanya pasal M Mira');   -- redelivered
  assert (select count(*) from net.calls) = n0 + 1, 'no alert for later messages or redeliveries';
  -- already in the CRM (e.g. a website enquiry or an older contact): no new-client alert
  cid := public.ai_upsert_contact('0123457002', 'Old Client');
  update public.ai_contacts set created_at = now() - interval '30 days' where id = cid;
  perform public.ai_wa_inbound('60123457002', 'Old Client', 'wamid.N3', 'text', 'Hi again');
  assert (select count(*) from net.calls) = n0 + 1, 'known client';
  -- a person wrote to them first from the phone app: their reply is not a new enquiry
  perform public.ai_wa_echo('60123457003', 'wamid.E9', 'text', 'Hi, saya dari One Stop Centre', now());
  perform public.ai_wa_inbound('60123457003', null, 'wamid.N4', 'text', 'Ok boleh');
  assert (select count(*) from net.calls) = n0 + 1, 'we messaged them first';
  -- the switch for new leads also covers this alert
  update public.ai_settings set notifications = jsonb_set(notifications, '{categories,new_website_lead}', 'false');
  perform public.ai_wa_inbound('60123457004', 'Eve', 'wamid.N5', 'text', 'Hello');
  assert (select count(*) from net.calls) = n0 + 1;
end $$;
rollback;

\echo 'T54 archiving an appointment only hides it: an advisor can archive and restore, no alert, status and reminders unchanged'
begin;
create temp table t54 (n bigint, j bigint, ap uuid);
grant all on t54 to authenticated;
insert into t54 select (select count(*) from net.calls), (select count(*) from public.ai_automation_jobs where status = 'scheduled'), null;
set local role authenticated;
select public.t_login('advisor@test.local');
do $$ declare l uuid; a uuid; begin
  l := public.ai_open_lead(public.ai_upsert_contact('0123335555', 'Hana'), null, 't1');
  insert into public.ai_appointments (lead_id, kind, preferred_text) values (l, 'showroom_visit', 'Sabtu pagi') returning id into a;
  update t54 set ap = a;
end $$;
reset role;
update t54 set n = (select count(*) from net.calls), j = (select count(*) from public.ai_automation_jobs where status = 'scheduled');
set local role authenticated;
select public.t_login('advisor@test.local');
update public.ai_appointments set archived_at = now(), archived_by = 'advisor@test.local' where id = (select ap from t54);
reset role;
do $$ declare a uuid := (select ap from t54); begin
  assert (select status from public.ai_appointments where id = a) = 'pending_confirmation', 'status unchanged';
  assert (select archived_by from public.ai_appointments where id = a) = 'advisor@test.local', 'archived by the advisor (RLS allows it)';
  assert (select count(*) from net.calls) = (select n from t54), 'no Telegram alert for archiving';
  assert (select count(*) from public.ai_automation_jobs where status = 'scheduled') = (select j from t54), 'jobs untouched';
end $$;
set local role authenticated;
select public.t_login('advisor@test.local');
update public.ai_appointments set archived_at = null, archived_by = null where id = (select ap from t54);
reset role;
do $$ begin assert (select archived_at from public.ai_appointments where id = (select ap from t54)) is null, 'restored'; end $$;
rollback;

\echo 'T55 Telegram carries only new clients, follow-up tasks and appointments: an existing buyer chatting (AI or person) sends nothing'
begin;
update public.ai_settings set flags = flags || '{"ai_auto_reply": true}', notifications = notifications || '{"daily_digest": false}';
do $$ declare r jsonb; conv uuid; lid uuid; n0 bigint; t1 uuid; t2 uuid; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123456901', 'Izalynn', 'wamid.Z1', 'text', 'Hi, nak tanya M Mira');
  conv := (r ->> 'conversation_id')::uuid; lid := (r ->> 'lead_id')::uuid;
  update public.ai_contacts set created_at = now() - interval '3 days' where id = (select contact_id from public.ai_leads where id = lid);
  -- a person takes the chat; the buyer keeps writing and waits
  insert into public.ai_messages (conversation_id, direction, sender_type, sender_email, body, status) values (conv, 'outbound', 'human', 'advisor@test.local', 'Hi, saya check', 'queued');
  n0 := (select count(*) from net.calls);
  perform public.ai_wa_inbound('60123456901', 'Izalynn', 'wamid.Z2', 'text', 'Akk skrg fokus Arte star 2.5%');
  perform public.ai_wa_inbound('60123456901', 'Izalynn', 'wamid.Z3', 'text', 'M Mira 2.4%');
  perform public.ai_wa_inbound('60123456901', 'Izalynn', 'wamid.Z3', 'text', 'M Mira 2.4%');   -- redelivered
  perform public.ai_run_reminders(now() + interval '2 hours');
  assert (select count(*) from net.calls) = n0, 'nothing on Telegram for an existing buyer waiting for a reply: ' || (select string_agg(left(body ->> 'text', 60), ' | ') from (select body from net.calls order by id desc limit (select count(*) from net.calls) - n0) x);
  assert not exists (select 1 from public.ai_automation_jobs where kind = 'human_reminder');
  assert not exists (select 1 from public.ai_tasks where lead_id = lid);
  -- the old kinds are refused centrally, whoever calls
  assert not public.ai_send_telegram('handover', 'x', 'legacy:h', '🔔 Follow-up needed — other');
  assert (select status from public.ai_notifications where dedupe_key = 'blocked:legacy:h') = 'skipped';
  -- a follow-up task due: announced once; the same cause again while open: no second task; done: nothing more
  t1 := public.ai_open_human_task(lid, 'Follow up with the buyer', 'the automatic follow-up could not be sent', 'followup:j1');
  t2 := public.ai_open_human_task(lid, 'Follow up with the buyer', null, 'followup:j2');
  assert t1 is not null and t2 is null;
  assert (select count(*) from net.calls) = n0 + 1;
  assert (select body ->> 'text' from net.calls order by id desc limit 1) like '🔔 Follow-up task%Follow up with the buyer%Izalynn%';
  perform public.ai_run_reminders(now());
  assert (select count(*) from net.calls) = n0 + 1, 'not twice';
  -- an appointment and an independent task for the same buyer each alert once
  update public.ai_settings set notifications = notifications || '{"appointment_changes": true}';
  insert into public.ai_appointments (lead_id, kind, status, start_at, end_at) values (lid, 'showroom_visit', 'confirmed', now() + interval '3 days', now() + interval '3 days 1 hour');
  assert (select count(*) from net.calls) = n0 + 2;
  assert (select count(*) from public.ai_notifications where kind = 'appointment_change' and status = 'sent') = 1;
end $$;
rollback;

\echo 'T56 RMK: enrol by full name, six stages by keyword (in order only), reminders scheduled/cancelled per stage, all signed stops'
begin;
update public.ai_settings set notifications = notifications || '{"daily_digest": false}';
do $$ declare r jsonb; lid uuid; n0 bigint; j1 uuid; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- a bare "RMK" from someone not in the pipeline does not enrol them (the AI asks which project)
  r := public.ai_wa_inbound('60123457001', 'Rahim', 'wamid.K0', 'text', 'RMK');
  lid := (r ->> 'lead_id')::uuid;
  assert not exists (select 1 from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = lid), 'keyword alone does not enrol';
  -- the project's name does
  n0 := (select count(*) from net.calls);
  perform public.ai_wa_inbound('60123457001', 'Rahim', 'wamid.K1', 'text', 'Saya berminat Residensi Metropolitan Kepong');
  assert (select stage || '/' || status || '/' || source from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = lid) = 'new/active/whatsapp';
  assert not exists (select 1 from public.ai_automation_jobs where lead_id = lid and kind = 'workflow_follow_up'), '"new": no reminders until they reply RMK';
  -- RMK → to book: one reminder scheduled for that stage
  perform public.ai_wa_inbound('60123457001', 'Rahim', 'wamid.K2', 'text', 'rmk');
  assert (select stage from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = lid) = 'to_book';
  select id into j1 from public.ai_automation_jobs where lead_id = lid and kind = 'workflow_follow_up' and status = 'scheduled';
  assert (select stage || '/' || seq from public.ai_automation_jobs where id = j1) = 'to_book/1';
  assert (select run_at from public.ai_automation_jobs where id = j1) between now() + interval '23 hours' and now() + interval '25 hours';
  -- a keyword out of order changes nothing; a repeated one neither
  perform public.ai_wa_inbound('60123457001', 'Rahim', 'wamid.K3', 'text', 'DONE PORTAL');
  perform public.ai_wa_inbound('60123457001', 'Rahim', 'wamid.K3', 'text', 'DONE PORTAL');   -- redelivered
  assert (select stage from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = lid) = 'to_book';
  -- DONE BOOKED → to portal: the old reminder is cancelled, a new one for the new stage
  perform public.ai_wa_inbound('60123457001', 'Rahim', 'wamid.K4', 'text', 'Done booked!');
  assert (select stage from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = lid) = 'to_portal';
  assert (select status || '/' || reason from public.ai_automation_jobs where id = j1) = 'cancelled/stage changed';
  assert (select count(*) from public.ai_automation_jobs where lead_id = lid and kind = 'workflow_follow_up' and status = 'scheduled' and stage = 'to_portal') = 1;
  perform public.ai_wa_inbound('60123457001', 'Rahim', 'wamid.K5', 'text', 'DONE BOOKED');  -- again: no change
  assert (select stage from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = lid) = 'to_portal';
  perform public.ai_wa_inbound('60123457001', 'Rahim', 'wamid.K6', 'text', 'DONE PORTAL');
  perform public.ai_wa_inbound('60123457001', 'Rahim', 'wamid.K7', 'text', 'DONE SUBMIT LOAN');
  assert (select stage from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = lid) = 'to_sign';
  assert (select run_at from public.ai_automation_jobs where lead_id = lid and kind = 'workflow_follow_up' and status = 'scheduled') between now() + interval '47 hours' and now() + interval '49 hours';
  perform public.ai_wa_inbound('60123457001', 'Rahim', 'wamid.K8', 'text', 'DONE SIGNED');
  assert (select stage || '/' || status from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = lid) = 'all_signed/completed';
  assert not exists (select 1 from public.ai_automation_jobs where lead_id = lid and kind = 'workflow_follow_up' and status = 'scheduled'), 'all signed: nothing pending';
  assert (select count(*) from public.ai_workflow_leads, jsonb_array_elements(history) h where workflow_id = public.ai_rmk_wf() and lead_id = lid and h ? 'from') = 5, 'five stage moves recorded';
  assert exists (select 1 from public.ai_messages m join public.ai_conversations v on v.id = m.conversation_id where v.lead_id = lid and m.body = 'DONE SIGNED'), 'conversation kept';
  assert (select count(*) from net.calls) = n0, 'no Telegram for RMK messages or stage moves';
end $$;
rollback;

\echo 'T57 RMK isolation: other projects untouched; a project change pauses RMK; staff stage/pause; website lead on the RMK listing joins'
begin;
update public.ai_settings set notifications = notifications || '{"daily_digest": false}';
update public.ai_workflows set project_id = 't1' where key = 'rmk';
do $$ declare r jsonb; other uuid; lid uuid; w uuid; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- a lead for another project sending the same keywords: no pipeline, no RMK jobs
  r := public.ai_wa_inbound('60123457002', 'Mira Buyer', 'wamid.I1', 'text', 'DONE BOOKED');
  other := (r ->> 'lead_id')::uuid;
  update public.ai_leads set primary_project_id = 't2' where id = other;
  assert not exists (select 1 from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = other);
  assert not exists (select 1 from public.ai_automation_jobs where lead_id = other and kind = 'workflow_follow_up');
  -- a lead set to the RMK listing joins; moved to another project it is paused and its reminders stop
  r := public.ai_wa_inbound('60123457003', 'Siti', 'wamid.I2', 'text', 'Hi');
  lid := (r ->> 'lead_id')::uuid;
  update public.ai_leads set primary_project_id = 't1' where id = lid;
  assert (select stage from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = lid) = 'new';
  perform public.ai_wa_inbound('60123457003', 'Siti', 'wamid.I3', 'text', 'RMK');
  assert exists (select 1 from public.ai_automation_jobs where lead_id = lid and kind = 'workflow_follow_up' and status = 'scheduled');
  update public.ai_leads set primary_project_id = 't2' where id = lid;
  assert (select status || '/' || status_reason from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = lid) like 'paused/project changed to %';
  assert not exists (select 1 from public.ai_automation_jobs where lead_id = lid and kind = 'workflow_follow_up' and status = 'scheduled');
  perform public.ai_wa_inbound('60123457003', 'Siti', 'wamid.I4', 'text', 'DONE BOOKED');
  assert (select stage from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = lid) = 'to_book', 'paused: keywords do not move it';
  update public.ai_leads set primary_project_id = 't1' where id = lid;
  assert (select status from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = lid) = 'active', 'back on RMK: resumed';
  assert exists (select 1 from public.ai_automation_jobs where lead_id = lid and kind = 'workflow_follow_up' and status = 'scheduled');
  -- staff: viewers cannot change anything; advisors can set a stage and pause
  perform public.t_login('viewer@test.local');
  begin perform public.ai_rmk_set_stage(lid, 'to_sign'); assert false, 'viewer changed a stage'; exception when raise_exception then null; end;
  perform public.t_login('advisor@test.local');
  perform public.ai_rmk_set_stage(lid, 'to_submit_loan');
  assert (select stage from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = lid) = 'to_submit_loan';
  perform public.ai_rmk_set_status(lid, 'paused', 'buyer travelling');
  assert not exists (select 1 from public.ai_automation_jobs where lead_id = lid and kind = 'workflow_follow_up' and status = 'scheduled');
  perform public.ai_rmk_set_status(lid, 'active');
  assert (select count(*) from public.ai_automation_jobs where lead_id = lid and kind = 'workflow_follow_up' and status = 'scheduled' and stage = 'to_submit_loan') = 1;
  -- a website enquiry for the RMK listing joins with source "website"
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  insert into public.leads (name, phone, project, message, consent) values ('Web RMK', '0127771111', 'Test Residence', 'RMK info', true);
  reset role;
  select a.lead_id into w from public.ai_activities a where a.kind = 'website_enquiry' and a.body = 'RMK info';
  assert (select stage || '/' || source from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = w) = 'new/website', coalesce((select stage || '/' || source from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = w), 'not enrolled; lead project=' || coalesce((select primary_project_id from public.ai_leads where id = w), 'null'));
end $$;
rollback;

\echo 'T58 RMK copied into the workflow tables unchanged: stages, keywords, intervals, templates, messages, sending switch'
begin;
do $$ declare w public.ai_workflows; c jsonb := (select rmk from public.ai_settings where id = 1); r record; begin
  select * into w from public.ai_workflows where key = 'rmk';
  assert w.id is not null and w.sending_enabled = false and w.pause_if_active_hours = 6 and w.status = 'active';
  assert (select string_agg(key, ',' order by position) from public.ai_workflow_stages where workflow_id = w.id) = 'new,to_book,to_portal,to_submit_loan,to_sign,all_signed';
  assert (select follow_up_hours || '/' || max_follow_ups || '/' || template from public.ai_workflow_stages where workflow_id = w.id and key = 'to_book') = '24/3/rmk_to_book';
  assert (select follow_up_hours || '/' || template from public.ai_workflow_stages where workflow_id = w.id and key = 'to_sign') = '48/rmk_to_sign';
  for r in select * from public.ai_workflow_stages where workflow_id = w.id and key <> 'all_signed' and key <> 'new' loop
    assert r.message_ms = c -> 'stages' -> r.key ->> 'message_ms' and r.message_en = c -> 'stages' -> r.key ->> 'message_en', 'message kept: ' || r.key;
  end loop;
  assert (select keywords from public.ai_workflow_stages where workflow_id = w.id and key = 'to_book') = array['DONE BOOKED','DONE BOOKING','DONE BOOK'];
  assert (select is_final from public.ai_workflow_stages where workflow_id = w.id and key = 'all_signed');
  assert exists (select 1 from public.ai_workflow_changes where workflow_id = w.id and action = 'created');
  assert public.ai_wf_next(w.id, 'to_sign') = 'all_signed' and public.ai_wf_next(w.id, 'all_signed') is null;
end $$;
rollback;

\echo 'T59 workflow builder: managers only, whole-workflow validation, new project workflow works end to end, audit trail'
begin;
update public.ai_settings set notifications = notifications || '{"daily_digest": false}';
create temp table t59 (wid uuid);
grant all on t59 to authenticated;
do $$ declare wid uuid; p jsonb; r jsonb; lid uuid; jn uuid; n0 bigint; begin
  p := '{"key":"heights","name":"Test Heights buyers","project_id":"t2","sending_enabled":true,"pause_if_active_hours":0,
         "entry":{"message_phrases":["test heights"],"ad_phrases":["heights launch"]},
         "stages":[
           {"key":"interested","name":"Interested","keywords":["YES HEIGHTS"],"follow_up_hours":0,"max_follow_ups":0},
           {"key":"docs","name":"Send documents","keywords":["DONE DOCS","Docs sent"],"follow_up_hours":12,"max_follow_ups":2,"template":"heights_docs","message_ms":"Hai {{name}}, sila hantar dokumen untuk {{project_name}}.","message_en":"Hi {{name}}, please send the documents for {{project_name}}."},
           {"key":"skipme","name":"Inactive step","keywords":["DONE SKIP"],"active":false},
           {"key":"visit","name":"Visit","keywords":["DONE VISIT"],"human_on_enter":true},
           {"key":"done","name":"Completed","is_final":true}]}';
  -- viewers and advisors cannot change workflows
  perform public.t_login('advisor@test.local');
  begin perform public.ai_wf_save(p); assert false, 'advisor saved a workflow'; exception when raise_exception then null; end;
  perform public.t_login('manager@test.local');
  -- the whole workflow is checked: duplicate keyword, no final stage, reminders without a message, a missing next stage
  begin perform public.ai_wf_save(jsonb_set(p, '{stages,1,keywords}', '["YES HEIGHTS"]')); assert false, 'duplicate keyword'; exception when raise_exception then null; end;
  begin perform public.ai_wf_save(jsonb_set(p, '{stages,4,is_final}', 'false')); assert false, 'no final stage'; exception when raise_exception then null; end;
  begin perform public.ai_wf_save(jsonb_set(jsonb_set(p, '{stages,1,message_ms}', '""'), '{stages,1,message_en}', '""')); assert false, 'no message'; exception when raise_exception then null; end;
  begin perform public.ai_wf_save(jsonb_set(p, '{stages,0,next_stage_key}', '"nowhere"')); assert false, 'bad next stage'; exception when raise_exception then null; end;
  begin perform public.ai_wf_save(jsonb_set(p, '{key}', '"rmk"')); assert false, 'key taken'; exception when raise_exception then null; end;
  assert not exists (select 1 from public.ai_workflows where key = 'heights'), 'nothing saved by a refused save';
  wid := public.ai_wf_save(p);
  insert into t59 values (wid);
  assert (select count(*) from public.ai_workflow_stages where workflow_id = wid) = 5;
  assert exists (select 1 from public.ai_workflow_changes where workflow_id = wid and action = 'created' and by = 'manager@test.local');
  -- a second active workflow for the same project is refused
  begin perform public.ai_wf_save(jsonb_set(p, '{key}', '"heights2"')); assert false, 'two workflows per project'; exception when raise_exception then null; end;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123458001', 'Hana', 'wamid.W1', 'text', 'Nak tahu pasal Test Heights');
  lid := (r ->> 'lead_id')::uuid;
  n0 := (select count(*) from net.calls);   -- after the new-client alert
  assert (select stage || '/' || source from public.ai_workflow_leads where workflow_id = wid and lead_id = lid) = 'interested/whatsapp', 'entry phrase enrols';
  assert not exists (select 1 from public.ai_workflow_leads where workflow_id = public.ai_rmk_wf() and lead_id = lid), 'not in RMK';
  -- RMK keywords mean nothing here; this workflow's do
  perform public.ai_wa_inbound('60123458001', 'Hana', 'wamid.W2', 'text', 'DONE BOOKED');
  perform public.ai_wa_inbound('60123458001', 'Hana', 'wamid.W3', 'text', 'yes heights!');
  assert (select stage from public.ai_workflow_leads where workflow_id = wid and lead_id = lid) = 'docs';
  select id into jn from public.ai_automation_jobs where workflow_id = wid and lead_id = lid and status = 'scheduled';
  assert (select kind || '/' || stage || '/' || seq from public.ai_automation_jobs where id = jn) = 'workflow_follow_up/docs/1';
  assert (select run_at from public.ai_automation_jobs where id = jn) between now() + interval '11 hours' and now() + interval '13 hours';
  -- an alias works too; the inactive stage is skipped; entering "Visit" opens a follow-up task for a person
  perform public.ai_wa_inbound('60123458001', 'Hana', 'wamid.W4', 'text', 'Docs sent');
  assert (select stage from public.ai_workflow_leads where workflow_id = wid and lead_id = lid) = 'visit', 'inactive stage skipped';
  assert (select status from public.ai_automation_jobs where id = jn) = 'cancelled';
  assert exists (select 1 from public.ai_tasks where lead_id = lid and status = 'open' and source_key like 'wf-heights:visit:%'), 'person follows up on entering Visit';

  -- reorder + explicit next stage: "visit" now goes straight to "done"; renaming a stage keeps its leads
  perform public.t_login('manager@test.local');
  p := public.ai_wf_snapshot(wid);
  p := jsonb_set(p, '{stages,3,name}', '"Showroom visit"');
  perform public.ai_wf_save(p);
  assert (select name from public.ai_workflow_stages where workflow_id = wid and key = 'visit') = 'Showroom visit';
  assert (select stage from public.ai_workflow_leads where workflow_id = wid and lead_id = lid) = 'visit';
  assert (select count(*) from public.ai_workflow_changes where workflow_id = wid) = 2, 'each save recorded';
  assert (select before -> 'stages' -> 3 ->> 'name' from public.ai_workflow_changes where workflow_id = wid and action = 'updated') = 'Visit';
  -- archiving a stage that has leads needs a stage to move them to
  begin perform public.ai_wf_save(jsonb_set(p, '{stages,3,archived}', 'true')); assert false, 'archived a stage with leads'; exception when raise_exception then null; end;
  perform public.ai_wf_save(jsonb_set(jsonb_set(p, '{stages,3,archived}', 'true'), '{stages,3,move_to}', '"docs"'));
  assert (select stage from public.ai_workflow_leads where workflow_id = wid and lead_id = lid) = 'docs', 'moved off the archived stage';
  assert exists (select 1 from public.ai_automation_jobs where workflow_id = wid and lead_id = lid and status = 'scheduled'), 'reminders for the new stage';
  assert public.ai_wf_next(wid, 'docs') = 'done', 'archived and inactive stages are skipped';
  -- archiving the workflow stops its reminders; the leads and history stay
  perform public.ai_wf_save(jsonb_set(public.ai_wf_snapshot(wid), '{status}', '"archived"'));
  assert not exists (select 1 from public.ai_automation_jobs where workflow_id = wid and status = 'scheduled');
  assert exists (select 1 from public.ai_workflow_leads where workflow_id = wid and lead_id = lid);
  assert exists (select 1 from public.ai_workflow_changes where workflow_id = wid and action = 'archived');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.ai_wa_inbound('60123458001', 'Hana', 'wamid.W5', 'text', 'DONE DOCS');
  assert (select stage from public.ai_workflow_leads where workflow_id = wid and lead_id = lid) = 'docs', 'archived workflow: keywords do nothing';
  assert (select count(*) from net.calls) = n0 + 1, 'only the one follow-up task went to Telegram';
end $$;
rollback;

\echo 'T60 workflows: ad entry, project listing entry/pause, staff moves, viewers read only'
begin;
update public.ai_settings set notifications = notifications || '{"daily_digest": false}';
do $$ declare wid uuid; r jsonb; lid uuid; n int; begin
  perform public.t_login('manager@test.local');
  wid := public.ai_wf_save('{"key":"res","name":"Test Residence","project_id":"t1","entry":{"ad_phrases":["test residence"]},
    "stages":[{"key":"a","name":"A","keywords":["DONE A"]},{"key":"b","name":"B","keywords":["DONE B"]},{"key":"z","name":"Done","is_final":true}]}');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123458002', 'Ali', 'wamid.X1', 'text', 'Hi');
  lid := (r ->> 'lead_id')::uuid;
  n := public.ai_wf_enroll_from_ad(lid, 'Unrelated ad', 'facebook');
  assert n = 0 and not exists (select 1 from public.ai_workflow_leads where lead_id = lid);
  n := public.ai_wf_enroll_from_ad(lid, 'Test Residence — new launch', 'instagram');
  assert n = 1 and (select source from public.ai_workflow_leads where workflow_id = wid and lead_id = lid) = 'instagram';
  -- moved to another project: paused; back: resumed
  update public.ai_leads set primary_project_id = 't2' where id = lid;
  assert (select status from public.ai_workflow_leads where workflow_id = wid and lead_id = lid) = 'paused';
  update public.ai_leads set primary_project_id = 't1' where id = lid;
  assert (select status from public.ai_workflow_leads where workflow_id = wid and lead_id = lid) = 'active';
  -- staff: viewers read but cannot move; advisors move and complete
  perform public.t_login('viewer@test.local');
  assert (select count(*) from public.ai_workflows) >= 2, 'viewers can read workflows';
  begin perform public.ai_wf_set_stage(wid, lid, 'b'); assert false, 'viewer moved a lead'; exception when raise_exception then null; end;
  perform public.t_login('advisor@test.local');
  perform public.ai_wf_set_stage(wid, lid, 'z');
  assert (select stage || '/' || status from public.ai_workflow_leads where workflow_id = wid and lead_id = lid) = 'z/completed';
  begin perform public.ai_wf_set_stage(wid, lid, 'nope'); assert false, 'unknown stage'; exception when raise_exception then null; end;
end $$;
rollback;

\echo 'T61 client profile: AI updates by evidence, never over a person''s entry (flagged instead), never twice per message'
begin;
update public.ai_settings set notifications = notifications || '{"daily_digest": false}';
create temp table t61 (lid uuid);
grant all on t61 to authenticated;
do $$ declare r jsonb; lid uuid; m1 uuid := gen_random_uuid(); m2 uuid := gen_random_uuid(); m3 uuid := gen_random_uuid(); begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123459001', 'Nadia', 'wamid.P1', 'text', 'Saya kerja di KLCC, naik LRT');
  lid := (r ->> 'lead_id')::uuid;
  insert into t61 values (lid);
  r := public.ai_lead_profile_set(lid, '[{"field":"work_area","value":"KLCC","status":"confirmed"},{"field":"commute_mode","value":["rail"],"status":"inferred"},{"field":"purpose","value":"own_stay","status":"confirmed"}]', 'ai', m1);
  assert jsonb_array_length(r -> 'applied') = 3, r::text;
  assert (select profile ->> 'work_area' from public.ai_leads where id = lid) = 'KLCC';
  assert (select qualification ->> 'purpose' from public.ai_leads where id = lid) = 'own_stay', 'qualification fields go to qualification';
  assert (select profile_meta -> 'commute_mode' ->> 'status' from public.ai_leads where id = lid) = 'inferred';
  assert (select count(*) from public.ai_lead_field_history where lead_id = lid) = 3;
  assert exists (select 1 from public.ai_activities where lead_id = lid and kind = 'profile_update' and body like 'AI updated%');
  -- the same message again (retried job): nothing applied twice
  r := public.ai_lead_profile_set(lid, '[{"field":"work_area","value":"Bangsar","status":"confirmed"}]', 'ai', m1);
  assert jsonb_array_length(r -> 'applied') = 0 and (select profile ->> 'work_area' from public.ai_leads where id = lid) = 'KLCC';
  -- a guess never replaces what the buyer said; the buyer's own correction does, with history
  r := public.ai_lead_profile_set(lid, '[{"field":"work_area","value":"Bangsar","status":"inferred"}]', 'ai', m2);
  assert (select profile ->> 'work_area' from public.ai_leads where id = lid) = 'KLCC';
  r := public.ai_lead_profile_set(lid, '[{"field":"work_area","value":"Bangsar","status":"confirmed"}]', 'ai', m3);
  assert (select profile ->> 'work_area' from public.ai_leads where id = lid) = 'Bangsar';
  assert (select old_value #>> '{}' from public.ai_lead_field_history where lead_id = lid and field = 'work_area' and message_id = m3) = 'KLCC';
  -- the AI never clears a field; unrelated fields are untouched
  r := public.ai_lead_profile_set(lid, '[{"field":"work_area","value":""}]', 'ai', gen_random_uuid());
  assert (select profile ->> 'work_area' from public.ai_leads where id = lid) = 'Bangsar';
  assert (select qualification ->> 'purpose' from public.ai_leads where id = lid) = 'own_stay';
  -- an inferred value the buyer then states becomes confirmed
  r := public.ai_lead_profile_set(lid, '[{"field":"commute_mode","value":["rail"],"status":"confirmed"}]', 'ai', gen_random_uuid());
  assert (select profile_meta -> 'commute_mode' ->> 'status' from public.ai_leads where id = lid) = 'confirmed';
  -- the AI cannot use the staff path, and the staff path is for advisors and up
  begin perform public.ai_lead_profile_set(lid, '[{"field":"work_area","value":"X"}]', 'staff'); assert false, 'service role used the staff path'; exception when raise_exception then null; end;
end $$;
set local role authenticated;
do $$ declare lid uuid := (select lid from t61); r jsonb; begin
  perform public.t_login('viewer@test.local');
  begin perform public.ai_lead_profile_set(lid, '[{"field":"residential_area","value":"Cheras"}]', 'staff'); assert false, 'viewer edited'; exception when raise_exception then null; end;
  perform public.t_login('advisor@test.local');
  begin perform public.ai_lead_profile_set(lid, '[{"field":"residential_area","value":"Cheras"}]', 'ai'); assert false, 'advisor used the AI path'; exception when raise_exception then null; end;
  r := public.ai_lead_profile_set(lid, '[{"field":"residential_area","value":"Cheras"},{"field":"occupants","value":"4"}]', 'staff', null, 'called the buyer');
  assert (select profile_meta -> 'residential_area' ->> 'source' from public.ai_leads where id = lid) = 'staff';
  assert (select note from public.ai_lead_field_history where lead_id = lid and field = 'residential_area') = 'called the buyer';
end $$;
reset role;
do $$ declare lid uuid := (select lid from t61); r jsonb; begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- the AI disagrees with a person's entry: flagged for review, the person's value stays
  r := public.ai_lead_profile_set(lid, '[{"field":"residential_area","value":"Kepong","status":"confirmed"}]', 'ai', gen_random_uuid());
  assert r -> 'conflicts' = '["residential_area"]'::jsonb, r::text;
  assert (select profile ->> 'residential_area' from public.ai_leads where id = lid) = 'Cheras';
  assert (select profile_meta -> 'residential_area' -> 'conflict' ->> 'value' from public.ai_leads where id = lid) = 'Kepong';
end $$;
set local role authenticated;
do $$ declare lid uuid := (select lid from t61); begin
  perform public.t_login('advisor@test.local');
  assert public.ai_lead_profile_resolve(lid, 'residential_area', true);
  assert (select profile ->> 'residential_area' from public.ai_leads where id = lid) = 'Kepong';
  assert not ((select profile_meta -> 'residential_area' from public.ai_leads where id = lid) ? 'conflict');
  -- clearing a field is a person's choice
  perform public.ai_lead_profile_set(lid, '[{"field":"occupants","value":""}]', 'staff');
  assert not ((select profile from public.ai_leads where id = lid) ? 'occupants');
end $$;
rollback;

\echo 'T62 AI summary and next action: kept per lead; a dismissed recommendation is not brought back; staff can edit'
begin;
create temp table t62 (lid uuid);
grant all on t62 to authenticated;
do $$ declare r jsonb; lid uuid; m uuid := gen_random_uuid(); begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123459002', 'Farid', 'wamid.S1', 'text', 'Berapa harga unit 3 bilik?');
  lid := (r ->> 'lead_id')::uuid; insert into t62 values (lid);
  perform public.ai_lead_summary_set(lid, '{"text":"Asked about 3-bedroom prices.","last_client_question":"Berapa harga unit 3 bilik?","next_action":{"action":"Send the 3-bedroom price list","reason":"Buyer asked for prices","priority":"high"}}', 'ai', m);
  assert (select ai_summary ->> 'text' from public.ai_leads where id = lid) = 'Asked about 3-bedroom prices.';
  assert (select ai_summary -> 'next_action' ->> 'status' from public.ai_leads where id = lid) = 'open';
  assert exists (select 1 from public.ai_activities where lead_id = lid and kind = 'ai_summary');
end $$;
set local role authenticated;
do $$ declare lid uuid := (select lid from t62); begin
  perform public.t_login('viewer@test.local');
  begin perform public.ai_lead_next_action(lid, 'done'); assert false, 'viewer closed an action'; exception when raise_exception then null; end;
  perform public.t_login('advisor@test.local');
  assert public.ai_lead_next_action(lid, 'dismissed');
  begin perform public.ai_lead_summary_set(lid, '{"text":"x"}', 'ai'); assert false, 'advisor wrote as AI'; exception when raise_exception then null; end;
end $$;
reset role;
do $$ declare lid uuid := (select lid from t62); begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform public.ai_lead_summary_set(lid, '{"next_action":{"action":"Send the 3-bedroom price list","priority":"high"}}', 'ai', gen_random_uuid());
  assert (select ai_summary -> 'next_action' ->> 'status' from public.ai_leads where id = lid) = 'dismissed', 'not brought back';
  perform public.ai_lead_summary_set(lid, '{"next_action":{"action":"Offer a showroom visit this weekend","priority":"normal","due_at":"2026-11-01"}}', 'ai', gen_random_uuid());
  assert (select ai_summary -> 'next_action' ->> 'status' || '/' || (ai_summary -> 'next_action' ->> 'due_at') from public.ai_leads where id = lid) = 'open/2026-11-01';
  assert (select ai_summary ->> 'text' from public.ai_leads where id = lid) = 'Asked about 3-bedroom prices.', 'summary text kept when not resent';
end $$;
set local role authenticated;
do $$ declare lid uuid := (select lid from t62); begin
  perform public.t_login('advisor@test.local');
  perform public.ai_lead_summary_set(lid, '{"text":"Wants a 3-bedroom unit; prefers weekends."}', 'staff');
  assert (select ai_summary ->> 'source' from public.ai_leads where id = lid) = 'staff';
end $$;
rollback;

\echo 'T63 stages: renamed pipeline keeps every lead; AI moves forward only with evidence; staff moves cancel stale check-ins; appointments move forward'
begin;
update public.ai_settings set notifications = notifications || '{"daily_digest": false}', flags = flags || '{"ai_auto_reply": true}';
create temp table t63 (lid uuid);
grant all on t63 to authenticated;
do $$ declare r jsonb; lid uuid; begin
  assert (select string_agg(key, ',' order by position) from public.ai_pipeline_stages where key is not null) =
    'new_enquiry,contacted,interested,no_response,follow_up_required,appointment_pending,appointment_booked,appointment_attended,unit_booked,documents_pending,loan_submitted,loan_approved,loan_declined,lo_signed,pending_spa_signing,signed_all,cancelled';
  assert (select is_won from public.ai_pipeline_stages where key = 'signed_all') and (select is_lost from public.ai_pipeline_stages where key = 'cancelled');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('60123459003', 'Lim', 'wamid.G1', 'text', 'Saya nak tahu lagi');
  lid := (r ->> 'lead_id')::uuid; insert into t63 values (lid);
  assert (select s.key from public.ai_leads l join public.ai_pipeline_stages s on s.id = l.stage_id where l.id = lid) = 'new_enquiry';
  -- the AI: forward, to stages it may set, with the buyer's words
  assert not public.ai_lead_set_stage(lid, (select id from public.ai_pipeline_stages where key = 'interested'), null, 'ai', null), 'no evidence';
  assert public.ai_lead_set_stage(lid, (select id from public.ai_pipeline_stages where key = 'interested'), null, 'ai', 'saya berminat');
  assert not public.ai_lead_set_stage(lid, (select id from public.ai_pipeline_stages where key = 'loan_approved'), null, 'ai', 'loan dah lulus'), 'loan approval needs a person';
  assert not public.ai_lead_set_stage(lid, (select id from public.ai_pipeline_stages where key = 'new_enquiry'), null, 'ai', 'x y z'), 'never backwards';
  assert not public.ai_lead_set_stage(lid, (select id from public.ai_pipeline_stages where key = 'cancelled'), null, 'ai', 'tak jadi'), 'never closes';
  assert exists (select 1 from public.ai_activities where lead_id = lid and kind = 'stage_change' and actor = 'ai' and meta ->> 'evidence' = 'saya berminat');
  assert exists (select 1 from public.ai_automation_jobs where lead_id = lid and kind = 'smart_follow_up' and status = 'scheduled'), 'AI move keeps the check-in';
  -- a confirmed appointment moves the lead to Appointment Booked
  insert into public.ai_appointments (lead_id, kind, status, start_at) values (lid, 'showroom_visit', 'confirmed', now() + interval '2 days');
  assert (select s.key from public.ai_leads l join public.ai_pipeline_stages s on s.id = l.stage_id where l.id = lid) = 'appointment_booked';
end $$;
set local role authenticated;
do $$ declare lid uuid := (select lid from t63); begin
  perform public.t_login('viewer@test.local');
  begin perform public.ai_lead_set_stage(lid, (select id from public.ai_pipeline_stages where key = 'unit_booked'), 'x'); assert false, 'viewer moved'; exception when raise_exception then null; end;
  perform public.t_login('advisor@test.local');
  begin perform public.ai_lead_set_stage(lid, (select id from public.ai_pipeline_stages where key = 'unit_booked'), 'x', 'ai', 'booked'); assert false, 'advisor used AI path'; exception when raise_exception then null; end;
  -- a person moves the lead (with a note): stale automatic check-ins are cancelled, the reason is recorded
  assert public.ai_lead_set_stage(lid, (select id from public.ai_pipeline_stages where key = 'unit_booked'), 'paid booking fee at showroom');
  assert exists (select 1 from public.ai_activities where lead_id = lid and kind = 'stage_change' and body like '%Unit Booked · paid booking fee at showroom' and meta ->> 'source' = 'staff');
  assert not exists (select 1 from public.ai_automation_jobs where lead_id = lid and kind = 'smart_follow_up' and status = 'scheduled');
  assert (select reason from public.ai_automation_jobs where lead_id = lid and kind = 'smart_follow_up' order by created_at desc limit 1) = 'stage changed to Unit Booked';
end $$;
reset role;
do $$ declare lid uuid := (select lid from t63); begin
  -- a later appointment does not move a booked lead back
  insert into public.ai_appointments (lead_id, kind, status, start_at) values (lid, 'property_viewing', 'confirmed', now() + interval '3 days');
  assert (select s.key from public.ai_leads l join public.ai_pipeline_stages s on s.id = l.stage_id where l.id = lid) = 'unit_booked';
end $$;
rollback;

\echo 'T64 geo cache: server only — staff and visitors cannot read or write it; the service role upserts by key'
begin;
set local role service_role;
insert into public.ai_geo_cache (key, kind, value, expires_at) values ('route:1,2|x|walk', 'route', '{"distance_m": 650}', now() + interval '14 days');
insert into public.ai_geo_cache (key, kind, value, expires_at) values ('route:1,2|x|walk', 'route', '{"distance_m": 700}', now() + interval '14 days')
  on conflict (key) do update set value = excluded.value;
do $$ begin assert (select (value ->> 'distance_m')::int from public.ai_geo_cache where key = 'route:1,2|x|walk') = 700; end $$;
reset role;
set local role authenticated;
do $$ begin
  begin perform 1 from public.ai_geo_cache; assert false, 'staff must not read the cache'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin insert into public.ai_geo_cache (key, kind, value, expires_at) values ('x', 'place', '{}', now()); assert false; exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  begin insert into public.ai_geo_cache (key, kind, value, expires_at) values ('y', 'nonsense', '{}', now()); assert false; exception when check_violation then null; end;
end $$;
rollback;

\echo 'T65 WhatsApp username buyers: a user id (no phone) gets a contact, lead, chat and reply job; never stored as a phone; a phone id still is'
begin;
do $$
declare r jsonb; r2 jsonb; c public.ai_contacts;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.ai_wa_inbound('MY.1349120865530274', 'Buyer With Username', 'wamid.U1', 'text', 'Hi, info M Mira?');
  assert (r ->> 'job_id') is not null, 'a reply job is queued';
  select * into c from public.ai_contacts where id = (r ->> 'contact_id')::uuid;
  assert c.wa_id = 'MY.1349120865530274' and c.phone_e164 is null, 'the user id is the WhatsApp id, not a phone';
  -- a short user id whose digits look like a phone number is still not a phone
  r2 := public.ai_wa_inbound('MY.60123456789', 'Other', 'wamid.U2', 'text', 'Hello');
  assert (select phone_e164 from public.ai_contacts where id = (r2 ->> 'contact_id')::uuid) is null;
  assert (r2 ->> 'contact_id') <> (r ->> 'contact_id');
  -- the same buyer again: same contact and chat
  r2 := public.ai_wa_inbound('MY.1349120865530274', 'Buyer With Username', 'wamid.U3', 'text', 'Hello again');
  assert (r2 ->> 'contact_id') = (r ->> 'contact_id') and (r2 ->> 'conversation_id') = (r ->> 'conversation_id');
  -- a reply from the phone app to that buyer: recorded in the same chat, AI steps back
  r2 := public.ai_wa_echo('MY.1349120865530274', 'wamid.U4', 'text', 'Hi, saya Hafizan');
  assert (r2 ->> 'conversation_id') = (r ->> 'conversation_id');
  -- a normal phone number still becomes the phone
  r2 := public.ai_wa_inbound('60198765432', 'Phone Buyer', 'wamid.U5', 'text', 'Hi');
  assert (select phone_e164 from public.ai_contacts where id = (r2 ->> 'contact_id')::uuid) = '60198765432';
end $$;
rollback;

\echo 'ALL DB TESTS PASSED'
