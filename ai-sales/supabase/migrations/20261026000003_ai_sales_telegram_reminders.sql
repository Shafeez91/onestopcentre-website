-- AI Sales module — Telegram notifications for staff: appointment alerts/reminders, follow-up (task) reminders,
-- and a daily digest. Runs inside the database every 5 minutes (pg_cron) and sends through pg_net, reusing the
-- existing Telegram bot token in Vault ('telegram_bot_token') — the same bot that sends website-enquiry alerts.
-- ADDITIVE ONLY: does not change notify_new_lead or any existing object. Messages go to staff only, never customers.

alter table public.ai_settings add column notifications jsonb not null default '{
  "telegram_enabled": true,
  "telegram_chat_id": "8821015679",
  "appointment_changes": true,
  "appointment_reminder_minutes": [1440, 120],
  "task_reminders": true,
  "task_lead_minutes": 30,
  "daily_digest": true,
  "digest_hour": 8
}'::jsonb;

create table public.ai_notifications (
  id          uuid primary key default gen_random_uuid(),
  channel     text not null default 'telegram',
  kind        text not null check (kind in ('appointment_change','appointment_reminder','task_reminder','follow_up_due','daily_digest','test')),
  ref_id      text,
  dedupe_key  text not null unique,         -- one message per event: re-runs never send twice
  message     text not null,
  status      text not null default 'queued' check (status in ('queued','sent','failed','skipped')),
  request_id  bigint,                       -- pg_net request id
  http_status int,
  error       text,
  created_at  timestamptz not null default now()
);
create index ai_notifications_recent on public.ai_notifications (created_at desc);
alter table public.ai_notifications enable row level security;
revoke all on public.ai_notifications from anon;
create policy "ai read" on public.ai_notifications for select to authenticated using (public.ai_has_role('manager'));

