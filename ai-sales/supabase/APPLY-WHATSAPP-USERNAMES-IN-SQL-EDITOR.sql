-- AI Sales migration 18 (30 Oct 2026): WhatsApp buyers with a username and a hidden phone number.
-- Their messages carry a business-scoped user id (e.g. 'MY.1349…') instead of a phone number. ai_wa_inbound and
-- ai_wa_echo passed the id to ai_upsert_contact as the phone as well; now only a phone-number id (8–15 digits) is
-- also stored as the phone. Everything else in both functions is unchanged. Idempotent (create or replace).

CREATE OR REPLACE FUNCTION public.ai_wa_inbound(p_wa_id text, p_name text, p_wamid text, p_type text, p_body text, p_sent_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cid uuid; lid uuid; conv uuid; mid uuid; jid uuid; c public.ai_conversations; l public.ai_leads;
begin
  if auth.role() <> 'service_role' then raise exception 'not allowed'; end if;
  if coalesce(p_wamid, '') = '' or coalesce(p_wa_id, '') = '' then raise exception 'wa_id and message id are required'; end if;

  select m.id, m.conversation_id into mid, conv from public.ai_messages m where m.provider_message_id = p_wamid;
  if mid is not null then
    return jsonb_build_object('duplicate', true, 'message_id', mid, 'conversation_id', conv);
  end if;

  -- a phone-number id doubles as the phone; a WhatsApp username's user id (e.g. 'MY.1349…') is never a phone number
  cid := public.ai_upsert_contact(case when p_wa_id ~ '^\d{8,15}$' then p_wa_id end, p_name, null, p_wa_id);
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
  if mid is null then
    return jsonb_build_object('duplicate', true, 'conversation_id', conv);
  end if;

  update public.ai_conversations
     set last_inbound_at = greatest(coalesce(last_inbound_at, '-infinity'), least(coalesce(p_sent_at, now()), now())),
         unread_count = unread_count + 1, status = 'open'
   where id = conv returning * into c;
  update public.ai_leads set last_contact_at = now() where id = lid returning * into l;

  update public.ai_follow_up_jobs j set status = 'cancelled', reason = 'customer replied'
   where j.lead_id = lid and j.status = 'scheduled'
     and coalesce((select 'customer_reply' = any(s.stop_on) from public.ai_follow_up_sequences s where s.id = j.sequence_id), true);

  insert into public.ai_jobs (kind, payload, dedupe_key)
  values ('wa_reply', jsonb_build_object('conversation_id', conv, 'message_id', mid), 'wa_reply:' || p_wamid)
  on conflict (dedupe_key) do nothing
  returning id into jid;

  return jsonb_build_object('duplicate', false, 'contact_id', cid, 'lead_id', lid, 'conversation_id', conv, 'message_id', mid,
                            'job_id', jid, 'mode', c.mode, 'ai_paused', l.ai_paused);
end $function$;

CREATE OR REPLACE FUNCTION public.ai_wa_echo(p_wa_id text, p_wamid text, p_type text, p_body text, p_sent_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cid uuid; lid uuid; conv uuid; mid uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'not allowed'; end if;
  if coalesce(p_wamid, '') = '' or coalesce(p_wa_id, '') = '' then raise exception 'wa_id and message id are required'; end if;
  if exists (select 1 from public.ai_messages where provider_message_id = p_wamid) then
    return jsonb_build_object('duplicate', true);
  end if;

  -- as in ai_wa_inbound: a username's user id is never stored as a phone number
  cid := public.ai_upsert_contact(case when p_wa_id ~ '^\d{8,15}$' then p_wa_id end, null, null, p_wa_id);
  lid := public.ai_open_lead(cid, 'WhatsApp (direct)');
  insert into public.ai_conversations (contact_id, lead_id, channel)
  values (cid, lid, 'whatsapp')
  on conflict (contact_id, channel) where status = 'open' do update set lead_id = excluded.lead_id
  returning id into conv;

  insert into public.ai_messages (conversation_id, direction, sender_type, body, media, provider, provider_message_id, status, purpose, created_at)
  values (conv, 'outbound', 'human', left(p_body, 4096),
          case when p_type in ('text','button','interactive') then null else jsonb_build_array(jsonb_build_object('type', p_type)) end,
          'whatsapp_app', p_wamid, 'sent', 'reply', least(coalesce(p_sent_at, now()), now()))
  on conflict (provider_message_id) do nothing
  returning id into mid;
  if mid is null then return jsonb_build_object('duplicate', true); end if;

  update public.ai_conversations
     set mode = 'human', unread_count = 0,
         last_outbound_at = greatest(coalesce(last_outbound_at, '-infinity'), least(coalesce(p_sent_at, now()), now()))
   where id = conv;
  update public.ai_leads set ai_paused = true, last_contact_at = now() where id = lid;
  update public.ai_follow_up_jobs set status = 'cancelled', reason = 'a person replied from the WhatsApp app'
   where lead_id = lid and status = 'scheduled';

  return jsonb_build_object('duplicate', false, 'conversation_id', conv, 'lead_id', lid, 'message_id', mid);
end $function$;
