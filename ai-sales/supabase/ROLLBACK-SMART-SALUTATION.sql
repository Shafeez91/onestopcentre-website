-- Rollback of migration 20 (Smart Salutation). Removes only what migration 20 added; the salutation column and all
-- other data stay. Run in the Supabase SQL Editor if the feature must be withdrawn.
drop trigger if exists ai_contacts_erase_salutation on public.ai_contacts;
drop function if exists public.ai_contacts_erase_salutation();
alter table public.ai_contacts drop constraint if exists ai_contacts_gender_chk;
alter table public.ai_contacts drop constraint if exists ai_contacts_salutation_confidence_chk;
alter table public.ai_contacts drop constraint if exists ai_contacts_salutation_source_chk;
alter table public.ai_contacts drop column if exists gender;
alter table public.ai_contacts drop column if exists salutation_confidence;
alter table public.ai_contacts drop column if exists salutation_source;
