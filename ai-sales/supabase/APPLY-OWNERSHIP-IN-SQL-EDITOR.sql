-- AI Sales module — human takeover, 12-hour follow-up and appointment reminder changes in ONE transaction (all-or-nothing).
-- For the live database, which already has migrations 1–8. Paste into Supabase → SQL Editor → New query → Run.
-- Additive only. Running it twice fails harmlessly with "already exists" and changes nothing.
begin;

-- AI Sales module — conversation ownership (AI ↔ human), smart 12-hour follow-up, WhatsApp appointment
-- confirmations/reminders as persisted jobs, and human follow-up reminders on Telegram.
-- ADDITIVE ONLY: new table, new columns, new functions/triggers. Existing rows are kept; the website is not touched.
--
-- Ownership is enforced in the database: any message a person sends (from the inbox or from the WhatsApp Business
-- app on the phone) switches the conversation to "human" in the same transaction that records it, cancels the
-- AI's pending replies and follow-ups, and only an advisor's explicit "Resume AI" switches it back.

-- ---------------------------------------------------------------------------
-- Settings (one jsonb column; keeps anything already set) and routine-message alerts off
-- ---------------------------------------------------------------------------
alter table public.ai_settings add column if not exists automation jsonb not null default '{
  "smart_follow_up": true,
  "follow_up_delay_hours": 12,
  "follow_up_template": "follow_up",
  "appointment_confirmations": true,
  "appointment_reminders": true,
  "appointment_reminder_minutes": [1440, 120],
  "human_reminders": true,
  "human_reminder_minutes": 60
}'::jsonb;
-- Telegram is for follow-up tasks and appointments, not a copy of every WhatsApp message
update public.ai_settings set notifications = notifications || '{"whatsapp_alerts": false}'::jsonb where id = 1;

-- ---------------------------------------------------------------------------
-- Conversation ownership and automation switches
-- ---------------------------------------------------------------------------
alter table public.ai_conversations
  add column human_takeover_at   timestamptz,
  add column takeover_by         text,
  add column ai_resumed_at       timestamptz,
  add column last_human_reply_at timestamptz,
  add column last_follow_up_at   timestamptz,
  add column automation          jsonb not null default '{}'::jsonb;  -- {"follow_ups": false, "appointment_reminders": false}

alter table public.ai_appointments
  add column wa_reminders            boolean not null default true,   -- WhatsApp confirmation + reminders for this appointment
  add column attendance_confirmed_at timestamptz;                     -- buyer replied "yes" to a confirmation/reminder

-- what the conversation history already shows
update public.ai_conversations c set last_human_reply_at = x.t
  from (select conversation_id, max(created_at) t from public.ai_messages where direction = 'outbound' and sender_type = 'human' group by 1) x
 where x.conversation_id = c.id;
update public.ai_conversations set human_takeover_at = coalesce(last_human_reply_at, updated_at) where mode <> 'ai';

-- ---------------------------------------------------------------------------
-- Automation jobs: every scheduled follow-up, reminder and confirmation, with why it was sent or not
-- ---------------------------------------------------------------------------
create table public.ai_automation_jobs (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in ('smart_follow_up','human_reminder','appt_confirmation','appt_reminder')),
  conversation_id   uuid references public.ai_conversations(id) on delete cascade,
  lead_id           uuid references public.ai_leads(id) on delete cascade,
  appointment_id    uuid references public.ai_appointments(id) on delete cascade,
  anchor_message_id uuid references public.ai_messages(id) on delete set null,  -- the buyer message it follows up
  ref_time          timestamptz,                                               -- appointment start it was scheduled for
  offset_minutes    int,
  run_at            timestamptz not null,
  status            text not null default 'scheduled' check (status in ('scheduled','processing','sent','skipped','cancelled','failed')),
  reason            text,                       -- why it was skipped / cancelled / failed (no message content)
  checks            jsonb not null default '[]'::jsonb,  -- [{check, ok}] evaluated when it ran
  message_id        uuid references public.ai_messages(id) on delete set null,
  attempts          int not null default 0,
  dedupe_key        text not null unique,       -- one job per event: retries and redeliveries never duplicate
  sent_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index ai_automation_due on public.ai_automation_jobs (run_at) where status = 'scheduled';
