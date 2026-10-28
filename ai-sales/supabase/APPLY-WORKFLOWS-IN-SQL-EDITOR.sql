-- Paste into Supabase Dashboard → SQL Editor → New query → Run (one transaction). Needs migrations 1–14 already applied.
begin;

-- AI Sales module — follow-up workflows built in the dashboard (2026-10-28). ADDITIVE ONLY.
--
-- Until now the RMK pipeline (migration 14) had its stages, keywords and transitions written into SQL and code.
-- This makes every follow-up workflow data:
--   ai_workflows          one workflow (usually per project): name, project, entry rules, sending switch, safeguards
--   ai_workflow_stages    its stages in order: keywords (first = the one shown to buyers, the rest aliases),
--                         reminder interval and count, BM/EN messages, 24-hour template, next stage, final stage,
--                         "a person takes over on entering", "a person takes over after the last reminder", active
--   ai_workflow_leads     the leads in a workflow: stage, automation status, source, history of every move
--   ai_workflow_changes   audit trail of every settings change (who, when, before and after)
-- Changes go through ai_wf_save (managers), which validates the whole workflow in one transaction.
-- RMK is copied in unchanged (same stages, keywords, messages, intervals, template names, sending switch).
-- ai_settings.rmk and ai_rmk_pipeline stay as they are (kept, no longer read); the ai_rmk_* functions now act on the
-- RMK workflow, so earlier callers keep working. Reminders are job kind workflow_follow_up; there are no
-- rmk_follow_up jobs in production, any left scheduled are moved over below.

-- ---------------------------------------------------------------------------- tables
create table public.ai_workflows (
  id                    uuid primary key default gen_random_uuid(),
  key                   text not null unique check (key ~ '^[a-z0-9_]{2,40}$'),
  name                  text not null check (length(trim(name)) between 1 and 120),
  description           text,
  project_id            text,                          -- the website listing (projects.id) this workflow belongs to
  status                text not null default 'active' check (status in ('active','archived')),
  sending_enabled       boolean not null default false, -- WhatsApp reminders are sent only when switched on
  pause_if_active_hours numeric not null default 6 check (pause_if_active_hours between 0 and 72),
  -- how leads join: ad_phrases (click-to-WhatsApp ad text), message_phrases (buyer's message), project_listing
  -- (lead set to project_id), ai_confirm (the AI, once the buyer confirms); exclusive_project: a lead moved to
  -- another project is paused here
  entry                 jsonb not null default '{"ad_phrases": [], "message_phrases": [], "project_listing": true, "ai_confirm": true, "exclusive_project": true}'::jsonb,
  ai_instructions       text,                          -- extra guidance for the AI about this workflow
  version               int not null default 1,
  created_at            timestamptz not null default now(),
  created_by            text not null default public.ai_actor(),
  updated_at            timestamptz not null default now(),
  updated_by            text
);
create unique index ai_workflows_one_per_project on public.ai_workflows (project_id) where status = 'active' and project_id is not null;
create trigger ai_workflows_touch before update on public.ai_workflows for each row execute function public.ai_touch_updated();

create table public.ai_workflow_stages (
  id                  uuid primary key default gen_random_uuid(),
  workflow_id         uuid not null references public.ai_workflows(id) on delete cascade,
  key                 text not null check (key ~ '^[a-z0-9_]{1,40}$'),
  position            int not null default 0,
  name                text not null check (length(trim(name)) between 1 and 120),
  step_en             text,                            -- what the buyer does at this stage
  step_ms             text,
  keywords            text[] not null default '{}',    -- buyer replies one of these when the step is done
  follow_up_hours     numeric not null default 0 check (follow_up_hours between 0 and 720),
  max_follow_ups      int not null default 0 check (max_follow_ups between 0 and 10),
  template            text,                            -- approved WhatsApp template for outside the 24-hour window
  message_ms          text check (length(message_ms) <= 1000),
  message_en          text check (length(message_en) <= 1000),
  next_stage_key      text,                            -- null: the next active stage in order
  is_final            boolean not null default false,  -- reaching it completes the workflow for the lead
  human_on_enter      boolean not null default false,  -- reaching it opens a follow-up task for a person
  escalate_after_max  boolean not null default true,   -- after the last reminder without progress: follow-up task
  active              boolean not null default true,   -- inactive: skipped by "next", sends no reminders
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (workflow_id, key)
);
create index ai_workflow_stages_order on public.ai_workflow_stages (workflow_id, position);
create trigger ai_workflow_stages_touch before update on public.ai_workflow_stages for each row execute function public.ai_touch_updated();

create table public.ai_workflow_leads (
  id               uuid primary key default gen_random_uuid(),
  workflow_id      uuid not null references public.ai_workflows(id) on delete restrict,
  lead_id          uuid not null references public.ai_leads(id) on delete cascade,
  stage            text not null,
  status           text not null default 'active' check (status in ('active','paused','completed','human')),
  status_reason    text,
  source           text not null default 'other' check (source in ('facebook','instagram','website','whatsapp','staff','other')),
  stage_changed_at timestamptz not null default now(),
  enrolled_at      timestamptz not null default now(),
  enrolled_by      text not null default public.ai_actor(),
  history          jsonb not null default '[]'::jsonb,   -- [{at, from, to, by, via}] / [{at, status, reason, by}]
  updated_at       timestamptz not null default now(),
  unique (workflow_id, lead_id)
);
create index ai_workflow_leads_lead on public.ai_workflow_leads (lead_id);
create index ai_workflow_leads_stage on public.ai_workflow_leads (workflow_id, stage, status);
create trigger ai_workflow_leads_touch before update on public.ai_workflow_leads for each row execute function public.ai_touch_updated();

create table public.ai_workflow_changes (
  id          uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.ai_workflows(id) on delete cascade,
  at          timestamptz not null default now(),
  by          text not null default public.ai_actor(),
  action      text not null,
  summary     text,
  before      jsonb,
  after       jsonb
);
create index ai_workflow_changes_wf on public.ai_workflow_changes (workflow_id, at desc);

do $$ declare t text; begin
  foreach t in array array['ai_workflows','ai_workflow_stages','ai_workflow_leads','ai_workflow_changes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create policy "ai read" on public.%I for select to authenticated using (public.ai_has_role(''viewer''))', t);
  end loop;
end $$;
-- every change goes through the functions below, so validation, scheduling and the audit trail always apply

-- ---------------------------------------------------------------------------- jobs
alter table public.ai_automation_jobs drop constraint ai_automation_jobs_kind_check;
alter table public.ai_automation_jobs add constraint ai_automation_jobs_kind_check
  check (kind in ('smart_follow_up','human_reminder','appt_confirmation','appt_reminder','rmk_follow_up','workflow_follow_up'));
alter table public.ai_automation_jobs add column if not exists workflow_id uuid references public.ai_workflows(id) on delete set null;
-- at most one workflow reminder waiting per lead and workflow, whoever schedules it
create unique index ai_automation_wf_one on public.ai_automation_jobs (workflow_id, lead_id) where kind = 'workflow_follow_up' and status = 'scheduled';

-- ---------------------------------------------------------------------------- helpers
-- "Done booked!" → "DONE BOOKED": keywords and phrases compare on letters and digits only
create or replace function public.ai_wf_norm(p text) returns text
language sql immutable set search_path = public as $$
  select trim(regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]+', ' ', 'g'))
$$;

-- a phrase found as whole words in a text ("metropolitan kepong" in "Saya minat Residensi Metropolitan Kepong")
create or replace function public.ai_wf_has_phrase(p_text text, p_phrases jsonb) returns boolean
language sql immutable set search_path = public as $$
  select exists (select 1 from jsonb_array_elements_text(coalesce(p_phrases, '[]'::jsonb)) x
                  where public.ai_wf_norm(x) <> '' and ' ' || public.ai_wf_norm(p_text) || ' ' like '% ' || public.ai_wf_norm(x) || ' %')
$$;

-- the stage after p_stage: its "next stage" if set and usable, else the next active stage in order; none after a final stage
create or replace function public.ai_wf_next(p_wf uuid, p_stage text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select n.key from public.ai_workflow_stages s join public.ai_workflow_stages n on n.workflow_id = s.workflow_id and n.key = s.next_stage_key
      where s.workflow_id = p_wf and s.key = p_stage and not s.is_final and n.archived_at is null and n.active and n.key <> s.key),
    (select n.key from public.ai_workflow_stages s join public.ai_workflow_stages n on n.workflow_id = s.workflow_id
      where s.workflow_id = p_wf and s.key = p_stage and not s.is_final and n.archived_at is null and n.active
        and (n.position, n.key) > (s.position, s.key)
      order by n.position, n.key limit 1))
