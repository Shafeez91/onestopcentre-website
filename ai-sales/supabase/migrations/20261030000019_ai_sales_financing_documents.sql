-- AI Sales migration 19 (30 Oct 2026): financing documents. Staff upload a buyer's payslip, CCRIS report or bank
-- statement on the lead page; the AI reads the figures; a staff member checks them before they reach the calculator.
-- ADDITIVE ONLY: one private storage bucket, one table, three functions, a settings flag; ai_erase_contact extended.
--
-- PDPA: the files hold personal data (IC number, salary, accounts). They sit in a private bucket that only the
-- server (service role) can reach — no storage policies for signed-in users at all — and are deleted, with the row
-- and what the AI read, after compliance.financing_docs_retention_days (default 30). The figures a staff member
-- confirms live on in ai_financing_profiles as before. The table has no audit trigger on purpose: the audit trail
-- must not keep a copy of what was read past the retention period (the server audits the actions, without figures).

do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit) values ('ai-financing-docs', 'ai-financing-docs', false, 4194304)
    on conflict (id) do update set public = false;
  end if;
end $$;

create or replace function public.ai_financing_doc_expiry()
returns timestamptz language sql stable security definer set search_path = public as $$
  select now() + make_interval(days => least(365, greatest(1, coalesce((select (compliance ->> 'financing_docs_retention_days')::int from public.ai_settings where id = 1), 30))));
$$;

create table if not exists public.ai_financing_documents (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid references public.ai_leads(id) on delete set null,   -- a deleted lead leaves the file for the purge
  kind         text not null check (kind in ('payslip','ccris','bank_statement')),
  file_name    text not null check (length(file_name) between 1 and 200),
  mime         text not null check (mime in ('application/pdf','image/jpeg','image/png','image/webp')),
  size_bytes   int  not null check (size_bytes > 0 and size_bytes <= 4194304),
  storage_path text not null unique,
  status       text not null default 'uploaded' check (status in ('uploaded','read','unreadable','failed','confirmed')),
  extracted    jsonb,
  error        text,
  model        text,
  uploaded_by  text not null,
  read_at      timestamptz,
  confirmed_by text,
  confirmed_at timestamptz,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default public.ai_financing_doc_expiry()
);
create index if not exists ai_financing_documents_lead on public.ai_financing_documents (lead_id, created_at desc);
create index if not exists ai_financing_documents_expiry on public.ai_financing_documents (expires_at);

-- advisors and above can see the list and what was read; every change goes through the server
alter table public.ai_financing_documents enable row level security;
revoke all on public.ai_financing_documents from anon, authenticated;
grant select on public.ai_financing_documents to authenticated;
drop policy if exists "ai read" on public.ai_financing_documents;
create policy "ai read" on public.ai_financing_documents for select to authenticated using (public.ai_has_role('advisor'));

update public.ai_settings set compliance = compliance || '{"financing_docs_retention_days": 30}'::jsonb
 where id = 1 and not (compliance ? 'financing_docs_retention_days');
update public.ai_settings set flags = flags || '{"financing_documents": true}'::jsonb
 where id = 1 and not (flags ? 'financing_documents');

-- what the purge must remove: expired rows, rows whose lead was deleted, and stray files in the bucket with no row
create or replace function public.ai_financing_docs_due(p_limit int default 50)
returns table (id uuid, storage_path text) language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'not allowed'; end if;
  return query
    select d.id, d.storage_path from public.ai_financing_documents d
     where d.expires_at < now() or d.lead_id is null
    union all
    select null::uuid, o.name from storage.objects o
     where o.bucket_id = 'ai-financing-docs' and o.created_at < now() - interval '1 day'
       and not exists (select 1 from public.ai_financing_documents d where d.storage_path = o.name)
    limit greatest(1, least(p_limit, 200));
end $$;

-- after the server has deleted the files
create or replace function public.ai_financing_docs_purged(p_ids uuid[])
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.role() <> 'service_role' then raise exception 'not allowed'; end if;
  delete from public.ai_financing_documents where id = any(coalesce(p_ids, '{}'));
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.ai_financing_doc_expiry() from public, anon;
revoke all on function public.ai_financing_docs_due(int) from public, anon, authenticated;
revoke all on function public.ai_financing_docs_purged(uuid[]) from public, anon, authenticated;
grant execute on function public.ai_financing_doc_expiry() to authenticated, service_role;
grant execute on function public.ai_financing_docs_due(int), public.ai_financing_docs_purged(uuid[]) to service_role;

-- PDPA erase: what was read is wiped now and the files are deleted by the next purge (within the hour).
-- Everything else in this function is unchanged from migration 16.
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
  update public.ai_activities set body = '[erased]', meta = '{}'::jsonb where contact_id = p_contact or lead_id in (select id from public.ai_leads where contact_id = p_contact);
  update public.ai_leads set qualification = '{}'::jsonb, profile = '{}'::jsonb, profile_meta = '{}'::jsonb, ai_summary = '{}'::jsonb where contact_id = p_contact;
  delete from public.ai_lead_field_history where lead_id in (select id from public.ai_leads where contact_id = p_contact);
  update public.ai_lead_interests set note = null, budget_text = null, next_action = null where lead_id in (select id from public.ai_leads where contact_id = p_contact);
  update public.ai_financing_documents set extracted = null, error = null, file_name = '[erased]', expires_at = now() - interval '1 second'
   where lead_id in (select id from public.ai_leads where contact_id = p_contact);
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
