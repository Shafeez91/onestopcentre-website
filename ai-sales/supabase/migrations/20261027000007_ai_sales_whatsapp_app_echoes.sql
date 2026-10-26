-- AI Sales module — WhatsApp coexistence: the number is used both in the WhatsApp Business app on the phone and
-- through the Cloud API. Meta reports messages sent from the phone app as "message echoes"; each one is stored in the
-- conversation and hands the chat to a person (AI paused, follow-ups cancelled), so the AI never answers a buyer
-- someone is already talking to from the phone. ADDITIVE ONLY. Server only.

create function public.ai_wa_echo(p_wa_id text, p_wamid text, p_type text, p_body text, p_sent_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare cid uuid; lid uuid; conv uuid; mid uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'not allowed'; end if;
  if coalesce(p_wamid, '') = '' or coalesce(p_wa_id, '') = '' then raise exception 'wa_id and message id are required'; end if;
  -- also covers echoes of messages this system sent itself (same message id): nothing changes
  if exists (select 1 from public.ai_messages where provider_message_id = p_wamid) then
    return jsonb_build_object('duplicate', true);
  end if;

  cid := public.ai_upsert_contact(p_wa_id, null, null, p_wa_id);
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
end $$;

revoke all on function public.ai_wa_echo(text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.ai_wa_echo(text, text, text, text, timestamptz) to service_role;