$$;

create or replace function public.ai_wf_first(p_wf uuid) returns text
language sql stable security definer set search_path = public as $$
  select key from public.ai_workflow_stages where workflow_id = p_wf and archived_at is null and active order by position, key limit 1
$$;

-- Cancels the lead's scheduled reminders in this workflow and, while it is active, schedules the first one of its stage.
create or replace function public.ai_wf_schedule(p_wf uuid, p_lead uuid, p_reason text default 'stage changed') returns uuid
language plpgsql security definer set search_path = public as $$
declare e public.ai_workflow_leads; st public.ai_workflow_stages; w public.ai_workflows; conv uuid; j uuid;
begin
  update public.ai_automation_jobs set status = 'cancelled', reason = p_reason
   where lead_id = p_lead and workflow_id = p_wf and kind = 'workflow_follow_up' and status = 'scheduled';
  select * into w from public.ai_workflows where id = p_wf;
  select * into e from public.ai_workflow_leads where workflow_id = p_wf and lead_id = p_lead;
  if w.id is null or w.status <> 'active' or e.id is null or e.status <> 'active' then return null; end if;
  select * into st from public.ai_workflow_stages where workflow_id = p_wf and key = e.stage;
  if st.id is null or st.is_final or not st.active or st.archived_at is not null
     or st.follow_up_hours <= 0 or st.max_follow_ups <= 0 then return null; end if;
  select v.id into conv from public.ai_conversations v join public.ai_leads l on l.contact_id = v.contact_id
   where l.id = p_lead and v.channel = 'whatsapp' and v.status = 'open' order by v.updated_at desc limit 1;
  insert into public.ai_automation_jobs (kind, workflow_id, conversation_id, lead_id, stage, seq, run_at, dedupe_key)
  values ('workflow_follow_up', p_wf, conv, p_lead, e.stage, 1, now() + make_interval(secs => greatest(1, least(720, st.follow_up_hours)) * 3600),
          'wf:' || p_wf || ':' || p_lead || ':' || e.stage || ':1:' || (extract(epoch from clock_timestamp()) * 1e6)::bigint)
  on conflict (workflow_id, lead_id) where kind = 'workflow_follow_up' and status = 'scheduled' do nothing
  returning id into j;
  return j;
