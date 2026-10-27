-- AI Sales module — Telegram alert rules (website leads, follow-up reminders, appointments only) in ONE transaction.
-- For the live database, which already has migrations 1–9. Paste into Supabase → SQL Editor → New query → Run.
-- Replaces the website's enquiry alert trigger (leads_notify) with one that files the enquiry in the CRM first; see the file for rollback.
begin;

-- AI Sales module — Telegram is a focused business-alert channel with exactly three categories:
--   new_website_lead          a genuinely new lead from the website enquiry form
--   human_followup_reminder   a buyer needs a person (handover, follow-up task or step due, waiting for a reply,
--                             message not delivered, daily AI limit, daily digest)
--   appointment_notification  appointment booked / confirmed / rescheduled / cancelled, and reminders
-- Every Telegram message goes through public.ai_send_telegram(), which now refuses any other kind (e.g. the old
-- per-WhatsApp-message alerts), so no legacy trigger, worker or retry can bypass the rules.
--
-- Website enquiries: the website's own trigger (leads_notify → notify_new_lead) is replaced by one that first files
-- the enquiry in the CRM (so the alert links to the lead) and alerts only when the CRM opens a NEW lead.
-- notify_new_lead() itself is kept unchanged for rollback: `create trigger leads_notify after insert on public.leads
-- for each row execute function notify_new_lead();` restores the old behaviour.

alter table public.ai_notifications drop constraint ai_notifications_kind_check;
alter table public.ai_notifications add constraint ai_notifications_kind_check
  check (kind in ('appointment_change','appointment_reminder','task_reminder','follow_up_due','daily_digest','test','ai_cap','handover','whatsapp_message','website_lead'));

update public.ai_settings set notifications = (notifications - 'whatsapp_alerts')
  || jsonb_build_object('categories', coalesce(notifications -> 'categories',
       '{"new_website_lead": true, "human_followup_reminder": true, "appointment_notification": true}'::jsonb))
 where id = 1;

-- which category a notification kind belongs to (null = not allowed on Telegram)
create function public.ai_telegram_category(p_kind text) returns text
language sql immutable set search_path = public as $$
  select case
    when p_kind = 'website_lead' then 'new_website_lead'
    when p_kind in ('handover','follow_up_due','task_reminder','ai_cap','daily_digest') then 'human_followup_reminder'
    when p_kind in ('appointment_change','appointment_reminder') then 'appointment_notification'
    when p_kind = 'test' then 'test'
    else null end
$$;

