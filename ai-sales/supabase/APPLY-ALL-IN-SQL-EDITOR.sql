-- AI Sales module — all migrations in ONE transaction (all-or-nothing). For a NEW installation only;
-- a database that already has migrations 1–5 uses APPLY-PHASE-4-IN-SQL-EDITOR.sql instead.
-- Paste into Supabase Dashboard → SQL Editor → New query → Run.
-- Additive only: creates ai_* objects, the private ai-docs bucket, enables pg_cron and schedules Telegram reminders.
-- Existing tables (projects, settings, leads, admins), the photos bucket and existing functions are not touched.
begin;

-- ===== 20261026000001_ai_sales_foundation.sql =====
-- AI Sales module — Phase 2 foundation
-- ADDITIVE ONLY. This migration does not alter, drop or add triggers to any existing object
-- (projects, settings, leads, admins, photos bucket, is_admin, leads_guard, notify_new_lead, touch_updated).
-- Every new object is prefixed ai_ and has row-level security enabled.
-- There are deliberately NO foreign keys to public.projects or public.leads: the existing CMS deletes
-- project rows on save, and a foreign key would make that delete fail.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
create table public.ai_team_members (
  email        text primary key check (email = lower(email) and position('@' in email) > 1),
  display_name text,
  role         text not null check (role in ('owner','manager','advisor','viewer')),
  phone        text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Everyone in the existing public.admins list is an owner of the AI module (read-only use of that table).
-- Other staff need a confirmed Supabase Auth account whose email is listed in ai_team_members.
create function public.ai_role() returns text
language sql stable security definer set search_path = public, auth as $$
  select case
    when exists (select 1 from public.admins a where lower(a.email) = lower(auth.jwt() ->> 'email')) then 'owner'
    else (select m.role from public.ai_team_members m
           join auth.users u on lower(u.email) = m.email and u.email_confirmed_at is not null
          where m.email = lower(auth.jwt() ->> 'email') and m.active
            and u.id = auth.uid())
  end
$$;

create function public.ai_has_role(min_role text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (array_position(array['viewer','advisor','manager','owner'], public.ai_role())
      >= array_position(array['viewer','advisor','manager','owner'], min_role)), false)
$$;

revoke all on function public.ai_role() from public, anon;
revoke all on function public.ai_has_role(text) from public, anon;
grant execute on function public.ai_role() to authenticated;
grant execute on function public.ai_has_role(text) to authenticated;

create function public.ai_actor() returns text
language sql stable as $$
  select coalesce(lower(auth.jwt() ->> 'email'), 'system')
$$;

create function public.ai_touch_updated() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

-- ---------------------------------------------------------------------------
-- Settings (singleton) and configuration
-- ---------------------------------------------------------------------------
create table public.ai_settings (
  id          int primary key default 1 check (id = 1),
  flags       jsonb not null default '{
    "module_enabled": true,
    "website_lead_import": true,
    "ai_auto_reply": false,
    "whatsapp_outbound": false,
    "follow_ups": false,
    "calendar_booking": false
  }'::jsonb,
  persona     jsonb not null default '{
    "name": "OSC Property Assistant",
    "discloses_ai": true,
    "languages": ["ms","en"],
    "allow_manglish": true,
    "tone": "Professional, friendly, patient, concise for WhatsApp. Never pushy.",
    "greeting_en": "Hi! I am the One Stop Centre AI property assistant. I can help with project details, prices and appointments. A human advisor is available any time.",
    "greeting_ms": "Hai! Saya pembantu hartanah AI One Stop Centre. Saya boleh bantu maklumat projek, harga dan temujanji. Penasihat manusia sentiasa boleh membantu."
  }'::jsonb,
  business    jsonb not null default '{
    "timezone": "Asia/Kuala_Lumpur",
    "hours": {"mon":["09:00","18:00"],"tue":["09:00","18:00"],"wed":["09:00","18:00"],"thu":["09:00","18:00"],"fri":["09:00","18:00"],"sat":["10:00","17:00"],"sun":null},
    "max_marketing_messages_per_week": 2,
    "inventory_max_age_hours": 72,
    "price_max_age_days": 30
  }'::jsonb,
  scoring     jsonb not null default '{
    "weights": {"readiness":25,"budget":20,"suitability":15,"timeline":15,"engagement":15,"financing":10},
    "thresholds": {"hot":70,"warm":45,"nurture":20}
  }'::jsonb,
  ai          jsonb not null default '{
    "provider": "anthropic",
    "model": "",
    "confidence_threshold": 0.7,
    "max_reply_chars": 700
  }'::jsonb,
  -- Mandatory safeguards are enforced in code and cannot be switched off here; this only stores extra rules.
  compliance  jsonb not null default '{
    "require_marketing_consent": true,
    "pdpa_notice_en": "We use your details only to respond to your property enquiry. Reply STOP at any time to stop messages.",
    "pdpa_notice_ms": "Kami menggunakan maklumat anda hanya untuk menjawab pertanyaan hartanah anda. Balas STOP pada bila-bila masa untuk berhenti menerima mesej."
  }'::jsonb,
  updated_at  timestamptz not null default now()
);
insert into public.ai_settings (id) values (1) on conflict do nothing;

create table public.ai_pipeline_stages (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (char_length(name) between 1 and 60),
  position   int not null,
  is_won     boolean not null default false,
  is_lost    boolean not null default false,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not (is_won and is_lost))
);
insert into public.ai_pipeline_stages (name, position, is_won, is_lost) values
  ('New Lead',1,false,false),('Contacted',2,false,false),('Qualified',3,false,false),
  ('Appointment Pending',4,false,false),('Appointment Confirmed',5,false,false),
  ('Visited Showroom',6,false,false),('Follow-Up',7,false,false),('Booking / Reservation',8,false,false),
  ('SPA Signing',9,false,false),('Won',10,true,false),('Lost',11,false,true);

