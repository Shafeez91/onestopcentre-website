-- AI Sales module — Phase 4: WhatsApp inbound/status ingestion, follow-up engine support, appointment settings,
-- staff alerts for handovers and unanswered WhatsApp messages.
-- ADDITIVE ONLY: new functions/columns on ai_* objects. Nothing here touches the website's own tables.
-- Every new function is callable by the server (service_role) only, except where noted.

-- ---------------------------------------------------------------------------
-- Settings defaults (keeps anything an owner already set)
-- ---------------------------------------------------------------------------
update public.ai_settings set business = jsonb_build_object('appointments', jsonb_build_object(
    'duration_minutes', 60, 'min_notice_hours', 3, 'days_ahead', 7, 'max_slots_offered', 6, 'location', '')) || business
 where id = 1 and not (business ? 'appointments');
update public.ai_settings set notifications = notifications || '{"handover_alerts": true, "whatsapp_alerts": true}'::jsonb
 where id = 1 and not (notifications ? 'handover_alerts');

alter table public.ai_notifications drop constraint ai_notifications_kind_check;
alter table public.ai_notifications add constraint ai_notifications_kind_check
  check (kind in ('appointment_change','appointment_reminder','task_reminder','follow_up_due','daily_digest','test','ai_cap','handover','whatsapp_message'));

-- Why an outbound message was sent: replies and service follow-ups vs marketing (consent + weekly cap apply).
alter table public.ai_messages add column purpose text check (purpose in ('reply','service','marketing','system'));
-- The worker job that produced an outbound message: unique, so a retried job can never send the same reply twice.
alter table public.ai_messages add column source_job_id uuid unique;
create index ai_messages_outbound_recent on public.ai_messages (conversation_id, created_at desc) where direction = 'outbound';

-- Follow-up jobs get a "processing" state so two workers can never send the same step.
alter table public.ai_follow_up_jobs drop constraint ai_follow_up_jobs_status_check;
alter table public.ai_follow_up_jobs add constraint ai_follow_up_jobs_status_check
  check (status in ('scheduled','processing','sent','skipped','failed','cancelled'));

