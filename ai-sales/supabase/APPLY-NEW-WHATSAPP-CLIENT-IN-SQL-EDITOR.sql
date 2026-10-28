-- AI Sales module — Telegram alert for a brand-new WhatsApp client (first message only) in ONE transaction.
-- For the live database, which already has migrations 1–10. Paste into Supabase → SQL Editor → New query → Run.
begin;

-- AI Sales module — one Telegram alert when a brand-new client messages the WhatsApp number for the first time.
-- "New" = the contact was created by this very message (not in the CRM before: no website enquiry, no earlier
-- chat) and nobody messaged them first. Their later messages, and anyone already in the CRM, never alert.
-- Part of the "new leads" category (same switch as website leads). ADDITIVE ONLY.

alter table public.ai_notifications drop constraint ai_notifications_kind_check;
alter table public.ai_notifications add constraint ai_notifications_kind_check
  check (kind in ('appointment_change','appointment_reminder','task_reminder','follow_up_due','daily_digest','test','ai_cap','handover',
                  'whatsapp_message','website_lead','new_whatsapp_client'));

create or replace function public.ai_telegram_category(p_kind text) returns text
language sql immutable set search_path = public as $$
  select case
    when p_kind in ('website_lead','new_whatsapp_client') then 'new_website_lead'
    when p_kind in ('handover','follow_up_due','task_reminder','ai_cap','daily_digest') then 'human_followup_reminder'
    when p_kind in ('appointment_change','appointment_reminder') then 'appointment_notification'
    when p_kind = 'test' then 'test'
    else null end
$$;

create function public.ai_new_whatsapp_client_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare c public.ai_contacts; l public.ai_leads; conv uuid := new.conversation_id;
begin
  if new.direction <> 'inbound' or coalesce(new.provider, '') <> 'whatsapp_cloud' then return new; end if;
  select k.* into c from public.ai_contacts k join public.ai_conversations v on v.contact_id = k.id where v.id = conv;
  if c.id is null or c.created_at < now() - interval '10 minutes' then return new; end if;   -- already in the CRM
  -- the first message from this contact, and nobody wrote to them before (e.g. from the phone app)
  if exists (select 1 from public.ai_messages m join public.ai_conversations v on v.id = m.conversation_id
              where v.contact_id = c.id and m.id <> new.id) then return new; end if;
  if exists (select 1 from public.ai_activities a where a.contact_id = c.id and a.kind = 'website_enquiry') then return new; end if;
  select * into l from public.ai_leads where contact_id = c.id and closed_at is null;
  perform public.ai_send_telegram('new_whatsapp_client', c.id::text, 'wa-new-client:' || c.id,
    '🆕 NEW WHATSAPP CLIENT' || chr(10)
    || '👤 ' || coalesce(nullif(trim(c.full_name), ''), '(no name)') || coalesce(' · ' || l.lead_code, '') || chr(10)
    || coalesce('📞 +' || coalesce(c.phone_e164, c.wa_id) || chr(10), '')
    || '💬 "' || left(coalesce(nullif(new.body, ''), '[media]'), 300) || '"' || chr(10)
    || '🕒 ' || public.ai_kl(new.created_at) || chr(10)
    || chr(10) || 'Open chat: https://onestopcentreproperty.com/sales/#/inbox?c=' || conv
    || coalesce(chr(10) || 'WhatsApp: https://wa.me/' || coalesce(c.wa_id, c.phone_e164), ''));
  return new;
exception when others then return new;  -- an alert problem must never block recording a message
end $$;
create trigger ai_messages_new_client_notify after insert on public.ai_messages for each row execute function public.ai_new_whatsapp_client_notify();

revoke all on function public.ai_new_whatsapp_client_notify() from public, anon, authenticated;
revoke all on function public.ai_telegram_category(text) from public, anon;
grant execute on function public.ai_telegram_category(text) to authenticated, service_role;

commit;