end $$;

-- After a lead reached a stage: reminders for the new stage, and a follow-up task if that stage needs a person.
create or replace function public.ai_wf_entered(p_wf uuid, p_lead uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare st public.ai_workflow_stages; w public.ai_workflows; e public.ai_workflow_leads;
begin
  perform public.ai_wf_schedule(p_wf, p_lead, p_reason);
  select * into w from public.ai_workflows where id = p_wf;
  select * into e from public.ai_workflow_leads where workflow_id = p_wf and lead_id = p_lead;
  select * into st from public.ai_workflow_stages where workflow_id = p_wf and key = e.stage;
  if st.human_on_enter and e.status <> 'paused' then
    perform public.ai_open_human_task(p_lead, left(w.name || ': ' || st.name || ' — a person follows up', 200),
      concat_ws(chr(10), 'Workflow: ' || w.name, 'Stage: ' || st.name, 'Step: ' || coalesce(st.step_en, st.step_ms)),
      'wf-' || w.key || ':' || st.key || ':' || p_lead);
  end if;
exception when others then
  raise warning 'ai_wf_entered: %', sqlerrm;   -- a task problem never undoes the stage change
end $$;

-- ---------------------------------------------------------------------------- leads
-- Puts a lead in a workflow at its first stage. Idempotent: a lead already in it is left as it is.
create or replace function public.ai_wf_enroll(p_wf uuid, p_lead uuid, p_source text default 'other', p_by text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare first_stage text; n int; who text := coalesce(p_by, public.ai_actor());
begin
  if p_lead is null or p_wf is null then return false; end if;
  if coalesce(auth.role(), '') = 'authenticated' and not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  if not exists (select 1 from public.ai_workflows where id = p_wf and status = 'active') then raise exception 'This workflow is archived or does not exist'; end if;
  first_stage := public.ai_wf_first(p_wf);
  if first_stage is null then raise exception 'This workflow has no active stage'; end if;
  insert into public.ai_workflow_leads (workflow_id, lead_id, stage, source, enrolled_by, history)
  values (p_wf, p_lead, first_stage, case when p_source in ('facebook','instagram','website','whatsapp','staff') then p_source else 'other' end,
          who, jsonb_build_array(jsonb_build_object('at', now(), 'to', first_stage, 'by', who, 'via', 'enrolled')))
  on conflict (workflow_id, lead_id) do nothing;
  get diagnostics n = row_count;
  if n > 0 then perform public.ai_wf_entered(p_wf, p_lead, 'enrolled'); end if;
  return n > 0;
end $$;

-- Moves a lead one stage on, only from the stage expected (a repeated or out-of-order confirmation changes nothing).
create or replace function public.ai_wf_advance(p_wf uuid, p_lead uuid, p_from text, p_by text default null, p_via text default 'keyword') returns boolean
language plpgsql security definer set search_path = public as $$
declare nxt text := public.ai_wf_next(p_wf, p_from); fin boolean; n int;
begin
  if nxt is null then return false; end if;
  fin := coalesce((select is_final from public.ai_workflow_stages where workflow_id = p_wf and key = nxt), false);
  update public.ai_workflow_leads
     set stage = nxt, stage_changed_at = now(),
         status = case when fin then 'completed' when status = 'human' then 'active' else status end,
         status_reason = case when fin then 'completed' when status = 'human' then null else status_reason end,
         history = history || jsonb_build_object('at', now(), 'from', p_from, 'to', nxt, 'by', coalesce(p_by, public.ai_actor()), 'via', p_via)
   where workflow_id = p_wf and lead_id = p_lead and stage = p_from and status <> 'paused';
  get diagnostics n = row_count;
  if n > 0 then perform public.ai_wf_entered(p_wf, p_lead, case when fin then 'completed' else 'stage changed' end); end if;
  return n > 0;
end $$;

-- moves every listed lead to a stage (staff corrections, and leads on a stage being archived)
create or replace function public.ai_wf_move(p_wf uuid, p_lead uuid, p_stage text, p_via text) returns boolean
language plpgsql security definer set search_path = public as $$
declare cur text; fin boolean;
begin
  select stage into cur from public.ai_workflow_leads where workflow_id = p_wf and lead_id = p_lead for update;
  if cur is null then raise exception 'This lead is not in the workflow'; end if;
  if cur = p_stage then return false; end if;
  select is_final into fin from public.ai_workflow_stages where workflow_id = p_wf and key = p_stage and archived_at is null;
  if fin is null then raise exception 'Unknown or archived stage %', p_stage; end if;
  update public.ai_workflow_leads
     set stage = p_stage, stage_changed_at = now(),
         status = case when fin then 'completed' when status in ('completed','human') then 'active' else status end,
         status_reason = case when fin then 'completed' when status in ('completed','human') then null else status_reason end,
         history = history || jsonb_build_object('at', now(), 'from', cur, 'to', p_stage, 'by', public.ai_actor(), 'via', p_via)
   where workflow_id = p_wf and lead_id = p_lead;
  perform public.ai_wf_entered(p_wf, p_lead, 'stage changed by staff');
  return true;
end $$;

create or replace function public.ai_wf_set_stage(p_wf uuid, p_lead uuid, p_stage text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  return public.ai_wf_move(p_wf, p_lead, p_stage, 'staff');
end $$;

create or replace function public.ai_wf_set_status(p_wf uuid, p_lead uuid, p_status text, p_reason text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare e public.ai_workflow_leads;
begin
  if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  if p_status not in ('active','paused') then raise exception 'Status must be active or paused'; end if;
  select * into e from public.ai_workflow_leads where workflow_id = p_wf and lead_id = p_lead for update;
  if e.id is null then raise exception 'This lead is not in the workflow'; end if;
  if e.status = 'completed' then raise exception 'Completed: nothing to follow up'; end if;
  update public.ai_workflow_leads set status = p_status, status_reason = nullif(trim(coalesce(p_reason, '')), ''),
         history = history || jsonb_build_object('at', now(), 'status', p_status, 'reason', p_reason, 'by', public.ai_actor())
   where id = e.id;
  perform public.ai_wf_schedule(p_wf, p_lead, case when p_status = 'paused' then 'paused by staff' else 'resumed by staff' end);
  return true;
end $$;

-- After switching sending on (or changing intervals): reschedule every active lead's current stage.
create or replace function public.ai_wf_reschedule(p_wf uuid) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if coalesce(auth.role(), '') = 'authenticated' and not public.ai_has_role('manager') then raise exception 'Managers only'; end if;
  for r in select lead_id from public.ai_workflow_leads where workflow_id = p_wf and status = 'active' loop
    if public.ai_wf_schedule(p_wf, r.lead_id, 'rescheduled after a settings change') is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- Click-to-WhatsApp ad: the lead joins every active workflow whose ad phrases appear in the ad's text.
create or replace function public.ai_wf_enroll_from_ad(p_lead uuid, p_text text, p_source text) returns int
language plpgsql security definer set search_path = public as $$
declare w record; n int := 0;
begin
  for w in select id, entry from public.ai_workflows where status = 'active' loop
    if public.ai_wf_has_phrase(p_text, w.entry -> 'ad_phrases') and public.ai_wf_enroll(w.id, p_lead, p_source, 'ad') then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------- settings
create or replace function public.ai_wf_snapshot(p_wf uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(w) - 'created_at' - 'updated_at' - 'updated_by' - 'version'
         || jsonb_build_object('stages', coalesce((select jsonb_agg(to_jsonb(s) - 'workflow_id' - 'created_at' - 'updated_at' order by s.position, s.key)
                                                     from public.ai_workflow_stages s where s.workflow_id = w.id), '[]'::jsonb))
    from public.ai_workflows w where w.id = p_wf
$$;

-- Creates or updates a whole workflow (settings + stages in order) and validates it. Managers.
-- p: {id?, key, name, description, project_id, status, sending_enabled, pause_if_active_hours, entry, ai_instructions,
--     stages: [{id?, key, name, step_en, step_ms, keywords[], follow_up_hours, max_follow_ups, template, message_ms,
--               message_en, next_stage_key, is_final, human_on_enter, escalate_after_max, active, archived, move_to}]}
-- Stages left out of the list are kept as they are. A stage being archived that still has leads needs move_to.
create or replace function public.ai_wf_save(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare wid uuid := nullif(p ->> 'id', '')::uuid; before jsonb; after jsonb; stg jsonb; i int := 0; sid uuid; k text;
        moves jsonb := '[]'::jsonb; mv jsonb; r record; dup text; bad text; old_status text; new_status text; n int;
        kws text[];
begin
  if coalesce(auth.role(), '') = 'authenticated' and not public.ai_has_role('manager') then raise exception 'Managers only'; end if;
  if length(trim(coalesce(p ->> 'name', ''))) = 0 then raise exception 'Give the workflow a name'; end if;
  if nullif(p ->> 'project_id', '') is not null and not exists (select 1 from public.projects where id = p ->> 'project_id') then
    raise exception 'Unknown project %', p ->> 'project_id'; end if;
  if nullif(p ->> 'project_id', '') is not null and coalesce(nullif(p ->> 'status', ''), 'active') = 'active' and exists (
       select 1 from public.ai_workflows where project_id = p ->> 'project_id' and status = 'active' and id is distinct from nullif(p ->> 'id', '')::uuid) then
    raise exception 'Another active workflow already belongs to this project'; end if;
  if jsonb_typeof(p -> 'stages') is distinct from 'array' then raise exception 'Stages are missing'; end if;
  new_status := coalesce(nullif(p ->> 'status', ''), 'active');
  if new_status not in ('active','archived') then raise exception 'Status must be active or archived'; end if;

  if wid is null then
    k := lower(trim(coalesce(p ->> 'key', '')));
    if k !~ '^[a-z0-9_]{2,40}$' then raise exception 'Short name: 2–40 lowercase letters, digits or _'; end if;
    if exists (select 1 from public.ai_workflows where key = k) then raise exception 'A workflow called "%" already exists', k; end if;
    insert into public.ai_workflows (key, name) values (k, trim(p ->> 'name')) returning id into wid;
    old_status := null;
  else
    select status into old_status from public.ai_workflows where id = wid for update;
    if old_status is null then raise exception 'Workflow not found'; end if;
    before := public.ai_wf_snapshot(wid);
  end if;

  update public.ai_workflows set
    name = left(trim(p ->> 'name'), 120),
    description = nullif(trim(coalesce(p ->> 'description', '')), ''),
    project_id = nullif(p ->> 'project_id', ''),
    status = new_status,
    sending_enabled = coalesce((p ->> 'sending_enabled')::boolean, false),
    pause_if_active_hours = coalesce((p ->> 'pause_if_active_hours')::numeric, 6),
    entry = jsonb_build_object(
      'ad_phrases', coalesce((select jsonb_agg(x) from jsonb_array_elements_text(coalesce(p -> 'entry' -> 'ad_phrases', '[]')) x where trim(x) <> ''), '[]'),
      'message_phrases', coalesce((select jsonb_agg(x) from jsonb_array_elements_text(coalesce(p -> 'entry' -> 'message_phrases', '[]')) x where trim(x) <> ''), '[]'),
      'project_listing', coalesce((p -> 'entry' ->> 'project_listing')::boolean, true),
      'ai_confirm', coalesce((p -> 'entry' ->> 'ai_confirm')::boolean, true),
      'exclusive_project', coalesce((p -> 'entry' ->> 'exclusive_project')::boolean, true)),
    ai_instructions = nullif(trim(coalesce(p ->> 'ai_instructions', '')), ''),
    version = version + case when before is null then 0 else 1 end,
    updated_by = public.ai_actor()
  where id = wid;

  for stg in select value from jsonb_array_elements(p -> 'stages') loop
    i := i + 1;
    sid := nullif(stg ->> 'id', '')::uuid;
    kws := coalesce((select array_agg(trim(x)) from jsonb_array_elements_text(coalesce(stg -> 'keywords', '[]')) x where public.ai_wf_norm(x) <> ''), '{}');
    if sid is null then
      k := lower(trim(coalesce(stg ->> 'key', '')));
      if k !~ '^[a-z0-9_]{1,40}$' then raise exception 'Stage short name "%": lowercase letters, digits or _', k; end if;
      if exists (select 1 from public.ai_workflow_stages where workflow_id = wid and key = k) then raise exception 'Two stages are called "%"', k; end if;
      insert into public.ai_workflow_stages (workflow_id, key, name) values (wid, k, coalesce(nullif(trim(stg ->> 'name'), ''), k)) returning id into sid;
    elsif not exists (select 1 from public.ai_workflow_stages where id = sid and workflow_id = wid) then
      raise exception 'Stage not in this workflow';
    end if;
    update public.ai_workflow_stages set
      position = i * 10,
      name = left(coalesce(nullif(trim(stg ->> 'name'), ''), key), 120),
      step_en = nullif(trim(coalesce(stg ->> 'step_en', '')), ''),
      step_ms = nullif(trim(coalesce(stg ->> 'step_ms', '')), ''),
      keywords = kws,
      follow_up_hours = coalesce((stg ->> 'follow_up_hours')::numeric, 0),
      max_follow_ups = coalesce((stg ->> 'max_follow_ups')::int, 0),
      template = nullif(trim(coalesce(stg ->> 'template', '')), ''),
      message_ms = nullif(trim(coalesce(stg ->> 'message_ms', '')), ''),
      message_en = nullif(trim(coalesce(stg ->> 'message_en', '')), ''),
      next_stage_key = nullif(trim(coalesce(stg ->> 'next_stage_key', '')), ''),
      is_final = coalesce((stg ->> 'is_final')::boolean, false),
      human_on_enter = coalesce((stg ->> 'human_on_enter')::boolean, false),
      escalate_after_max = coalesce((stg ->> 'escalate_after_max')::boolean, true),
      active = coalesce((stg ->> 'active')::boolean, true) and not coalesce((stg ->> 'archived')::boolean, false),
      archived_at = case when coalesce((stg ->> 'archived')::boolean, false) then coalesce(archived_at, now()) else null end
    where id = sid;
    if coalesce((stg ->> 'archived')::boolean, false) then
      moves := moves || jsonb_build_object('from', (select key from public.ai_workflow_stages where id = sid), 'to', nullif(stg ->> 'move_to', ''));
    end if;
  end loop;

  -- the whole workflow must make sense before anything is saved
  if (select count(*) from public.ai_workflow_stages where workflow_id = wid and archived_at is null) < 2 then raise exception 'A workflow needs at least two stages'; end if;
  if not exists (select 1 from public.ai_workflow_stages where workflow_id = wid and archived_at is null and is_final) then raise exception 'Mark the last stage (e.g. "Completed") as final'; end if;
  if not exists (select 1 from public.ai_workflow_stages where workflow_id = wid and archived_at is null and active and not is_final) then raise exception 'At least one active stage before the final one is needed'; end if;
  select string_agg(nk, ', ') into dup from (
    select public.ai_wf_norm(x) nk from public.ai_workflow_stages st, unnest(st.keywords) x
     where st.workflow_id = wid and st.archived_at is null group by 1 having count(*) > 1) q;
  if dup is not null then raise exception 'Keyword used by more than one stage: %', dup; end if;
  select string_agg(s.name, ', ') into bad from public.ai_workflow_stages s
   where s.workflow_id = wid and s.archived_at is null and s.next_stage_key is not null
     and (s.next_stage_key = s.key or not exists (select 1 from public.ai_workflow_stages n where n.workflow_id = wid and n.key = s.next_stage_key and n.archived_at is null));
  if bad is not null then raise exception 'Next stage missing or archived for: %', bad; end if;
  select string_agg(s.name, ', ') into bad from public.ai_workflow_stages s
   where s.workflow_id = wid and s.archived_at is null and not s.is_final and s.active and s.follow_up_hours > 0 and s.max_follow_ups > 0
     and s.message_ms is null and s.message_en is null;
  if bad is not null then raise exception 'Write a reminder message (or set no reminders) for: %', bad; end if;

  -- leads on archived stages: moved where the manager said, or the save is refused
  for mv in select value from jsonb_array_elements(moves) loop
    select count(*) into n from public.ai_workflow_leads where workflow_id = wid and stage = mv ->> 'from';
    if n > 0 then
      if mv ->> 'to' is null then raise exception '% lead(s) are at stage "%": choose where to move them before archiving it', n, mv ->> 'from'; end if;
      if not exists (select 1 from public.ai_workflow_stages where workflow_id = wid and key = mv ->> 'to' and archived_at is null) then raise exception 'Move-to stage "%" is not available', mv ->> 'to'; end if;
      for r in select lead_id from public.ai_workflow_leads where workflow_id = wid and stage = mv ->> 'from' loop
        perform public.ai_wf_move(wid, r.lead_id, mv ->> 'to', 'stage archived');
      end loop;
    end if;
  end loop;

  if new_status = 'archived' then
    update public.ai_automation_jobs set status = 'cancelled', reason = 'workflow archived'
     where workflow_id = wid and kind = 'workflow_follow_up' and status = 'scheduled';
  elsif (select sending_enabled from public.ai_workflows where id = wid) then
    perform public.ai_wf_reschedule(wid);
  end if;

  after := public.ai_wf_snapshot(wid);
  if before is distinct from after then
    insert into public.ai_workflow_changes (workflow_id, action, summary, before, after)
    values (wid, case when before is null then 'created' when old_status = 'active' and new_status = 'archived' then 'archived'
                      when old_status = 'archived' and new_status = 'active' then 'restored' else 'updated' end,
            nullif(trim(coalesce(p ->> 'change_note', '')), ''), before, after);
  end if;
  return wid;
end $$;

-- ---------------------------------------------------------------------------- buyer messages
-- A stage keyword moves the lead on (in each workflow it is in); a workflow's entry phrase in a buyer's message puts
-- the lead in that workflow.
create or replace function public.ai_wf_on_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare lid uuid; k text; r record;
begin
  if new.direction <> 'inbound' or coalesce(new.body, '') = '' then return new; end if;
  select l.id into lid from public.ai_conversations v join public.ai_leads l on l.id = v.lead_id
   where v.id = new.conversation_id and l.closed_at is null;
  if lid is null then return new; end if;
  k := public.ai_wf_norm(new.body);
  for r in select e.workflow_id, e.stage from public.ai_workflow_leads e join public.ai_workflows w on w.id = e.workflow_id
            where e.lead_id = lid and w.status = 'active' and e.status in ('active','human') loop
    if exists (select 1 from public.ai_workflow_stages s, unnest(s.keywords) x
                where s.workflow_id = r.workflow_id and s.key = r.stage and s.archived_at is null and public.ai_wf_norm(x) = k) then
      perform public.ai_wf_advance(r.workflow_id, lid, r.stage, 'buyer', 'keyword');
    end if;
  end loop;
  for r in select w.id from public.ai_workflows w
            where w.status = 'active' and public.ai_wf_has_phrase(new.body, w.entry -> 'message_phrases')
              and not exists (select 1 from public.ai_workflow_leads e where e.workflow_id = w.id and e.lead_id = lid) loop
    perform public.ai_wf_enroll(r.id, lid, 'whatsapp', 'buyer message');
  end loop;
  return new;
exception when others then
  raise warning 'ai_wf_on_message: %', sqlerrm;   -- never block recording a message
  return new;
end $$;

-- ---------------------------------------------------------------------------- project of the lead
-- A lead set to a workflow's listing joins it; a lead moved to another project is paused in workflows tied to one
-- project (exclusive_project), and resumed when it is set back.
create or replace function public.ai_wf_on_lead() returns trigger
language plpgsql security definer set search_path = public as $$
declare src text; w record;
begin
  if new.primary_project_id is not distinct from (case when tg_op = 'UPDATE' then old.primary_project_id end) then return new; end if;
  if new.primary_project_id is null then return new; end if;
  for w in select * from public.ai_workflows where status = 'active' loop
    if w.project_id = new.primary_project_id then
      if coalesce((w.entry ->> 'project_listing')::boolean, true) then
        if src is null then
          select case s.channel when 'website' then 'website' when 'whatsapp' then 'whatsapp' when 'facebook' then 'facebook' when 'instagram' then 'instagram' else 'other' end
            into src from public.ai_lead_sources s where s.id = new.source_id;
        end if;
        perform public.ai_wf_enroll(w.id, new.id, coalesce(src, 'other'), 'project');
      end if;
      -- back on the project after a pause for a project change: resume
      update public.ai_workflow_leads set status = 'active', status_reason = null,
             history = history || jsonb_build_object('at', now(), 'status', 'active', 'reason', 'project set back', 'by', public.ai_actor())
       where workflow_id = w.id and lead_id = new.id and status = 'paused' and status_reason like 'project changed%';
      if found then perform public.ai_wf_schedule(w.id, new.id, 'project set back'); end if;
    elsif coalesce((w.entry ->> 'exclusive_project')::boolean, true) then
      update public.ai_workflow_leads set status = 'paused',
             status_reason = 'project changed to ' || coalesce((select data ->> 'n' from public.projects where id = new.primary_project_id), new.primary_project_id),
             history = history || jsonb_build_object('at', now(), 'status', 'paused', 'reason', 'project changed', 'by', public.ai_actor())
       where workflow_id = w.id and lead_id = new.id and status in ('active','human');
      if found then perform public.ai_wf_schedule(w.id, new.id, 'project changed'); end if;
    end if;
  end loop;
  return new;
exception when others then
  raise warning 'ai_wf_on_lead: %', sqlerrm;
  return new;
end $$;

drop trigger if exists ai_messages_rmk on public.ai_messages;
drop trigger if exists ai_leads_rmk on public.ai_leads;
create trigger ai_messages_workflow after insert on public.ai_messages for each row execute function public.ai_wf_on_message();
create trigger ai_leads_workflow after insert or update of primary_project_id on public.ai_leads for each row execute function public.ai_wf_on_lead();

-- ---------------------------------------------------------------------------- RMK, copied in unchanged
do $$
declare c jsonb := coalesce((select rmk from public.ai_settings where id = 1), '{}'::jsonb); wid uuid;
begin
  insert into public.ai_workflows (key, name, description, project_id, sending_enabled, pause_if_active_hours, entry, ai_instructions, created_by)
  values ('rmk', 'RMK — Residensi Metropolitan Kepong', 'RUMAWIP project with its own step-by-step process: book, register on the portal, submit loan documents, sign.',
          nullif(c ->> 'project_id', ''), coalesce((c ->> 'enabled')::boolean, false), coalesce((c ->> 'pause_if_active_hours')::numeric, 6),
          jsonb_build_object('ad_phrases', jsonb_build_array('metropolitan kepong', 'RMK'), 'message_phrases', jsonb_build_array('metropolitan kepong'),
                             'project_listing', true, 'ai_confirm', true, 'exclusive_project', true),
          'RMK can also be a typo or mean something else: if a buyer who is not in this workflow writes "RMK" or seems to ask about it, ask whether they mean Residensi Metropolitan Kepong, and confirm interest only once they clearly say so.',
          'migration')
  returning id into wid;
  insert into public.ai_workflow_stages (workflow_id, key, position, name, step_en, step_ms, keywords, follow_up_hours, max_follow_ups, template, message_ms, message_en, is_final)
  select wid, x.key, x.pos, x.name, x.step_en, x.step_ms, x.kw,
         coalesce((c -> 'stages' -> x.key ->> 'follow_up_hours')::numeric, 0), coalesce((c -> 'stages' -> x.key ->> 'max_follow_ups')::int, 0),
         nullif(c -> 'stages' -> x.key ->> 'template', ''), nullif(c -> 'stages' -> x.key ->> 'message_ms', ''), nullif(c -> 'stages' -> x.key ->> 'message_en', ''),
         x.key = 'all_signed'
    from (values
      ('new',            10, 'New RMK enquiry',           'Confirm interest in RMK',               'Sahkan minat terhadap RMK',          array['RMK']),
      ('to_book',        20, 'To book unit',              'Book a unit',                           'Buat tempahan unit',                 array['DONE BOOKED','DONE BOOKING','DONE BOOK']),
      ('to_portal',      30, 'To apply portal (RUMAWIP)', 'Register on the RUMAWIP portal',        'Daftar di portal RUMAWIP',           array['DONE PORTAL']),
      ('to_submit_loan', 40, 'To submit loan documents',  'Submit the loan application documents', 'Hantar dokumen permohonan pinjaman', array['DONE SUBMIT LOAN','DONE SUBMIT','DONE LOAN','DONE SUBMITTED']),
      ('to_sign',        50, 'To sign LO, SPA & LA',      'Sign the LO, SPA & LA',                 'Tandatangan LO, SPA & LA',           array['DONE SIGNED','DONE SIGN','DONE SIGNING']),
      ('all_signed',     60, 'All signed',                'Completed',                             'Selesai',                            array[]::text[])
    ) as x(key, pos, name, step_en, step_ms, kw);
  -- leads already in the RMK pipeline (none in production when this was written) keep their stage and history
  insert into public.ai_workflow_leads (workflow_id, lead_id, stage, status, status_reason, source, stage_changed_at, enrolled_at, enrolled_by, history)
  select wid, lead_id, stage, status, status_reason, source, stage_changed_at, enrolled_at, enrolled_by, history from public.ai_rmk_pipeline
  on conflict do nothing;
  update public.ai_automation_jobs set status = 'cancelled', reason = 'moved to workflow follow-ups'
   where kind = 'rmk_follow_up' and status = 'scheduled';
  perform public.ai_wf_schedule(wid, lead_id, 'moved to workflow follow-ups') from public.ai_workflow_leads where workflow_id = wid and status = 'active';
  insert into public.ai_workflow_changes (workflow_id, by, action, summary, after)
  values (wid, 'migration', 'created', 'Copied from the RMK settings (Settings → RMK) unchanged', public.ai_wf_snapshot(wid));
end $$;

-- the earlier RMK functions keep working, on the RMK workflow
create or replace function public.ai_rmk_wf() returns uuid
language sql stable security definer set search_path = public as $$ select id from public.ai_workflows where key = 'rmk' $$;
create or replace function public.ai_rmk_enroll(p_lead uuid, p_source text default 'other', p_by text default null) returns boolean
language sql security definer set search_path = public as $$ select public.ai_wf_enroll(public.ai_rmk_wf(), p_lead, p_source, p_by) $$;
create or replace function public.ai_rmk_advance(p_lead uuid, p_from text, p_by text default null, p_via text default 'keyword') returns boolean
language sql security definer set search_path = public as $$ select public.ai_wf_advance(public.ai_rmk_wf(), p_lead, p_from, p_by, p_via) $$;
create or replace function public.ai_rmk_set_stage(p_lead uuid, p_stage text) returns boolean
language sql security definer set search_path = public as $$ select public.ai_wf_set_stage(public.ai_rmk_wf(), p_lead, p_stage) $$;
create or replace function public.ai_rmk_set_status(p_lead uuid, p_status text, p_reason text default null) returns boolean
language sql security definer set search_path = public as $$ select public.ai_wf_set_status(public.ai_rmk_wf(), p_lead, p_status, p_reason) $$;
create or replace function public.ai_rmk_reschedule_all() returns int
language sql security definer set search_path = public as $$ select public.ai_wf_reschedule(public.ai_rmk_wf()) $$;
create or replace function public.ai_rmk_schedule(p_lead uuid, p_reason text default 'stage changed') returns uuid
language sql security definer set search_path = public as $$ select public.ai_wf_schedule(public.ai_rmk_wf(), p_lead, p_reason) $$;

-- ---------------------------------------------------------------------------- grants
revoke all on function public.ai_wf_on_message() from public, anon, authenticated;
revoke all on function public.ai_wf_on_lead() from public, anon, authenticated;
revoke all on function public.ai_wf_schedule(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.ai_wf_entered(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.ai_wf_advance(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.ai_wf_move(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.ai_wf_enroll_from_ad(uuid, text, text) from public, anon, authenticated;
revoke all on function public.ai_wf_next(uuid, text) from public, anon;
revoke all on function public.ai_wf_first(uuid) from public, anon;
revoke all on function public.ai_wf_snapshot(uuid) from public, anon;
revoke all on function public.ai_wf_enroll(uuid, uuid, text, text) from public, anon;
revoke all on function public.ai_wf_set_stage(uuid, uuid, text) from public, anon;
revoke all on function public.ai_wf_set_status(uuid, uuid, text, text) from public, anon;
revoke all on function public.ai_wf_reschedule(uuid) from public, anon;
revoke all on function public.ai_wf_save(jsonb) from public, anon;
revoke all on function public.ai_rmk_wf() from public, anon;
grant execute on function public.ai_wf_next(uuid, text), public.ai_wf_first(uuid), public.ai_wf_snapshot(uuid),
  public.ai_wf_enroll(uuid, uuid, text, text), public.ai_wf_set_stage(uuid, uuid, text), public.ai_wf_set_status(uuid, uuid, text, text),
  public.ai_wf_reschedule(uuid), public.ai_wf_save(jsonb), public.ai_rmk_wf() to authenticated, service_role;
grant execute on function public.ai_wf_advance(uuid, uuid, text, text, text), public.ai_wf_schedule(uuid, uuid, text),
  public.ai_wf_enroll_from_ad(uuid, text, text) to service_role;
revoke all on function public.ai_wf_norm(text) from public, anon;
revoke all on function public.ai_wf_has_phrase(text, jsonb) from public, anon;
grant execute on function public.ai_wf_norm(text), public.ai_wf_has_phrase(text, jsonb) to authenticated, service_role;

commit;
