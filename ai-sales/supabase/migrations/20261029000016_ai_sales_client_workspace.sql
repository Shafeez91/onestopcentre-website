-- AI Sales module — client workspace: structured client profile, AI conversation summary and next action, field
-- history, richer property interests, and a structured, configurable sales pipeline (2026-10-29). ADDITIVE ONLY.
--
--   ai_leads.profile        client profile values (location, commute, household, preferences, intent, notes…)
--   ai_leads.profile_meta   per field: confirmed / inferred / conflict, who or what set it, when, from which message
--   ai_leads.ai_summary     conversation summary, last client question, outstanding items, next best action
--   ai_lead_field_history   every change to a profile or qualification field (old → new, source, message)
--   ai_lead_interests       + priority (primary / alternative / comparison / no longer), unit type, budget, next action
--   ai_pipeline_stages      + key (structured value), colour, ai_settable, description; stages renamed / added to the
--                           pipeline requested on 2026-10-29 (no stage deleted, every lead keeps its stage)
-- Rules (ai_lead_profile_set): a person's entry is never overwritten by the AI (a different value is flagged as a
-- conflict for review); an inferred value never replaces a confirmed one; the same message is never applied twice.
-- Stage moves (ai_lead_set_stage): staff any stage, with a note; the AI only forward, only to stages marked
-- ai_settable, never closing a lead, and only with the buyer's own words as evidence; confirmed / completed
-- appointments move the lead to Appointment Booked / Attended (forward only). A manual stage change cancels the
-- automatic check-ins scheduled for the old situation.

-- ---------------------------------------------------------------------------- lead profile, summary, history
alter table public.ai_leads add column if not exists profile jsonb not null default '{}'::jsonb;
alter table public.ai_leads add column if not exists profile_meta jsonb not null default '{}'::jsonb;
alter table public.ai_leads add column if not exists ai_summary jsonb not null default '{}'::jsonb;

create table public.ai_lead_field_history (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references public.ai_leads(id) on delete cascade,
  field      text not null,
  old_value  jsonb,
  new_value  jsonb,
  status     text not null check (status in ('confirmed','inferred','conflict','cleared')),
  source     text not null check (source in ('staff','ai','system')),
  by         text not null default public.ai_actor(),
  message_id uuid,
  note       text,
  at         timestamptz not null default now()
);
create index ai_lead_field_history_lead on public.ai_lead_field_history (lead_id, at desc);
-- the same buyer message never updates the same field twice (redelivered messages, retried jobs)
create unique index ai_lead_field_history_once on public.ai_lead_field_history (lead_id, field, message_id) where message_id is not null and source = 'ai';
alter table public.ai_lead_field_history enable row level security;
revoke all on public.ai_lead_field_history from anon;
create policy "ai read" on public.ai_lead_field_history for select to authenticated using (public.ai_has_role('viewer'));

alter table public.ai_activities drop constraint ai_activities_kind_check;
alter table public.ai_activities add constraint ai_activities_kind_check
  check (kind in ('note','call','website_enquiry','stage_change','assignment','qualification','handover','appointment','message_summary','system','profile_update','ai_summary'));

-- ---------------------------------------------------------------------------- property interests
alter table public.ai_lead_interests add column if not exists priority text not null default 'alternative'
  check (priority in ('primary','alternative','comparison','no_longer'));
alter table public.ai_lead_interests add column if not exists unit_type text;
alter table public.ai_lead_interests add column if not exists budget_text text;
alter table public.ai_lead_interests add column if not exists next_action text;
alter table public.ai_lead_interests add column if not exists updated_at timestamptz not null default now();
update public.ai_lead_interests i set priority = 'primary' from public.ai_leads l where l.id = i.lead_id and l.primary_project_id = i.project_id;
update public.ai_lead_interests set priority = 'no_longer' where interest = 'rejected' and priority <> 'primary';

-- ---------------------------------------------------------------------------- pipeline stages
alter table public.ai_pipeline_stages add column if not exists key text;
alter table public.ai_pipeline_stages add column if not exists color text not null default 'slate'
  check (color in ('slate','blue','teal','green','amber','orange','red','purple','gold','navy'));
