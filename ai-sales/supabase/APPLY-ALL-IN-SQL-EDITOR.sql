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

-- ===== 20261027000008_ai_sales_financing.sql =====
-- AI Sales module — loan eligibility & affordability engine (preliminary LPPSA / bank estimates).
-- ADDITIVE ONLY: one settings column, two new tables, and the PDPA erase / retention functions extended to cover them.
-- Nothing here touches the website's own tables or existing ai_* rows.
--
-- Income and commitment figures are personal financial data: they live in their own tables, readable by advisors
-- and above only (viewers see the outcome label on the lead, not the figures), are audited, erased with the
-- contact, and deleted after the retention period (compliance.financing_retention_days, default 365).

-- owner-editable assumptions (LPPSA rule set and bank scenarios); empty = the defaults in sales/shared/finance.mjs
alter table public.ai_settings add column if not exists financing jsonb not null default '{}'::jsonb;

-- the figures collected so far for one lead (one row per lead, updated as the buyer answers)
create table public.ai_financing_profiles (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null unique references public.ai_leads(id) on delete cascade,
  route       text check (route in ('lppsa','bank')),
  inputs      jsonb not null default '{}'::jsonb,
  result      jsonb,
  outcome     text check (outcome in ('potentially_affordable','may_be_affordable_with_adjustments','potentially_challenging','insufficient_information')),
  source      text not null default 'ai' check (source in ('ai','advisor')),
  updated_by  text not null default public.ai_actor(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- every completed calculation, kept as a history (what was calculated, from which figures, under which rules)
create table public.ai_financing_assessments (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.ai_leads(id) on delete cascade,
  route         text not null check (route in ('lppsa','bank')),
  inputs        jsonb not null,
  result        jsonb not null,
  outcome       text not null check (outcome in ('potentially_affordable','may_be_affordable_with_adjustments','potentially_challenging','insufficient_information')),
  rules_version text,
  engine_version text,
  source        text not null default 'ai' check (source in ('ai','advisor')),
  created_by    text not null default public.ai_actor(),
  created_at    timestamptz not null default now()
);
create index ai_financing_assessments_lead on public.ai_financing_assessments (lead_id, created_at desc);

create trigger ai_financing_profiles_touch before update on public.ai_financing_profiles for each row execute function public.ai_touch_updated();
create trigger ai_financing_profiles_audit after insert or update or delete on public.ai_financing_profiles for each row execute function public.ai_audit();
create trigger ai_financing_assessments_audit after insert or update or delete on public.ai_financing_assessments for each row execute function public.ai_audit();

alter table public.ai_financing_profiles enable row level security;
alter table public.ai_financing_assessments enable row level security;
revoke all on public.ai_financing_profiles from anon;
revoke all on public.ai_financing_assessments from anon;
create policy "ai read" on public.ai_financing_profiles for select to authenticated using (public.ai_has_role('advisor'));
create policy "ai insert" on public.ai_financing_profiles for insert to authenticated with check (public.ai_has_role('advisor'));
create policy "ai update" on public.ai_financing_profiles for update to authenticated using (public.ai_has_role('advisor')) with check (public.ai_has_role('advisor'));
create policy "ai delete" on public.ai_financing_profiles for delete to authenticated using (public.ai_has_role('manager'));
create policy "ai read" on public.ai_financing_assessments for select to authenticated using (public.ai_has_role('advisor'));
create policy "ai insert" on public.ai_financing_assessments for insert to authenticated with check (public.ai_has_role('advisor'));
create policy "ai delete" on public.ai_financing_assessments for delete to authenticated using (public.ai_has_role('manager'));
-- (no update policy: a recorded calculation is never edited, only superseded by a new one)

update public.ai_settings set compliance = compliance || '{"financing_retention_days": 365}'::jsonb
 where id = 1 and not (compliance ? 'financing_retention_days');

-- PDPA erasure now also deletes the financing figures, and scrubs them from the audit trail
create or replace function public.ai_erase_contact(p_contact uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare fin text[];
begin
  if auth.role() <> 'service_role' and not public.ai_has_role('owner') then raise exception 'only owners can erase contacts'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required'; end if;
  update public.ai_contacts set full_name = '[erased]', phone_e164 = null, wa_id = null, email = null, notes = null, erased_at = now()
   where id = p_contact;
  update public.ai_messages set body = '[erased]', media = null
   where conversation_id in (select id from public.ai_conversations where contact_id = p_contact);
  update public.ai_activities set body = '[erased]' where contact_id = p_contact or lead_id in (select id from public.ai_leads where contact_id = p_contact);
  update public.ai_leads set qualification = '{}'::jsonb where contact_id = p_contact;
  select array_agg(id::text) into fin from (
    select id from public.ai_financing_profiles where lead_id in (select id from public.ai_leads where contact_id = p_contact)
    union all
    select id from public.ai_financing_assessments where lead_id in (select id from public.ai_leads where contact_id = p_contact)) x;
  delete from public.ai_financing_profiles where lead_id in (select id from public.ai_leads where contact_id = p_contact);
  delete from public.ai_financing_assessments where lead_id in (select id from public.ai_leads where contact_id = p_contact);
  -- the audit trail must not keep the erased personal data either
  update public.ai_audit_logs set changes = jsonb_build_object('erased', true)
   where (table_name = 'ai_contacts' and record_id = p_contact::text)
      or (table_name = 'ai_leads' and record_id in (select id::text from public.ai_leads where contact_id = p_contact))
      or (table_name in ('ai_financing_profiles','ai_financing_assessments') and record_id = any(coalesce(fin, '{}')));
  insert into public.ai_audit_logs (actor, action, table_name, record_id, changes)
  values (public.ai_actor(), 'erase_contact', 'ai_contacts', p_contact::text, jsonb_build_object('reason', p_reason));
end $$;

-- retention: financing figures are deleted after compliance.financing_retention_days (default 365) without an update
create or replace function public.ai_purge_expired()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a int; b int; c int; d int; e int; days int; fin text[];
begin
  if auth.role() <> 'service_role' and not public.ai_has_role('owner') then raise exception 'not allowed'; end if;
  delete from public.ai_webhook_events where received_at < now() - interval '90 days' and status <> 'failed';
  get diagnostics a = row_count;
  update public.ai_agent_runs set input = null, output = null where created_at < now() - interval '180 days' and (input is not null or output is not null);
  get diagnostics b = row_count;
  delete from public.ai_jobs where status in ('done','dead') and updated_at < now() - interval '30 days';
  delete from public.ai_notifications where created_at < now() - interval '90 days';
  get diagnostics c = row_count;
  select greatest(30, coalesce((compliance ->> 'financing_retention_days')::int, 365)) into days from public.ai_settings where id = 1;
  days := coalesce(days, 365);
  select array_agg(id::text) into fin from (
    select id from public.ai_financing_profiles where updated_at < now() - make_interval(days => days)
    union all
    select id from public.ai_financing_assessments where created_at < now() - make_interval(days => days)) x;
  delete from public.ai_financing_profiles where updated_at < now() - make_interval(days => days);
  get diagnostics d = row_count;
  delete from public.ai_financing_assessments where created_at < now() - make_interval(days => days);
  get diagnostics e = row_count;
  update public.ai_audit_logs set changes = jsonb_build_object('expired', true)
   where table_name in ('ai_financing_profiles','ai_financing_assessments') and record_id = any(coalesce(fin, '{}'));
  return jsonb_build_object('webhook_events_deleted', a, 'agent_runs_trimmed', b, 'notifications_deleted', c, 'financing_deleted', d + e);
end $$;

revoke all on function public.ai_erase_contact(uuid,text) from public, anon;
revoke all on function public.ai_purge_expired() from public, anon;
grant execute on function public.ai_erase_contact(uuid,text) to authenticated, service_role;
grant execute on function public.ai_purge_expired() to authenticated, service_role;

-- ===== 20261027000009_ai_sales_ownership_automation.sql =====
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

-- ===== 20261027000010_ai_sales_telegram_categories.sql =====
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

-- ===== 20261028000011_ai_sales_new_whatsapp_client_alert.sql =====
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

-- ===== 20261028000012_ai_sales_appointment_archive.sql =====
-- AI Sales module — archive appointments to keep the Appointments list focused. ADDITIVE ONLY.
-- Archiving only hides a row from the list (it can be restored); it never changes the status, so it sends no
-- Telegram alert or WhatsApp message and leaves reminders alone. Nothing is deleted.
alter table public.ai_appointments add column if not exists archived_at timestamptz;
alter table public.ai_appointments add column if not exists archived_by text;

-- ===== 20261028000013_ai_sales_followup_tasks_only.sql =====
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

-- ===== 20261028000014_ai_sales_rmk_pipeline.sql =====
-- AI Sales module — RMK (Residensi Metropolitan Kepong): its own lead pipeline and stage follow-ups. ADDITIVE ONLY.
--
-- Stages: new → to_book → to_portal (RUMAWIP) → to_submit_loan → to_sign (LO, SPA & LA) → all_signed.
-- The buyer moves a lead on by replying the stage keyword (RMK · DONE BOOKED · DONE PORTAL · DONE SUBMIT LOAN ·
-- DONE SIGNED), the AI when the buyer clearly says the same in their own words, or staff on the RMK page.
-- Isolation: only leads in ai_rmk_pipeline get RMK follow-ups (job kind rmk_follow_up); every job re-checks the
-- lead, its stage and its project right before sending. Nothing here changes other projects' leads or follow-ups.
-- Sending is OFF until switched on in Settings → RMK (ai_settings.rmk.enabled).

-- ---------------------------------------------------------------------------- settings
alter table public.ai_settings add column if not exists rmk jsonb not null default '{}'::jsonb;
update public.ai_settings set rmk = jsonb_build_object(
  'enabled', false,
  'project_id', null,                -- the website listing for RMK, once it exists (optional)
  'pause_if_active_hours', 6,        -- no reminder while the buyer has talked to us within this many hours
  'stages', jsonb_build_object(
    'new',            jsonb_build_object('follow_up_hours', 0,  'max_follow_ups', 0, 'template', '',
      'message_ms', '', 'message_en', ''),
    'to_book',        jsonb_build_object('follow_up_hours', 24, 'max_follow_ups', 3, 'template', 'rmk_to_book',
      'message_ms', 'Hai {name} 👋 Ini peringatan untuk tempahan unit RMK (Residensi Metropolitan Kepong). Kalau dah buat booking, balas *DONE BOOKED*. Ada soalan? Balas sahaja mesej ini 😊',
      'message_en', 'Hi {name} 👋 A reminder about booking your RMK (Residensi Metropolitan Kepong) unit. Once you have booked, reply *DONE BOOKED*. Any questions? Just reply to this message 😊'),
    'to_portal',      jsonb_build_object('follow_up_hours', 24, 'max_follow_ups', 3, 'template', 'rmk_to_portal',
      'message_ms', 'Hai {name}, langkah seterusnya untuk RMK ialah mendaftar di portal RUMAWIP. Bila dah selesai, balas *DONE PORTAL*. Perlukan bantuan untuk daftar? Balas mesej ini 😊',
      'message_en', 'Hi {name}, the next step for RMK is to register on the RUMAWIP portal. Once done, reply *DONE PORTAL*. Need help registering? Reply to this message 😊'),
    'to_submit_loan', jsonb_build_object('follow_up_hours', 48, 'max_follow_ups', 3, 'template', 'rmk_to_submit_loan',
      'message_ms', 'Hai {name}, untuk RMK, sila hantar dokumen permohonan pinjaman. Bila dah hantar, balas *DONE SUBMIT LOAN*. Tak pasti dokumen apa diperlukan? Balas mesej ini 😊',
      'message_en', 'Hi {name}, for RMK, please submit your loan application documents. Once submitted, reply *DONE SUBMIT LOAN*. Not sure which documents are needed? Reply to this message 😊'),
    'to_sign',        jsonb_build_object('follow_up_hours', 48, 'max_follow_ups', 3, 'template', 'rmk_to_sign',
      'message_ms', 'Hai {name}, langkah terakhir RMK: tandatangan LO, SPA & LA. Bila semua dah ditandatangani, balas *DONE SIGNED*. Perlukan slot untuk tandatangan? Balas mesej ini 😊',
      'message_en', 'Hi {name}, the last RMK step: signing the LO, SPA & LA. Once everything is signed, reply *DONE SIGNED*. Need a signing slot? Reply to this message 😊')
  )) || rmk
 where id = 1;

create or replace function public.ai_rmk_cfg() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select rmk from public.ai_settings where id = 1), '{}'::jsonb)
$$;

-- ---------------------------------------------------------------------------- pipeline
create table public.ai_rmk_pipeline (
  lead_id          uuid primary key references public.ai_leads(id) on delete cascade,
  stage            text not null default 'new' check (stage in ('new','to_book','to_portal','to_submit_loan','to_sign','all_signed')),
  status           text not null default 'active' check (status in ('active','paused','completed','human')),
  status_reason    text,
  source           text not null default 'other' check (source in ('facebook','instagram','website','whatsapp','other')),
  stage_changed_at timestamptz not null default now(),
  enrolled_at      timestamptz not null default now(),
  enrolled_by      text not null default public.ai_actor(),
  history          jsonb not null default '[]'::jsonb,   -- [{at, from, to, by, via}] / [{at, status, reason, by}]
  updated_at       timestamptz not null default now()
);
create index ai_rmk_stage on public.ai_rmk_pipeline (stage, status);
create trigger ai_rmk_pipeline_touch before update on public.ai_rmk_pipeline for each row execute function public.ai_touch_updated();
alter table public.ai_rmk_pipeline enable row level security;
revoke all on public.ai_rmk_pipeline from anon;
create policy "ai read" on public.ai_rmk_pipeline for select to authenticated using (public.ai_has_role('viewer'));
-- changes go through the functions below (advisors and up), so stage rules and scheduling always apply

-- ---------------------------------------------------------------------------- jobs
alter table public.ai_automation_jobs drop constraint ai_automation_jobs_kind_check;
alter table public.ai_automation_jobs add constraint ai_automation_jobs_kind_check
  check (kind in ('smart_follow_up','human_reminder','appt_confirmation','appt_reminder','rmk_follow_up'));
alter table public.ai_automation_jobs add column if not exists stage text;
alter table public.ai_automation_jobs add column if not exists seq int;
-- at most one RMK reminder waiting per lead, whoever schedules it
create unique index ai_automation_rmk_one on public.ai_automation_jobs (lead_id) where kind = 'rmk_follow_up' and status = 'scheduled';

create or replace function public.ai_rmk_next(p_stage text) returns text
language sql immutable set search_path = public as $$
  select case p_stage when 'new' then 'to_book' when 'to_book' then 'to_portal' when 'to_portal' then 'to_submit_loan'
                      when 'to_submit_loan' then 'to_sign' when 'to_sign' then 'all_signed' end
$$;

-- Cancels the lead's scheduled RMK reminders and, while it is active, schedules the first one of its stage.
create or replace function public.ai_rmk_schedule(p_lead uuid, p_reason text default 'stage changed') returns uuid
language plpgsql security definer set search_path = public as $$
declare p public.ai_rmk_pipeline; st jsonb; hrs numeric; conv uuid; j uuid;
begin
  update public.ai_automation_jobs set status = 'cancelled', reason = p_reason
   where lead_id = p_lead and kind = 'rmk_follow_up' and status = 'scheduled';
  select * into p from public.ai_rmk_pipeline where lead_id = p_lead;
  if p.lead_id is null or p.status <> 'active' or p.stage = 'all_signed' then return null; end if;
  st := public.ai_rmk_cfg() -> 'stages' -> p.stage;
  hrs := coalesce((st ->> 'follow_up_hours')::numeric, 0);
  if hrs <= 0 or coalesce((st ->> 'max_follow_ups')::int, 0) <= 0 then return null; end if;
  select v.id into conv from public.ai_conversations v join public.ai_leads l on l.contact_id = v.contact_id
   where l.id = p_lead and v.channel = 'whatsapp' and v.status = 'open' order by v.updated_at desc limit 1;
  insert into public.ai_automation_jobs (kind, conversation_id, lead_id, stage, seq, run_at, dedupe_key)
  values ('rmk_follow_up', conv, p_lead, p.stage, 1, now() + make_interval(secs => greatest(1, least(720, hrs)) * 3600),
          'rmk:' || p_lead || ':' || p.stage || ':1:' || (extract(epoch from clock_timestamp()) * 1e6)::bigint)
  on conflict (lead_id) where kind = 'rmk_follow_up' and status = 'scheduled' do nothing
  returning id into j;
  return j;
end $$;

-- Puts a lead in the RMK pipeline (stage "new"). Idempotent: a lead already in it is left as it is.
create or replace function public.ai_rmk_enroll(p_lead uuid, p_source text default 'other', p_by text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_lead is null then return false; end if;
  if coalesce(auth.role(), '') = 'authenticated' and not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  insert into public.ai_rmk_pipeline (lead_id, source, enrolled_by, history)
  values (p_lead, case when p_source in ('facebook','instagram','website','whatsapp') then p_source else 'other' end,
          coalesce(p_by, public.ai_actor()), jsonb_build_array(jsonb_build_object('at', now(), 'to', 'new', 'by', coalesce(p_by, public.ai_actor()), 'via', 'enrolled')))
  on conflict (lead_id) do nothing;
  get diagnostics n = row_count;
  if n > 0 then perform public.ai_rmk_schedule(p_lead, 'enrolled'); end if;
  return n > 0;
end $$;

-- Moves a lead one stage on, only from the stage expected (a repeated or out-of-order confirmation changes nothing).
create or replace function public.ai_rmk_advance(p_lead uuid, p_from text, p_by text default null, p_via text default 'keyword') returns boolean
language plpgsql security definer set search_path = public as $$
declare nxt text := public.ai_rmk_next(p_from); n int;
begin
  if nxt is null then return false; end if;
  update public.ai_rmk_pipeline
     set stage = nxt, stage_changed_at = now(),
         status = case when nxt = 'all_signed' then 'completed' when status = 'human' then 'active' else status end,
         status_reason = case when nxt = 'all_signed' then 'all signed' when status = 'human' then null else status_reason end,
         history = history || jsonb_build_object('at', now(), 'from', p_from, 'to', nxt, 'by', coalesce(p_by, public.ai_actor()), 'via', p_via)
   where lead_id = p_lead and stage = p_from and status <> 'paused';
  get diagnostics n = row_count;
  if n > 0 then perform public.ai_rmk_schedule(p_lead, case when nxt = 'all_signed' then 'all signed' else 'stage changed' end); end if;
  return n > 0;
end $$;

-- Staff: set any stage (corrections), or pause / resume the automation for one lead.
create or replace function public.ai_rmk_set_stage(p_lead uuid, p_stage text) returns boolean
language plpgsql security definer set search_path = public as $$
declare cur text;
begin
  if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  if p_stage not in ('new','to_book','to_portal','to_submit_loan','to_sign','all_signed') then raise exception 'Unknown stage %', p_stage; end if;
  select stage into cur from public.ai_rmk_pipeline where lead_id = p_lead for update;
  if cur is null then raise exception 'This lead is not in the RMK pipeline'; end if;
  if cur = p_stage then return false; end if;
  update public.ai_rmk_pipeline
     set stage = p_stage, stage_changed_at = now(),
         status = case when p_stage = 'all_signed' then 'completed' when status in ('completed','human') then 'active' else status end,
         status_reason = case when p_stage = 'all_signed' then 'all signed' when status in ('completed','human') then null else status_reason end,
         history = history || jsonb_build_object('at', now(), 'from', cur, 'to', p_stage, 'by', public.ai_actor(), 'via', 'staff')
   where lead_id = p_lead;
  perform public.ai_rmk_schedule(p_lead, 'stage changed by staff');
  return true;
end $$;

create or replace function public.ai_rmk_set_status(p_lead uuid, p_status text, p_reason text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare p public.ai_rmk_pipeline;
begin
  if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  if p_status not in ('active','paused') then raise exception 'Status must be active or paused'; end if;
  select * into p from public.ai_rmk_pipeline where lead_id = p_lead for update;
  if p.lead_id is null then raise exception 'This lead is not in the RMK pipeline'; end if;
  if p.stage = 'all_signed' then raise exception 'All signed: nothing to follow up'; end if;
  update public.ai_rmk_pipeline set status = p_status, status_reason = nullif(trim(coalesce(p_reason, '')), ''),
         history = history || jsonb_build_object('at', now(), 'status', p_status, 'reason', p_reason, 'by', public.ai_actor())
   where lead_id = p_lead;
  perform public.ai_rmk_schedule(p_lead, case when p_status = 'paused' then 'paused by staff' else 'resumed by staff' end);
  return true;
end $$;

-- After switching sending on (or changing the intervals): reschedule every active lead's current stage.
create or replace function public.ai_rmk_reschedule_all() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if coalesce(auth.role(), '') = 'authenticated' and not public.ai_has_role('manager') then raise exception 'Managers only'; end if;
  for r in select lead_id from public.ai_rmk_pipeline where status = 'active' and stage <> 'all_signed' loop
    if public.ai_rmk_schedule(r.lead_id, 'rescheduled after a settings change') is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------- buyer messages
-- The exact stage keywords move the lead on; the project's full name puts a WhatsApp buyer in the pipeline.
-- A bare "RMK" from someone not in the pipeline is left to the AI, which asks which project they mean.
create or replace function public.ai_rmk_on_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare lid uuid; cur text; k text; expect text;
begin
  if new.direction <> 'inbound' or coalesce(new.body, '') = '' then return new; end if;
  select l.id into lid from public.ai_conversations v join public.ai_leads l on l.id = v.lead_id
   where v.id = new.conversation_id and l.closed_at is null;
  if lid is null then return new; end if;
  select stage into cur from public.ai_rmk_pipeline where lead_id = lid;
  if cur is null then
    if new.body ~* 'metropolitan\s*kepong' then perform public.ai_rmk_enroll(lid, 'whatsapp', 'buyer message'); end if;
    return new;
  end if;
  k := trim(regexp_replace(upper(new.body), '[^A-Z]+', ' ', 'g'));
  expect := case
    when k = 'RMK' then 'new'
    when k in ('DONE BOOKED','DONE BOOKING','DONE BOOK') then 'to_book'
    when k in ('DONE PORTAL') then 'to_portal'
    when k in ('DONE SUBMIT LOAN','DONE SUBMIT','DONE LOAN','DONE SUBMITTED') then 'to_submit_loan'
    when k in ('DONE SIGNED','DONE SIGN','DONE SIGNING') then 'to_sign'
  end;
  if expect is not null and expect = cur then perform public.ai_rmk_advance(lid, cur, 'buyer', 'keyword'); end if;
  return new;
exception when others then
  raise warning 'ai_rmk_on_message: %', sqlerrm;   -- never block recording a message
  return new;
end $$;
create trigger ai_messages_rmk after insert on public.ai_messages for each row execute function public.ai_rmk_on_message();

-- ---------------------------------------------------------------------------- project of the lead
-- A lead set to the RMK listing (website enquiry or staff) joins the pipeline; a lead moved to another project is
-- paused there, and its RMK reminders stop.
create or replace function public.ai_rmk_on_lead() returns trigger
language plpgsql security definer set search_path = public as $$
declare rmk_pid text := nullif(public.ai_rmk_cfg() ->> 'project_id', ''); src text;
begin
  if new.primary_project_id is not distinct from (case when tg_op = 'UPDATE' then old.primary_project_id end) then return new; end if;
  if rmk_pid is not null and new.primary_project_id = rmk_pid then
    select case s.channel when 'website' then 'website' when 'whatsapp' then 'whatsapp' when 'facebook' then 'facebook' when 'instagram' then 'instagram' else 'other' end
      into src from public.ai_lead_sources s where s.id = new.source_id;
    perform public.ai_rmk_enroll(new.id, coalesce(src, 'other'), 'project');
    -- back on RMK after a pause for a project change: resume
    update public.ai_rmk_pipeline set status = 'active', status_reason = null,
           history = history || jsonb_build_object('at', now(), 'status', 'active', 'reason', 'project set back to RMK', 'by', public.ai_actor())
     where lead_id = new.id and status = 'paused' and status_reason like 'project changed%';
    if found then perform public.ai_rmk_schedule(new.id, 'project set back to RMK'); end if;
  elsif new.primary_project_id is not null then
    update public.ai_rmk_pipeline set status = 'paused',
           status_reason = 'project changed to ' || coalesce((select data ->> 'n' from public.projects where id = new.primary_project_id), new.primary_project_id),
           history = history || jsonb_build_object('at', now(), 'status', 'paused', 'reason', 'project changed', 'by', public.ai_actor())
     where lead_id = new.id and status in ('active','human');
    if found then perform public.ai_rmk_schedule(new.id, 'project changed'); end if;
  end if;
  return new;
exception when others then
  raise warning 'ai_rmk_on_lead: %', sqlerrm;
  return new;
end $$;
create trigger ai_leads_rmk after insert or update of primary_project_id on public.ai_leads for each row execute function public.ai_rmk_on_lead();

revoke all on function public.ai_rmk_on_message() from public, anon, authenticated;
revoke all on function public.ai_rmk_on_lead() from public, anon, authenticated;
revoke all on function public.ai_rmk_schedule(uuid, text) from public, anon, authenticated;
revoke all on function public.ai_rmk_advance(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.ai_rmk_cfg() from public, anon;
revoke all on function public.ai_rmk_next(text) from public, anon;
grant execute on function public.ai_rmk_next(text) to authenticated, service_role;
revoke all on function public.ai_rmk_enroll(uuid, text, text) from public, anon;
revoke all on function public.ai_rmk_set_stage(uuid, text) from public, anon;
revoke all on function public.ai_rmk_set_status(uuid, text, text) from public, anon;
revoke all on function public.ai_rmk_reschedule_all() from public, anon;
grant execute on function public.ai_rmk_enroll(uuid, text, text), public.ai_rmk_set_stage(uuid, text), public.ai_rmk_set_status(uuid, text, text),
  public.ai_rmk_reschedule_all(), public.ai_rmk_cfg() to authenticated, service_role;
grant execute on function public.ai_rmk_advance(uuid, text, text, text), public.ai_rmk_schedule(uuid, text) to service_role;

-- ===== 20261028000015_ai_sales_follow_up_workflows.sql =====
-- AI Sales module — follow-up workflows built in the dashboard (2026-10-28). ADDITIVE ONLY.
--
-- Until now the RMK pipeline (migration 14) had its stages, keywords and transitions written into SQL and code.
-- This makes every follow-up workflow data:
--   ai_workflows          one workflow (usually per project): name, project, entry rules, sending switch, safeguards
--   ai_workflow_stages    its stages in order: keywords (first = the one shown to buyers, the rest aliases),
--                         reminder interval and count, BM/EN messages, 24-hour template, next stage, final stage,
--                         "a person takes over on entering", "a person takes over after the last reminder", active
--   ai_workflow_leads     the leads in a workflow: stage, automation status, source, history of every move
--   ai_workflow_changes   audit trail of every settings change (who, when, before and after)
-- Changes go through ai_wf_save (managers), which validates the whole workflow in one transaction.
-- RMK is copied in unchanged (same stages, keywords, messages, intervals, template names, sending switch).
-- ai_settings.rmk and ai_rmk_pipeline stay as they are (kept, no longer read); the ai_rmk_* functions now act on the
-- RMK workflow, so earlier callers keep working. Reminders are job kind workflow_follow_up; there are no
-- rmk_follow_up jobs in production, any left scheduled are moved over below.

-- ---------------------------------------------------------------------------- tables
create table public.ai_workflows (
  id                    uuid primary key default gen_random_uuid(),
  key                   text not null unique check (key ~ '^[a-z0-9_]{2,40}$'),
  name                  text not null check (length(trim(name)) between 1 and 120),
  description           text,
  project_id            text,                          -- the website listing (projects.id) this workflow belongs to
  status                text not null default 'active' check (status in ('active','archived')),
  sending_enabled       boolean not null default false, -- WhatsApp reminders are sent only when switched on
  pause_if_active_hours numeric not null default 6 check (pause_if_active_hours between 0 and 72),
  -- how leads join: ad_phrases (click-to-WhatsApp ad text), message_phrases (buyer's message), project_listing
  -- (lead set to project_id), ai_confirm (the AI, once the buyer confirms); exclusive_project: a lead moved to
  -- another project is paused here
  entry                 jsonb not null default '{"ad_phrases": [], "message_phrases": [], "project_listing": true, "ai_confirm": true, "exclusive_project": true}'::jsonb,
  ai_instructions       text,                          -- extra guidance for the AI about this workflow
  version               int not null default 1,
  created_at            timestamptz not null default now(),
  created_by            text not null default public.ai_actor(),
  updated_at            timestamptz not null default now(),
  updated_by            text
);
create unique index ai_workflows_one_per_project on public.ai_workflows (project_id) where status = 'active' and project_id is not null;
create trigger ai_workflows_touch before update on public.ai_workflows for each row execute function public.ai_touch_updated();

create table public.ai_workflow_stages (
  id                  uuid primary key default gen_random_uuid(),
  workflow_id         uuid not null references public.ai_workflows(id) on delete cascade,
  key                 text not null check (key ~ '^[a-z0-9_]{1,40}$'),
  position            int not null default 0,
  name                text not null check (length(trim(name)) between 1 and 120),
  step_en             text,                            -- what the buyer does at this stage
  step_ms             text,
  keywords            text[] not null default '{}',    -- buyer replies one of these when the step is done
  follow_up_hours     numeric not null default 0 check (follow_up_hours between 0 and 720),
  max_follow_ups      int not null default 0 check (max_follow_ups between 0 and 10),
  template            text,                            -- approved WhatsApp template for outside the 24-hour window
  message_ms          text check (length(message_ms) <= 1000),
  message_en          text check (length(message_en) <= 1000),
  next_stage_key      text,                            -- null: the next active stage in order
  is_final            boolean not null default false,  -- reaching it completes the workflow for the lead
  human_on_enter      boolean not null default false,  -- reaching it opens a follow-up task for a person
  escalate_after_max  boolean not null default true,   -- after the last reminder without progress: follow-up task
  active              boolean not null default true,   -- inactive: skipped by "next", sends no reminders
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (workflow_id, key)
);
create index ai_workflow_stages_order on public.ai_workflow_stages (workflow_id, position);
create trigger ai_workflow_stages_touch before update on public.ai_workflow_stages for each row execute function public.ai_touch_updated();

create table public.ai_workflow_leads (
  id               uuid primary key default gen_random_uuid(),
  workflow_id      uuid not null references public.ai_workflows(id) on delete restrict,
  lead_id          uuid not null references public.ai_leads(id) on delete cascade,
  stage            text not null,
  status           text not null default 'active' check (status in ('active','paused','completed','human')),
  status_reason    text,
  source           text not null default 'other' check (source in ('facebook','instagram','website','whatsapp','staff','other')),
  stage_changed_at timestamptz not null default now(),
  enrolled_at      timestamptz not null default now(),
  enrolled_by      text not null default public.ai_actor(),
  history          jsonb not null default '[]'::jsonb,   -- [{at, from, to, by, via}] / [{at, status, reason, by}]
  updated_at       timestamptz not null default now(),
  unique (workflow_id, lead_id)
);
create index ai_workflow_leads_lead on public.ai_workflow_leads (lead_id);
create index ai_workflow_leads_stage on public.ai_workflow_leads (workflow_id, stage, status);
create trigger ai_workflow_leads_touch before update on public.ai_workflow_leads for each row execute function public.ai_touch_updated();

create table public.ai_workflow_changes (
  id          uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.ai_workflows(id) on delete cascade,
  at          timestamptz not null default now(),
  by          text not null default public.ai_actor(),
  action      text not null,
  summary     text,
  before      jsonb,
  after       jsonb
);
create index ai_workflow_changes_wf on public.ai_workflow_changes (workflow_id, at desc);

do $$ declare t text; begin
  foreach t in array array['ai_workflows','ai_workflow_stages','ai_workflow_leads','ai_workflow_changes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create policy "ai read" on public.%I for select to authenticated using (public.ai_has_role(''viewer''))', t);
  end loop;
end $$;
-- every change goes through the functions below, so validation, scheduling and the audit trail always apply

-- ---------------------------------------------------------------------------- jobs
alter table public.ai_automation_jobs drop constraint ai_automation_jobs_kind_check;
alter table public.ai_automation_jobs add constraint ai_automation_jobs_kind_check
  check (kind in ('smart_follow_up','human_reminder','appt_confirmation','appt_reminder','rmk_follow_up','workflow_follow_up'));
alter table public.ai_automation_jobs add column if not exists workflow_id uuid references public.ai_workflows(id) on delete set null;
-- at most one workflow reminder waiting per lead and workflow, whoever schedules it
create unique index ai_automation_wf_one on public.ai_automation_jobs (workflow_id, lead_id) where kind = 'workflow_follow_up' and status = 'scheduled';

-- ---------------------------------------------------------------------------- helpers
-- "Done booked!" → "DONE BOOKED": keywords and phrases compare on letters and digits only
create or replace function public.ai_wf_norm(p text) returns text
language sql immutable set search_path = public as $$
  select trim(regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]+', ' ', 'g'))
$$;

-- a phrase found as whole words in a text ("metropolitan kepong" in "Saya minat Residensi Metropolitan Kepong")
create or replace function public.ai_wf_has_phrase(p_text text, p_phrases jsonb) returns boolean
language sql immutable set search_path = public as $$
  select exists (select 1 from jsonb_array_elements_text(coalesce(p_phrases, '[]'::jsonb)) x
                  where public.ai_wf_norm(x) <> '' and ' ' || public.ai_wf_norm(p_text) || ' ' like '% ' || public.ai_wf_norm(x) || ' %')
$$;

-- the stage after p_stage: its "next stage" if set and usable, else the next active stage in order; none after a final stage
create or replace function public.ai_wf_next(p_wf uuid, p_stage text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select n.key from public.ai_workflow_stages s join public.ai_workflow_stages n on n.workflow_id = s.workflow_id and n.key = s.next_stage_key
      where s.workflow_id = p_wf and s.key = p_stage and not s.is_final and n.archived_at is null and n.active and n.key <> s.key),
    (select n.key from public.ai_workflow_stages s join public.ai_workflow_stages n on n.workflow_id = s.workflow_id
      where s.workflow_id = p_wf and s.key = p_stage and not s.is_final and n.archived_at is null and n.active
        and (n.position, n.key) > (s.position, s.key)
      order by n.position, n.key limit 1))
$$;

create or replace function public.ai_wf_first(p_wf uuid) returns text
language sql stable security definer set search_path = public as $$
  select key from public.ai_workflow_stages where workflow_id = p_wf and archived_at is null and active order by position, key limit 1
$$;

-- Cancels the lead's scheduled reminders in this workflow and, while it is active, schedules the first one of its stage.
create or replace function public.ai_wf_schedule(p_wf uuid, p_lead uuid, p_reason text default 'stage changed') returns uuid
language plpgsql security definer set search_path = public as $$
declare e public.ai_workflow_leads; st public.ai_workflow_stages; w public.ai_workflows; conv uuid; j uuid;
begin
  update public.ai_automation_jobs set status = 'cancelled', reason = p_reason
   where lead_id = p_lead and workflow_id = p_wf and kind = 'workflow_follow_up' and status = 'scheduled';
  select * into w from public.ai_workflows where id = p_wf;
  select * into e from public.ai_workflow_leads where workflow_id = p_wf and lead_id = p_lead;
  if w.id is null or w.status <> 'active' or e.id is null or e.status <> 'active' then return null; end if;
  select * into st from public.ai_workflow_stages where workflow_id = p_wf and key = e.stage;
  if st.id is null or st.is_final or not st.active or st.archived_at is not null
     or st.follow_up_hours <= 0 or st.max_follow_ups <= 0 then return null; end if;
  select v.id into conv from public.ai_conversations v join public.ai_leads l on l.contact_id = v.contact_id
   where l.id = p_lead and v.channel = 'whatsapp' and v.status = 'open' order by v.updated_at desc limit 1;
  insert into public.ai_automation_jobs (kind, workflow_id, conversation_id, lead_id, stage, seq, run_at, dedupe_key)
  values ('workflow_follow_up', p_wf, conv, p_lead, e.stage, 1, now() + make_interval(secs => greatest(1, least(720, st.follow_up_hours)) * 3600),
          'wf:' || p_wf || ':' || p_lead || ':' || e.stage || ':1:' || (extract(epoch from clock_timestamp()) * 1e6)::bigint)
  on conflict (workflow_id, lead_id) where kind = 'workflow_follow_up' and status = 'scheduled' do nothing
  returning id into j;
  return j;
end $$;

-- After a lead reached a stage: reminders for the new stage, and a follow-up task if that stage needs a person.
create or replace function public.ai_wf_entered(p_wf uuid, p_lead uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare st public.ai_workflow_stages; w public.ai_workflows; e public.ai_workflow_leads;
begin
  perform public.ai_wf_schedule(p_wf, p_lead, p_reason);
  select * into w from public.ai_workflows where id = p_wf;
  select * into e from public.ai_workflow_leads where workflow_id = p_wf and lead_id = p_lead;
  select * into st from public.ai_workflow_stages where workflow_id = p_wf and key = e.stage;
  if st.human_on_enter and e.status <> 'paused' then
    perform public.ai_open_human_task(p_lead, left(w.name || ': ' || st.name || ' — a person follows up', 200),
      concat_ws(chr(10), 'Workflow: ' || w.name, 'Stage: ' || st.name, 'Step: ' || coalesce(st.step_en, st.step_ms)),
      'wf-' || w.key || ':' || st.key || ':' || p_lead);
  end if;
exception when others then
  raise warning 'ai_wf_entered: %', sqlerrm;   -- a task problem never undoes the stage change
end $$;

-- ---------------------------------------------------------------------------- leads
-- Puts a lead in a workflow at its first stage. Idempotent: a lead already in it is left as it is.
create or replace function public.ai_wf_enroll(p_wf uuid, p_lead uuid, p_source text default 'other', p_by text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare first_stage text; n int; who text := coalesce(p_by, public.ai_actor());
begin
  if p_lead is null or p_wf is null then return false; end if;
  if coalesce(auth.role(), '') = 'authenticated' and not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  if not exists (select 1 from public.ai_workflows where id = p_wf and status = 'active') then raise exception 'This workflow is archived or does not exist'; end if;
  first_stage := public.ai_wf_first(p_wf);
  if first_stage is null then raise exception 'This workflow has no active stage'; end if;
  insert into public.ai_workflow_leads (workflow_id, lead_id, stage, source, enrolled_by, history)
  values (p_wf, p_lead, first_stage, case when p_source in ('facebook','instagram','website','whatsapp','staff') then p_source else 'other' end,
          who, jsonb_build_array(jsonb_build_object('at', now(), 'to', first_stage, 'by', who, 'via', 'enrolled')))
  on conflict (workflow_id, lead_id) do nothing;
  get diagnostics n = row_count;
  if n > 0 then perform public.ai_wf_entered(p_wf, p_lead, 'enrolled'); end if;
  return n > 0;
end $$;

-- Moves a lead one stage on, only from the stage expected (a repeated or out-of-order confirmation changes nothing).
create or replace function public.ai_wf_advance(p_wf uuid, p_lead uuid, p_from text, p_by text default null, p_via text default 'keyword') returns boolean
language plpgsql security definer set search_path = public as $$
declare nxt text := public.ai_wf_next(p_wf, p_from); fin boolean; n int;
begin
  if nxt is null then return false; end if;
  fin := coalesce((select is_final from public.ai_workflow_stages where workflow_id = p_wf and key = nxt), false);
  update public.ai_workflow_leads
     set stage = nxt, stage_changed_at = now(),
         status = case when fin then 'completed' when status = 'human' then 'active' else status end,
         status_reason = case when fin then 'completed' when status = 'human' then null else status_reason end,
         history = history || jsonb_build_object('at', now(), 'from', p_from, 'to', nxt, 'by', coalesce(p_by, public.ai_actor()), 'via', p_via)
   where workflow_id = p_wf and lead_id = p_lead and stage = p_from and status <> 'paused';
  get diagnostics n = row_count;
  if n > 0 then perform public.ai_wf_entered(p_wf, p_lead, case when fin then 'completed' else 'stage changed' end); end if;
  return n > 0;
end $$;

-- moves every listed lead to a stage (staff corrections, and leads on a stage being archived)
create or replace function public.ai_wf_move(p_wf uuid, p_lead uuid, p_stage text, p_via text) returns boolean
language plpgsql security definer set search_path = public as $$
declare cur text; fin boolean;
begin
  select stage into cur from public.ai_workflow_leads where workflow_id = p_wf and lead_id = p_lead for update;
  if cur is null then raise exception 'This lead is not in the workflow'; end if;
  if cur = p_stage then return false; end if;
  select is_final into fin from public.ai_workflow_stages where workflow_id = p_wf and key = p_stage and archived_at is null;
  if fin is null then raise exception 'Unknown or archived stage %', p_stage; end if;
  update public.ai_workflow_leads
     set stage = p_stage, stage_changed_at = now(),
         status = case when fin then 'completed' when status in ('completed','human') then 'active' else status end,
         status_reason = case when fin then 'completed' when status in ('completed','human') then null else status_reason end,
         history = history || jsonb_build_object('at', now(), 'from', cur, 'to', p_stage, 'by', public.ai_actor(), 'via', p_via)
   where workflow_id = p_wf and lead_id = p_lead;
  perform public.ai_wf_entered(p_wf, p_lead, 'stage changed by staff');
  return true;
end $$;

create or replace function public.ai_wf_set_stage(p_wf uuid, p_lead uuid, p_stage text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  return public.ai_wf_move(p_wf, p_lead, p_stage, 'staff');
end $$;

create or replace function public.ai_wf_set_status(p_wf uuid, p_lead uuid, p_status text, p_reason text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare e public.ai_workflow_leads;
begin
  if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  if p_status not in ('active','paused') then raise exception 'Status must be active or paused'; end if;
  select * into e from public.ai_workflow_leads where workflow_id = p_wf and lead_id = p_lead for update;
  if e.id is null then raise exception 'This lead is not in the workflow'; end if;
  if e.status = 'completed' then raise exception 'Completed: nothing to follow up'; end if;
  update public.ai_workflow_leads set status = p_status, status_reason = nullif(trim(coalesce(p_reason, '')), ''),
         history = history || jsonb_build_object('at', now(), 'status', p_status, 'reason', p_reason, 'by', public.ai_actor())
   where id = e.id;
  perform public.ai_wf_schedule(p_wf, p_lead, case when p_status = 'paused' then 'paused by staff' else 'resumed by staff' end);
  return true;
end $$;

-- After switching sending on (or changing intervals): reschedule every active lead's current stage.
create or replace function public.ai_wf_reschedule(p_wf uuid) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if coalesce(auth.role(), '') = 'authenticated' and not public.ai_has_role('manager') then raise exception 'Managers only'; end if;
  for r in select lead_id from public.ai_workflow_leads where workflow_id = p_wf and status = 'active' loop
    if public.ai_wf_schedule(p_wf, r.lead_id, 'rescheduled after a settings change') is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- Click-to-WhatsApp ad: the lead joins every active workflow whose ad phrases appear in the ad's text.
create or replace function public.ai_wf_enroll_from_ad(p_lead uuid, p_text text, p_source text) returns int
language plpgsql security definer set search_path = public as $$
declare w record; n int := 0;
begin
  for w in select id, entry from public.ai_workflows where status = 'active' loop
    if public.ai_wf_has_phrase(p_text, w.entry -> 'ad_phrases') and public.ai_wf_enroll(w.id, p_lead, p_source, 'ad') then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------- settings
create or replace function public.ai_wf_snapshot(p_wf uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(w) - 'created_at' - 'updated_at' - 'updated_by' - 'version'
         || jsonb_build_object('stages', coalesce((select jsonb_agg(to_jsonb(s) - 'workflow_id' - 'created_at' - 'updated_at' order by s.position, s.key)
                                                     from public.ai_workflow_stages s where s.workflow_id = w.id), '[]'::jsonb))
    from public.ai_workflows w where w.id = p_wf
$$;

-- Creates or updates a whole workflow (settings + stages in order) and validates it. Managers.
-- p: {id?, key, name, description, project_id, status, sending_enabled, pause_if_active_hours, entry, ai_instructions,
--     stages: [{id?, key, name, step_en, step_ms, keywords[], follow_up_hours, max_follow_ups, template, message_ms,
--               message_en, next_stage_key, is_final, human_on_enter, escalate_after_max, active, archived, move_to}]}
-- Stages left out of the list are kept as they are. A stage being archived that still has leads needs move_to.
create or replace function public.ai_wf_save(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare wid uuid := nullif(p ->> 'id', '')::uuid; before jsonb; after jsonb; stg jsonb; i int := 0; sid uuid; k text;
        moves jsonb := '[]'::jsonb; mv jsonb; r record; dup text; bad text; old_status text; new_status text; n int;
        kws text[];
begin
  if coalesce(auth.role(), '') = 'authenticated' and not public.ai_has_role('manager') then raise exception 'Managers only'; end if;
  if length(trim(coalesce(p ->> 'name', ''))) = 0 then raise exception 'Give the workflow a name'; end if;
  if nullif(p ->> 'project_id', '') is not null and not exists (select 1 from public.projects where id = p ->> 'project_id') then
    raise exception 'Unknown project %', p ->> 'project_id'; end if;
  if nullif(p ->> 'project_id', '') is not null and coalesce(nullif(p ->> 'status', ''), 'active') = 'active' and exists (
       select 1 from public.ai_workflows where project_id = p ->> 'project_id' and status = 'active' and id is distinct from nullif(p ->> 'id', '')::uuid) then
    raise exception 'Another active workflow already belongs to this project'; end if;
  if jsonb_typeof(p -> 'stages') is distinct from 'array' then raise exception 'Stages are missing'; end if;
  new_status := coalesce(nullif(p ->> 'status', ''), 'active');
  if new_status not in ('active','archived') then raise exception 'Status must be active or archived'; end if;

  if wid is null then
    k := lower(trim(coalesce(p ->> 'key', '')));
    if k !~ '^[a-z0-9_]{2,40}$' then raise exception 'Short name: 2–40 lowercase letters, digits or _'; end if;
    if exists (select 1 from public.ai_workflows where key = k) then raise exception 'A workflow called "%" already exists', k; end if;
    insert into public.ai_workflows (key, name) values (k, trim(p ->> 'name')) returning id into wid;
    old_status := null;
  else
    select status into old_status from public.ai_workflows where id = wid for update;
    if old_status is null then raise exception 'Workflow not found'; end if;
    before := public.ai_wf_snapshot(wid);
  end if;

  update public.ai_workflows set
    name = left(trim(p ->> 'name'), 120),
    description = nullif(trim(coalesce(p ->> 'description', '')), ''),
    project_id = nullif(p ->> 'project_id', ''),
    status = new_status,
    sending_enabled = coalesce((p ->> 'sending_enabled')::boolean, false),
    pause_if_active_hours = coalesce((p ->> 'pause_if_active_hours')::numeric, 6),
    entry = jsonb_build_object(
      'ad_phrases', coalesce((select jsonb_agg(x) from jsonb_array_elements_text(coalesce(p -> 'entry' -> 'ad_phrases', '[]')) x where trim(x) <> ''), '[]'),
      'message_phrases', coalesce((select jsonb_agg(x) from jsonb_array_elements_text(coalesce(p -> 'entry' -> 'message_phrases', '[]')) x where trim(x) <> ''), '[]'),
      'project_listing', coalesce((p -> 'entry' ->> 'project_listing')::boolean, true),
      'ai_confirm', coalesce((p -> 'entry' ->> 'ai_confirm')::boolean, true),
      'exclusive_project', coalesce((p -> 'entry' ->> 'exclusive_project')::boolean, true)),
    ai_instructions = nullif(trim(coalesce(p ->> 'ai_instructions', '')), ''),
    version = version + case when before is null then 0 else 1 end,
    updated_by = public.ai_actor()
  where id = wid;

  for stg in select value from jsonb_array_elements(p -> 'stages') loop
    i := i + 1;
    sid := nullif(stg ->> 'id', '')::uuid;
    kws := coalesce((select array_agg(trim(x)) from jsonb_array_elements_text(coalesce(stg -> 'keywords', '[]')) x where public.ai_wf_norm(x) <> ''), '{}');
    if sid is null then
      k := lower(trim(coalesce(stg ->> 'key', '')));
      if k !~ '^[a-z0-9_]{1,40}$' then raise exception 'Stage short name "%": lowercase letters, digits or _', k; end if;
      if exists (select 1 from public.ai_workflow_stages where workflow_id = wid and key = k) then raise exception 'Two stages are called "%"', k; end if;
      insert into public.ai_workflow_stages (workflow_id, key, name) values (wid, k, coalesce(nullif(trim(stg ->> 'name'), ''), k)) returning id into sid;
    elsif not exists (select 1 from public.ai_workflow_stages where id = sid and workflow_id = wid) then
      raise exception 'Stage not in this workflow';
    end if;
    update public.ai_workflow_stages set
      position = i * 10,
      name = left(coalesce(nullif(trim(stg ->> 'name'), ''), key), 120),
      step_en = nullif(trim(coalesce(stg ->> 'step_en', '')), ''),
      step_ms = nullif(trim(coalesce(stg ->> 'step_ms', '')), ''),
      keywords = kws,
      follow_up_hours = coalesce((stg ->> 'follow_up_hours')::numeric, 0),
      max_follow_ups = coalesce((stg ->> 'max_follow_ups')::int, 0),
      template = nullif(trim(coalesce(stg ->> 'template', '')), ''),
      message_ms = nullif(trim(coalesce(stg ->> 'message_ms', '')), ''),
      message_en = nullif(trim(coalesce(stg ->> 'message_en', '')), ''),
      next_stage_key = nullif(trim(coalesce(stg ->> 'next_stage_key', '')), ''),
      is_final = coalesce((stg ->> 'is_final')::boolean, false),
      human_on_enter = coalesce((stg ->> 'human_on_enter')::boolean, false),
      escalate_after_max = coalesce((stg ->> 'escalate_after_max')::boolean, true),
      active = coalesce((stg ->> 'active')::boolean, true) and not coalesce((stg ->> 'archived')::boolean, false),
      archived_at = case when coalesce((stg ->> 'archived')::boolean, false) then coalesce(archived_at, now()) else null end
    where id = sid;
    if coalesce((stg ->> 'archived')::boolean, false) then
      moves := moves || jsonb_build_object('from', (select key from public.ai_workflow_stages where id = sid), 'to', nullif(stg ->> 'move_to', ''));
    end if;
  end loop;

  -- the whole workflow must make sense before anything is saved
  if (select count(*) from public.ai_workflow_stages where workflow_id = wid and archived_at is null) < 2 then raise exception 'A workflow needs at least two stages'; end if;
  if not exists (select 1 from public.ai_workflow_stages where workflow_id = wid and archived_at is null and is_final) then raise exception 'Mark the last stage (e.g. "Completed") as final'; end if;
  if not exists (select 1 from public.ai_workflow_stages where workflow_id = wid and archived_at is null and active and not is_final) then raise exception 'At least one active stage before the final one is needed'; end if;
  select string_agg(nk, ', ') into dup from (
    select public.ai_wf_norm(x) nk from public.ai_workflow_stages st, unnest(st.keywords) x
     where st.workflow_id = wid and st.archived_at is null group by 1 having count(*) > 1) q;
  if dup is not null then raise exception 'Keyword used by more than one stage: %', dup; end if;
  select string_agg(s.name, ', ') into bad from public.ai_workflow_stages s
   where s.workflow_id = wid and s.archived_at is null and s.next_stage_key is not null
     and (s.next_stage_key = s.key or not exists (select 1 from public.ai_workflow_stages n where n.workflow_id = wid and n.key = s.next_stage_key and n.archived_at is null));
  if bad is not null then raise exception 'Next stage missing or archived for: %', bad; end if;
  select string_agg(s.name, ', ') into bad from public.ai_workflow_stages s
   where s.workflow_id = wid and s.archived_at is null and not s.is_final and s.active and s.follow_up_hours > 0 and s.max_follow_ups > 0
     and s.message_ms is null and s.message_en is null;
  if bad is not null then raise exception 'Write a reminder message (or set no reminders) for: %', bad; end if;

  -- leads on archived stages: moved where the manager said, or the save is refused
  for mv in select value from jsonb_array_elements(moves) loop
    select count(*) into n from public.ai_workflow_leads where workflow_id = wid and stage = mv ->> 'from';
    if n > 0 then
      if mv ->> 'to' is null then raise exception '% lead(s) are at stage "%": choose where to move them before archiving it', n, mv ->> 'from'; end if;
      if not exists (select 1 from public.ai_workflow_stages where workflow_id = wid and key = mv ->> 'to' and archived_at is null) then raise exception 'Move-to stage "%" is not available', mv ->> 'to'; end if;
      for r in select lead_id from public.ai_workflow_leads where workflow_id = wid and stage = mv ->> 'from' loop
        perform public.ai_wf_move(wid, r.lead_id, mv ->> 'to', 'stage archived');
      end loop;
    end if;
  end loop;

  if new_status = 'archived' then
    update public.ai_automation_jobs set status = 'cancelled', reason = 'workflow archived'
     where workflow_id = wid and kind = 'workflow_follow_up' and status = 'scheduled';
  elsif (select sending_enabled from public.ai_workflows where id = wid) then
    perform public.ai_wf_reschedule(wid);
  end if;

  after := public.ai_wf_snapshot(wid);
  if before is distinct from after then
    insert into public.ai_workflow_changes (workflow_id, action, summary, before, after)
    values (wid, case when before is null then 'created' when old_status = 'active' and new_status = 'archived' then 'archived'
                      when old_status = 'archived' and new_status = 'active' then 'restored' else 'updated' end,
            nullif(trim(coalesce(p ->> 'change_note', '')), ''), before, after);
  end if;
  return wid;
end $$;

-- ---------------------------------------------------------------------------- buyer messages
-- A stage keyword moves the lead on (in each workflow it is in); a workflow's entry phrase in a buyer's message puts
-- the lead in that workflow.
create or replace function public.ai_wf_on_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare lid uuid; k text; r record;
begin
  if new.direction <> 'inbound' or coalesce(new.body, '') = '' then return new; end if;
  select l.id into lid from public.ai_conversations v join public.ai_leads l on l.id = v.lead_id
   where v.id = new.conversation_id and l.closed_at is null;
  if lid is null then return new; end if;
  k := public.ai_wf_norm(new.body);
  for r in select e.workflow_id, e.stage from public.ai_workflow_leads e join public.ai_workflows w on w.id = e.workflow_id
            where e.lead_id = lid and w.status = 'active' and e.status in ('active','human') loop
    if exists (select 1 from public.ai_workflow_stages s, unnest(s.keywords) x
                where s.workflow_id = r.workflow_id and s.key = r.stage and s.archived_at is null and public.ai_wf_norm(x) = k) then
      perform public.ai_wf_advance(r.workflow_id, lid, r.stage, 'buyer', 'keyword');
    end if;
  end loop;
  for r in select w.id from public.ai_workflows w
            where w.status = 'active' and public.ai_wf_has_phrase(new.body, w.entry -> 'message_phrases')
              and not exists (select 1 from public.ai_workflow_leads e where e.workflow_id = w.id and e.lead_id = lid) loop
    perform public.ai_wf_enroll(r.id, lid, 'whatsapp', 'buyer message');
  end loop;
  return new;
exception when others then
  raise warning 'ai_wf_on_message: %', sqlerrm;   -- never block recording a message
  return new;
end $$;

-- ---------------------------------------------------------------------------- project of the lead
-- A lead set to a workflow's listing joins it; a lead moved to another project is paused in workflows tied to one
-- project (exclusive_project), and resumed when it is set back.
create or replace function public.ai_wf_on_lead() returns trigger
language plpgsql security definer set search_path = public as $$
declare src text; w record;
begin
  if new.primary_project_id is not distinct from (case when tg_op = 'UPDATE' then old.primary_project_id end) then return new; end if;
  if new.primary_project_id is null then return new; end if;
  for w in select * from public.ai_workflows where status = 'active' loop
    if w.project_id = new.primary_project_id then
      if coalesce((w.entry ->> 'project_listing')::boolean, true) then
        if src is null then
          select case s.channel when 'website' then 'website' when 'whatsapp' then 'whatsapp' when 'facebook' then 'facebook' when 'instagram' then 'instagram' else 'other' end
            into src from public.ai_lead_sources s where s.id = new.source_id;
        end if;
        perform public.ai_wf_enroll(w.id, new.id, coalesce(src, 'other'), 'project');
      end if;
      -- back on the project after a pause for a project change: resume
      update public.ai_workflow_leads set status = 'active', status_reason = null,
             history = history || jsonb_build_object('at', now(), 'status', 'active', 'reason', 'project set back', 'by', public.ai_actor())
       where workflow_id = w.id and lead_id = new.id and status = 'paused' and status_reason like 'project changed%';
      if found then perform public.ai_wf_schedule(w.id, new.id, 'project set back'); end if;
    elsif coalesce((w.entry ->> 'exclusive_project')::boolean, true) then
      update public.ai_workflow_leads set status = 'paused',
             status_reason = 'project changed to ' || coalesce((select data ->> 'n' from public.projects where id = new.primary_project_id), new.primary_project_id),
             history = history || jsonb_build_object('at', now(), 'status', 'paused', 'reason', 'project changed', 'by', public.ai_actor())
       where workflow_id = w.id and lead_id = new.id and status in ('active','human');
      if found then perform public.ai_wf_schedule(w.id, new.id, 'project changed'); end if;
    end if;
  end loop;
  return new;
exception when others then
  raise warning 'ai_wf_on_lead: %', sqlerrm;
  return new;
end $$;

drop trigger if exists ai_messages_rmk on public.ai_messages;
drop trigger if exists ai_leads_rmk on public.ai_leads;
create trigger ai_messages_workflow after insert on public.ai_messages for each row execute function public.ai_wf_on_message();
create trigger ai_leads_workflow after insert or update of primary_project_id on public.ai_leads for each row execute function public.ai_wf_on_lead();

-- ---------------------------------------------------------------------------- RMK, copied in unchanged
do $$
declare c jsonb := coalesce((select rmk from public.ai_settings where id = 1), '{}'::jsonb); wid uuid;
begin
  insert into public.ai_workflows (key, name, description, project_id, sending_enabled, pause_if_active_hours, entry, ai_instructions, created_by)
  values ('rmk', 'RMK — Residensi Metropolitan Kepong', 'RUMAWIP project with its own step-by-step process: book, register on the portal, submit loan documents, sign.',
          nullif(c ->> 'project_id', ''), coalesce((c ->> 'enabled')::boolean, false), coalesce((c ->> 'pause_if_active_hours')::numeric, 6),
          jsonb_build_object('ad_phrases', jsonb_build_array('metropolitan kepong', 'RMK'), 'message_phrases', jsonb_build_array('metropolitan kepong'),
                             'project_listing', true, 'ai_confirm', true, 'exclusive_project', true),
          'RMK can also be a typo or mean something else: if a buyer who is not in this workflow writes "RMK" or seems to ask about it, ask whether they mean Residensi Metropolitan Kepong, and confirm interest only once they clearly say so.',
          'migration')
  returning id into wid;
  insert into public.ai_workflow_stages (workflow_id, key, position, name, step_en, step_ms, keywords, follow_up_hours, max_follow_ups, template, message_ms, message_en, is_final)
  select wid, x.key, x.pos, x.name, x.step_en, x.step_ms, x.kw,
         coalesce((c -> 'stages' -> x.key ->> 'follow_up_hours')::numeric, 0), coalesce((c -> 'stages' -> x.key ->> 'max_follow_ups')::int, 0),
         nullif(c -> 'stages' -> x.key ->> 'template', ''), nullif(c -> 'stages' -> x.key ->> 'message_ms', ''), nullif(c -> 'stages' -> x.key ->> 'message_en', ''),
         x.key = 'all_signed'
    from (values
      ('new',            10, 'New RMK enquiry',           'Confirm interest in RMK',               'Sahkan minat terhadap RMK',          array['RMK']),
      ('to_book',        20, 'To book unit',              'Book a unit',                           'Buat tempahan unit',                 array['DONE BOOKED','DONE BOOKING','DONE BOOK']),
      ('to_portal',      30, 'To apply portal (RUMAWIP)', 'Register on the RUMAWIP portal',        'Daftar di portal RUMAWIP',           array['DONE PORTAL']),
      ('to_submit_loan', 40, 'To submit loan documents',  'Submit the loan application documents', 'Hantar dokumen permohonan pinjaman', array['DONE SUBMIT LOAN','DONE SUBMIT','DONE LOAN','DONE SUBMITTED']),
      ('to_sign',        50, 'To sign LO, SPA & LA',      'Sign the LO, SPA & LA',                 'Tandatangan LO, SPA & LA',           array['DONE SIGNED','DONE SIGN','DONE SIGNING']),
      ('all_signed',     60, 'All signed',                'Completed',                             'Selesai',                            array[]::text[])
    ) as x(key, pos, name, step_en, step_ms, kw);
  -- leads already in the RMK pipeline (none in production when this was written) keep their stage and history
  insert into public.ai_workflow_leads (workflow_id, lead_id, stage, status, status_reason, source, stage_changed_at, enrolled_at, enrolled_by, history)
  select wid, lead_id, stage, status, status_reason, source, stage_changed_at, enrolled_at, enrolled_by, history from public.ai_rmk_pipeline
  on conflict do nothing;
  update public.ai_automation_jobs set status = 'cancelled', reason = 'moved to workflow follow-ups'
   where kind = 'rmk_follow_up' and status = 'scheduled';
  perform public.ai_wf_schedule(wid, lead_id, 'moved to workflow follow-ups') from public.ai_workflow_leads where workflow_id = wid and status = 'active';
  insert into public.ai_workflow_changes (workflow_id, by, action, summary, after)
  values (wid, 'migration', 'created', 'Copied from the RMK settings (Settings → RMK) unchanged', public.ai_wf_snapshot(wid));
end $$;

-- the earlier RMK functions keep working, on the RMK workflow
create or replace function public.ai_rmk_wf() returns uuid
language sql stable security definer set search_path = public as $$ select id from public.ai_workflows where key = 'rmk' $$;
create or replace function public.ai_rmk_enroll(p_lead uuid, p_source text default 'other', p_by text default null) returns boolean
language sql security definer set search_path = public as $$ select public.ai_wf_enroll(public.ai_rmk_wf(), p_lead, p_source, p_by) $$;
create or replace function public.ai_rmk_advance(p_lead uuid, p_from text, p_by text default null, p_via text default 'keyword') returns boolean
language sql security definer set search_path = public as $$ select public.ai_wf_advance(public.ai_rmk_wf(), p_lead, p_from, p_by, p_via) $$;
create or replace function public.ai_rmk_set_stage(p_lead uuid, p_stage text) returns boolean
language sql security definer set search_path = public as $$ select public.ai_wf_set_stage(public.ai_rmk_wf(), p_lead, p_stage) $$;
create or replace function public.ai_rmk_set_status(p_lead uuid, p_status text, p_reason text default null) returns boolean
language sql security definer set search_path = public as $$ select public.ai_wf_set_status(public.ai_rmk_wf(), p_lead, p_status, p_reason) $$;
create or replace function public.ai_rmk_reschedule_all() returns int
language sql security definer set search_path = public as $$ select public.ai_wf_reschedule(public.ai_rmk_wf()) $$;
create or replace function public.ai_rmk_schedule(p_lead uuid, p_reason text default 'stage changed') returns uuid
language sql security definer set search_path = public as $$ select public.ai_wf_schedule(public.ai_rmk_wf(), p_lead, p_reason) $$;

-- ---------------------------------------------------------------------------- grants
revoke all on function public.ai_wf_on_message() from public, anon, authenticated;
revoke all on function public.ai_wf_on_lead() from public, anon, authenticated;
revoke all on function public.ai_wf_schedule(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.ai_wf_entered(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.ai_wf_advance(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.ai_wf_move(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.ai_wf_enroll_from_ad(uuid, text, text) from public, anon, authenticated;
revoke all on function public.ai_wf_next(uuid, text) from public, anon;
revoke all on function public.ai_wf_first(uuid) from public, anon;
revoke all on function public.ai_wf_snapshot(uuid) from public, anon;
revoke all on function public.ai_wf_enroll(uuid, uuid, text, text) from public, anon;
revoke all on function public.ai_wf_set_stage(uuid, uuid, text) from public, anon;
revoke all on function public.ai_wf_set_status(uuid, uuid, text, text) from public, anon;
revoke all on function public.ai_wf_reschedule(uuid) from public, anon;
revoke all on function public.ai_wf_save(jsonb) from public, anon;
revoke all on function public.ai_rmk_wf() from public, anon;
grant execute on function public.ai_wf_next(uuid, text), public.ai_wf_first(uuid), public.ai_wf_snapshot(uuid),
  public.ai_wf_enroll(uuid, uuid, text, text), public.ai_wf_set_stage(uuid, uuid, text), public.ai_wf_set_status(uuid, uuid, text, text),
  public.ai_wf_reschedule(uuid), public.ai_wf_save(jsonb), public.ai_rmk_wf() to authenticated, service_role;
grant execute on function public.ai_wf_advance(uuid, uuid, text, text, text), public.ai_wf_schedule(uuid, uuid, text),
  public.ai_wf_enroll_from_ad(uuid, text, text) to service_role;
revoke all on function public.ai_wf_norm(text) from public, anon;
revoke all on function public.ai_wf_has_phrase(text, jsonb) from public, anon;
grant execute on function public.ai_wf_norm(text), public.ai_wf_has_phrase(text, jsonb) to authenticated, service_role;

-- ===== 20261029000016_ai_sales_client_workspace.sql =====
-- AI Sales module — client workspace: structured client profile, AI conversation summary and next action, field
-- history, richer property interests, and a structured, configurable sales pipeline (2026-10-29). ADDITIVE ONLY.
--
--   ai_leads.profile        client profile values (location, commute, household, preferences, intent, notes…)
--   ai_leads.profile_meta   per field: confirmed / inferred / conflict, who or what set it, when, from which message
--   ai_leads.ai_summary     conversation summary, last client question, outstanding items, next best action
--   ai_lead_field_history   every change to a profile or qualification field (old → new, source, message)
--   ai_lead_interests       + priority (primary / alternative / comparison / no longer), unit type, budget, next action
--   ai_pipeline_stages      + key (structured value), colour, ai_settable, description; stages renamed / added to the
--                           pipeline requested on 2026-10-29 (no stage deleted, every lead keeps its stage)
-- Rules (ai_lead_profile_set): a person's entry is never overwritten by the AI (a different value is flagged as a
-- conflict for review); an inferred value never replaces a confirmed one; the same message is never applied twice.
-- Stage moves (ai_lead_set_stage): staff any stage, with a note; the AI only forward, only to stages marked
-- ai_settable, never closing a lead, and only with the buyer's own words as evidence; confirmed / completed
-- appointments move the lead to Appointment Booked / Attended (forward only). A manual stage change cancels the
-- automatic check-ins scheduled for the old situation.

-- ---------------------------------------------------------------------------- lead profile, summary, history
alter table public.ai_leads add column if not exists profile jsonb not null default '{}'::jsonb;
alter table public.ai_leads add column if not exists profile_meta jsonb not null default '{}'::jsonb;
alter table public.ai_leads add column if not exists ai_summary jsonb not null default '{}'::jsonb;

create table public.ai_lead_field_history (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references public.ai_leads(id) on delete cascade,
  field      text not null,
  old_value  jsonb,
  new_value  jsonb,
  status     text not null check (status in ('confirmed','inferred','conflict','cleared')),
  source     text not null check (source in ('staff','ai','system')),
  by         text not null default public.ai_actor(),
  message_id uuid,
  note       text,
  at         timestamptz not null default now()
);
create index ai_lead_field_history_lead on public.ai_lead_field_history (lead_id, at desc);
-- the same buyer message never updates the same field twice (redelivered messages, retried jobs)
create unique index ai_lead_field_history_once on public.ai_lead_field_history (lead_id, field, message_id) where message_id is not null and source = 'ai';
alter table public.ai_lead_field_history enable row level security;
revoke all on public.ai_lead_field_history from anon;
create policy "ai read" on public.ai_lead_field_history for select to authenticated using (public.ai_has_role('viewer'));

alter table public.ai_activities drop constraint ai_activities_kind_check;
alter table public.ai_activities add constraint ai_activities_kind_check
  check (kind in ('note','call','website_enquiry','stage_change','assignment','qualification','handover','appointment','message_summary','system','profile_update','ai_summary'));

-- ---------------------------------------------------------------------------- property interests
alter table public.ai_lead_interests add column if not exists priority text not null default 'alternative'
  check (priority in ('primary','alternative','comparison','no_longer'));
alter table public.ai_lead_interests add column if not exists unit_type text;
alter table public.ai_lead_interests add column if not exists budget_text text;
alter table public.ai_lead_interests add column if not exists next_action text;
alter table public.ai_lead_interests add column if not exists updated_at timestamptz not null default now();
update public.ai_lead_interests i set priority = 'primary' from public.ai_leads l where l.id = i.lead_id and l.primary_project_id = i.project_id;
update public.ai_lead_interests set priority = 'no_longer' where interest = 'rejected' and priority <> 'primary';

-- ---------------------------------------------------------------------------- pipeline stages
alter table public.ai_pipeline_stages add column if not exists key text;
alter table public.ai_pipeline_stages add column if not exists color text not null default 'slate'
  check (color in ('slate','blue','teal','green','amber','orange','red','purple','gold','navy'));
alter table public.ai_pipeline_stages add column if not exists ai_settable boolean not null default false;
alter table public.ai_pipeline_stages add column if not exists description text;
create unique index if not exists ai_pipeline_stages_key on public.ai_pipeline_stages (key) where key is not null;

do $$
declare r record;
begin
  -- names are unique and positions are renumbered at the end, so move every stage out of the way first
  update public.ai_pipeline_stages set position = position + 1000;
  for r in select * from (values
    -- old name,               new name,                 key,                    pos, colour,   ai,    description
    ('New Lead',              'New Enquiry',            'new_enquiry',           1, 'slate',  false, 'A new valid enquiry'),
    ('Contacted',             'Contacted',              'contacted',             2, 'blue',   false, 'We have replied to the buyer'),
    ('Qualified',             'Interested / Qualified', 'interested',            3, 'blue',   true,  'The buyer clearly wants to know more about a project'),
    (null,                    'No Response',            'no_response',           4, 'orange', false, 'The buyer stopped replying'),
    ('Follow-Up',             'Follow-Up Required',     'follow_up_required',    5, 'amber',  false, 'We owe the buyer an answer or a call'),
    ('Appointment Pending',   'Appointment Pending',    'appointment_pending',   6, 'amber',  false, 'A visit was requested, time not yet confirmed'),
    ('Appointment Confirmed', 'Appointment Booked',     'appointment_booked',    7, 'teal',   false, 'A confirmed appointment (set automatically)'),
    ('Visited Showroom',      'Appointment Attended',   'appointment_attended',  8, 'teal',   false, 'The buyer came (set automatically when the appointment is completed)'),
    ('Booking / Reservation', 'Unit Booked',            'unit_booked',           9, 'green',  true,  'The buyer has booked a unit'),
    ('Pending Document',      'Documents Pending',      'documents_pending',    10, 'purple', false, 'Waiting for the buyer''s documents'),
    ('Pending Approval',      'Loan Submitted',         'loan_submitted',       11, 'purple', true,  'The loan application has been submitted'),
    (null,                    'Loan Approved',          'loan_approved',        12, 'green',  false, 'Confirmed by the bank or an authorised agent'),
    (null,                    'Loan Declined',          'loan_declined',        13, 'red',    false, 'Confirmed by the bank or an authorised agent'),
    ('SPA Signing',           'LO Signed',              'lo_signed',            14, 'gold',   false, 'Letter of offer signed'),
    ('Pending SPA Signing',   'Pending SPA Signing',    'pending_spa_signing',  15, 'gold',   false, null),
    ('Won',                   'LO, SPA & LA Signed',    'signed_all',           16, 'navy',   false, 'All documents signed: closes the lead as won'),
    ('Lost',                  'Cancelled / Lost',       'cancelled',            17, 'red',    false, 'Closes the lead as lost')
  ) as x(old_name, new_name, key, pos, color, ai, description) loop
    if r.old_name is not null and exists (select 1 from public.ai_pipeline_stages where name = r.old_name) then
      update public.ai_pipeline_stages set name = r.new_name, key = r.key, position = r.pos, color = r.color, ai_settable = r.ai,
             description = coalesce(description, r.description)
       where name = r.old_name;
    elsif not exists (select 1 from public.ai_pipeline_stages where name = r.new_name) then
      insert into public.ai_pipeline_stages (name, key, position, color, ai_settable, description) values (r.new_name, r.key, r.pos, r.color, r.ai, r.description);
    end if;
  end loop;
  -- any other stage an owner added keeps its order, after these
  with o as (select id, row_number() over (order by position) + 17 as p from public.ai_pipeline_stages where position >= 1000)
  update public.ai_pipeline_stages s set position = o.p from o where s.id = o.id;
end $$;

-- ---------------------------------------------------------------------------- profile & qualification fields
-- p_changes: [{field, value, status: confirmed|inferred}]. Qualification fields go to ai_leads.qualification, every
-- other field to ai_leads.profile. Returns {applied, conflicts, skipped}.
create or replace function public.ai_lead_profile_set(p_lead uuid, p_changes jsonb, p_source text default 'staff', p_message uuid default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ch jsonb; k text; v jsonb; st text; l public.ai_leads; meta jsonb; cur jsonb; curm jsonb; isq boolean; who text;
        applied text[] := '{}'; conflicts text[] := '{}'; skipped text[] := '{}';
        qual_keys text[] := array['purpose','first_home','bedrooms','size_sqft','budget_min','budget_max','employment','financing',
                                  'timeline_months','readiness','concerns','project_fit','budget_fit','unsuitable','unsuitable_reason'];
begin
  if p_source not in ('staff','ai') then raise exception 'source must be staff or ai'; end if;
  if p_source = 'staff' then
    if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then raise exception 'AI updates come from the server only';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'array' then raise exception 'changes must be a list'; end if;
  who := case when p_source = 'ai' then 'ai' else public.ai_actor() end;
  select * into l from public.ai_leads where id = p_lead for update;
  if l.id is null then raise exception 'Lead not found'; end if;
  meta := coalesce(l.profile_meta, '{}'::jsonb);
  l.profile := coalesce(l.profile, '{}'::jsonb);
  l.qualification := coalesce(l.qualification, '{}'::jsonb);

  for ch in select value from jsonb_array_elements(p_changes) loop
    k := ch ->> 'field';
    if k is null or k !~ '^[a-z][a-z0-9_]{1,39}$' or k = 'signals' then continue; end if;
    isq := k = any(qual_keys);
    v := ch -> 'value';
    if v is null or v = 'null'::jsonb or v = '""'::jsonb or v = '[]'::jsonb then
      if p_source = 'ai' then skipped := skipped || k; continue; end if;   -- the AI never clears a field
      v := null;
    elsif jsonb_typeof(v) = 'string' then v := to_jsonb(left(trim(v #>> '{}'), 1000));
    elsif jsonb_typeof(v) = 'array' then v := (select coalesce(jsonb_agg(left(x, 80)), '[]'::jsonb) from (select jsonb_array_elements_text(v) x limit 20) y);
    elsif jsonb_typeof(v) not in ('number','boolean') then continue;
    end if;
    st := case when p_source = 'staff' or ch ->> 'status' = 'confirmed' then 'confirmed' else 'inferred' end;
    cur := case when isq then l.qualification -> k else l.profile -> k end;
    curm := meta -> k;

    if p_source = 'ai' then
      if p_message is not null and exists (select 1 from public.ai_lead_field_history where lead_id = p_lead and field = k and message_id = p_message and source = 'ai') then
        skipped := skipped || k; continue;
      end if;
      if cur is not distinct from v then
        -- the same value: one the AI had only inferred becomes confirmed once the buyer states it
        if st = 'confirmed' and curm ->> 'status' = 'inferred' then
          meta := jsonb_set(meta, array[k], curm || jsonb_build_object('status', 'confirmed', 'at', now(), 'message_id', p_message));
          insert into public.ai_lead_field_history (lead_id, field, old_value, new_value, status, source, by, message_id)
          values (p_lead, k, cur, v, 'confirmed', 'ai', who, p_message);
          applied := applied || k;
        else skipped := skipped || k; end if;
        continue;
      end if;
      if cur is not null and curm ->> 'source' = 'staff' then
        -- a person's entry is never overwritten by the AI: the new value is shown for review
        meta := jsonb_set(meta, array[k], curm || jsonb_build_object('conflict', jsonb_build_object('value', v, 'status', st, 'at', now(), 'message_id', p_message)));
        insert into public.ai_lead_field_history (lead_id, field, old_value, new_value, status, source, by, message_id)
        values (p_lead, k, cur, v, 'conflict', 'ai', who, p_message);
        conflicts := conflicts || k;
        continue;
      end if;
      if cur is not null and coalesce(curm ->> 'status', 'confirmed') = 'confirmed' and st = 'inferred' then
        skipped := skipped || k; continue;   -- a guess never replaces what the buyer said
      end if;
    end if;

    if isq then l.qualification := case when v is null then l.qualification - k else jsonb_set(l.qualification, array[k], v) end;
    else l.profile := case when v is null then l.profile - k else jsonb_set(l.profile, array[k], v) end; end if;
    meta := case when v is null then meta - k
                 else jsonb_set(meta, array[k], jsonb_strip_nulls(jsonb_build_object('status', st, 'source', p_source, 'by', who, 'at', now(),
                                                                                    'message_id', p_message, 'note', nullif(trim(coalesce(p_note, '')), '')))) end;
    insert into public.ai_lead_field_history (lead_id, field, old_value, new_value, status, source, by, message_id, note)
    values (p_lead, k, cur, v, case when v is null then 'cleared' else st end, p_source, who, p_message, nullif(trim(coalesce(p_note, '')), ''));
    applied := applied || k;
  end loop;

  if cardinality(applied) > 0 or cardinality(conflicts) > 0 then
    update public.ai_leads set profile = l.profile, qualification = l.qualification, profile_meta = meta where id = p_lead;
    insert into public.ai_activities (lead_id, contact_id, kind, body, meta, actor)
    values (p_lead, l.contact_id, 'profile_update',
            concat_ws(' · ', case when cardinality(applied) > 0 then (case when p_source = 'ai' then 'AI updated ' else 'Updated ' end) || array_to_string(applied, ', ') end,
                             case when cardinality(conflicts) > 0 then 'needs review: ' || array_to_string(conflicts, ', ') end),
            jsonb_build_object('fields', to_jsonb(applied), 'conflicts', to_jsonb(conflicts), 'source', p_source, 'message_id', p_message), who);
  end if;
  return jsonb_build_object('applied', to_jsonb(applied), 'conflicts', to_jsonb(conflicts), 'skipped', to_jsonb(skipped));
end $$;

-- A person resolves a conflict: keep their value, or take the one the buyer gave.
create or replace function public.ai_lead_profile_resolve(p_lead uuid, p_field text, p_accept boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare l public.ai_leads; c jsonb;
begin
  if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  select * into l from public.ai_leads where id = p_lead for update;
  c := l.profile_meta -> p_field -> 'conflict';
  if c is null then return false; end if;
  update public.ai_leads set profile_meta = jsonb_set(profile_meta, array[p_field], (profile_meta -> p_field) - 'conflict') where id = p_lead;
  if p_accept then
    perform public.ai_lead_profile_set(p_lead, jsonb_build_array(jsonb_build_object('field', p_field, 'value', c -> 'value')), 'staff', null, 'accepted the value from the conversation');
  end if;
  return true;
end $$;

-- ---------------------------------------------------------------------------- summary & next action
-- p_summary: {text, last_client_question, outstanding, next_question, next_action: {action, reason, priority, due_at}}
-- AI: from the server only; a person may also edit the summary text and set the next action.
create or replace function public.ai_lead_summary_set(p_lead uuid, p_summary jsonb, p_source text default 'ai', p_message uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.ai_leads; s jsonb; na jsonb; cur_na jsonb; who text;
begin
  if p_source = 'staff' then
    if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  elsif p_source = 'ai' then
    if coalesce(auth.role(), '') <> 'service_role' then raise exception 'AI updates come from the server only'; end if;
  else raise exception 'source must be staff or ai';
  end if;
  who := case when p_source = 'ai' then 'ai' else public.ai_actor() end;
  select * into l from public.ai_leads where id = p_lead for update;
  if l.id is null then raise exception 'Lead not found'; end if;
  s := coalesce(l.ai_summary, '{}'::jsonb);
  if nullif(trim(coalesce(p_summary ->> 'text', '')), '') is not null then
    s := s || jsonb_build_object('text', left(trim(p_summary ->> 'text'), 1500), 'updated_at', now(), 'updated_by', who, 'source', p_source, 'message_id', p_message);
  end if;
  if p_summary ? 'last_client_question' then s := s || jsonb_build_object('last_client_question', nullif(left(trim(coalesce(p_summary ->> 'last_client_question', '')), 400), '')); end if;
  if p_summary ? 'outstanding' then s := s || jsonb_build_object('outstanding', nullif(left(trim(coalesce(p_summary ->> 'outstanding', '')), 600), '')); end if;
  if p_summary ? 'next_question' then s := s || jsonb_build_object('next_question', nullif(left(trim(coalesce(p_summary ->> 'next_question', '')), 300), '')); end if;
  na := p_summary -> 'next_action';
  cur_na := s -> 'next_action';
  if na is not null and nullif(trim(coalesce(na ->> 'action', '')), '') is not null
     and (cur_na is null or cur_na ->> 'action' is distinct from trim(na ->> 'action') or cur_na ->> 'status' is distinct from 'open') then
    -- a recommendation a person dismissed or completed is not brought back unchanged by the AI
    if not coalesce(p_source = 'ai' and cur_na ->> 'action' = trim(na ->> 'action') and cur_na ->> 'status' in ('done','dismissed'), false) then
      s := s || jsonb_build_object('next_action', jsonb_strip_nulls(jsonb_build_object(
        'action', left(trim(na ->> 'action'), 300), 'reason', nullif(left(trim(coalesce(na ->> 'reason', '')), 400), ''),
        'priority', case when na ->> 'priority' in ('low','normal','high') then na ->> 'priority' else 'normal' end,
        'due_at', case when (na ->> 'due_at') ~ '^\d{4}-\d{2}-\d{2}' then na ->> 'due_at' end,
        'status', 'open', 'source', p_source, 'by', who, 'at', now())));
    end if;
  end if;
  update public.ai_leads set ai_summary = s where id = p_lead;
  if p_source = 'staff' or (l.ai_summary ->> 'text') is distinct from (s ->> 'text') then
    insert into public.ai_activities (lead_id, contact_id, kind, body, meta, actor)
    values (p_lead, l.contact_id, 'ai_summary', case when p_source = 'ai' then 'AI summary updated' else 'Summary edited' end,
            jsonb_build_object('source', p_source, 'message_id', p_message), who);
  end if;
  return s;
end $$;

create or replace function public.ai_lead_next_action(p_lead uuid, p_status text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  if p_status not in ('done','dismissed','open') then raise exception 'Status must be done, dismissed or open'; end if;
  update public.ai_leads set ai_summary = jsonb_set(ai_summary, '{next_action}', (ai_summary -> 'next_action') || jsonb_build_object('status', p_status, 'closed_by', public.ai_actor(), 'closed_at', now()))
   where id = p_lead and ai_summary ? 'next_action';
  return found;
end $$;

-- ---------------------------------------------------------------------------- stage moves
-- the timeline records who moved the lead, how and why (note / evidence set by ai_lead_set_stage)
create or replace function public.ai_lead_timeline() returns trigger
language plpgsql security definer set search_path = public as $$
declare note text := nullif(current_setting('ai.stage_note', true), ''); src text := nullif(current_setting('ai.stage_source', true), '');
        ev text := nullif(current_setting('ai.stage_evidence', true), '');
begin
  if new.stage_id is distinct from old.stage_id then
    insert into public.ai_activities (lead_id, contact_id, kind, body, meta, actor)
    select new.id, new.contact_id, 'stage_change',
           (select name from public.ai_pipeline_stages where id = old.stage_id) || ' → ' || s.name || coalesce(' · ' || note, '') || coalesce(' · buyer: "' || left(ev, 200) || '"', ''),
           jsonb_strip_nulls(jsonb_build_object('from', old.stage_id, 'to', new.stage_id, 'source', coalesce(src, 'staff'), 'note', note, 'evidence', ev)),
           case when src in ('ai','system') then src else public.ai_actor() end
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

-- staff: any active stage (with an optional note); ai: forward only, to ai_settable stages, never closing, with the
-- buyer's words as evidence; system: forward only (appointments). Returns true when the stage changed.
create or replace function public.ai_lead_set_stage(p_lead uuid, p_stage uuid, p_note text default null, p_source text default 'staff', p_evidence text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare l public.ai_leads; tgt public.ai_pipeline_stages; cur public.ai_pipeline_stages;
begin
  if p_source = 'staff' then
    if not public.ai_has_role('advisor') then raise exception 'Advisors only'; end if;
  elsif p_source in ('ai','system') then
    if coalesce(auth.role(), '') <> 'service_role' and current_setting('ai.internal', true) is distinct from 'on' then raise exception 'Not allowed'; end if;
  else raise exception 'Unknown source';
  end if;
  select * into l from public.ai_leads where id = p_lead for update;
  select * into tgt from public.ai_pipeline_stages where id = p_stage;
  if l.id is null or tgt.id is null then raise exception 'Lead or stage not found'; end if;
  if l.stage_id = tgt.id then return false; end if;
  if not tgt.active and p_source <> 'staff' then return false; end if;
  select * into cur from public.ai_pipeline_stages where id = l.stage_id;
  if p_source <> 'staff' then
    if l.closed_at is not null or tgt.is_won or tgt.is_lost or tgt.position <= coalesce(cur.position, 0) then return false; end if;
    if p_source = 'ai' and (not tgt.ai_settable or length(trim(coalesce(p_evidence, ''))) < 3) then return false; end if;
  end if;
  perform set_config('ai.stage_note', coalesce(left(trim(p_note), 300), ''), true);
  perform set_config('ai.stage_source', p_source, true);
  perform set_config('ai.stage_evidence', coalesce(left(trim(p_evidence), 300), ''), true);
  update public.ai_leads set stage_id = tgt.id where id = p_lead;
  perform set_config('ai.stage_note', '', true);
  perform set_config('ai.stage_source', '', true);
  perform set_config('ai.stage_evidence', '', true);
  -- a person moved the lead on: check-ins scheduled for the old situation are dropped (the buyer's next message
  -- schedules a fresh one); a closed lead gets no more automatic messages at all
  if p_source = 'staff' or tgt.is_won or tgt.is_lost then
    update public.ai_automation_jobs set status = 'cancelled', reason = 'stage changed to ' || tgt.name
     where lead_id = p_lead and status = 'scheduled'
       and (kind = 'smart_follow_up' or (tgt.is_won or tgt.is_lost) and kind in ('appt_confirmation','appt_reminder'));
    update public.ai_follow_up_jobs set status = 'cancelled', reason = 'stage changed to ' || tgt.name
     where lead_id = p_lead and status = 'scheduled';
  end if;
  return true;
end $$;

-- a confirmed / completed appointment moves the lead to Appointment Booked / Attended (forward only)
create or replace function public.ai_appointment_stage() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; sid uuid;
begin
  if new.status is not distinct from (case when tg_op = 'UPDATE' then old.status end) then return new; end if;
  k := case new.status when 'confirmed' then 'appointment_booked' when 'completed' then 'appointment_attended' end;
  if k is null or new.lead_id is null then return new; end if;
  select id into sid from public.ai_pipeline_stages where key = k and active;
  if sid is null then return new; end if;
  perform set_config('ai.internal', 'on', true);
  perform public.ai_lead_set_stage(new.lead_id, sid, case k when 'appointment_booked' then 'appointment confirmed' else 'appointment completed' end, 'system');
  perform set_config('ai.internal', '', true);
  return new;
exception when others then
  perform set_config('ai.internal', '', true);
  raise warning 'ai_appointment_stage: %', sqlerrm;   -- never block the appointment itself
  return new;
end $$;
create trigger ai_appointments_stage after insert or update of status on public.ai_appointments for each row execute function public.ai_appointment_stage();

-- ---------------------------------------------------------------------------- PDPA erase covers the new data
create or replace function public.ai_erase_contact(p_contact uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare fin text[];
begin
  if auth.role() <> 'service_role' and not public.ai_has_role('owner') then raise exception 'only owners can erase contacts'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required'; end if;
  update public.ai_contacts set full_name = '[erased]', phone_e164 = null, wa_id = null, email = null, notes = null, erased_at = now()
   where id = p_contact;
  update public.ai_messages set body = '[erased]', media = null
   where conversation_id in (select id from public.ai_conversations where contact_id = p_contact);
  update public.ai_activities set body = '[erased]', meta = '{}'::jsonb where contact_id = p_contact or lead_id in (select id from public.ai_leads where contact_id = p_contact);
  update public.ai_leads set qualification = '{}'::jsonb, profile = '{}'::jsonb, profile_meta = '{}'::jsonb, ai_summary = '{}'::jsonb where contact_id = p_contact;
  delete from public.ai_lead_field_history where lead_id in (select id from public.ai_leads where contact_id = p_contact);
  update public.ai_lead_interests set note = null, budget_text = null, next_action = null where lead_id in (select id from public.ai_leads where contact_id = p_contact);
  select array_agg(id::text) into fin from (
    select id from public.ai_financing_profiles where lead_id in (select id from public.ai_leads where contact_id = p_contact)
    union all
    select id from public.ai_financing_assessments where lead_id in (select id from public.ai_leads where contact_id = p_contact)) x;
  delete from public.ai_financing_profiles where lead_id in (select id from public.ai_leads where contact_id = p_contact);
  delete from public.ai_financing_assessments where lead_id in (select id from public.ai_leads where contact_id = p_contact);
  -- the audit trail must not keep the erased personal data either
  update public.ai_audit_logs set changes = jsonb_build_object('erased', true)
   where (table_name = 'ai_contacts' and record_id = p_contact::text)
      or (table_name = 'ai_leads' and record_id in (select id::text from public.ai_leads where contact_id = p_contact))
      or (table_name in ('ai_financing_profiles','ai_financing_assessments') and record_id = any(coalesce(fin, '{}')));
  insert into public.ai_audit_logs (actor, action, table_name, record_id, changes)
  values (public.ai_actor(), 'erase_contact', 'ai_contacts', p_contact::text, jsonb_build_object('reason', p_reason));
end $$;

-- ---------------------------------------------------------------------------- grants
revoke all on function public.ai_lead_profile_set(uuid, jsonb, text, uuid, text) from public, anon;
revoke all on function public.ai_lead_profile_resolve(uuid, text, boolean) from public, anon;
revoke all on function public.ai_lead_summary_set(uuid, jsonb, text, uuid) from public, anon;
revoke all on function public.ai_lead_next_action(uuid, text) from public, anon;
revoke all on function public.ai_lead_set_stage(uuid, uuid, text, text, text) from public, anon;
revoke all on function public.ai_appointment_stage() from public, anon, authenticated;
grant execute on function public.ai_lead_profile_set(uuid, jsonb, text, uuid, text), public.ai_lead_profile_resolve(uuid, text, boolean),
  public.ai_lead_summary_set(uuid, jsonb, text, uuid), public.ai_lead_next_action(uuid, text),
  public.ai_lead_set_stage(uuid, uuid, text, text, text) to authenticated, service_role;

commit;
