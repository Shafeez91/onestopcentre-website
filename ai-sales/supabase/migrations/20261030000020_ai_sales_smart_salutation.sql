-- AI Sales migration 20 (30 Oct 2026): Smart Salutation. ADDITIVE ONLY: three nullable columns on ai_contacts.
-- The existing "salutation" column keeps its meaning (the title to use) and becomes the preferred salutation.
--   gender                 male / female / unknown / not_provided   (never guessed into this column: only a person
--                          or the buyer sets it; name recognition is worked out in code and never stored as fact)
--   salutation_confidence  confirmed / high / uncertain
--   salutation_source      customer / advisor / name_recognition / not_set
-- Existing rows: a salutation already typed by staff is marked as the advisor's. Nothing else changes.
-- Rollback: ai-sales/supabase/ROLLBACK-SMART-SALUTATION.sql
alter table public.ai_contacts add column if not exists gender text;
alter table public.ai_contacts add column if not exists salutation_confidence text;
alter table public.ai_contacts add column if not exists salutation_source text;

do $$ begin
  alter table public.ai_contacts add constraint ai_contacts_gender_chk check (gender is null or gender in ('male','female','unknown','not_provided'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.ai_contacts add constraint ai_contacts_salutation_confidence_chk check (salutation_confidence is null or salutation_confidence in ('confirmed','high','uncertain'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.ai_contacts add constraint ai_contacts_salutation_source_chk check (salutation_source is null or salutation_source in ('customer','advisor','name_recognition','not_set'));
exception when duplicate_object then null; end $$;

update public.ai_contacts set salutation_source = 'advisor', salutation_confidence = 'confirmed'
 where salutation is not null and trim(salutation) <> '' and salutation_source is null;

-- PDPA erase also clears these
create or replace function public.ai_contacts_erase_salutation() returns trigger language plpgsql set search_path = public as $$
begin
  if new.erased_at is not null and old.erased_at is null then
    new.salutation := null; new.gender := null; new.salutation_confidence := null; new.salutation_source := null;
  end if;
  return new;
end $$;
drop trigger if exists ai_contacts_erase_salutation on public.ai_contacts;
create trigger ai_contacts_erase_salutation before update of erased_at on public.ai_contacts for each row execute function public.ai_contacts_erase_salutation();
revoke all on function public.ai_contacts_erase_salutation() from public, anon, authenticated;
