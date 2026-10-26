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
  assert (select s.name from public.ai_leads l join public.ai_pipeline_stages s on s.id = l.stage_id where l.id = l1) = 'New Lead';
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
insert into public.leads (name, phone, email, project, message, consent) values
  ('Farid', '012-999 8888', null, 'Test Residence', 'Berapa harga?', true),
  ('Mei Ling', null, 'mei@example.test', 'Unknown Project', 'Price list please', true),
  ('No Contact', null, '-', null, 'hi', true);
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
  update public.ai_leads set stage_id = (select id from public.ai_pipeline_stages where name = 'Qualified') where id = l;
  assert exists (select 1 from public.ai_activities where lead_id = l and kind = 'stage_change' and body = 'New Lead → Qualified');
  update public.ai_leads set stage_id = (select id from public.ai_pipeline_stages where name = 'Won'), owner_email = 'advisor@test.local' where id = l;
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
  assert (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname in ('projects','settings','leads') and not t.tgisinternal) = 3,
    'no new triggers on existing tables';
end $$;

\echo 'ALL DB TESTS PASSED'