create table public.ai_lead_sources (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  channel    text not null default 'other' check (channel in ('website','whatsapp','facebook','instagram','google','tiktok','portal','referral','walk_in','event','other')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.ai_lead_sources (name, channel) values
  ('Website enquiry form','website'),('WhatsApp (direct)','whatsapp'),('Facebook Ads','facebook'),
  ('Instagram','instagram'),('Google Ads','google'),('TikTok','tiktok'),('Property portal','portal'),
  ('Referral','referral'),('Walk-in / showroom','walk_in'),('Event / roadshow','event'),('Other','other');

create table public.ai_campaigns (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  source_id   uuid references public.ai_lead_sources(id) on delete set null,
  project_id  text,                       -- public.projects.id (no FK on purpose)
  utm_campaign text,
  tracking_code text unique,              -- e.g. code in a click-to-WhatsApp prefilled message
  starts_on   date,
  ends_on     date,
  budget_myr  numeric(12,2) check (budget_myr >= 0),
  spend_myr   numeric(12,2) check (spend_myr >= 0),   -- actual spend, entered or synced; null = unknown
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- CRM
-- ---------------------------------------------------------------------------
-- Malaysian-aware phone normalisation to digits-only E.164 (no plus): 012-345 6789 -> 60123456789
create function public.ai_normalize_phone(p text) returns text
language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p,''), '\D', '', 'g');
begin
  if d = '' then return null; end if;
  if d like '00%' then d := substr(d, 3); end if;
  if d like '0%' then d := '6' || d;
  elsif d ~ '^1\d{8,9}$' then d := '60' || d;
  end if;
  if char_length(d) < 8 or char_length(d) > 15 then return null; end if;
  return d;
end $$;

create table public.ai_contacts (
  id            uuid primary key default gen_random_uuid(),
  full_name     text check (char_length(full_name) <= 120),
  phone_e164    text unique check (phone_e164 ~ '^\d{8,15}$'),
  wa_id         text unique,
  email         text check (char_length(email) <= 160),
  preferred_language text check (preferred_language in ('ms','en','mixed')),
  salutation    text,                     -- e.g. Encik, Puan, Mr, Ms
  notes         text,
  erased_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index ai_contacts_email_idx on public.ai_contacts (lower(email));

create sequence public.ai_lead_code_seq;
create table public.ai_leads (
  id             uuid primary key default gen_random_uuid(),
  lead_code      text not null unique default ('OSC-' || lpad(nextval('public.ai_lead_code_seq')::text, 6, '0')),
  contact_id     uuid not null references public.ai_contacts(id) on delete restrict,
  stage_id       uuid not null references public.ai_pipeline_stages(id) on delete restrict,
  owner_email    text,
  source_id      uuid references public.ai_lead_sources(id) on delete set null,
  campaign_id    uuid references public.ai_campaigns(id) on delete set null,
  primary_project_id text,                -- public.projects.id (no FK on purpose)
  temperature    text not null default 'nurture' check (temperature in ('hot','warm','nurture','unqualified')),
  score          int check (score between 0 and 100),
  score_rationale jsonb not null default '[]'::jsonb,
  qualification  jsonb not null default '{}'::jsonb,   -- purpose, first_home, bedrooms, budget_min/max, employment, financing, timeline, concerns…
  ai_paused      boolean not null default false,
  handover_status text not null default 'none' check (handover_status in ('none','requested','assigned','resolved')),
  lost_reason    text,
  first_response_at timestamptz,
  last_contact_at   timestamptz,
  closed_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- one open lead per contact prevents duplicates; a returning buyer re-opens or gets a new lead after closing
create unique index ai_leads_one_open_per_contact on public.ai_leads (contact_id) where closed_at is null;
create index ai_leads_stage_idx on public.ai_leads (stage_id) where closed_at is null;
create index ai_leads_owner_idx on public.ai_leads (owner_email);
create index ai_leads_created_idx on public.ai_leads (created_at desc);

create table public.ai_lead_interests (
  lead_id    uuid not null references public.ai_leads(id) on delete cascade,
  project_id text not null,               -- public.projects.id (no FK on purpose)
  interest   text not null default 'interested' check (interest in ('enquired','interested','shortlisted','visited','rejected')),
  note       text,
  created_at timestamptz not null default now(),
  primary key (lead_id, project_id)
);

create table public.ai_activities (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid references public.ai_leads(id) on delete cascade,
  contact_id  uuid references public.ai_contacts(id) on delete cascade,
  kind        text not null check (kind in ('note','call','website_enquiry','stage_change','assignment','qualification','handover','appointment','message_summary','system')),
  body        text,
  meta        jsonb not null default '{}'::jsonb,
  external_ref text unique,               -- idempotency, e.g. 'website_lead:<uuid>'
  actor       text not null default public.ai_actor(),
  created_at  timestamptz not null default now(),
  check (lead_id is not null or contact_id is not null)
);
create index ai_activities_lead_idx on public.ai_activities (lead_id, created_at desc);

create table public.ai_tasks (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid references public.ai_leads(id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 200),
  details     text,
  due_at      timestamptz,
  assignee_email text,
  status      text not null default 'open' check (status in ('open','done','cancelled')),
  created_by  text not null default public.ai_actor(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index ai_tasks_open_idx on public.ai_tasks (assignee_email, due_at) where status = 'open';

-- Consent is append-only: the current state is the latest row per contact/channel/purpose.
create table public.ai_consent_records (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null references public.ai_contacts(id) on delete cascade,
  channel     text not null check (channel in ('whatsapp','email','phone','sms','any')),
  purpose     text not null check (purpose in ('service','marketing')),
  status      text not null check (status in ('granted','withdrawn')),
  source      text not null,              -- website_form, whatsapp_optin, whatsapp_stop, advisor_recorded, import…
  evidence    text,                       -- wording shown / message id / form id
  recorded_by text not null default public.ai_actor(),
  recorded_at timestamptz not null default now()
);
create index ai_consent_lookup on public.ai_consent_records (contact_id, channel, purpose, recorded_at desc);

create view public.ai_consent_current with (security_invoker = true) as
  select distinct on (contact_id, channel, purpose) contact_id, channel, purpose, status, source, recorded_at
  from public.ai_consent_records
  order by contact_id, channel, purpose, recorded_at desc;

create function public.ai_block_change() returns trigger
language plpgsql as $$
begin raise exception '% is append-only', tg_table_name; end $$;
create trigger ai_consent_append_only before update or delete on public.ai_consent_records
  for each row execute function public.ai_block_change();

-- ---------------------------------------------------------------------------
-- Property knowledge (verified extras; public.projects stays the listing source of truth)
-- ---------------------------------------------------------------------------
create table public.ai_project_facts (
  project_id         text primary key,    -- public.projects.id (no FK on purpose)
  title_type         text,                -- strata / individual / master
  booking_fee        text,
  payment_terms      text,
  maintenance_fee_psf numeric(6,3),
  sinking_fund_psf    numeric(6,3),
  parking_allocation  text,
  completion_date     date,
  eligibility         text,               -- e.g. Bumiputera quota, first-time buyer, income cap
  restrictions        text,
  showroom_address    text,
  showroom_hours      text,
  showroom_map_url    text,
  official_url        text,
  extra              jsonb not null default '{}'::jsonb,
  source             text,
  verified_by        text,
  verified_at        timestamptz,
  notes              text,
  updated_at         timestamptz not null default now()
);

create table public.ai_project_units (
  id            uuid primary key default gen_random_uuid(),
  project_id    text not null,
  unit_no       text not null,
  unit_type     text,
  tower         text,
  floor         text,
  size_sqft     numeric(8,1) check (size_sqft > 0),
  bedrooms      text,
  bathrooms     text,
  facing        text,
  status        text not null default 'unknown' check (status in ('available','reserved','booked','sold','unavailable','unknown')),
  list_price    numeric(12,2) check (list_price > 0),
  status_verified_at timestamptz,
  source        text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (project_id, unit_no)
);
create index ai_units_project_idx on public.ai_project_units (project_id, status);

create table public.ai_project_prices (
  id            uuid primary key default gen_random_uuid(),
  project_id    text not null,
  unit_type     text not null,            -- layout name as on the website, e.g. "Type A"
  price_kind    text not null default 'list' check (price_kind in ('list','nett','promo','from')),
  price_myr     numeric(12,2) not null check (price_myr > 0),
  effective_from date not null default current_date,
  effective_to   date,                    -- null = still current
  source        text not null,
  verified_by   text,
  verified_at   timestamptz,
  created_at    timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);
create unique index ai_prices_one_current on public.ai_project_prices (project_id, unit_type, price_kind) where effective_to is null;

-- Adding a new current price closes the previous one, so history is never overwritten.
create function public.ai_close_previous_price() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.effective_to is null then
    update public.ai_project_prices
       set effective_to = greatest(effective_from, new.effective_from - 1)
     where project_id = new.project_id and unit_type = new.unit_type and price_kind = new.price_kind
       and effective_to is null and id <> new.id;
  end if;
  return new;
end $$;
create trigger ai_prices_close_previous before insert on public.ai_project_prices
  for each row execute function public.ai_close_previous_price();

create table public.ai_promotions (
  id           uuid primary key default gen_random_uuid(),
  project_id   text,                      -- null = applies to all projects
  title        text not null,
  details      text not null,
  conditions   text,
  valid_from   date not null,
  valid_to     date,
  source       text not null,             -- e.g. developer circular ref / URL
  approved     boolean not null default false,
  approved_by  text,
  approved_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from)
);
create view public.ai_active_promotions with (security_invoker = true) as
  select * from public.ai_promotions
  where approved and valid_from <= (now() at time zone 'Asia/Kuala_Lumpur')::date
    and (valid_to is null or valid_to >= (now() at time zone 'Asia/Kuala_Lumpur')::date);

create table public.ai_faqs (
  id          uuid primary key default gen_random_uuid(),
  project_id  text,                       -- null = general
  lang        text not null check (lang in ('ms','en')),
  question    text not null,
  answer      text not null,
  approved    boolean not null default false,
  approved_by text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  tsv         tsvector generated always as (to_tsvector('simple', question || ' ' || answer)) stored
);
create index ai_faqs_tsv on public.ai_faqs using gin (tsv);

create table public.ai_documents (
  id           uuid primary key default gen_random_uuid(),
  project_id   text,
  title        text not null,
  kind         text not null default 'other' check (kind in ('brochure','price_list','floor_plan','spreadsheet','promotion','image','video','faq','other')),
  storage_path text unique,               -- object in the private ai-docs bucket
  mime_type    text,
  size_bytes   bigint,
  lang         text check (lang in ('ms','en','mixed')),
  extract_status text not null default 'pending' check (extract_status in ('pending','extracted','failed','not_applicable')),
  extract_error text,
  share_with_customers boolean not null default false,  -- may the AI send this file to buyers?
  uploaded_by  text not null default public.ai_actor(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.ai_knowledge_chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid references public.ai_documents(id) on delete cascade,
  project_id  text,
  lang        text check (lang in ('ms','en','mixed')),
  title       text,
  content     text not null check (char_length(content) between 1 and 8000),
  position    int not null default 0,
  approved    boolean not null default false,  -- only approved chunks may be used by the AI
  approved_by text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  tsv         tsvector generated always as (to_tsvector('simple', coalesce(title,'') || ' ' || content)) stored
);
create index ai_chunks_tsv on public.ai_knowledge_chunks using gin (tsv);
create index ai_chunks_project on public.ai_knowledge_chunks (project_id) where approved;

-- Full-text search over approved knowledge + approved FAQs (BM and EN; 'simple' config keeps Malay words intact)
create function public.ai_search_knowledge(q text, p_project text default null, only_approved boolean default true, max_rows int default 8)
returns table (kind text, id uuid, project_id text, title text, content text, rank real)
language sql stable security invoker set search_path = public as $$
  with query as (select websearch_to_tsquery('simple', q) as tq)
  select * from (
    select 'chunk'::text, c.id, c.project_id, c.title, c.content, ts_rank(c.tsv, query.tq)
      from public.ai_knowledge_chunks c, query
     where c.tsv @@ query.tq and (not only_approved or c.approved)
       and (p_project is null or c.project_id is null or c.project_id = p_project)
    union all
    select 'faq', f.id, f.project_id, f.question, f.answer, (ts_rank(f.tsv, query.tq) * 1.2)::real
      from public.ai_faqs f, query
     where f.tsv @@ query.tq and (not only_approved or f.approved)
       and (p_project is null or f.project_id is null or f.project_id = p_project)
  ) r order by 6 desc limit least(greatest(max_rows, 1), 50)
$$;

-- ---------------------------------------------------------------------------
-- Messaging (logic arrives in Phase 4)
-- ---------------------------------------------------------------------------
create table public.ai_conversations (
  id              uuid primary key default gen_random_uuid(),
  contact_id      uuid not null references public.ai_contacts(id) on delete cascade,
  lead_id         uuid references public.ai_leads(id) on delete set null,
  channel         text not null default 'whatsapp' check (channel in ('whatsapp','web','email','sms')),
  mode            text not null default 'ai' check (mode in ('ai','human','paused')),
  assigned_email  text,
  status          text not null default 'open' check (status in ('open','closed')),
  last_inbound_at  timestamptz,           -- WhatsApp 24-hour customer-service window starts here
  last_outbound_at timestamptz,
  unread_count    int not null default 0,
  summary         text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index ai_conv_one_open on public.ai_conversations (contact_id, channel) where status = 'open';
create index ai_conv_recent on public.ai_conversations (status, last_inbound_at desc);

create table public.ai_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  direction       text not null check (direction in ('inbound','outbound')),
  sender_type     text not null check (sender_type in ('customer','ai','human','system')),
  sender_email    text,
  body            text,
  media           jsonb,                  -- [{type, url|storage_path, mime, caption}]
  template_name   text,
  provider        text,
  provider_message_id text unique,        -- wamid; makes webhook redelivery harmless
  status          text not null default 'received' check (status in ('received','queued','sent','delivered','read','failed','skipped')),
  status_reason   text,
  agent_run_id    uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index ai_messages_conv on public.ai_messages (conversation_id, created_at);

create table public.ai_message_templates (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  lang          text not null check (lang in ('ms','en')),
  category      text not null check (category in ('utility','marketing','authentication','service_reply')),
  body          text not null,
  variables     jsonb not null default '[]'::jsonb,
  wa_template_name text,                  -- name of the Meta-approved template, if any
  wa_status     text not null default 'not_submitted' check (wa_status in ('not_submitted','pending','approved','rejected','paused')),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (name, lang)
);

create table public.ai_objections (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  examples    text[] not null default '{}',
  guidance_en text not null,
  guidance_ms text not null,
  clarifying_question_en text,
  clarifying_question_ms text,
  escalate    boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Automation (logic arrives in Phases 3–4)
-- ---------------------------------------------------------------------------
create table public.ai_follow_up_sequences (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  lead_type   text not null,              -- new_enquiry, price_list, brochure, financing, undecided, appointment_pending, …
  steps       jsonb not null default '[]'::jsonb, -- [{delay_hours, template_id|instruction, purpose:'service'|'marketing'}]
  stop_on     text[] not null default array['customer_reply','opt_out','appointment_booked','human_requested','lead_closed'],
  active      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.ai_follow_up_jobs (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.ai_leads(id) on delete cascade,
  sequence_id   uuid references public.ai_follow_up_sequences(id) on delete set null,
  step_index    int not null default 0,
  run_at        timestamptz not null,
  status        text not null default 'scheduled' check (status in ('scheduled','sent','skipped','failed','cancelled')),
  reason        text,                     -- why skipped/failed/cancelled
  message_id    uuid references public.ai_messages(id) on delete set null,
  idempotency_key text not null unique,
  attempts      int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index ai_fu_due on public.ai_follow_up_jobs (run_at) where status = 'scheduled';

create table public.ai_appointments (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid not null references public.ai_leads(id) on delete cascade,
  project_id      text,
  kind            text not null check (kind in ('showroom_visit','property_viewing','phone_call','video_call','financing_discussion')),
  status          text not null default 'pending_confirmation' check (status in ('pending_confirmation','confirmed','rescheduled','cancelled','completed','no_show')),
  start_at        timestamptz,
  end_at          timestamptz,
  preferred_text  text,                   -- buyer's own words when no calendar slot is confirmed yet
  advisor_email   text,
  location        text,
  calendar_provider text,
  calendar_event_id text,
  idempotency_key text unique,
  reminders       jsonb not null default '[]'::jsonb,
  notes           text,
  created_by      text not null default public.ai_actor(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (end_at is null or start_at is null or end_at > start_at),
  -- "confirmed" requires a real slot; calendar confirmation is enforced by the booking service in Phase 4
  check (status <> 'confirmed' or start_at is not null)
);
create index ai_appt_upcoming on public.ai_appointments (start_at) where status in ('pending_confirmation','confirmed','rescheduled');

create table public.ai_jobs (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,
  payload      jsonb not null default '{}'::jsonb,
  run_at       timestamptz not null default now(),
  status       text not null default 'queued' check (status in ('queued','running','done','failed','dead')),
  attempts     int not null default 0,
  max_attempts int not null default 5,
  locked_at    timestamptz,
  last_error   text,
  dedupe_key   text unique,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index ai_jobs_due on public.ai_jobs (run_at) where status in ('queued','failed');

-- Claims due jobs for a worker (service role only). SKIP LOCKED makes concurrent workers safe.
create function public.ai_claim_jobs(max_jobs int default 10, stale_after interval default '5 minutes')
returns setof public.ai_jobs language sql security invoker set search_path = public as $$
  update public.ai_jobs j set status = 'running', locked_at = now(), attempts = j.attempts + 1, updated_at = now()
   where j.id in (
     select id from public.ai_jobs
      where (status in ('queued','failed') and run_at <= now() and attempts < max_attempts)
         or (status = 'running' and locked_at < now() - stale_after)
      order by run_at
      limit least(greatest(max_jobs,1),50)
      for update skip locked)
  returning j.*
$$;
revoke all on function public.ai_claim_jobs(int, interval) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- AI runs, handover, audit, integrations
-- ---------------------------------------------------------------------------
create table public.ai_agent_runs (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.ai_conversations(id) on delete set null,
  lead_id         uuid references public.ai_leads(id) on delete set null,
  trigger_message_id uuid references public.ai_messages(id) on delete set null,
  agent           text not null,          -- orchestrator, reception, knowledge, qualification, …
  intent          text,
  model           text,
  input           jsonb,
  output          jsonb,
  confidence      numeric(4,3),
  decision        text,                   -- replied, escalated, blocked_by_validator, skipped, failed
  validation      jsonb,
  input_tokens    int,
  output_tokens   int,
  latency_ms      int,
  error           text,
  created_at      timestamptz not null default now()
);
create index ai_runs_conv on public.ai_agent_runs (conversation_id, created_at desc);

create table public.ai_agent_tool_calls (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references public.ai_agent_runs(id) on delete cascade,
  tool            text not null,
  input           jsonb,
  output          jsonb,
  status          text not null check (status in ('ok','error','denied','needs_approval','approved','rejected')),
  approved_by     text,
  created_at      timestamptz not null default now()
);

create table public.ai_handover_events (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid references public.ai_leads(id) on delete cascade,
  conversation_id uuid references public.ai_conversations(id) on delete set null,
  reason          text not null check (reason in ('customer_request','ready_to_buy','negotiation','legal','complaint','financing','conflicting_info','low_confidence','sensitive','other')),
  summary         jsonb not null default '{}'::jsonb,
  status          text not null default 'open' check (status in ('open','accepted','resolved')),
  accepted_by     text,
  accepted_at     timestamptz,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index ai_handover_open on public.ai_handover_events (created_at desc) where status <> 'resolved';

create table public.ai_audit_logs (
  id          bigint generated always as identity primary key,
  actor       text not null,
  action      text not null,             -- insert / update / delete / custom action names
  table_name  text,
  record_id   text,
  changes     jsonb,
  created_at  timestamptz not null default now()
);
create index ai_audit_recent on public.ai_audit_logs (created_at desc);
create index ai_audit_record on public.ai_audit_logs (table_name, record_id);

-- Non-secret integration state only. Tokens and keys live in Netlify environment variables.
create table public.ai_integration_accounts (
  provider       text primary key check (provider in ('whatsapp_cloud','twilio_whatsapp','anthropic','openai','google_calendar','telegram')),
  status         text not null default 'not_configured' check (status in ('not_configured','configured','healthy','degraded','error','disabled')),
  config         jsonb not null default '{}'::jsonb,   -- e.g. phone_number_id, calendar_id (never secrets)
  last_checked_at timestamptz,
  last_error     text,
  updated_at     timestamptz not null default now()
);
insert into public.ai_integration_accounts (provider) values ('whatsapp_cloud'),('anthropic'),('google_calendar') on conflict do nothing;

create table public.ai_webhook_events (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,
  event_key     text not null,            -- provider id (e.g. wamid + status) used to drop redeliveries
  signature_ok  boolean not null,
  payload       jsonb,
  status        text not null default 'received' check (status in ('received','processed','ignored','failed')),
  error         text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  unique (provider, event_key)
);

-- ---------------------------------------------------------------------------
-- Triggers: updated_at, audit trail, stage-change timeline
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['ai_team_members','ai_pipeline_stages','ai_campaigns','ai_contacts','ai_leads','ai_tasks',
    'ai_project_facts','ai_project_units','ai_promotions','ai_faqs','ai_documents','ai_knowledge_chunks',
    'ai_conversations','ai_messages','ai_message_templates','ai_objections','ai_follow_up_sequences',
    'ai_follow_up_jobs','ai_appointments','ai_jobs','ai_integration_accounts','ai_settings']
  loop
    execute format('create trigger %I before update on public.%I for each row execute function public.ai_touch_updated()', t || '_touch', t);
  end loop;
end $$;

create function public.ai_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  rid text;
  diff jsonb;
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
begin
  rid := coalesce(n, o) ->> (case when tg_table_name in ('ai_team_members') then 'email'
                                  when tg_table_name in ('ai_project_facts') then 'project_id'
                                  when tg_table_name in ('ai_integration_accounts') then 'provider'
                                  else 'id' end);
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(k, jsonb_build_object('from', o -> k, 'to', n -> k)) into diff
      from jsonb_object_keys(n) k
     where k not in ('updated_at','tsv') and (o -> k) is distinct from (n -> k);
    if diff is null then return new; end if;
  else
    diff := coalesce(n, o) - 'tsv';
  end if;
  insert into public.ai_audit_logs (actor, action, table_name, record_id, changes)
  values (public.ai_actor(), lower(tg_op), tg_table_name, rid, diff);
  return coalesce(new, old);
end $$;
revoke all on function public.ai_audit() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['ai_settings','ai_team_members','ai_pipeline_stages','ai_lead_sources','ai_campaigns',
    'ai_contacts','ai_leads','ai_tasks','ai_consent_records','ai_project_facts','ai_project_units','ai_project_prices',
    'ai_promotions','ai_faqs','ai_documents','ai_message_templates','ai_objections','ai_follow_up_sequences',
    'ai_appointments','ai_conversations','ai_integration_accounts','ai_handover_events']
  loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.ai_audit()', t || '_audit', t);
  end loop;
end $$;

create function public.ai_lead_timeline() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stage_id is distinct from old.stage_id then
    insert into public.ai_activities (lead_id, contact_id, kind, body, meta)
    select new.id, new.contact_id, 'stage_change',
           (select name from public.ai_pipeline_stages where id = old.stage_id) || ' → ' || s.name,
           jsonb_build_object('from', old.stage_id, 'to', new.stage_id)
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
revoke all on function public.ai_lead_timeline() from public, anon, authenticated;
create trigger ai_leads_timeline before update on public.ai_leads for each row execute function public.ai_lead_timeline();

-- ---------------------------------------------------------------------------
-- CRM functions
-- ---------------------------------------------------------------------------
-- Find-or-create a contact by phone (then WhatsApp id, then email). Never creates duplicates for the same phone.
create function public.ai_upsert_contact(p_phone text, p_name text default null, p_email text default null, p_wa_id text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare ph text := public.ai_normalize_phone(p_phone); cid uuid; em text := nullif(lower(trim(p_email)), '');
begin
  if auth.role() <> 'service_role' and not public.ai_has_role('advisor') then raise exception 'not allowed'; end if;
  if em = '-' then em := null; end if;
  if ph is null and p_wa_id is null and em is null then raise exception 'phone, WhatsApp id or email is required'; end if;
  select id into cid from public.ai_contacts
   where (ph is not null and phone_e164 = ph) or (p_wa_id is not null and wa_id = p_wa_id)
   order by created_at limit 1;
  if cid is null and ph is null and em is not null then
    select id into cid from public.ai_contacts where lower(email) = em and erased_at is null order by created_at limit 1;
  end if;
  if cid is null then
    insert into public.ai_contacts (full_name, phone_e164, wa_id, email)
    values (nullif(trim(p_name), ''), ph, p_wa_id, em)
    on conflict (phone_e164) do update set full_name = coalesce(public.ai_contacts.full_name, excluded.full_name)
    returning id into cid;
  else
    update public.ai_contacts set
      full_name = coalesce(full_name, nullif(trim(p_name), '')),
      email = coalesce(email, em),
      wa_id = coalesce(wa_id, p_wa_id),
      phone_e164 = coalesce(phone_e164, ph)
    where id = cid;
  end if;
  return cid;
end $$;

-- Returns the open lead for a contact, creating one in the first pipeline stage if there is none.
create function public.ai_open_lead(p_contact uuid, p_source text default null, p_project text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare lid uuid; sid uuid;
begin
  if auth.role() <> 'service_role' and not public.ai_has_role('advisor') then raise exception 'not allowed'; end if;
  select id into lid from public.ai_leads where contact_id = p_contact and closed_at is null;
  if lid is not null then
    if p_project is not null then
      insert into public.ai_lead_interests (lead_id, project_id, interest) values (lid, p_project, 'enquired') on conflict do nothing;
    end if;
    return lid;
  end if;
  select id into sid from public.ai_lead_sources where name = p_source;
  insert into public.ai_leads (contact_id, stage_id, source_id, primary_project_id)
  values (p_contact, (select id from public.ai_pipeline_stages where active and not is_won and not is_lost order by position limit 1), sid, p_project)
  on conflict (contact_id) where closed_at is null do update set updated_at = now()
  returning id into lid;
  if p_project is not null then
    insert into public.ai_lead_interests (lead_id, project_id, interest) values (lid, p_project, 'enquired') on conflict do nothing;
  end if;
  return lid;
end $$;

-- Copies website enquiries (public.leads, read-only) into the CRM. Safe to run any number of times.
create function public.ai_import_website_leads(max_rows int default 500)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; cid uuid; lid uuid; pid text; imported int := 0; skipped int := 0;
begin
  if auth.role() <> 'service_role' and not public.ai_has_role('advisor') then raise exception 'not allowed'; end if;
  if coalesce((select (flags ->> 'website_lead_import')::boolean from public.ai_settings where id = 1), false) is not true then
    raise exception 'website lead import is switched off in AI Sales settings';
  end if;
  for r in
    select l.* from public.leads l
     where not exists (select 1 from public.ai_activities a where a.external_ref = 'website_lead:' || l.id)
     order by l.created_at limit least(greatest(max_rows,1), 2000)
  loop
    if public.ai_normalize_phone(r.phone) is null and nullif(nullif(trim(r.email),''),'-') is null then
      skipped := skipped + 1; continue;
    end if;
    cid := public.ai_upsert_contact(r.phone, r.name, r.email);
    -- match the enquiry's project text to an existing listing name, if any (read-only lookup)
    select p.id into pid from public.projects p
     where r.project is not null and lower(p.data ->> 'n') = lower(trim(r.project)) limit 1;
    lid := public.ai_open_lead(cid, 'Website enquiry form', pid);
    insert into public.ai_activities (lead_id, contact_id, kind, body, meta, external_ref, actor, created_at)
    values (lid, cid, 'website_enquiry', r.message,
            jsonb_build_object('project_text', r.project, 'website_status', r.status), 'website_lead:' || r.id, 'website', r.created_at);
    -- the website form requires consent to be contacted about the enquiry (service, not marketing)
    if r.consent then
      insert into public.ai_consent_records (contact_id, channel, purpose, status, source, evidence, recorded_at)
      values (cid, 'any', 'service', 'granted', 'website_form', 'public.leads ' || r.id, r.created_at);
    end if;
    imported := imported + 1;
  end loop;
  return jsonb_build_object('imported', imported, 'skipped_no_contact', skipped);
end $$;

-- PDPA erasure: anonymises a contact and their message content, keeps consent history as proof.
create function public.ai_erase_contact(p_contact uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' and not public.ai_has_role('owner') then raise exception 'only owners can erase contacts'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required'; end if;
  update public.ai_contacts set full_name = '[erased]', phone_e164 = null, wa_id = null, email = null, notes = null, erased_at = now()
   where id = p_contact;
  update public.ai_messages set body = '[erased]', media = null
   where conversation_id in (select id from public.ai_conversations where contact_id = p_contact);
  update public.ai_activities set body = '[erased]' where contact_id = p_contact or lead_id in (select id from public.ai_leads where contact_id = p_contact);
  update public.ai_leads set qualification = '{}'::jsonb where contact_id = p_contact;
  -- the audit trail must not keep the erased personal data either
  update public.ai_audit_logs set changes = jsonb_build_object('erased', true)
   where (table_name = 'ai_contacts' and record_id = p_contact::text)
      or (table_name = 'ai_leads' and record_id in (select id::text from public.ai_leads where contact_id = p_contact));
  insert into public.ai_audit_logs (actor, action, table_name, record_id, changes)
  values (public.ai_actor(), 'erase_contact', 'ai_contacts', p_contact::text, jsonb_build_object('reason', p_reason));
end $$;

-- Retention: run daily by the scheduler (Phase 4) or manually by an owner.
create function public.ai_purge_expired()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a int; b int;
begin
  if auth.role() <> 'service_role' and not public.ai_has_role('owner') then raise exception 'not allowed'; end if;
  delete from public.ai_webhook_events where received_at < now() - interval '90 days' and status <> 'failed';
  get diagnostics a = row_count;
  update public.ai_agent_runs set input = null, output = null where created_at < now() - interval '180 days' and (input is not null or output is not null);
  get diagnostics b = row_count;
  delete from public.ai_jobs where status in ('done','dead') and updated_at < now() - interval '30 days';
  return jsonb_build_object('webhook_events_deleted', a, 'agent_runs_trimmed', b);
end $$;

revoke all on function public.ai_upsert_contact(text,text,text,text) from public, anon;
revoke all on function public.ai_open_lead(uuid,text,text) from public, anon;
revoke all on function public.ai_import_website_leads(int) from public, anon;
revoke all on function public.ai_erase_contact(uuid,text) from public, anon;
revoke all on function public.ai_purge_expired() from public, anon;
revoke all on function public.ai_search_knowledge(text,text,boolean,int) from public, anon;
grant execute on function public.ai_upsert_contact(text,text,text,text) to authenticated, service_role;
grant execute on function public.ai_open_lead(uuid,text,text) to authenticated, service_role;
grant execute on function public.ai_import_website_leads(int) to authenticated, service_role;
grant execute on function public.ai_erase_contact(uuid,text) to authenticated, service_role;
grant execute on function public.ai_purge_expired() to authenticated, service_role;
grant execute on function public.ai_search_knowledge(text,text,boolean,int) to authenticated, service_role;
grant execute on function public.ai_claim_jobs(int, interval) to service_role;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- read_role: minimum role to read. write_role: minimum role to insert/update. del_role: minimum to delete (null = nobody).
do $$
declare r record;
begin
  for r in select * from (values
    ('ai_settings',            'viewer',  null,      null),      -- updates: owner only (policy below)
    ('ai_team_members',        'viewer',  'owner',   'owner'),
    ('ai_pipeline_stages',     'viewer',  'manager', 'manager'),
    ('ai_lead_sources',        'viewer',  'manager', 'manager'),
    ('ai_campaigns',           'viewer',  'manager', 'manager'),
    ('ai_contacts',            'viewer',  'advisor', null),
    ('ai_leads',               'viewer',  'advisor', null),
    ('ai_lead_interests',      'viewer',  'advisor', 'advisor'),
    ('ai_activities',          'viewer',  'advisor', 'manager'),
    ('ai_tasks',               'viewer',  'advisor', 'advisor'),
    ('ai_consent_records',     'viewer',  'advisor', null),
    ('ai_project_facts',       'viewer',  'manager', 'manager'),
    ('ai_project_units',       'viewer',  'manager', 'manager'),
    ('ai_project_prices',      'viewer',  'manager', 'manager'),
    ('ai_promotions',          'viewer',  'manager', 'manager'),
    ('ai_faqs',                'viewer',  'manager', 'manager'),
    ('ai_documents',           'viewer',  'manager', 'manager'),
    ('ai_knowledge_chunks',    'viewer',  'manager', 'manager'),
    ('ai_conversations',       'viewer',  'advisor', null),
    ('ai_messages',            'viewer',  null,      null),      -- written by the server only
    ('ai_message_templates',   'viewer',  'manager', 'manager'),
    ('ai_objections',          'viewer',  'manager', 'manager'),
    ('ai_follow_up_sequences', 'viewer',  'manager', 'manager'),
    ('ai_follow_up_jobs',      'viewer',  null,      null),
    ('ai_appointments',        'viewer',  'advisor', null),
    ('ai_jobs',                'manager', null,      null),
    ('ai_agent_runs',          'manager', null,      null),
    ('ai_agent_tool_calls',    'manager', null,      null),
    ('ai_handover_events',     'viewer',  'advisor', null),
    ('ai_audit_logs',          'manager', null,      null),
    ('ai_integration_accounts','manager', 'owner',   null),
    ('ai_webhook_events',      'manager', null,      null)
  ) as t(tbl, read_role, write_role, del_role)
  loop
    execute format('alter table public.%I enable row level security', r.tbl);
    execute format('revoke all on public.%I from anon', r.tbl);
    execute format('create policy "ai read" on public.%I for select to authenticated using (public.ai_has_role(%L))', r.tbl, r.read_role);
    if r.write_role is not null then
      execute format('create policy "ai insert" on public.%I for insert to authenticated with check (public.ai_has_role(%L))', r.tbl, r.write_role);
      if r.tbl <> 'ai_consent_records' then
        execute format('create policy "ai update" on public.%I for update to authenticated using (public.ai_has_role(%L)) with check (public.ai_has_role(%L))', r.tbl, r.write_role, r.write_role);
      end if;
    end if;
    if r.del_role is not null then
      execute format('create policy "ai delete" on public.%I for delete to authenticated using (public.ai_has_role(%L))', r.tbl, r.del_role);
    end if;
  end loop;
end $$;

create policy "ai update" on public.ai_settings for update to authenticated
  using (public.ai_has_role('owner')) with check (public.ai_has_role('owner'));
revoke all on public.ai_consent_current from anon;
revoke all on public.ai_active_promotions from anon;
revoke all on sequence public.ai_lead_code_seq from anon;

-- Postgres grants EXECUTE to PUBLIC (and Supabase to anon) by default; nothing in this module is for anonymous use.
-- Signed-in staff keep EXECUTE on the non-trigger helpers (RLS policies and column defaults call them);
-- the job-queue claim stays server-only. Trigger functions need no EXECUTE grant to fire.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname, p.prorettype = 'trigger'::regtype as is_trigger
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'ai\_%'
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if not f.is_trigger and f.proname <> 'ai_claim_jobs' then
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Private storage bucket for uploaded knowledge documents (separate from the public "photos" bucket)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('ai-docs', 'ai-docs', false, 52428800)
on conflict (id) do nothing;

create policy "ai-docs read" on storage.objects for select to authenticated
  using (bucket_id = 'ai-docs' and public.ai_has_role('viewer'));
create policy "ai-docs upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'ai-docs' and public.ai_has_role('manager'));
create policy "ai-docs update" on storage.objects for update to authenticated
  using (bucket_id = 'ai-docs' and public.ai_has_role('manager'));
create policy "ai-docs delete" on storage.objects for delete to authenticated
  using (bucket_id = 'ai-docs' and public.ai_has_role('manager'));

-- ===== 20261026000002_ai_sales_seed_content.sql =====
-- AI Sales module — starter content (editable in /sales/ → Templates & objections, Follow-up automation).
-- No customer data, prices or promotions are seeded. Follow-up sequences are seeded INACTIVE as examples.

insert into public.ai_objections (key, examples, guidance_en, guidance_ms, clarifying_question_en, clarifying_question_ms, escalate) values
('price_too_high', array['Harga mahal','Mahal sangat','Too expensive'],
 'Acknowledge the concern. Ask which budget range is comfortable. Compare using verified prices only (price per sqft, layout, tenure, facilities, location). Offer smaller layouts or other projects within budget if they exist. Never invent discounts.',
 'Akui kebimbangan. Tanya julat bajet yang selesa. Bandingkan dengan harga yang disahkan sahaja (harga sekaki persegi, pelan, pegangan, kemudahan, lokasi). Cadangkan pelan lebih kecil atau projek lain dalam bajet jika ada. Jangan reka diskaun.',
 'May I know the budget range you are comfortable with?', 'Boleh saya tahu julat bajet yang tuan/puan selesa?', false),
('installment_too_high', array['Monthly installment terlalu tinggi','Bulanan tinggi sangat'],
 'Explain that the instalment depends on loan amount, rate, tenure and financing type. Offer an estimate with stated assumptions; never present it as a loan offer. Suggest LPPSA vs bank comparison if relevant, or a lower-priced layout.',
 'Terangkan ansuran bergantung pada jumlah pinjaman, kadar, tempoh dan jenis pembiayaan. Beri anggaran dengan andaian yang jelas; jangan nyatakan sebagai tawaran pinjaman. Cadangkan perbandingan LPPSA dan bank jika sesuai, atau pelan lebih rendah harga.',
 'What monthly amount would feel comfortable for you?', 'Berapa anggaran bulanan yang tuan/puan rasa selesa?', false),
('need_to_think', array['Saya nak fikir dulu','Let me think first'],
 'Respect the decision. Offer to send a short summary (layouts, verified price, location) and ask if a specific point is still unclear. Ask permission before any follow-up.',
 'Hormati keputusan. Tawarkan ringkasan pendek (pelan, harga disahkan, lokasi) dan tanya jika ada perkara yang masih kurang jelas. Minta izin sebelum membuat susulan.',
 'Is there anything specific you would like me to clarify?', 'Ada perkara tertentu yang tuan/puan nak saya jelaskan?', false),
('discuss_with_spouse', array['Saya nak bincang dengan isteri','Saya nak bincang dengan suami','Need to ask my wife/husband'],
 'Support it. Offer materials they can share (brochure, floor plan, website link) and offer a joint showroom visit or video call at a time that suits both.',
 'Sokong keputusan itu. Tawarkan bahan untuk dikongsi (brosur, pelan lantai, pautan laman web) dan tawarkan lawatan showroom atau panggilan video bersama pada masa yang sesuai untuk kedua-duanya.',
 'Would a joint showroom visit or video call be helpful?', 'Adakah lawatan showroom atau panggilan video bersama akan membantu?', false),
('loan_worry', array['Takut susah nak dapat loan','Takut loan tak lulus'],
 'Acknowledge. Explain approval depends on income, commitments, credit record and the financier. Offer a preliminary check based on information they choose to share, or a session with a qualified person. Never guarantee approval.',
 'Akui kebimbangan. Terangkan kelulusan bergantung pada pendapatan, komitmen, rekod kredit dan pihak pembiaya. Tawarkan semakan awal berdasarkan maklumat yang mereka pilih untuk kongsi, atau sesi dengan pihak yang layak. Jangan jamin kelulusan.',
 'Would you like a preliminary eligibility check?', 'Tuan/puan nak buat semakan kelayakan awal?', true),
('cashback_doubt', array['Saya tak percaya cashback','Cashback betul ke?'],
 'State that any cashback or rebate is subject to the official written promotion terms. Share only approved, currently valid promotion details with their conditions and source. If none is on record, say confirmation is required.',
 'Nyatakan sebarang cashback atau rebat tertakluk pada syarat promosi rasmi secara bertulis. Kongsi hanya butiran promosi yang diluluskan dan masih sah bersama syarat dan sumbernya. Jika tiada rekod, nyatakan perlu pengesahan.',
 null, null, false),
('location_far', array['Lokasi jauh','Too far'],
 'Ask where they work or commute to. Share verified connectivity (transit, highways, travel considerations) honestly, including trade-offs. Suggest closer projects if available.',
 'Tanya lokasi tempat kerja atau perjalanan harian. Kongsi maklumat ketersambungan yang disahkan (pengangkutan awam, lebuh raya) secara jujur termasuk kekurangannya. Cadangkan projek lebih dekat jika ada.',
 'Where do you usually commute to?', 'Tuan/puan biasanya berulang-alik ke kawasan mana?', false),
('too_many_projects', array['Banyak projek baru dekat kawasan ini'],
 'Agree it is worth comparing. Offer an objective comparison on verified facts (price psf, tenure, maintenance fee, completion, facilities). Do not disparage competitors.',
 'Setuju perbandingan itu wajar. Tawarkan perbandingan objektif berdasarkan fakta disahkan (harga sekaki persegi, pegangan, yuran penyelenggaraan, tarikh siap, kemudahan). Jangan memburukkan pesaing.',
 'Which other projects are you considering?', 'Projek lain mana yang tuan/puan sedang pertimbangkan?', false),
('price_drop_fear', array['Saya takut harga property jatuh','Saya nak tunggu harga turun'],
 'Acknowledge the uncertainty. Explain no one can predict prices and the AI cannot guarantee appreciation. Focus on fit for own-stay needs, affordability and verified facts. Offer to keep them informed only with consent.',
 'Akui ketidakpastian. Terangkan tiada siapa boleh meramal harga dan tiada jaminan kenaikan nilai. Fokus pada kesesuaian untuk didiami, kemampuan dan fakta disahkan. Tawarkan untuk memaklumkan perkembangan dengan izin sahaja.',
 'Are you buying mainly for own stay or investment?', 'Tuan/puan beli untuk didiami atau pelaburan?', false),
('already_own_home', array['Saya dah ada rumah'],
 'Respect it. Ask whether they are considering an upgrade, a home for family, or investment. Mention that financing terms and eligibility may differ for an additional property and confirmation is needed.',
 'Hormati. Tanya sama ada mereka mempertimbangkan naik taraf, rumah untuk keluarga atau pelaburan. Maklumkan syarat pembiayaan dan kelayakan mungkin berbeza untuk hartanah tambahan dan perlu disahkan.',
 'Is this for an upgrade, family, or investment?', 'Ini untuk naik taraf, keluarga atau pelaburan?', false),
('more_discount', array['Boleh bagi discount lagi?','Can discount more?'],
 'Do not negotiate or promise. Share only approved current promotions. Hand over to a human advisor for any special pricing request.',
 'Jangan berunding atau berjanji. Kongsi hanya promosi semasa yang diluluskan. Serahkan kepada penasihat manusia untuk sebarang permintaan harga istimewa.',
 null, null, true),
('rental_demand', array['Saya nak tahu rental demand','Boleh sewa berapa?'],
 'Share only verified, sourced rental information if present in the knowledge base, clearly labelled as indicative. Otherwise say verified data is not available and offer an advisor follow-up. Never state a yield as fact.',
 'Kongsi hanya maklumat sewaan yang disahkan dan bersumber jika ada dalam pangkalan pengetahuan, dilabel sebagai anggaran. Jika tiada, nyatakan data disahkan tidak tersedia dan tawarkan susulan penasihat. Jangan nyatakan pulangan sebagai fakta.',
 null, null, false),
('guaranteed_return', array['Boleh guarantee investment return?'],
 'Say clearly that returns and capital appreciation cannot be guaranteed. Offer verified facts and a conversation with a human advisor.',
 'Nyatakan dengan jelas pulangan dan kenaikan nilai tidak boleh dijamin. Tawarkan fakta disahkan dan perbincangan dengan penasihat manusia.',
 null, null, true),
('late_completion', array['Saya risau projek lambat siap'],
 'Acknowledge. Share the verified expected completion date and developer information on record. Explain buyer protections are in the SPA and legal questions go to a human advisor or lawyer.',
 'Akui kebimbangan. Kongsi jangkaan tarikh siap yang disahkan dan maklumat pemaju yang ada dalam rekod. Terangkan perlindungan pembeli ada dalam SPA dan soalan undang-undang dirujuk kepada penasihat manusia atau peguam.',
 null, null, true)
on conflict (key) do nothing;

insert into public.ai_follow_up_sequences (name, lead_type, steps, active) values
('New enquiry (example)', 'new_enquiry', '[
  {"delay_hours": 24,  "purpose": "service",   "instruction": "If no reply, check in once about their original question."},
  {"delay_hours": 72,  "purpose": "service",   "instruction": "Share one useful verified fact or answer a likely concern."},
  {"delay_hours": 168, "purpose": "service",   "instruction": "Ask whether they would like a consultation or showroom visit."},
  {"delay_hours": 336, "purpose": "marketing", "instruction": "Final relevant follow-up, then pause or move to nurture."}
]'::jsonb, false),
('Appointment pending (example)', 'appointment_pending', '[
  {"delay_hours": 4,  "purpose": "service", "instruction": "Remind them a preferred slot is still pending confirmation and ask for an alternative if needed."},
  {"delay_hours": 24, "purpose": "service", "instruction": "Ask once more, then hand over to an advisor."}
]'::jsonb, false),
('Missed appointment (example)', 'missed_appointment', '[
  {"delay_hours": 2,  "purpose": "service", "instruction": "Politely ask if they would like to reschedule."},
  {"delay_hours": 72, "purpose": "service", "instruction": "Offer a video call alternative."}
]'::jsonb, false),
('Post-viewing (example)', 'post_viewing', '[
  {"delay_hours": 24, "purpose": "service", "instruction": "Thank them and ask if any questions remain after the visit."},
  {"delay_hours": 96, "purpose": "service", "instruction": "Share any requested documents and offer an advisor call."}
]'::jsonb, false)
on conflict (name) do nothing;

-- ===== 20261026000003_ai_sales_telegram_reminders.sql =====
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

-- ===== 20261026000004_ai_sales_pin_search_path.sql =====
-- Hardening (Supabase advisor 0011): pin search_path on the AI Sales helpers that did not set it.
-- They only use built-ins and fully qualified names, so an empty search_path changes nothing else.
alter function public.ai_actor() set search_path = '';
alter function public.ai_normalize_phone(text) set search_path = '';
alter function public.ai_block_change() set search_path = '';
alter function public.ai_kl(timestamptz) set search_path = '';

-- ===== 20261027000005_ai_sales_daily_cap.sql =====
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

-- ===== 20261027000006_ai_sales_whatsapp_followups_calendar.sql =====
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

-- ===== 20261027000007_ai_sales_whatsapp_app_echoes.sql =====
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

commit;
