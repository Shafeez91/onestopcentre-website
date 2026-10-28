-- AI Sales module — RMK (Residensi Metropolitan Kepong): its own lead pipeline and stage follow-ups. ADDITIVE ONLY.
--
-- Stages: new → to_book → to_portal (RUMAWIP) → to_submit_loan → to_sign (LO, SPA & LA) → all_signed.
-- The buyer moves a lead on by replying the stage keyword (RMK · DONE BOOKED · DONE PORTAL · DONE SUBMIT LOAN ·
-- DONE SIGNED), the AI when the buyer clearly says the same in their own words, or staff on the RMK page.
-- Isolation: only leads in ai_rmk_pipeline get RMK follow-ups (job kind rmk_follow_up); every job re-checks the
-- lead, its stage and its project right before sending. Nothing here changes other projects' leads or follow-ups.
-- Sending is OFF until switched on in Settings → RMK (ai_settings.rmk.enabled).

-- ---------------------------------------------------------------------------- settings
alter table public.ai_settings add column if not exists rmk jsonb not null default '{}'::jsonb;
update public.ai_settings set rmk = jsonb_build_object(
  'enabled', false,
  'project_id', null,                -- the website listing for RMK, once it exists (optional)
  'pause_if_active_hours', 6,        -- no reminder while the buyer has talked to us within this many hours
  'stages', jsonb_build_object(
    'new',            jsonb_build_object('follow_up_hours', 0,  'max_follow_ups', 0, 'template', '',
      'message_ms', '', 'message_en', ''),
    'to_book',        jsonb_build_object('follow_up_hours', 24, 'max_follow_ups', 3, 'template', 'rmk_to_book',
      'message_ms', 'Hai {name} 👋 Ini peringatan untuk tempahan unit RMK (Residensi Metropolitan Kepong). Kalau dah buat booking, balas *DONE BOOKED*. Ada soalan? Balas sahaja mesej ini 😊',
      'message_en', 'Hi {name} 👋 A reminder about booking your RMK (Residensi Metropolitan Kepong) unit. Once you have booked, reply *DONE BOOKED*. Any questions? Just reply to this message 😊'),
    'to_portal',      jsonb_build_object('follow_up_hours', 24, 'max_follow_ups', 3, 'template', 'rmk_to_portal',
      'message_ms', 'Hai {name}, langkah seterusnya untuk RMK ialah mendaftar di portal RUMAWIP. Bila dah selesai, balas *DONE PORTAL*. Perlukan bantuan untuk daftar? Balas mesej ini 😊',
      'message_en', 'Hi {name}, the next step for RMK is to register on the RUMAWIP portal. Once done, reply *DONE PORTAL*. Need help registering? Reply to this message 😊'),
    'to_submit_loan', jsonb_build_object('follow_up_hours', 48, 'max_follow_ups', 3, 'template', 'rmk_to_submit_loan',
      'message_ms', 'Hai {name}, untuk RMK, sila hantar dokumen permohonan pinjaman. Bila dah hantar, balas *DONE SUBMIT LOAN*. Tak pasti dokumen apa diperlukan? Balas mesej ini 😊',
      'message_en', 'Hi {name}, for RMK, please submit your loan application documents. Once submitted, reply *DONE SUBMIT LOAN*. Not sure which documents are needed? Reply to this message 😊'),
    'to_sign',        jsonb_build_object('follow_up_hours', 48, 'max_follow_ups', 3, 'template', 'rmk_to_sign',
      'message_ms', 'Hai {name}, langkah terakhir RMK: tandatangan LO, SPA & LA. Bila semua dah ditandatangani, balas *DONE SIGNED*. Perlukan slot untuk tandatangan? Balas mesej ini 😊',
      'message_en', 'Hi {name}, the last RMK step: signing the LO, SPA & LA. Once everything is signed, reply *DONE SIGNED*. Need a signing slot? Reply to this message 😊')
  )) || rmk
 where id = 1;

create or replace function public.ai_rmk_cfg() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select rmk from public.ai_settings where id = 1), '{}'::jsonb)
$$;