alter table public.ai_pipeline_stages add column if not exists ai_settable boolean not null default false;
alter table public.ai_pipeline_stages add column if not exists description text;
create unique index if not exists ai_pipeline_stages_key on public.ai_pipeline_stages (key) where key is not null;

do $$
declare r record;
begin
  -- names are unique and positions are renumbered at the end, so move every stage out of the way first
  update public.ai_pipeline_stages set position = position + 1000;
  for r in select * from (values
    -- old name,               new name,                 key,                    pos, colour,   ai,    description
    ('New Lead',              'New Enquiry',            'new_enquiry',           1, 'slate',  false, 'A new valid enquiry'),
    ('Contacted',             'Contacted',              'contacted',             2, 'blue',   false, 'We have replied to the buyer'),
    ('Qualified',             'Interested / Qualified', 'interested',            3, 'blue',   true,  'The buyer clearly wants to know more about a project'),
    (null,                    'No Response',            'no_response',           4, 'orange', false, 'The buyer stopped replying'),
    ('Follow-Up',             'Follow-Up Required',     'follow_up_required',    5, 'amber',  false, 'We owe the buyer an answer or a call'),
    ('Appointment Pending',   'Appointment Pending',    'appointment_pending',   6, 'amber',  false, 'A visit was requested, time not yet confirmed'),
    ('Appointment Confirmed', 'Appointment Booked',     'appointment_booked',    7, 'teal',   false, 'A confirmed appointment (set automatically)'),
    ('Visited Showroom',      'Appointment Attended',   'appointment_attended',  8, 'teal',   false, 'The buyer came (set automatically when the appointment is completed)'),
    ('Booking / Reservation', 'Unit Booked',            'unit_booked',           9, 'green',  true,  'The buyer has booked a unit'),
    ('Pending Document',      'Documents Pending',      'documents_pending',    10, 'purple', false, 'Waiting for the buyer''s documents'),
    ('Pending Approval',      'Loan Submitted',         'loan_submitted',       11, 'purple', true,  'The loan application has been submitted'),
    (null,                    'Loan Approved',          'loan_approved',        12, 'green',  false, 'Confirmed by the bank or an authorised agent'),
    (null,                    'Loan Declined',          'loan_declined',        13, 'red',    false, 'Confirmed by the bank or an authorised agent'),
    ('SPA Signing',           'LO Signed',              'lo_signed',            14, 'gold',   false, 'Letter of offer signed'),
    ('Pending SPA Signing',   'Pending SPA Signing',    'pending_spa_signing',  15, 'gold',   false, null),
    ('Won',                   'LO, SPA & LA Signed',    'signed_all',           16, 'navy',   false, 'All documents signed: closes the lead as won'),
    ('Lost',                  'Cancelled / Lost',       'cancelled',            17, 'red',    false, 'Closes the lead as lost')
  ) as x(old_name, new_name, key, pos, color, ai, description) loop
    if r.old_name is not null and exists (select 1 from public.ai_pipeline_stages where name = r.old_name) then
      update public.ai_pipeline_stages set name = r.new_name, key = r.key, position = r.pos, color = r.color, ai_settable = r.ai,
             description = coalesce(description, r.description)
       where name = r.old_name;
    elsif not exists (select 1 from public.ai_pipeline_stages where name = r.new_name) then
      insert into public.ai_pipeline_stages (name, key, position, color, ai_settable, description) values (r.new_name, r.key, r.pos, r.color, r.ai, r.description);
    end if;
  end loop;
  -- any other stage an owner added keeps its order, after these
  with o as (select id, row_number() over (order by position) + 17 as p from public.ai_pipeline_stages where position >= 1000)
  update public.ai_pipeline_stages s set position = o.p from o where s.id = o.id;
end $$;

