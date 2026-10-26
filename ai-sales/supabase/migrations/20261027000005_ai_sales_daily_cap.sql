-- AI Sales module — daily cap on AI replies (cost protection).
-- The counter is per Malaysian calendar day and is reserved atomically before every AI call; the cap is read
-- from ai_settings inside the database, so it cannot be bypassed from the browser. ADDITIVE: only ai_* objects.

create table public.ai_usage_daily (
  day          date primary key,
  ai_messages  int not null default 0,    -- buyer messages answered by the AI model
  capped       int not null default 0,    -- buyer messages turned away because the cap was reached
  updated_at   timestamptz not null default now()
);
alter table public.ai_usage_daily enable row level security;
revoke all on public.ai_usage_daily from anon;
create policy "ai read" on public.ai_usage_daily for select to authenticated using (public.ai_has_role('viewer'));

-- default cap for existing installs (keeps any value an owner already set)
update public.ai_settings set ai = ai || '{"daily_message_cap": 200}'::jsonb where id = 1 and not (ai ? 'daily_message_cap');
alter table public.ai_settings alter column ai set default '{"provider":"anthropic","model":"","effort":"low","confidence_threshold":0.7,"max_reply_chars":700,"daily_message_cap":200}'::jsonb;

-- allow the new Telegram alert kind
alter table public.ai_notifications drop constraint ai_notifications_kind_check;
alter table public.ai_notifications add constraint ai_notifications_kind_check
  check (kind in ('appointment_change','appointment_reminder','task_reminder','follow_up_due','daily_digest','test','ai_cap'));

-- Reserves one AI reply for today. Returns {allowed, used, cap}. Sends one Telegram alert the first time the cap is hit each day.
create function public.ai_reserve_ai_call()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cap int := greatest(0, coalesce((select (ai ->> 'daily_message_cap')::int from public.ai_settings where id = 1), 200));
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  used int;
begin
  if auth.role() <> 'service_role' and not public.ai_has_role('advisor') then raise exception 'not allowed'; end if;
  insert into public.ai_usage_daily (day) values (d) on conflict (day) do nothing;
  update public.ai_usage_daily set ai_messages = ai_messages + 1, updated_at = now()
   where day = d and ai_messages < cap
  returning ai_messages into used;
  if used is not null then
    return jsonb_build_object('allowed', true, 'used', used, 'cap', cap);
  end if;
  update public.ai_usage_daily set capped = capped + 1, updated_at = now() where day = d;
  perform public.ai_send_telegram('ai_cap', d::text, 'ai-cap:' || d,
    '⚠️ AI daily limit reached (' || cap || ' replies today).' || chr(10) ||
    'Until midnight, buyers get a holding reply and are handed to your advisors.' || chr(10) ||
    'Change the limit in /sales/ → Settings → AI model & limits.' || chr(10) ||
    'https://onestopcentreproperty.com/sales/#/handover');
  return jsonb_build_object('allowed', false, 'used', (select ai_messages from public.ai_usage_daily where day = d), 'cap', cap);
end $$;
revoke all on function public.ai_reserve_ai_call() from public, anon;
grant execute on function public.ai_reserve_ai_call() to authenticated, service_role;