-- The one Telegram sender. Same signature and behaviour as before, plus the category rules.
create or replace function public.ai_send_telegram(p_kind text, p_ref text, p_key text, p_text text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare
  cfg jsonb := (select notifications from public.ai_settings where id = 1);
  cat text := public.ai_telegram_category(p_kind);
  tok text;
  nid uuid;
  rid bigint;
begin
  if cat is null or (cat <> 'test' and coalesce((cfg -> 'categories' ->> cat)::boolean, true) is not true) then
    -- recorded (once per key) so the log shows what was held back and why; never sent
    begin
      insert into public.ai_notifications (kind, ref_id, dedupe_key, message, status, error)
      values (p_kind, p_ref, 'blocked:' || p_key, left(p_text, 4000), 'skipped',
              case when cat is null then 'blocked: not one of the Telegram categories (website leads, follow-up reminders, appointments)'
                   else 'blocked: the "' || cat || '" category is switched off' end)
      on conflict (dedupe_key) do nothing;
    exception when others then null;
    end;
    return false;
  end if;
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

-- ---------------------------------------------------------------------------
-- Handovers: one alert per outstanding handover, not one per message
-- ---------------------------------------------------------------------------
create or replace function public.ai_handover_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare cfg jsonb := (select notifications from public.ai_settings where id = 1); who text; code text; proj text; conv uuid;
begin
  if coalesce((cfg ->> 'handover_alerts')::boolean, true) is not true then return new; end if;
  -- already announced and still waiting for a person: this buyer is on your list, no repeat alert
  if exists (select 1 from public.ai_handover_events h
              where h.lead_id = new.lead_id and h.id <> new.id and h.status = 'open' and h.created_at > now() - interval '24 hours') then
    return new;
  end if;
  select coalesce(nullif(c.full_name, ''), '(no name)'), l.lead_code, (select p.data ->> 'n' from public.projects p where p.id = l.primary_project_id)
    into who, code, proj
    from public.ai_leads l join public.ai_contacts c on c.id = l.contact_id where l.id = new.lead_id;
  conv := coalesce(new.conversation_id, (select v.id from public.ai_conversations v join public.ai_leads l on l.contact_id = v.contact_id
                                          where l.id = new.lead_id and v.status = 'open' limit 1));
  perform public.ai_send_telegram('handover', new.id::text, 'handover:' || new.id,
    '🔔 Follow-up needed — ' || replace(new.reason, '_', ' ') || chr(10)
    || '👤 ' || coalesce(who, '(unknown)') || coalesce(' · ' || code, '') || chr(10)
    || coalesce('🏠 ' || proj || chr(10), '')
    || coalesce(left(new.summary ->> 'text', 600) || chr(10), '')
    || coalesce('Next: ' || (new.summary ->> 'next_action') || chr(10), '')
    || case when conv is not null then 'https://onestopcentreproperty.com/sales/#/inbox?c=' || conv
            else 'https://onestopcentreproperty.com/sales/#/lead/' || new.lead_id end);
  return new;
exception when others then return new;  -- an alert problem must never block the handover itself
end $$;

-- a person replied: open handovers for that buyer are taken (the next one alerts again)
create function public.ai_message_accept_handovers() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.direction = 'outbound' and new.sender_type = 'human' then
    update public.ai_handover_events h set status = 'accepted', accepted_at = now(),
           accepted_by = coalesce(new.sender_email, case when new.provider = 'whatsapp_app' then 'WhatsApp app' end)
     where h.status = 'open'
       and h.lead_id = (select lead_id from public.ai_conversations where id = new.conversation_id);
  end if;
  return new;
exception when others then return new;
end $$;
create trigger ai_messages_accept_handovers after insert on public.ai_messages for each row execute function public.ai_message_accept_handovers();

-- ---------------------------------------------------------------------------
-- Appointment alerts and reminders: include the showroom map link
-- ---------------------------------------------------------------------------
create or replace function public.ai_appt_text(a public.ai_appointments) returns text
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
    || coalesce('🗺 ' || (select f.showroom_map_url from public.ai_project_facts f
                          where f.project_id = a.project_id and f.showroom_address = a.location and coalesce(f.showroom_map_url, '') <> '') || chr(10), '')
    || coalesce('🧑‍💼 ' || a.advisor_email || chr(10), '')
    || 'https://onestopcentreproperty.com/sales/#/lead/' || a.lead_id
  from public.ai_leads l join public.ai_contacts c on c.id = l.contact_id
  where l.id = a.lead_id
$$;

-- ---------------------------------------------------------------------------
-- Website enquiries: filed in the CRM at once, alert only for a genuinely new lead
-- ---------------------------------------------------------------------------
-- Files one website enquiry in the CRM (same rules as ai_import_website_leads, which skips it afterwards).
-- Returns {lead_id, lead_code, new_lead} or null when it cannot be filed (no phone/email, or import switched off).
create function public.ai_file_website_lead(r public.leads) returns jsonb
language plpgsql security definer set search_path = public as $$
declare claims text := current_setting('request.jwt.claims', true); cid uuid; lid uuid; pid text; existed boolean; code text;
begin
  if coalesce((select (flags ->> 'website_lead_import')::boolean from public.ai_settings where id = 1), false) is not true then return null; end if;
  if exists (select 1 from public.ai_activities a where a.external_ref = 'website_lead:' || r.id) then
    select l.id, l.lead_code into lid, code from public.ai_activities a join public.ai_leads l on l.id = a.lead_id where a.external_ref = 'website_lead:' || r.id;
    return jsonb_build_object('lead_id', lid, 'lead_code', code, 'new_lead', false, 'duplicate', true);
  end if;
  if public.ai_normalize_phone(r.phone) is null and nullif(nullif(trim(r.email), ''), '-') is null then return null; end if;
  -- the CRM helpers run as the server for this one call (the form is submitted anonymously)
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  cid := public.ai_upsert_contact(r.phone, r.name, r.email);
  existed := exists (select 1 from public.ai_leads where contact_id = cid and closed_at is null);
  select p.id into pid from public.projects p where r.project is not null and lower(trim(p.data ->> 'n')) = lower(trim(r.project)) limit 1;
  lid := public.ai_open_lead(cid, 'Website enquiry form', pid);
  insert into public.ai_activities (lead_id, contact_id, kind, body, meta, external_ref, actor, created_at)
  values (lid, cid, 'website_enquiry', r.message, jsonb_build_object('project_text', r.project, 'website_status', r.status), 'website_lead:' || r.id, 'website', r.created_at);
  if r.consent then
    insert into public.ai_consent_records (contact_id, channel, purpose, status, source, evidence, recorded_at)
    values (cid, 'any', 'service', 'granted', 'website_form', 'public.leads ' || r.id, r.created_at);
  end if;
  perform set_config('request.jwt.claims', coalesce(claims, ''), true);
  select lead_code into code from public.ai_leads where id = lid;
  return jsonb_build_object('lead_id', lid, 'lead_code', code, 'new_lead', not existed);
exception when others then
  perform set_config('request.jwt.claims', coalesce(claims, ''), true);
  raise warning 'ai_file_website_lead: %', sqlerrm;
  return null;
end $$;

create function public.ai_website_lead_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare f jsonb; ph text := regexp_replace(coalesce(new.phone, ''), '\D', '', 'g');
begin
  f := public.ai_file_website_lead(new);
  -- an enquiry from someone who already has an open lead updates that lead: no "new lead" alert
  if f is not null and not coalesce((f ->> 'new_lead')::boolean, false) then return new; end if;
  if ph like '0%' then ph := '6' || ph; end if;
  perform public.ai_send_telegram('website_lead', new.id::text, 'web-lead:' || new.id,
    '🆕 NEW WEBSITE LEAD' || chr(10)
    || '👤 ' || coalesce(nullif(trim(new.name), ''), '(no name)') || coalesce(' · ' || (f ->> 'lead_code'), '') || chr(10)
    || case when coalesce(new.phone, '') <> '' then '📞 ' || new.phone || chr(10) else '' end
    || case when coalesce(new.email, '') <> '' then '✉️ ' || new.email || chr(10) else '' end
    || '🏠 ' || coalesce(nullif(trim(new.project), ''), 'General enquiry') || chr(10)
    || case when coalesce(new.message, '') <> '' then '💬 ' || left(new.message, 400) || chr(10) else '' end
    || '🔎 Source: Website enquiry form' || chr(10)
    || '🕒 ' || public.ai_kl(coalesce(new.created_at, now())) || chr(10)
    || case when f ? 'lead_id' then chr(10) || 'Open lead: https://onestopcentreproperty.com/sales/#/lead/' || (f ->> 'lead_id')
            else chr(10) || 'Dashboard: https://onestopcentreproperty.com/admin' end
    || case when ph <> '' then chr(10) || 'WhatsApp: https://wa.me/' || ph else '' end);
  return new;
exception when others then
  return new;  -- an alert or CRM problem must never block a website enquiry
end $$;

drop trigger if exists leads_notify on public.leads;
create trigger ai_leads_website_notify after insert on public.leads for each row execute function public.ai_website_lead_notify();

revoke all on function public.ai_telegram_category(text) from public, anon;
revoke all on function public.ai_send_telegram(text,text,text,text) from public, anon, authenticated;
revoke all on function public.ai_message_accept_handovers() from public, anon, authenticated;
revoke all on function public.ai_file_website_lead(public.leads) from public, anon, authenticated;
revoke all on function public.ai_website_lead_notify() from public, anon, authenticated;
revoke all on function public.ai_appt_text(public.ai_appointments) from public, anon, authenticated;
grant execute on function public.ai_telegram_category(text) to authenticated, service_role;

commit;