-- ---------------------------------------------------------------------------
-- WhatsApp inbound message: contact → open lead → open conversation → message → reply job, in one transaction.
-- Redelivered webhooks (same wamid) are recognised and change nothing.
-- ---------------------------------------------------------------------------
create function public.ai_wa_inbound(p_wa_id text, p_name text, p_wamid text, p_type text, p_body text, p_sent_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare cid uuid; lid uuid; conv uuid; mid uuid; jid uuid; c public.ai_conversations; l public.ai_leads;
begin
  if auth.role() <> 'service_role' then raise exception 'not allowed'; end if;
  if coalesce(p_wamid, '') = '' or coalesce(p_wa_id, '') = '' then raise exception 'wa_id and message id are required'; end if;

  select m.id, m.conversation_id into mid, conv from public.ai_messages m where m.provider_message_id = p_wamid;
  if mid is not null then
    return jsonb_build_object('duplicate', true, 'message_id', mid, 'conversation_id', conv);
  end if;

  cid := public.ai_upsert_contact(p_wa_id, p_name, null, p_wa_id);
  lid := public.ai_open_lead(cid, 'WhatsApp (direct)');

  insert into public.ai_conversations (contact_id, lead_id, channel)
  values (cid, lid, 'whatsapp')
  on conflict (contact_id, channel) where status = 'open' do update set lead_id = excluded.lead_id
  returning id into conv;

  insert into public.ai_messages (conversation_id, direction, sender_type, body, media, provider, provider_message_id, status, created_at)
  values (conv, 'inbound', 'customer', left(p_body, 4096),
          case when p_type in ('text','button','interactive') then null else jsonb_build_array(jsonb_build_object('type', p_type)) end,
          'whatsapp_cloud', p_wamid, 'received', least(coalesce(p_sent_at, now()), now()))
  on conflict (provider_message_id) do nothing
  returning id into mid;
  if mid is null then  -- lost a race with a concurrent redelivery
    return jsonb_build_object('duplicate', true, 'conversation_id', conv);
  end if;

  update public.ai_conversations
     set last_inbound_at = greatest(coalesce(last_inbound_at, '-infinity'), least(coalesce(p_sent_at, now()), now())),
         unread_count = unread_count + 1, status = 'open'
   where id = conv returning * into c;
  update public.ai_leads set last_contact_at = now() where id = lid returning * into l;

  -- a reply from the buyer stops pending follow-ups (sequences that stop on customer_reply, which is the default)
  update public.ai_follow_up_jobs j set status = 'cancelled', reason = 'customer replied'
   where j.lead_id = lid and j.status = 'scheduled'
     and coalesce((select 'customer_reply' = any(s.stop_on) from public.ai_follow_up_sequences s where s.id = j.sequence_id), true);

  insert into public.ai_jobs (kind, payload, dedupe_key)
  values ('wa_reply', jsonb_build_object('conversation_id', conv, 'message_id', mid), 'wa_reply:' || p_wamid)
  on conflict (dedupe_key) do nothing
  returning id into jid;

  return jsonb_build_object('duplicate', false, 'contact_id', cid, 'lead_id', lid, 'conversation_id', conv, 'message_id', mid,
                            'job_id', jid, 'mode', c.mode, 'ai_paused', l.ai_paused);
end $$;

-- Delivery status from WhatsApp. Only moves forward (sent → delivered → read); "failed" is always recorded.
create function public.ai_wa_status(p_wamid text, p_status text, p_error text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.role() <> 'service_role' then raise exception 'not allowed'; end if;
  if p_status not in ('sent','delivered','read','failed') then return false; end if;
  update public.ai_messages m
     set status = p_status, status_reason = case when p_status = 'failed' then left(p_error, 500) else m.status_reason end
   where m.provider_message_id = p_wamid and m.direction = 'outbound'
     and (p_status = 'failed'
          or array_position(array['queued','sent','delivered','read'], p_status) > coalesce(array_position(array['queued','sent','delivered','read'], m.status), 0));
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- ---------------------------------------------------------------------------
-- Follow-ups
-- ---------------------------------------------------------------------------
-- Starts (or restarts) the active sequence for a lead type: cancels the lead's other scheduled steps, schedules step 1.
-- Returns the job id, or null when no active sequence exists for that lead type.
create function public.ai_follow_up_start(p_lead uuid, p_lead_type text, p_from timestamptz default now())
returns uuid language plpgsql security definer set search_path = public as $$
declare s public.ai_follow_up_sequences; jid uuid; delay numeric;
begin
  if auth.role() <> 'service_role' and not public.ai_has_role('advisor') then raise exception 'not allowed'; end if;
  select * into s from public.ai_follow_up_sequences where lead_type = p_lead_type and active order by created_at limit 1;
  if s.id is null or jsonb_array_length(s.steps) = 0 then return null; end if;
  if exists (select 1 from public.ai_leads where id = p_lead and (closed_at is not null or ai_paused)) then return null; end if;
  update public.ai_follow_up_jobs set status = 'cancelled', reason = 'replaced by a newer sequence'
   where lead_id = p_lead and status = 'scheduled';
  delay := greatest(1, least(2160, coalesce((s.steps -> 0 ->> 'delay_hours')::numeric, 24)));
  insert into public.ai_follow_up_jobs (lead_id, sequence_id, step_index, run_at, idempotency_key)
  values (p_lead, s.id, 0, p_from + make_interval(secs => delay * 3600),
          'fu:' || p_lead || ':' || s.id || ':0:' || floor(extract(epoch from p_from))::bigint)
  on conflict (idempotency_key) do nothing
  returning id into jid;
  return jid;
end $$;

-- Claims due follow-up steps for a worker. SKIP LOCKED makes concurrent workers safe; stuck steps are retried.
create function public.ai_claim_follow_ups(max_jobs int default 20)
returns setof public.ai_follow_up_jobs language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'not allowed'; end if;
  return query
  update public.ai_follow_up_jobs j set status = 'processing', attempts = j.attempts + 1
   where j.id in (
     select id from public.ai_follow_up_jobs
      where ((status = 'scheduled' and run_at <= now()) or (status = 'processing' and updated_at < now() - interval '10 minutes'))
        and attempts < 5
      order by run_at
      limit least(greatest(max_jobs, 1), 50)
      for update skip locked)
  returning j.*;
end $$;

-- Stops follow-ups once an appointment is confirmed (sequences that stop on appointment_booked).
create function public.ai_appt_stop_follow_ups() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'confirmed' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    update public.ai_follow_up_jobs j set status = 'cancelled', reason = 'appointment booked'
     where j.lead_id = new.lead_id and j.status = 'scheduled'
       and coalesce((select 'appointment_booked' = any(s.stop_on) from public.ai_follow_up_sequences s where s.id = j.sequence_id), true);
  end if;
  return new;
end $$;
create trigger ai_appt_stop_follow_ups after insert or update of status on public.ai_appointments
  for each row execute function public.ai_appt_stop_follow_ups();

-- ---------------------------------------------------------------------------
-- Staff alert when a buyer needs a person (from the AI, a STOP/"talk to a human" message or a staff flag)
-- ---------------------------------------------------------------------------
create function public.ai_handover_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare cfg jsonb := (select notifications from public.ai_settings where id = 1); who text; code text;
begin
  if coalesce((cfg ->> 'handover_alerts')::boolean, true) is not true then return new; end if;
  select coalesce(nullif(c.full_name, ''), '(no name)'), l.lead_code into who, code
    from public.ai_leads l join public.ai_contacts c on c.id = l.contact_id where l.id = new.lead_id;
  perform public.ai_send_telegram('handover', new.id::text, 'handover:' || new.id,
    '🙋 Buyer needs a person — ' || replace(new.reason, '_', ' ') || chr(10)
    || '👤 ' || coalesce(who, '(unknown)') || coalesce(' · ' || code, '') || chr(10)
    || coalesce(left(new.summary ->> 'text', 600) || chr(10), '')
    || coalesce('Next: ' || (new.summary ->> 'next_action') || chr(10), '')
    || 'https://onestopcentreproperty.com/sales/#/handover');
  return new;
exception when others then return new;  -- an alert problem must never block the handover itself
end $$;
create trigger ai_handover_notify after insert on public.ai_handover_events
  for each row execute function public.ai_handover_notify();

-- ---------------------------------------------------------------------------
-- Google service-account key from Supabase Vault (alternative to the GOOGLE_PRIVATE_KEY Netlify variable,
-- which counts towards Netlify's 4 KB limit on function variables). Server only; Google secrets only.
-- ---------------------------------------------------------------------------
create function public.ai_vault_secret(p_name text) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'not allowed'; end if;
  if p_name not in ('google_private_key') then raise exception 'not an AI Sales secret'; end if;
  return (select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1);
end $$;
revoke all on function public.ai_vault_secret(text) from public, anon, authenticated;
grant execute on function public.ai_vault_secret(text) to service_role;

-- ---------------------------------------------------------------------------
-- Permissions: server only (the dashboard reaches these through Netlify Functions)
-- ---------------------------------------------------------------------------
revoke all on function public.ai_wa_inbound(text, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.ai_wa_status(text, text, text) from public, anon, authenticated;
revoke all on function public.ai_claim_follow_ups(int) from public, anon, authenticated;
revoke all on function public.ai_follow_up_start(uuid, text, timestamptz) from public, anon;
grant execute on function public.ai_follow_up_start(uuid, text, timestamptz) to authenticated;
revoke all on function public.ai_appt_stop_follow_ups() from public, anon, authenticated;
revoke all on function public.ai_handover_notify() from public, anon, authenticated;
grant execute on function public.ai_wa_inbound(text, text, text, text, text, timestamptz), public.ai_wa_status(text, text, text),
  public.ai_claim_follow_ups(int), public.ai_follow_up_start(uuid, text, timestamptz) to service_role;