-- ---------------------------------------------------------------------------- pipeline
create table public.ai_rmk_pipeline (
  lead_id          uuid primary key references public.ai_leads(id) on delete cascade,
  stage            text not null default 'new' check (stage in ('new','to_book','to_portal','to_submit_loan','to_sign','all_signed')),
  status           text not null default 'active' check (status in ('active','paused','completed','human')),
  status_reason    text,
  source           text not null default 'other' check (source in ('facebook','instagram','website','whatsapp','other')),
  stage_changed_at timestamptz not null default now(),
  enrolled_at      timestamptz not null default now(),
  enrolled_by      text not null default public.ai_actor(),
  history          jsonb not null default '[]'::jsonb,   -- [{at, from, to, by, via}] / [{at, status, reason, by}]
  updated_at       timestamptz not null default now()
);
create index ai_rmk_stage on public.ai_rmk_pipeline (stage, status);
create trigger ai_rmk_pipeline_touch before update on public.ai_rmk_pipeline for each row execute function public.ai_touch_updated();
alter table public.ai_rmk_pipeline enable row level security;
revoke all on public.ai_rmk_pipeline from anon;
create policy "ai read" on public.ai_rmk_pipeline for select to authenticated using (public.ai_has_role('viewer'));
-- changes go through the functions below (advisors and up), so stage rules and scheduling always apply

-- ---------------------------------------------------------------------------- jobs
alter table public.ai_automation_jobs drop constraint ai_automation_jobs_kind_check;
alter table public.ai_automation_jobs add constraint ai_automation_jobs_kind_check
  check (kind in ('smart_follow_up','human_reminder','appt_confirmation','appt_reminder','rmk_follow_up'));
alter table public.ai_automation_jobs add column if not exists stage text;
alter table public.ai_automation_jobs add column if not exists seq int;
-- at most one RMK reminder waiting per lead, whoever schedules it
create unique index ai_automation_rmk_one on public.ai_automation_jobs (lead_id) where kind = 'rmk_follow_up' and status = 'scheduled';

create or replace function public.ai_rmk_next(p_stage text) returns text
language sql immutable set search_path = public as $$
  select case p_stage when 'new' then 'to_book' when 'to_book' then 'to_portal' when 'to_portal' then 'to_submit_loan'
                      when 'to_submit_loan' then 'to_sign' when 'to_sign' then 'all_signed' end
$$;

-- Cancels the lead's scheduled RMK reminders and, while it is active, schedules the first one of its stage.
create or replace function public.ai_rmk_schedule(p_lead uuid, p_reason text default 'stage changed') returns uuid
language plpgsql security definer set search_path = public as $$
declare p public.ai_rmk_pipeline; st jsonb; hrs numeric; conv uuid; j uuid;
begin
  update public.ai_automation_jobs set status = 'cancelled', reason = p_reason
   where lead_id = p_lead and kind = 'rmk_follow_up' and status = 'scheduled';
  select * into p from public.ai_rmk_pipeline where lead_id = p_lead;
  if p.lead_id is null or p.status <> 'active' or p.stage = 'all_signed' then return null; end if;
  st := public.ai_rmk_cfg() -> 'stages' -> p.stage;
  hrs := coalesce((st ->> 'follow_up_hours')::numeric, 0);
  if hrs <= 0 or coalesce((st ->> 'max_follow_ups')::int, 0) <= 0 then return null; end if;
  select v.id into conv from public.ai_conversations v join public.ai_leads l on l.contact_id = v.contact_id
   where l.id = p_lead and v.channel = 'whatsapp' and v.status = 'open' order by v.updated_at desc limit 1;
  insert into public.ai_automation_jobs (kind, conversation_id, lead_id, stage, seq, run_at, dedupe_key)
  values ('rmk_follow_up', conv, p_lead, p.stage, 1, now() + make_interval(secs => greatest(1, least(720, hrs)) * 3600),
          'rmk:' || p_lead || ':' || p.stage || ':1:' || (extract(epoch from clock_timestamp()) * 1e6)::bigint)
  on conflict (lead_id) where kind = 'rmk_follow_up' and status = 'scheduled' do nothing
  returning id into j;
  return j;
end $$;

