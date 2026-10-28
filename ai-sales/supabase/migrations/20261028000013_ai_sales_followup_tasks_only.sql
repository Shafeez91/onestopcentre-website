-- AI Sales module — Telegram "follow-up" alerts come only from real follow-up tasks (2026-10-28). ADDITIVE ONLY.
-- Before: every buyer message in a chat a person handles scheduled a "the buyer is waiting for your reply" alert,
-- and every AI hand-over sent "Follow-up needed". Neither was a follow-up task, so existing buyers asking ordinary
-- questions filled Telegram. Now:
--   * Telegram categories: new clients · follow-up tasks (task_reminder, and follow_up_due for scheduled steps to
--     send by hand) · appointments. The kind handover is refused centrally (logged as skipped).
--   * A follow-up task is a row in ai_tasks: created by staff, or by the system (ai_open_human_task) only for
--     cases that need a person to act: a hand-over the buyer or the deal requires (asked for a person, ready to buy,
--     negotiation, legal, complaint, financing, sensitive), an automatic follow-up or appointment message that
--     could not be sent, or a reply that could not be delivered. One open system task per buyer and cause; each is
--     announced once when created (and never again: same key as the 5-minute reminder run).
--   * A person replying to the buyer completes that buyer's open system tasks; staff tasks are left alone.
--   * No more "waiting for your reply" reminders: those jobs are no longer created, scheduled ones are cancelled.

alter table public.ai_tasks add column if not exists source_key text;
create unique index if not exists ai_tasks_source_key on public.ai_tasks (source_key) where source_key is not null;

create or replace function public.ai_telegram_category(p_kind text) returns text
language sql immutable set search_path = public as $$
  select case
    when p_kind in ('website_lead','new_whatsapp_client') then 'new_website_lead'
    -- follow_up_due: a scheduled follow-up step to send by hand while automatic sending is off (ai_run_reminders)
    when p_kind in ('task_reminder','follow_up_due','ai_cap','daily_digest') then 'human_followup_reminder'
    when p_kind in ('appointment_change','appointment_reminder') then 'appointment_notification'
    when p_kind = 'test' then 'test'
    else null end
$$;

-- Announces one follow-up task now (same dedupe key as the reminder run, so it is never sent twice).
create function public.ai_task_alert(p_task uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare t record; conv uuid;
begin
  if coalesce((select (notifications ->> 'task_reminders')::boolean from public.ai_settings where id = 1), true) is not true then return false; end if;
  select k.*, l.lead_code, l.contact_id, c.full_name, c.phone_e164, c.wa_id into t
    from public.ai_tasks k left join public.ai_leads l on l.id = k.lead_id left join public.ai_contacts c on c.id = l.contact_id
   where k.id = p_task and k.status = 'open' and k.due_at is not null;
  if t.id is null then return false; end if;
  select v.id into conv from public.ai_conversations v where v.contact_id = t.contact_id and v.channel = 'whatsapp' and v.status = 'open' limit 1;
  return public.ai_send_telegram('task_reminder', t.id::text, 'task:' || t.id || ':' || extract(epoch from t.due_at)::bigint,
    '🔔 Follow-up task' || chr(10)
    || '📝 ' || t.title || chr(10)
    || coalesce('👤 ' || coalesce(nullif(t.full_name, ''), '(no name)') || coalesce(' · ' || t.lead_code, '') || chr(10), '')
    || coalesce(left(t.details, 500) || chr(10), '')
    || coalesce('🧑‍💼 ' || t.assignee_email || chr(10), '')
    || coalesce('📞 https://wa.me/' || coalesce(t.wa_id, t.phone_e164) || chr(10), '')
    || case when conv is not null then 'https://onestopcentreproperty.com/sales/#/inbox?c=' || conv
            else 'https://onestopcentreproperty.com/sales/#/lead/' || t.lead_id end);
end $$;

-- A follow-up task the system opens because a person has to act. p_key = '<cause>:<unique part>'; while a task of
-- the same cause is open for this buyer, no second one is opened. Returns the new task id, or null.
create function public.ai_open_human_task(p_lead uuid, p_title text, p_details text, p_key text) returns uuid
language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if p_lead is null or coalesce(p_key, '') = '' then return null; end if;
  if exists (select 1 from public.ai_tasks where lead_id = p_lead and status = 'open' and source_key is not null
              and split_part(source_key, ':', 1) = split_part(p_key, ':', 1)) then return null; end if;
  insert into public.ai_tasks (lead_id, title, details, due_at, assignee_email, source_key, created_by)
  values (p_lead, left(coalesce(nullif(trim(p_title), ''), 'Follow up with the buyer'), 200), nullif(left(p_details, 2000), ''), now(),
          (select owner_email from public.ai_leads where id = p_lead), p_key, 'system')
  on conflict (source_key) where source_key is not null do nothing
  returning id into t;
  if t is not null then perform public.ai_task_alert(t); end if;
  return t;
end $$;

-- AI hand-over: a follow-up task only when a person must act; otherwise it waits in the hand-over queue (no Telegram)
create or replace function public.ai_handover_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce((select (notifications ->> 'handover_alerts')::boolean from public.ai_settings where id = 1), true) is not true then return new; end if;
  if new.reason not in ('customer_request','ready_to_buy','negotiation','legal','complaint','financing','sensitive') then return new; end if;
  perform public.ai_open_human_task(new.lead_id,
    'Buyer needs a person: ' || replace(new.reason, '_', ' '),
    concat_ws(chr(10), left(new.summary ->> 'text', 600), 'Next: ' || (new.summary ->> 'next_action')),
    'handover:' || new.id);
  return new;
exception when others then return new;  -- an alert problem must never block the handover itself
end $$;

-- a person replied: open handovers are taken and the buyer's open system follow-up tasks are done
create or replace function public.ai_message_accept_handovers() returns trigger
language plpgsql security definer set search_path = public as $$
declare lid uuid;
begin
  if new.direction = 'outbound' and new.sender_type = 'human' then
    lid := (select lead_id from public.ai_conversations where id = new.conversation_id);
    update public.ai_handover_events h set status = 'accepted', accepted_at = now(),
           accepted_by = coalesce(new.sender_email, case when new.provider = 'whatsapp_app' then 'WhatsApp app' end)
     where h.status = 'open' and h.lead_id = lid;
    update public.ai_tasks set status = 'done' where lead_id = lid and status = 'open' and source_key is not null;
  end if;
  return new;
exception when others then return new;
end $$;

-- no more "waiting for your reply" reminders
create or replace function public.ai_message_automation() returns trigger
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

update public.ai_automation_jobs set status = 'cancelled', reason = 'buyers waiting for a reply are no longer sent to Telegram'
 where kind = 'human_reminder' and status = 'scheduled';

revoke all on function public.ai_task_alert(uuid) from public, anon, authenticated;
revoke all on function public.ai_open_human_task(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.ai_open_human_task(uuid, text, text, text) to service_role;