-- Sends one Telegram message (plain text) once per dedupe key. Never raises: a Telegram problem must not block CRM writes.
create function public.ai_send_telegram(p_kind text, p_ref text, p_key text, p_text text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare
  cfg jsonb := (select notifications from public.ai_settings where id = 1);
  tok text;
  nid uuid;
  rid bigint;
begin
  if coalesce((cfg ->> 'telegram_enabled')::boolean, false) is not true then return false; end if;
  insert into public.ai_notifications (kind, ref_id, dedupe_key, message)
  values (p_kind, p_ref, p_key, left(p_text, 4000))
  on conflict (dedupe_key) do nothing
  returning id into nid;
  if nid is null then return false; end if;               -- already sent
  begin
    tok := (select trim(decrypted_secret) from vault.decrypted_secrets where name = 'telegram_bot_token' limit 1);
    if coalesce(tok, '') = '' or coalesce(cfg ->> 'telegram_chat_id', '') = '' then
      update public.ai_notifications set status = 'skipped', error = 'Telegram bot token or chat id not configured' where id = nid;
      return false;
    end if;
    rid := net.http_post(
      url     := 'https://api.telegram.org/bot' || tok || '/sendMessage',
      body    := jsonb_build_object('chat_id', cfg ->> 'telegram_chat_id', 'text', left(p_text, 4000), 'disable_web_page_preview', true),
      headers := '{"Content-Type":"application/json"}'::jsonb);
    update public.ai_notifications set status = 'sent', request_id = rid where id = nid;
    return true;
  exception when others then
    update public.ai_notifications set status = 'failed', error = left(sqlerrm, 500) where id = nid;
    return false;
  end;
end $$;

create function public.ai_kl(t timestamptz) returns text language sql stable as $$
  select to_char(t at time zone 'Asia/Kuala_Lumpur', 'Dy DD Mon YYYY, HH12:MI AM')
$$;

-- Human-readable appointment line used by alerts, reminders and the digest.
create function public.ai_appt_text(a public.ai_appointments) returns text
language sql stable security definer set search_path = public as $$
  select
    case a.kind when 'showroom_visit' then 'Showroom visit' when 'property_viewing' then 'Property viewing'
                when 'phone_call' then 'Phone consultation' when 'video_call' then 'Video consultation'
                else 'Financing discussion' end
    || coalesce(' · ' || (select p.data ->> 'n' from public.projects p where p.id = a.project_id), '') || chr(10)
    || '👤 ' || coalesce(nullif(c.full_name, ''), '(no name)') || coalesce(' · ' || l.lead_code, '') || chr(10)
    || coalesce('📞 +' || c.phone_e164 || chr(10), '')
    || '🕒 ' || coalesce(public.ai_kl(a.start_at), 'Preferred: ' || coalesce(a.preferred_text, 'not given') || ' (not confirmed)') || chr(10)
    || coalesce('📍 ' || a.location || chr(10), '')
    || coalesce('🧑‍💼 ' || a.advisor_email || chr(10), '')
    || 'https://onestopcentreproperty.com/sales/#/lead/' || a.lead_id
  from public.ai_leads l join public.ai_contacts c on c.id = l.contact_id
  where l.id = a.lead_id
$$;

-- Instant alert when an appointment is created, confirmed, rescheduled, cancelled or marked no-show.
create function public.ai_appointment_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare head text;
begin
  if coalesce((select (notifications ->> 'appointment_changes')::boolean from public.ai_settings where id = 1), false) is not true then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.status is not distinct from old.status and new.start_at is not distinct from old.start_at then
    return new;
  end if;
  head := case
    when tg_op = 'INSERT' and new.status = 'confirmed' then '📅 New appointment (confirmed)'
    when tg_op = 'INSERT' then '📅 New appointment request (pending confirmation)'
    when new.status = 'cancelled' then '❌ Appointment cancelled'
    when new.status = 'no_show' then '⚠️ Buyer did not show up — follow up'
    when new.status = 'completed' then null
    when new.start_at is distinct from old.start_at then '🔁 Appointment rescheduled'
    when new.status = 'confirmed' then '✅ Appointment confirmed'
    else '📅 Appointment updated: ' || replace(new.status, '_', ' ') end;
  if head is null then return new; end if;
  perform public.ai_send_telegram('appointment_change', new.id::text,
    'appt-change:' || new.id || ':' || new.status || ':' || coalesce(extract(epoch from new.start_at)::bigint::text, '-'),
    head || chr(10) || public.ai_appt_text(new));
  return new;
exception when others then
  return new;   -- never block saving an appointment
end $$;
create trigger ai_appointments_notify after insert or update of status, start_at on public.ai_appointments
  for each row execute function public.ai_appointment_notify();

-- Runs every 5 minutes: appointment reminders, follow-up task reminders, follow-up jobs due, daily digest,
-- and delivery checks. Safe to run any number of times (every message has a dedupe key).
create function public.ai_run_reminders(p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  cfg jsonb := (select notifications from public.ai_settings where id = 1);
  offs int[];
  a public.ai_appointments; t record; j record;
  o int;
  n_appt int := 0; n_task int := 0; n_fu int := 0; n_digest int := 0;
  lead_min int := greatest(coalesce((cfg ->> 'task_lead_minutes')::int, 30), 0);
  local_now timestamp := p_now at time zone 'Asia/Kuala_Lumpur';
  day_start timestamptz := date_trunc('day', p_now at time zone 'Asia/Kuala_Lumpur') at time zone 'Asia/Kuala_Lumpur';
  body text;
begin
  if coalesce((cfg ->> 'telegram_enabled')::boolean, false) is not true then
    return jsonb_build_object('skipped', 'telegram disabled');
  end if;
  select coalesce(array_agg(x::int order by x::int), '{}') into offs
    from jsonb_array_elements_text(coalesce(cfg -> 'appointment_reminder_minutes', '[]'::jsonb)) x where x ~ '^\d+$';

  -- 1) appointment reminders: send the smallest reminder window that has been reached (no bursts)
  if array_length(offs, 1) > 0 then
    for a in select * from public.ai_appointments
              where status in ('pending_confirmation','confirmed','rescheduled') and start_at > p_now
                and start_at <= p_now + make_interval(mins => offs[array_length(offs, 1)])
    loop
      select min(x) into o from unnest(offs) x where p_now >= a.start_at - make_interval(mins => x);
      if o is not null and public.ai_send_telegram('appointment_reminder', a.id::text,
           'appt-rem:' || a.id || ':' || o || ':' || extract(epoch from a.start_at)::bigint,
           '⏰ Appointment in ' || case when o >= 1440 then (o / 1440) || ' day(s)' when o >= 60 then (o / 60) || ' hour(s)' else o || ' min' end
           || case when a.status = 'pending_confirmation' then ' — STILL PENDING CONFIRMATION' else '' end || chr(10)
           || public.ai_appt_text(a)) then
        n_appt := n_appt + 1;
      end if;
    end loop;
  end if;

  -- 2) follow-up reminders from tasks (due soon / just due; old overdue items go into the digest instead)
  if coalesce((cfg ->> 'task_reminders')::boolean, false) then
    for t in select k.*, l.lead_code, c.full_name, c.phone_e164
               from public.ai_tasks k
               left join public.ai_leads l on l.id = k.lead_id
               left join public.ai_contacts c on c.id = l.contact_id
              where k.status = 'open' and k.due_at is not null
                and p_now >= k.due_at - make_interval(mins => lead_min) and k.due_at > p_now - interval '12 hours'
    loop
      if public.ai_send_telegram('task_reminder', t.id::text, 'task:' || t.id || ':' || extract(epoch from t.due_at)::bigint,
           '🔔 Follow-up ' || case when t.due_at <= p_now then 'due now' else 'due ' || to_char(t.due_at at time zone 'Asia/Kuala_Lumpur', 'HH12:MI AM') end || chr(10)
           || '📝 ' || t.title || chr(10)
           || coalesce('👤 ' || coalesce(nullif(t.full_name, ''), '(no name)') || coalesce(' · ' || t.lead_code, '') || chr(10), '')
           || coalesce('📞 +' || t.phone_e164 || chr(10), '')
           || coalesce('🧑‍💼 ' || t.assignee_email || chr(10), '')
           || coalesce('https://onestopcentreproperty.com/sales/#/lead/' || t.lead_id, '')) then
        n_task := n_task + 1;
      end if;
    end loop;

    -- automated follow-up steps that are due while the automatic engine is off: remind a human to send them
    if coalesce((select (flags ->> 'follow_ups')::boolean from public.ai_settings where id = 1), false) is not true then
      for j in select f.*, l.lead_code, c.full_name, c.phone_e164, s.name seq_name, s.steps -> f.step_index ->> 'instruction' instr
                 from public.ai_follow_up_jobs f
                 join public.ai_leads l on l.id = f.lead_id
                 join public.ai_contacts c on c.id = l.contact_id
                 left join public.ai_follow_up_sequences s on s.id = f.sequence_id
                where f.status = 'scheduled' and p_now >= f.run_at - make_interval(mins => lead_min) and f.run_at > p_now - interval '12 hours'
      loop
        if public.ai_send_telegram('follow_up_due', j.id::text, 'fu:' || j.id,
             '🔔 Follow-up step due (send manually)' || chr(10)
             || coalesce('🔁 ' || j.seq_name || ' · step ' || (j.step_index + 1) || chr(10), '')
             || coalesce('📝 ' || j.instr || chr(10), '')
             || '👤 ' || coalesce(nullif(j.full_name, ''), '(no name)') || ' · ' || j.lead_code || chr(10)
             || coalesce('📞 +' || j.phone_e164 || chr(10), '')
             || 'https://onestopcentreproperty.com/sales/#/lead/' || j.lead_id) then
          n_fu := n_fu + 1;
        end if;
      end loop;
    end if;
  end if;

  -- 3) daily digest (once per Malaysian calendar day, at or after digest_hour)
  if coalesce((cfg ->> 'daily_digest')::boolean, false)
     and extract(hour from local_now) >= coalesce((cfg ->> 'digest_hour')::int, 8) then
    select '☀️ AI Sales — ' || to_char(local_now, 'Dy DD Mon') || chr(10) || chr(10)
      || '📅 Appointments today: ' || (select count(*) from public.ai_appointments
            where status in ('pending_confirmation','confirmed','rescheduled') and start_at >= day_start and start_at < day_start + interval '1 day') || chr(10)
      || coalesce((select string_agg('  • ' || to_char(x.start_at at time zone 'Asia/Kuala_Lumpur', 'HH12:MI AM') || ' ' || coalesce(nullif(c.full_name,''), l.lead_code)
                          || case when x.status = 'pending_confirmation' then ' (pending)' else '' end, chr(10) order by x.start_at) || chr(10)
            from public.ai_appointments x join public.ai_leads l on l.id = x.lead_id join public.ai_contacts c on c.id = l.contact_id
            where x.status in ('pending_confirmation','confirmed','rescheduled') and x.start_at >= day_start and x.start_at < day_start + interval '1 day'), '')
      || '⏳ Appointment requests without a confirmed time: ' || (select count(*) from public.ai_appointments where status = 'pending_confirmation' and start_at is null) || chr(10)
      || '🔔 Follow-ups due today: ' || (select count(*) from public.ai_tasks where status = 'open' and due_at >= day_start and due_at < day_start + interval '1 day') || chr(10)
      || '❗ Overdue follow-ups: ' || (select count(*) from public.ai_tasks where status = 'open' and due_at < day_start) || chr(10)
      || '🙋 Waiting for a human: ' || (select count(*) from public.ai_handover_events where status = 'open') || chr(10)
      || '🔥 Hot leads open: ' || (select count(*) from public.ai_leads where closed_at is null and temperature = 'hot') || chr(10)
      || 'https://onestopcentreproperty.com/sales/'
    into body;
    if public.ai_send_telegram('daily_digest', null, 'digest:' || to_char(local_now, 'YYYY-MM-DD'), body) then n_digest := 1; end if;
  end if;

  -- 4) delivery check: record Telegram's HTTP answer for messages sent in the last day
  begin
    update public.ai_notifications n set http_status = r.status_code,
           status = case when r.status_code between 200 and 299 then 'sent' else 'failed' end,
           error = case when r.status_code between 200 and 299 then null else left(coalesce(r.error_msg, r.content::text), 500) end
      from net._http_response r
     where r.id = n.request_id and n.http_status is null and n.created_at > p_now - interval '1 day';
  exception when others then null;   -- response table layout differs between pg_net versions; delivery check is best-effort
  end;

  return jsonb_build_object('appointment_reminders', n_appt, 'task_reminders', n_task, 'follow_ups_due', n_fu, 'digest', n_digest);