-- Puts a lead in the RMK pipeline (stage "new"). Idempotent: a lead already in it is left as it is.
create or replace function public.ai_rmk_enroll(p_lead uuid, p_source text default 'other', p_by text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_lead is null then return false; end if;
  if coalesce(auth.role(), '') = 'authenticated' and not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  insert into public.ai_rmk_pipeline (lead_id, source, enrolled_by, history)
  values (p_lead, case when p_source in ('facebook','instagram','website','whatsapp') then p_source else 'other' end,
          coalesce(p_by, public.ai_actor()), jsonb_build_array(jsonb_build_object('at', now(), 'to', 'new', 'by', coalesce(p_by, public.ai_actor()), 'via', 'enrolled')))
  on conflict (lead_id) do nothing;
  get diagnostics n = row_count;
  if n > 0 then perform public.ai_rmk_schedule(p_lead, 'enrolled'); end if;
  return n > 0;
end $$;

-- Moves a lead one stage on, only from the stage expected (a repeated or out-of-order confirmation changes nothing).
create or replace function public.ai_rmk_advance(p_lead uuid, p_from text, p_by text default null, p_via text default 'keyword') returns boolean
language plpgsql security definer set search_path = public as $$
declare nxt text := public.ai_rmk_next(p_from); n int;
begin
  if nxt is null then return false; end if;
  update public.ai_rmk_pipeline
     set stage = nxt, stage_changed_at = now(),
         status = case when nxt = 'all_signed' then 'completed' when status = 'human' then 'active' else status end,
         status_reason = case when nxt = 'all_signed' then 'all signed' when status = 'human' then null else status_reason end,
         history = history || jsonb_build_object('at', now(), 'from', p_from, 'to', nxt, 'by', coalesce(p_by, public.ai_actor()), 'via', p_via)
   where lead_id = p_lead and stage = p_from and status <> 'paused';
  get diagnostics n = row_count;
  if n > 0 then perform public.ai_rmk_schedule(p_lead, case when nxt = 'all_signed' then 'all signed' else 'stage changed' end); end if;
  return n > 0;
end $$;

-- Staff: set any stage (corrections), or pause / resume the automation for one lead.
create or replace function public.ai_rmk_set_stage(p_lead uuid, p_stage text) returns boolean
language plpgsql security definer set search_path = public as $$
declare cur text;
begin
  if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  if p_stage not in ('new','to_book','to_portal','to_submit_loan','to_sign','all_signed') then raise exception 'Unknown stage %', p_stage; end if;
  select stage into cur from public.ai_rmk_pipeline where lead_id = p_lead for update;
  if cur is null then raise exception 'This lead is not in the RMK pipeline'; end if;
  if cur = p_stage then return false; end if;
  update public.ai_rmk_pipeline
     set stage = p_stage, stage_changed_at = now(),
         status = case when p_stage = 'all_signed' then 'completed' when status in ('completed','human') then 'active' else status end,
         status_reason = case when p_stage = 'all_signed' then 'all signed' when status in ('completed','human') then null else status_reason end,
         history = history || jsonb_build_object('at', now(), 'from', cur, 'to', p_stage, 'by', public.ai_actor(), 'via', 'staff')
   where lead_id = p_lead;
  perform public.ai_rmk_schedule(p_lead, 'stage changed by staff');
  return true;
end $$;

create or replace function public.ai_rmk_set_status(p_lead uuid, p_status text, p_reason text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare p public.ai_rmk_pipeline;
begin
  if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  if p_status not in ('active','paused') then raise exception 'Status must be active or paused'; end if;
  select * into p from public.ai_rmk_pipeline where lead_id = p_lead for update;
  if p.lead_id is null then raise exception 'This lead is not in the RMK pipeline'; end if;
  if p.stage = 'all_signed' then raise exception 'All signed: nothing to follow up'; end if;
  update public.ai_rmk_pipeline set status = p_status, status_reason = nullif(trim(coalesce(p_reason, '')), ''),
         history = history || jsonb_build_object('at', now(), 'status', p_status, 'reason', p_reason, 'by', public.ai_actor())
   where lead_id = p_lead;
  perform public.ai_rmk_schedule(p_lead, case when p_status = 'paused' then 'paused by staff' else 'resumed by staff' end);
  return true;
end $$;

-- After switching sending on (or changing the intervals): reschedule every active lead's current stage.
create or replace function public.ai_rmk_reschedule_all() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if coalesce(auth.role(), '') = 'authenticated' and not public.ai_has_role('manager') then raise exception 'Managers only'; end if;
  for r in select lead_id from public.ai_rmk_pipeline where status = 'active' and stage <> 'all_signed' loop
    if public.ai_rmk_schedule(r.lead_id, 'rescheduled after a settings change') is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------- buyer messages
-- The exact stage keywords move the lead on; the project's full name puts a WhatsApp buyer in the pipeline.
-- A bare "RMK" from someone not in the pipeline is left to the AI, which asks which project they mean.
create or replace function public.ai_rmk_on_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare lid uuid; cur text; k text; expect text;
begin
  if new.direction <> 'inbound' or coalesce(new.body, '') = '' then return new; end if;
  select l.id into lid from public.ai_conversations v join public.ai_leads l on l.id = v.lead_id
   where v.id = new.conversation_id and l.closed_at is null;
  if lid is null then return new; end if;
  select stage into cur from public.ai_rmk_pipeline where lead_id = lid;
  if cur is null then
    if new.body ~* 'metropolitan\s*kepong' then perform public.ai_rmk_enroll(lid, 'whatsapp', 'buyer message'); end if;
    return new;
  end if;
  k := trim(regexp_replace(upper(new.body), '[^A-Z]+', ' ', 'g'));
  expect := case
    when k = 'RMK' then 'new'
    when k in ('DONE BOOKED','DONE BOOKING','DONE BOOK') then 'to_book'
    when k in ('DONE PORTAL') then 'to_portal'
    when k in ('DONE SUBMIT LOAN','DONE SUBMIT','DONE LOAN','DONE SUBMITTED') then 'to_submit_loan'
    when k in ('DONE SIGNED','DONE SIGN','DONE SIGNING') then 'to_sign'
  end;
  if expect is not null and expect = cur then perform public.ai_rmk_advance(lid, cur, 'buyer', 'keyword'); end if;
  return new;
exception when others then
  raise warning 'ai_rmk_on_message: %', sqlerrm;   -- never block recording a message
  return new;
end $$;
create trigger ai_messages_rmk after insert on public.ai_messages for each row execute function public.ai_rmk_on_message();

-- ---------------------------------------------------------------------------- project of the lead
-- A lead set to the RMK listing (website enquiry or staff) joins the pipeline; a lead moved to another project is
-- paused there, and its RMK reminders stop.
create or replace function public.ai_rmk_on_lead() returns trigger
language plpgsql security definer set search_path = public as $$
declare rmk_pid text := nullif(public.ai_rmk_cfg() ->> 'project_id', ''); src text;
begin
  if new.primary_project_id is not distinct from (case when tg_op = 'UPDATE' then old.primary_project_id end) then return new; end if;
  if rmk_pid is not null and new.primary_project_id = rmk_pid then
    select case s.channel when 'website' then 'website' when 'whatsapp' then 'whatsapp' when 'facebook' then 'facebook' when 'instagram' then 'instagram' else 'other' end
      into src from public.ai_lead_sources s where s.id = new.source_id;
    perform public.ai_rmk_enroll(new.id, coalesce(src, 'other'), 'project');
    -- back on RMK after a pause for a project change: resume
    update public.ai_rmk_pipeline set status = 'active', status_reason = null,
           history = history || jsonb_build_object('at', now(), 'status', 'active', 'reason', 'project set back to RMK', 'by', public.ai_actor())
     where lead_id = new.id and status = 'paused' and status_reason like 'project changed%';
    if found then perform public.ai_rmk_schedule(new.id, 'project set back to RMK'); end if;
  elsif new.primary_project_id is not null then
    update public.ai_rmk_pipeline set status = 'paused',
           status_reason = 'project changed to ' || coalesce((select data ->> 'n' from public.projects where id = new.primary_project_id), new.primary_project_id),
           history = history || jsonb_build_object('at', now(), 'status', 'paused', 'reason', 'project changed', 'by', public.ai_actor())
     where lead_id = new.id and status in ('active','human');
    if found then perform public.ai_rmk_schedule(new.id, 'project changed'); end if;
  end if;
  return new;
exception when others then
  raise warning 'ai_rmk_on_lead: %', sqlerrm;
  return new;
end $$;
create trigger ai_leads_rmk after insert or update of primary_project_id on public.ai_leads for each row execute function public.ai_rmk_on_lead();

revoke all on function public.ai_rmk_on_message() from public, anon, authenticated;
revoke all on function public.ai_rmk_on_lead() from public, anon, authenticated;
revoke all on function public.ai_rmk_schedule(uuid, text) from public, anon, authenticated;
revoke all on function public.ai_rmk_advance(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.ai_rmk_cfg() from public, anon;
revoke all on function public.ai_rmk_next(text) from public, anon;
grant execute on function public.ai_rmk_next(text) to authenticated, service_role;
revoke all on function public.ai_rmk_enroll(uuid, text, text) from public, anon;
revoke all on function public.ai_rmk_set_stage(uuid, text) from public, anon;
revoke all on function public.ai_rmk_set_status(uuid, text, text) from public, anon;
revoke all on function public.ai_rmk_reschedule_all() from public, anon;
grant execute on function public.ai_rmk_enroll(uuid, text, text), public.ai_rmk_set_stage(uuid, text), public.ai_rmk_set_status(uuid, text, text),
  public.ai_rmk_reschedule_all(), public.ai_rmk_cfg() to authenticated, service_role;
grant execute on function public.ai_rmk_advance(uuid, text, text, text), public.ai_rmk_schedule(uuid, text) to service_role;