-- ---------------------------------------------------------------------------- profile & qualification fields
-- p_changes: [{field, value, status: confirmed|inferred}]. Qualification fields go to ai_leads.qualification, every
-- other field to ai_leads.profile. Returns {applied, conflicts, skipped}.
create or replace function public.ai_lead_profile_set(p_lead uuid, p_changes jsonb, p_source text default 'staff', p_message uuid default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ch jsonb; k text; v jsonb; st text; l public.ai_leads; meta jsonb; cur jsonb; curm jsonb; isq boolean; who text;
        applied text[] := '{}'; conflicts text[] := '{}'; skipped text[] := '{}';
        qual_keys text[] := array['purpose','first_home','bedrooms','size_sqft','budget_min','budget_max','employment','financing',
                                  'timeline_months','readiness','concerns','project_fit','budget_fit','unsuitable','unsuitable_reason'];
begin
  if p_source not in ('staff','ai') then raise exception 'source must be staff or ai'; end if;
  if p_source = 'staff' then
    if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then raise exception 'AI updates come from the server only';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'array' then raise exception 'changes must be a list'; end if;
  who := case when p_source = 'ai' then 'ai' else public.ai_actor() end;
  select * into l from public.ai_leads where id = p_lead for update;
  if l.id is null then raise exception 'Lead not found'; end if;
  meta := coalesce(l.profile_meta, '{}'::jsonb);
  l.profile := coalesce(l.profile, '{}'::jsonb);
  l.qualification := coalesce(l.qualification, '{}'::jsonb);

  for ch in select value from jsonb_array_elements(p_changes) loop
    k := ch ->> 'field';
    if k is null or k !~ '^[a-z][a-z0-9_]{1,39}$' or k = 'signals' then continue; end if;
    isq := k = any(qual_keys);
    v := ch -> 'value';
    if v is null or v = 'null'::jsonb or v = '""'::jsonb or v = '[]'::jsonb then
      if p_source = 'ai' then skipped := skipped || k; continue; end if;   -- the AI never clears a field
      v := null;
    elsif jsonb_typeof(v) = 'string' then v := to_jsonb(left(trim(v #>> '{}'), 1000));
    elsif jsonb_typeof(v) = 'array' then v := (select coalesce(jsonb_agg(left(x, 80)), '[]'::jsonb) from (select jsonb_array_elements_text(v) x limit 20) y);
    elsif jsonb_typeof(v) not in ('number','boolean') then continue;
    end if;
    st := case when p_source = 'staff' or ch ->> 'status' = 'confirmed' then 'confirmed' else 'inferred' end;
    cur := case when isq then l.qualification -> k else l.profile -> k end;
    curm := meta -> k;

    if p_source = 'ai' then
      if p_message is not null and exists (select 1 from public.ai_lead_field_history where lead_id = p_lead and field = k and message_id = p_message and source = 'ai') then
        skipped := skipped || k; continue;
      end if;
      if cur is not distinct from v then
        -- the same value: one the AI had only inferred becomes confirmed once the buyer states it
        if st = 'confirmed' and curm ->> 'status' = 'inferred' then
          meta := jsonb_set(meta, array[k], curm || jsonb_build_object('status', 'confirmed', 'at', now(), 'message_id', p_message));
          insert into public.ai_lead_field_history (lead_id, field, old_value, new_value, status, source, by, message_id)
          values (p_lead, k, cur, v, 'confirmed', 'ai', who, p_message);
          applied := applied || k;
        else skipped := skipped || k; end if;
        continue;
      end if;
      if cur is not null and curm ->> 'source' = 'staff' then
        -- a person's entry is never overwritten by the AI: the new value is shown for review
        meta := jsonb_set(meta, array[k], curm || jsonb_build_object('conflict', jsonb_build_object('value', v, 'status', st, 'at', now(), 'message_id', p_message)));
        insert into public.ai_lead_field_history (lead_id, field, old_value, new_value, status, source, by, message_id)
        values (p_lead, k, cur, v, 'conflict', 'ai', who, p_message);
        conflicts := conflicts || k;
        continue;
      end if;
      if cur is not null and coalesce(curm ->> 'status', 'confirmed') = 'confirmed' and st = 'inferred' then
        skipped := skipped || k; continue;   -- a guess never replaces what the buyer said
      end if;
    end if;

    if isq then l.qualification := case when v is null then l.qualification - k else jsonb_set(l.qualification, array[k], v) end;
    else l.profile := case when v is null then l.profile - k else jsonb_set(l.profile, array[k], v) end; end if;
    meta := case when v is null then meta - k
                 else jsonb_set(meta, array[k], jsonb_strip_nulls(jsonb_build_object('status', st, 'source', p_source, 'by', who, 'at', now(),
                                                                                    'message_id', p_message, 'note', nullif(trim(coalesce(p_note, '')), '')))) end;
    insert into public.ai_lead_field_history (lead_id, field, old_value, new_value, status, source, by, message_id, note)
    values (p_lead, k, cur, v, case when v is null then 'cleared' else st end, p_source, who, p_message, nullif(trim(coalesce(p_note, '')), ''));
    applied := applied || k;
  end loop;

  if cardinality(applied) > 0 or cardinality(conflicts) > 0 then
    update public.ai_leads set profile = l.profile, qualification = l.qualification, profile_meta = meta where id = p_lead;
    insert into public.ai_activities (lead_id, contact_id, kind, body, meta, actor)
    values (p_lead, l.contact_id, 'profile_update',
            concat_ws(' · ', case when cardinality(applied) > 0 then (case when p_source = 'ai' then 'AI updated ' else 'Updated ' end) || array_to_string(applied, ', ') end,
                             case when cardinality(conflicts) > 0 then 'needs review: ' || array_to_string(conflicts, ', ') end),
            jsonb_build_object('fields', to_jsonb(applied), 'conflicts', to_jsonb(conflicts), 'source', p_source, 'message_id', p_message), who);
  end if;
  return jsonb_build_object('applied', to_jsonb(applied), 'conflicts', to_jsonb(conflicts), 'skipped', to_jsonb(skipped));
end $$;

-- A person resolves a conflict: keep their value, or take the one the buyer gave.
create or replace function public.ai_lead_profile_resolve(p_lead uuid, p_field text, p_accept boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare l public.ai_leads; c jsonb;
begin
  if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  select * into l from public.ai_leads where id = p_lead for update;
  c := l.profile_meta -> p_field -> 'conflict';
  if c is null then return false; end if;
  update public.ai_leads set profile_meta = jsonb_set(profile_meta, array[p_field], (profile_meta -> p_field) - 'conflict') where id = p_lead;
  if p_accept then
    perform public.ai_lead_profile_set(p_lead, jsonb_build_array(jsonb_build_object('field', p_field, 'value', c -> 'value')), 'staff', null, 'accepted the value from the conversation');
  end if;
  return true;
end $$;

-- ---------------------------------------------------------------------------- summary & next action
-- p_summary: {text, last_client_question, outstanding, next_question, next_action: {action, reason, priority, due_at}}
-- AI: from the server only; a person may also edit the summary text and set the next action.
create or replace function public.ai_lead_summary_set(p_lead uuid, p_summary jsonb, p_source text default 'ai', p_message uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.ai_leads; s jsonb; na jsonb; cur_na jsonb; who text;
begin
  if p_source = 'staff' then
    if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  elsif p_source = 'ai' then
    if coalesce(auth.role(), '') <> 'service_role' then raise exception 'AI updates come from the server only'; end if;
  else raise exception 'source must be staff or ai';
  end if;
  who := case when p_source = 'ai' then 'ai' else public.ai_actor() end;
  select * into l from public.ai_leads where id = p_lead for update;
  if l.id is null then raise exception 'Lead not found'; end if;
  s := coalesce(l.ai_summary, '{}'::jsonb);
  if nullif(trim(coalesce(p_summary ->> 'text', '')), '') is not null then
    s := s || jsonb_build_object('text', left(trim(p_summary ->> 'text'), 1500), 'updated_at', now(), 'updated_by', who, 'source', p_source, 'message_id', p_message);
  end if;
  if p_summary ? 'last_client_question' then s := s || jsonb_build_object('last_client_question', nullif(left(trim(coalesce(p_summary ->> 'last_client_question', '')), 400), '')); end if;
  if p_summary ? 'outstanding' then s := s || jsonb_build_object('outstanding', nullif(left(trim(coalesce(p_summary ->> 'outstanding', '')), 600), '')); end if;
  if p_summary ? 'next_question' then s := s || jsonb_build_object('next_question', nullif(left(trim(coalesce(p_summary ->> 'next_question', '')), 300), '')); end if;
  na := p_summary -> 'next_action';
  cur_na := s -> 'next_action';
  if na is not null and nullif(trim(coalesce(na ->> 'action', '')), '') is not null
     and (cur_na is null or cur_na ->> 'action' is distinct from trim(na ->> 'action') or cur_na ->> 'status' is distinct from 'open') then
    -- a recommendation a person dismissed or completed is not brought back unchanged by the AI
    if not coalesce(p_source = 'ai' and cur_na ->> 'action' = trim(na ->> 'action') and cur_na ->> 'status' in ('done','dismissed'), false) then
      s := s || jsonb_build_object('next_action', jsonb_strip_nulls(jsonb_build_object(
        'action', left(trim(na ->> 'action'), 300), 'reason', nullif(left(trim(coalesce(na ->> 'reason', '')), 400), ''),
        'priority', case when na ->> 'priority' in ('low','normal','high') then na ->> 'priority' else 'normal' end,
        'due_at', case when (na ->> 'due_at') ~ '^\d{4}-\d{2}-\d{2}' then na ->> 'due_at' end,
        'status', 'open', 'source', p_source, 'by', who, 'at', now())));
    end if;
  end if;
  update public.ai_leads set ai_summary = s where id = p_lead;
  if p_source = 'staff' or (l.ai_summary ->> 'text') is distinct from (s ->> 'text') then
    insert into public.ai_activities (lead_id, contact_id, kind, body, meta, actor)
    values (p_lead, l.contact_id, 'ai_summary', case when p_source = 'ai' then 'AI summary updated' else 'Summary edited' end,
            jsonb_build_object('source', p_source, 'message_id', p_message), who);
  end if;
  return s;
end $$;

create or replace function public.ai_lead_next_action(p_lead uuid, p_status text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  if p_status not in ('done','dismissed','open') then raise exception 'Status must be done, dismissed or open'; end if;
  update public.ai_leads set ai_summary = jsonb_set(ai_summary, '{next_action}', (ai_summary -> 'next_action') || jsonb_build_object('status', p_status, 'closed_by', public.ai_actor(), 'closed_at', now()))
   where id = p_lead and ai_summary ? 'next_action';
  return found;
end $$;

-- ---------------------------------------------------------------------------- stage moves
-- the timeline records who moved the lead, how and why (note / evidence set by ai_lead_set_stage)
create or replace function public.ai_lead_timeline() returns trigger
language plpgsql security definer set search_path = public as $$
declare note text := nullif(current_setting('ai.stage_note', true), ''); src text := nullif(current_setting('ai.stage_source', true), '');
        ev text := nullif(current_setting('ai.stage_evidence', true), '');
begin
  if new.stage_id is distinct from old.stage_id then
    insert into public.ai_activities (lead_id, contact_id, kind, body, meta, actor)
    select new.id, new.contact_id, 'stage_change',
           (select name from public.ai_pipeline_stages where id = old.stage_id) || ' → ' || s.name || coalesce(' · ' || note, '') || coalesce(' · buyer: "' || left(ev, 200) || '"', ''),
           jsonb_strip_nulls(jsonb_build_object('from', old.stage_id, 'to', new.stage_id, 'source', coalesce(src, 'staff'), 'note', note, 'evidence', ev)),
           case when src in ('ai','system') then src else public.ai_actor() end
      from public.ai_pipeline_stages s where s.id = new.stage_id;
    if (select is_won or is_lost from public.ai_pipeline_stages where id = new.stage_id) then
      new.closed_at := coalesce(new.closed_at, now());
    else
      new.closed_at := null;
    end if;
  end if;
  if new.owner_email is distinct from old.owner_email then
    insert into public.ai_activities (lead_id, contact_id, kind, body)
    values (new.id, new.contact_id, 'assignment', coalesce('Assigned to ' || new.owner_email, 'Unassigned'));
  end if;
  return new;
end $$;

-- staff: any active stage (with an optional note); ai: forward only, to ai_settable stages, never closing, with the
-- buyer's words as evidence; system: forward only (appointments). Returns true when the stage changed.
create or replace function public.ai_lead_set_stage(p_lead uuid, p_stage uuid, p_note text default null, p_source text default 'staff', p_evidence text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare l public.ai_leads; tgt public.ai_pipeline_stages; cur public.ai_pipeline_stages;
begin
  if p_source = 'staff' then
    if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  elsif p_source in ('ai','system') then
    if coalesce(auth.role(), '') <> 'service_role' and current_setting('ai.internal', true) is distinct from 'on' then raise exception 'Not allowed'; end if;
  else raise exception 'Unknown source';
  end if;
  select * into l from public.ai_leads where id = p_lead for update;
  select * into tgt from public.ai_pipeline_stages where id = p_stage;
  if l.id is null or tgt.id is null then raise exception 'Lead or stage not found'; end if;
  if l.stage_id = tgt.id then return false; end if;
  if not tgt.active and p_source <> 'staff' then return false; end if;
  select * into cur from public.ai_pipeline_stages where id = l.stage_id;
  if p_source <> 'staff' then
    if l.closed_at is not null or tgt.is_won or tgt.is_lost or tgt.position <= coalesce(cur.position, 0) then return false; end if;
    if p_source = 'ai' and (not tgt.ai_settable or length(trim(coalesce(p_evidence, ''))) < 3) then return false; end if;
  end if;
  perform set_config('ai.stage_note', coalesce(left(trim(p_note), 300), ''), true);
  perform set_config('ai.stage_source', p_source, true);
  perform set_config('ai.stage_evidence', coalesce(left(trim(p_evidence), 300), ''), true);
  update public.ai_leads set stage_id = tgt.id where id = p_lead;
  perform set_config('ai.stage_note', '', true);
  perform set_config('ai.stage_source', '', true);
  perform set_config('ai.stage_evidence', '', true);
  -- a person moved the lead on: check-ins scheduled for the old situation are dropped (the buyer's next message
  -- schedules a fresh one); a closed lead gets no more automatic messages at all
  if p_source = 'staff' or tgt.is_won or tgt.is_lost then
    update public.ai_automation_jobs set status = 'cancelled', reason = 'stage changed to ' || tgt.name
     where lead_id = p_lead and status = 'scheduled'
       and (kind = 'smart_follow_up' or (tgt.is_won or tgt.is_lost) and kind in ('appt_confirmation','appt_reminder'));
    update public.ai_follow_up_jobs set status = 'cancelled', reason = 'stage changed to ' || tgt.name
     where lead_id = p_lead and status = 'scheduled';
  end if;
  return true;
end $$;

-- a confirmed / completed appointment moves the lead to Appointment Booked / Attended (forward only)
create or replace function public.ai_appointment_stage() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; sid uuid;
begin
  if new.status is not distinct from (case when tg_op = 'UPDATE' then old.status end) then return new; end if;
  k := case new.status when 'confirmed' then 'appointment_booked' when 'completed' then 'appointment_attended' end;
  if k is null or new.lead_id is null then return new; end if;
  select id into sid from public.ai_pipeline_stages where key = k and active;
  if sid is null then return new; end if;
  perform set_config('ai.internal', 'on', true);
  perform public.ai_lead_set_stage(new.lead_id, sid, case k when 'appointment_booked' then 'appointment confirmed' else 'appointment completed' end, 'system');
  perform set_config('ai.internal', '', true);
  return new;
exception when others then
  perform set_config('ai.internal', '', true);
  raise warning 'ai_appointment_stage: %', sqlerrm;   -- never block the appointment itself
  return new;
end $$;
create trigger ai_appointments_stage after insert or update of status on public.ai_appointments for each row execute function public.ai_appointment_stage();

-- ---------------------------------------------------------------------------- PDPA erase covers the new data
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

-- ---------------------------------------------------------------------------- grants
revoke all on function public.ai_lead_profile_set(uuid, jsonb, text, uuid, text) from public, anon;
revoke all on function public.ai_lead_profile_resolve(uuid, text, boolean) from public, anon;
revoke all on function public.ai_lead_summary_set(uuid, jsonb, text, uuid) from public, anon;
revoke all on function public.ai_lead_next_action(uuid, text) from public, anon;
revoke all on function public.ai_lead_set_stage(uuid, uuid, text, text, text) from public, anon;
revoke all on function public.ai_appointment_stage() from public, anon, authenticated;
grant execute on function public.ai_lead_profile_set(uuid, jsonb, text, uuid, text), public.ai_lead_profile_resolve(uuid, text, boolean),
  public.ai_lead_summary_set(uuid, jsonb, text, uuid), public.ai_lead_next_action(uuid, text),
  public.ai_lead_set_stage(uuid, uuid, text, text, text) to authenticated, service_role;