end $$;

-- Owners can send a test message from /sales/ → Settings → Notifications.
create function public.ai_telegram_test()
returns jsonb language plpgsql security definer set search_path = public as $$
declare ok boolean; r public.ai_notifications;
begin
  if not public.ai_has_role('owner') then raise exception 'only owners can send a test message'; end if;
  ok := public.ai_send_telegram('test', null, 'test:' || clock_timestamp()::text,
    '✅ AI Sales test message — Telegram notifications are working.' || chr(10) || 'Sent by ' || public.ai_actor() || ' at ' || public.ai_kl(now()));
  select * into r from public.ai_notifications where kind = 'test' order by created_at desc limit 1;
  return jsonb_build_object('queued', ok, 'status', r.status, 'error', r.error);
end $$;

-- retention: also clear notification log entries after 90 days
create or replace function public.ai_purge_expired()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a int; b int; c int;
begin
  if auth.role() <> 'service_role' and not public.ai_has_role('owner') then raise exception 'not allowed'; end if;
  delete from public.ai_webhook_events where received_at < now() - interval '90 days' and status <> 'failed';
  get diagnostics a = row_count;
  update public.ai_agent_runs set input = null, output = null where created_at < now() - interval '180 days' and (input is not null or output is not null);
  get diagnostics b = row_count;
  delete from public.ai_jobs where status in ('done','dead') and updated_at < now() - interval '30 days';
  delete from public.ai_notifications where created_at < now() - interval '90 days';
  get diagnostics c = row_count;
  return jsonb_build_object('webhook_events_deleted', a, 'agent_runs_trimmed', b, 'notifications_deleted', c);
end $$;

-- permissions: only the owner test function is callable from the dashboard; the rest run inside the database
do $$
declare f text;
begin
  foreach f in array array['public.ai_send_telegram(text,text,text,text)', 'public.ai_run_reminders(timestamptz)',
                           'public.ai_appt_text(public.ai_appointments)', 'public.ai_appointment_notify()']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;
revoke all on function public.ai_kl(timestamptz) from public, anon;
grant execute on function public.ai_kl(timestamptz) to authenticated, service_role;
revoke all on function public.ai_telegram_test() from public, anon;
grant execute on function public.ai_telegram_test() to authenticated;
revoke all on function public.ai_purge_expired() from public, anon;
grant execute on function public.ai_purge_expired() to authenticated, service_role;

-- schedule: every 5 minutes (skipped automatically where pg_cron is unavailable, e.g. local tests)
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('ai-sales-reminders', '*/5 * * * *', 'select public.ai_run_reminders()');
  end if;
end $$;
