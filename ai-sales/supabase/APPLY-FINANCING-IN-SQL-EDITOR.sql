-- AI Sales module — loan eligibility engine database changes in ONE transaction (all-or-nothing).
-- For the live database, which already has migrations 1–7. Paste into Supabase → SQL Editor → New query → Run.
-- Additive only. Running it twice fails harmlessly with "already exists" and changes nothing.
begin;

-- AI Sales module — loan eligibility & affordability engine (preliminary LPPSA / bank estimates).
-- ADDITIVE ONLY: one settings column, two new tables, and the PDPA erase / retention functions extended to cover them.
-- Nothing here touches the website's own tables or existing ai_* rows.
--
-- Income and commitment figures are personal financial data: they live in their own tables, readable by advisors
-- and above only (viewers see the outcome label on the lead, not the figures), are audited, erased with the
-- contact, and deleted after the retention period (compliance.financing_retention_days, default 365).

-- owner-editable assumptions (LPPSA rule set and bank scenarios); empty = the defaults in sales/shared/finance.mjs
alter table public.ai_settings add column if not exists financing jsonb not null default '{}'::jsonb;

-- the figures collected so far for one lead (one row per lead, updated as the buyer answers)
create table public.ai_financing_profiles (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null unique references public.ai_leads(id) on delete cascade,
  route       text check (route in ('lppsa','bank')),
  inputs      jsonb not null default '{}'::jsonb,
  result      jsonb,
  outcome     text check (outcome in ('potentially_affordable','may_be_affordable_with_adjustments','potentially_challenging','insufficient_information')),
  source      text not null default 'ai' check (source in ('ai','advisor')),
  updated_by  text not null default public.ai_actor(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- every completed calculation, kept as a history (what was calculated, from which figures, under which rules)
create table public.ai_financing_assessments (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.ai_leads(id) on delete cascade,
  route         text not null check (route in ('lppsa','bank')),
  inputs        jsonb not null,
  result        jsonb not null,
  outcome       text not null check (outcome in ('potentially_affordable','may_be_affordable_with_adjustments','potentially_challenging','insufficient_information')),
  rules_version text,
  engine_version text,
  source        text not null default 'ai' check (source in ('ai','advisor')),
  created_by    text not null default public.ai_actor(),
  created_at    timestamptz not null default now()
);
create index ai_financing_assessments_lead on public.ai_financing_assessments (lead_id, created_at desc);

create trigger ai_financing_profiles_touch before update on public.ai_financing_profiles for each row execute function public.ai_touch_updated();
create trigger ai_financing_profiles_audit after insert or update or delete on public.ai_financing_profiles for each row execute function public.ai_audit();
create trigger ai_financing_assessments_audit after insert or update or delete on public.ai_financing_assessments for each row execute function public.ai_audit();

alter table public.ai_financing_profiles enable row level security;
alter table public.ai_financing_assessments enable row level security;
revoke all on public.ai_financing_profiles from anon;
revoke all on public.ai_financing_assessments from anon;
create policy "ai read" on public.ai_financing_profiles for select to authenticated using (public.ai_has_role('advisor'));
create policy "ai insert" on public.ai_financing_profiles for insert to authenticated with check (public.ai_has_role('advisor'));
create policy "ai update" on public.ai_financing_profiles for update to authenticated using (public.ai_has_role('advisor')) with check (public.ai_has_role('advisor'));
create policy "ai delete" on public.ai_financing_profiles for delete to authenticated using (public.ai_has_role('manager'));
create policy "ai read" on public.ai_financing_assessments for select to authenticated using (public.ai_has_role('advisor'));
create policy "ai insert" on public.ai_financing_assessments for insert to authenticated with check (public.ai_has_role('advisor'));
create policy "ai delete" on public.ai_financing_assessments for delete to authenticated using (public.ai_has_role('manager'));
-- (no update policy: a recorded calculation is never edited, only superseded by a new one)

update public.ai_settings set compliance = compliance || '{"financing_retention_days": 365}'::jsonb
 where id = 1 and not (compliance ? 'financing_retention_days');

-- PDPA erasure now also deletes the financing figures, and scrubs them from the audit trail
create or replace function public.ai_erase_contact(p_contact uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare fin text[];
begin
  if auth.role() <> 'service_role' and not public.ai_has_role('owner') then raise exception 'only owners can erase contacts'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required'; end if;
  update public.ai_contacts set full_name = '[erased]', phone_e164 = null, wa_id = null, email = null, notes = null, erased_at = now()
   where id = p_contact;
  update public.ai_messages set body = '[erased]', media = null
   where conversation_id in (select id from public.ai_conversations where contact_id = p_contact);
  update public.ai_activities set body = '[erased]' where contact_id = p_contact or lead_id in (select id from public.ai_leads where contact_id = p_contact);
  update public.ai_leads set qualification = '{}'::jsonb where contact_id = p_contact;
  select array_agg(id::text) into fin from (
    select id from public.ai_financing_profiles where lead_id in (select id from public.ai_leads where contact_id = p_contact)
    union all
    select id from public.ai_financing_assessments where lead_id in (select id from public.ai_leads where contact_id = p_contact)) x;
  delete from public.ai_financing_profiles where lead_id in (select id from public.ai_leads where contact_id = p_contact);
  delete from public.ai_financing_assessments where lead_id in (select id from public.ai_leads where contact_id = p_contact);
  -- the audit trail must not keep the erased personal data either
  update public.ai_audit_logs set changes = jsonb_build_object('erased', true)
   where (table_name = 'ai_contacts' and record_id = p_contact::text)
      or (table_name = 'ai_leads' and record_id in (select id::text from public.ai_leads where contact_id = p_contact))
      or (table_name in ('ai_financing_profiles','ai_financing_assessments') and record_id = any(coalesce(fin, '{}')));
  insert into public.ai_audit_logs (actor, action, table_name, record_id, changes)
  values (public.ai_actor(), 'erase_contact', 'ai_contacts', p_contact::text, jsonb_build_object('reason', p_reason));
end $$;

-- retention: financing figures are deleted after compliance.financing_retention_days (default 365) without an update
create or replace function public.ai_purge_expired()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a int; b int; c int; d int; e int; days int; fin text[];
begin
  if auth.role() <> 'service_role' and not public.ai_has_role('owner') then raise exception 'not allowed'; end if;
  delete from public.ai_webhook_events where received_at < now() - interval '90 days' and status <> 'failed';
  get diagnostics a = row_count;
  update public.ai_agent_runs set input = null, output = null where created_at < now() - interval '180 days' and (input is not null or output is not null);
  get diagnostics b = row_count;
  delete from public.ai_jobs where status in ('done','dead') and updated_at < now() - interval '30 days';
  delete from public.ai_notifications where created_at < now() - interval '90 days';
  get diagnostics c = row_count;
  select greatest(30, coalesce((compliance ->> 'financing_retention_days')::int, 365)) into days from public.ai_settings where id = 1;
  days := coalesce(days, 365);
  select array_agg(id::text) into fin from (
    select id from public.ai_financing_profiles where updated_at < now() - make_interval(days => days)
    union all
    select id from public.ai_financing_assessments where created_at < now() - make_interval(days => days)) x;
  delete from public.ai_financing_profiles where updated_at < now() - make_interval(days => days);
  get diagnostics d = row_count;
  delete from public.ai_financing_assessments where created_at < now() - make_interval(days => days);
  get diagnostics e = row_count;
  update public.ai_audit_logs set changes = jsonb_build_object('expired', true)
   where table_name in ('ai_financing_profiles','ai_financing_assessments') and record_id = any(coalesce(fin, '{}'));
  return jsonb_build_object('webhook_events_deleted', a, 'agent_runs_trimmed', b, 'notifications_deleted', c, 'financing_deleted', d + e);
end $$;

revoke all on function public.ai_erase_contact(uuid,text) from public, anon;
revoke all on function public.ai_purge_expired() from public, anon;
grant execute on function public.ai_erase_contact(uuid,text) to authenticated, service_role;
grant execute on function public.ai_purge_expired() to authenticated, service_role;

commit;