create index ai_automation_conv on public.ai_automation_jobs (conversation_id, status);
create index ai_automation_appt on public.ai_automation_jobs (appointment_id, status);
create trigger ai_automation_jobs_touch before update on public.ai_automation_jobs for each row execute function public.ai_touch_updated();
alter table public.ai_automation_jobs enable row level security;
revoke all on public.ai_automation_jobs from anon;
create policy "ai read" on public.ai_automation_jobs for select to authenticated using (public.ai_has_role('viewer'));
-- written by the server and the triggers below only; staff cancel through ai_cancel_automation_job()

-- settings with defaults filled in
create function public.ai_automation_cfg() returns jsonb
language sql stable security definer set search_path = public as $$
  select '{"smart_follow_up": true, "follow_up_delay_hours": 12, "appointment_confirmations": true, "appointment_reminders": true,
           "appointment_reminder_minutes": [1440, 120], "human_reminders": true, "human_reminder_minutes": 60}'::jsonb
         || coalesce((select automation from public.ai_settings where id = 1), '{}'::jsonb)
$$;

-- ---------------------------------------------------------------------------
-- Takeover (shared by the trigger, the inbox button and phone-app echoes)
-- ---------------------------------------------------------------------------
create function public.ai_apply_takeover(p_conv uuid, p_by text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare lid uuid;
begin
  update public.ai_conversations
     set human_takeover_at = case when mode = 'ai' or human_takeover_at is null then now() else human_takeover_at end,
         mode = 'human', takeover_by = coalesce(p_by, takeover_by), assigned_email = coalesce(assigned_email, nullif(p_by, 'WhatsApp app'))
   where id = p_conv returning lead_id into lid;
  if lid is not null then update public.ai_leads set ai_paused = true where id = lid and not ai_paused; end if;
  -- nothing the AI queued earlier may go out now
  update public.ai_automation_jobs set status = 'cancelled', reason = p_reason
   where conversation_id = p_conv and status = 'scheduled' and kind = 'smart_follow_up';
  update public.ai_jobs set status = 'done', last_error = 'cancelled: ' || p_reason
   where kind = 'wa_reply' and status in ('queued','failed') and payload ->> 'conversation_id' = p_conv::text;
  if lid is not null then
    update public.ai_follow_up_jobs set status = 'cancelled', reason = p_reason where lead_id = lid and status = 'scheduled';
  end if;
end $$;

-- "Take over" button in the inbox (advisors and above)
create function public.ai_take_over(p_conversation uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' and not public.ai_has_role('advisor') then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.ai_conversations where id = p_conversation) then raise exception 'conversation not found'; end if;
  perform public.ai_apply_takeover(p_conversation, public.ai_actor(), 'a person took over the conversation');
  insert into public.ai_audit_logs (actor, action, table_name, record_id, changes)
  values (public.ai_actor(), 'take_over', 'ai_conversations', p_conversation::text, '{}'::jsonb);
  return jsonb_build_object('mode', 'human');
end $$;

-- "Resume AI" (advisors and above): the only way a conversation goes back to the AI
create function public.ai_resume_ai(p_conversation uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare lid uuid; n int;
begin
  if auth.role() <> 'service_role' and not public.ai_has_role('advisor') then raise exception 'not allowed'; end if;
  update public.ai_conversations set mode = 'ai', ai_resumed_at = now(), assigned_email = null
   where id = p_conversation returning lead_id into lid;
  if not found then raise exception 'conversation not found'; end if;
  if lid is not null then update public.ai_leads set ai_paused = false where id = lid; end if;
  update public.ai_handover_events set status = 'resolved', resolved_at = now()
   where status <> 'resolved' and (conversation_id = p_conversation or (lid is not null and lead_id = lid));
  get diagnostics n = row_count;
  -- old queued work is stale: the AI answers the buyer's next message, not old ones
  update public.ai_jobs set status = 'done', last_error = 'cancelled: stale when the AI was resumed'
   where kind = 'wa_reply' and status in ('queued','failed') and payload ->> 'conversation_id' = p_conversation::text;
  update public.ai_automation_jobs set status = 'cancelled', reason = 'AI resumed'
   where conversation_id = p_conversation and status = 'scheduled' and kind = 'human_reminder';
  insert into public.ai_audit_logs (actor, action, table_name, record_id, changes)
  values (public.ai_actor(), 'resume_ai', 'ai_conversations', p_conversation::text, jsonb_build_object('handovers_resolved', n));
  return jsonb_build_object('mode', 'ai', 'handovers_resolved', n);
end $$;

create function public.ai_cancel_automation_job(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.ai_has_role('advisor') then raise exception 'not allowed'; end if;
  update public.ai_automation_jobs set status = 'cancelled', reason = 'cancelled by ' || public.ai_actor()
   where id = p_id and status = 'scheduled';
  return found;
end $$;

-- Claims due jobs for a worker (or one specific job, e.g. the confirmation right after booking). SKIP LOCKED makes
-- concurrent workers safe: a job is handed out once; one stuck in "processing" for 10 minutes is retried.
create function public.ai_claim_automation_jobs(max_jobs int default 20, only_id uuid default null)
returns setof public.ai_automation_jobs language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'not allowed'; end if;
  return query
  update public.ai_automation_jobs j set status = 'processing', attempts = j.attempts + 1
   where j.id in (
     select id from public.ai_automation_jobs
      where ((status = 'scheduled' and run_at <= now()) or (status = 'processing' and updated_at < now() - interval '10 minutes'))
        and attempts < 5 and (only_id is null or id = only_id)
      order by run_at
      limit least(greatest(max_jobs, 1), 50)
      for update skip locked)
  returning j.*;
end $$;

-- ---------------------------------------------------------------------------
-- Message trigger: schedules / cancels automation as messages are recorded
-- ---------------------------------------------------------------------------
create function public.ai_message_automation() returns trigger
language plpgsql security definer set search_path = public as $$
declare c public.ai_conversations; l public.ai_leads; cfg jsonb; auto_reply boolean; appt uuid;
begin
  select * into c from public.ai_conversations where id = new.conversation_id;
  if c.id is null then return new; end if;
  select * into l from public.ai_leads where id = c.lead_id;
  cfg := public.ai_automation_cfg();

  if new.direction = 'inbound' then
    -- the buyer wrote again: earlier timers restart from this message
    update public.ai_automation_jobs set status = 'cancelled', reason = 'superseded by a newer buyer message'
     where conversation_id = c.id and status = 'scheduled' and kind in ('smart_follow_up','human_reminder');
    if c.status = 'open' and (l.id is null or l.closed_at is null) then
      auto_reply := coalesce((select (flags ->> 'ai_auto_reply')::boolean from public.ai_settings where id = 1), false);
      if coalesce((cfg ->> 'smart_follow_up')::boolean, true) and c.mode = 'ai' and not coalesce(l.ai_paused, false)
         and coalesce(c.automation ->> 'follow_ups', 'true') <> 'false' then
        insert into public.ai_automation_jobs (kind, conversation_id, lead_id, anchor_message_id, run_at, dedupe_key)
        values ('smart_follow_up', c.id, l.id, new.id,
                new.created_at + make_interval(secs => greatest(1, least(168, coalesce((cfg ->> 'follow_up_delay_hours')::numeric, 12))) * 3600),
                'smart:' || new.id)
        on conflict (dedupe_key) do nothing;
      end if;
      -- a person has to answer this one: remind them if nobody has after a while
      if coalesce((cfg ->> 'human_reminders')::boolean, true) and (c.mode <> 'ai' or coalesce(l.ai_paused, false) or not auto_reply) then
        insert into public.ai_automation_jobs (kind, conversation_id, lead_id, anchor_message_id, run_at, dedupe_key)
        values ('human_reminder', c.id, l.id, new.id,
                now() + make_interval(mins => greatest(5, least(1440, coalesce((cfg ->> 'human_reminder_minutes')::int, 60)))),
                'human:' || new.id)
        on conflict (dedupe_key) do nothing;
      end if;
    end if;
    -- "yes, see you" after a confirmation or reminder: record that the buyer confirmed attendance
    if new.body ~* '^\s*(ya|yes|yup|ok|okay|okey|boleh|confirm|confirmed|jadi|insya ?allah|in ?sha ?allah|on|set|baik|noted|sure|datang|will come|see you|jumpa)\M' and l.id is not null then
      select a.id into appt from public.ai_appointments a
       where a.lead_id = l.id and a.status = 'confirmed' and a.start_at > now() and a.attendance_confirmed_at is null
         and exists (select 1 from public.ai_automation_jobs j where j.appointment_id = a.id and j.kind in ('appt_confirmation','appt_reminder')
                      and j.status = 'sent' and j.sent_at > now() - interval '24 hours')
       order by a.start_at limit 1;
      if appt is not null then update public.ai_appointments set attendance_confirmed_at = now() where id = appt; end if;
    end if;

  elsif new.sender_type = 'human' then
    -- a person replied (inbox or phone app): the conversation is theirs until someone resumes the AI
    perform public.ai_apply_takeover(c.id, coalesce(new.sender_email, case when new.provider = 'whatsapp_app' then 'WhatsApp app' end), 'a person replied');
    update public.ai_conversations set last_human_reply_at = greatest(coalesce(last_human_reply_at, '-infinity'), new.created_at) where id = c.id;
    update public.ai_automation_jobs set status = 'cancelled', reason = 'a person replied'
     where conversation_id = c.id and status = 'scheduled' and kind = 'human_reminder';
    -- a person already reminded the buyer about a visit: the automatic reminder would be a duplicate
    if l.id is not null and (coalesce(new.template_name, '') ~* '(remind|peringatan)'
        or coalesce(new.body, '') ~* '(peringatan|remind|ingatkan|jangan lupa|temujanji|janji temu|appointment|lawatan|showroom)') then
      update public.ai_automation_jobs set status = 'cancelled', reason = 'a person already reminded the buyer'
       where id = (select j.id from public.ai_automation_jobs j join public.ai_appointments a on a.id = j.appointment_id
                    where a.lead_id = l.id and j.kind = 'appt_reminder' and j.status = 'scheduled'
                      and j.run_at <= now() + interval '24 hours' and a.start_at <= now() + interval '36 hours'
                    order by j.run_at limit 1);
    end if;
  end if;
  return new;
exception when others then
  raise warning 'ai_message_automation: %', sqlerrm;  -- automation must never block recording a message
  return new;
end $$;
create trigger ai_messages_automation after insert on public.ai_messages for each row execute function public.ai_message_automation();

-- ---------------------------------------------------------------------------
-- Appointment trigger: confirmations and reminders follow the appointment's current state
-- ---------------------------------------------------------------------------
create function public.ai_appt_automation() returns trigger
language plpgsql security definer set search_path = public as $$
declare cfg jsonb := public.ai_automation_cfg(); conv uuid; o int; r timestamptz;
begin
  -- obsolete jobs: cancelled, rescheduled, or switched off
  update public.ai_automation_jobs set status = 'cancelled',
         reason = case when new.status <> 'confirmed' then 'appointment ' || replace(new.status, '_', ' ')
                       when ref_time is distinct from new.start_at then 'appointment rescheduled'
                       else 'reminders switched off for this appointment' end
   where appointment_id = new.id and status = 'scheduled'
     and (new.status <> 'confirmed' or ref_time is distinct from new.start_at or not new.wa_reminders);

  if new.status = 'confirmed' and new.start_at > now() and new.wa_reminders then
    select id into conv from public.ai_conversations c
     where c.contact_id = (select contact_id from public.ai_leads where id = new.lead_id) and c.channel = 'whatsapp' and c.status = 'open';
    if coalesce((cfg ->> 'appointment_confirmations')::boolean, true)
       and (tg_op = 'INSERT' or old.status is distinct from 'confirmed' or old.start_at is distinct from new.start_at) then
      insert into public.ai_automation_jobs (kind, conversation_id, lead_id, appointment_id, ref_time, run_at, dedupe_key)
      values ('appt_confirmation', conv, new.lead_id, new.id, new.start_at, now(), 'appt-confirm:' || new.id || ':' || extract(epoch from new.start_at)::bigint)
      on conflict (dedupe_key) do update set status = 'scheduled', reason = null, run_at = now()
       where ai_automation_jobs.status = 'cancelled' and (ai_automation_jobs.reason like 'appointment%' or ai_automation_jobs.reason like 'reminders switched off%');
    end if;
    if coalesce((cfg ->> 'appointment_reminders')::boolean, true) then
      for o in select x::int from jsonb_array_elements_text(coalesce(cfg -> 'appointment_reminder_minutes', '[]'::jsonb)) x where x ~ '^\d+$' loop
        r := new.start_at - make_interval(mins => o);
        -- a reminder due within the hour after booking would only repeat the confirmation: skipped
        if r >= now() + interval '60 minutes' then
          insert into public.ai_automation_jobs (kind, conversation_id, lead_id, appointment_id, ref_time, offset_minutes, run_at, dedupe_key)
          values ('appt_reminder', conv, new.lead_id, new.id, new.start_at, o, r, 'appt-rem:' || new.id || ':' || o || ':' || extract(epoch from new.start_at)::bigint)
          on conflict (dedupe_key) do update set status = 'scheduled', reason = null
           where ai_automation_jobs.status = 'cancelled' and (ai_automation_jobs.reason like 'appointment%' or ai_automation_jobs.reason like 'reminders switched off%');
        end if;
      end loop;
    end if;
  end if;
  return new;
exception when others then
  raise warning 'ai_appt_automation: %', sqlerrm;  -- never block saving an appointment
  return new;
end $$;
create trigger ai_appointments_automation after insert or update of status, start_at, wa_reminders on public.ai_appointments
  for each row execute function public.ai_appt_automation();

-- reminders for confirmed appointments that already exist (a 24-hour reminder already sent is not repeated)
insert into public.ai_automation_jobs (kind, conversation_id, lead_id, appointment_id, ref_time, offset_minutes, run_at, dedupe_key, status, reason)
select 'appt_reminder', c.id, a.lead_id, a.id, a.start_at, o.m, a.start_at - make_interval(mins => o.m),
       'appt-rem:' || a.id || ':' || o.m || ':' || extract(epoch from a.start_at)::bigint,
       case when o.m >= 720 and a.reminders @> '[{"type":"wa_24h"}]' then 'cancelled' else 'scheduled' end,
       case when o.m >= 720 and a.reminders @> '[{"type":"wa_24h"}]' then 'already reminded before this update' end
  from public.ai_appointments a
  join public.ai_leads l on l.id = a.lead_id
  left join public.ai_conversations c on c.contact_id = l.contact_id and c.channel = 'whatsapp' and c.status = 'open'
  cross join (values (1440), (120)) o(m)
 where a.status = 'confirmed' and a.start_at - make_interval(mins => o.m) > now()
on conflict (dedupe_key) do nothing;

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
revoke all on function public.ai_automation_cfg() from public, anon;
revoke all on function public.ai_apply_takeover(uuid, text, text) from public, anon, authenticated;
revoke all on function public.ai_claim_automation_jobs(int, uuid) from public, anon, authenticated;
revoke all on function public.ai_message_automation() from public, anon, authenticated;
revoke all on function public.ai_appt_automation() from public, anon, authenticated;
revoke all on function public.ai_take_over(uuid) from public, anon;
revoke all on function public.ai_resume_ai(uuid) from public, anon;
revoke all on function public.ai_cancel_automation_job(uuid) from public, anon;
grant execute on function public.ai_automation_cfg() to authenticated, service_role;
grant execute on function public.ai_take_over(uuid), public.ai_resume_ai(uuid), public.ai_cancel_automation_job(uuid) to authenticated, service_role;
grant execute on function public.ai_claim_automation_jobs(int, uuid), public.ai_apply_takeover(uuid, text, text) to service_role;

commit;
