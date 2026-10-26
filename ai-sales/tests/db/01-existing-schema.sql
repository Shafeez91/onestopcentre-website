-- Replica of the EXISTING production objects (as audited on 2026-10-26) so tests can prove the new
-- migration leaves them working. TEST HARNESS ONLY.
create table public.admins (email text primary key);
alter table public.admins enable row level security;

create function public.is_admin() returns boolean language sql stable security definer set search_path to 'public' as
  $$ select exists (select 1 from public.admins where lower(email) = lower(auth.jwt() ->> 'email')); $$;

create table public.projects (id text primary key, slug text unique, data jsonb, published boolean default true, updated_at timestamptz default now());
alter table public.projects enable row level security;
create policy "admin manages projects" on public.projects for all to authenticated using (is_admin()) with check (is_admin());
create policy "public reads published projects" on public.projects for select to anon, authenticated using (published or is_admin());

create table public.settings (id int primary key default 1 check (id = 1), data jsonb default '{}'::jsonb, updated_at timestamptz default now());
alter table public.settings enable row level security;
create policy "admin updates settings" on public.settings for update to authenticated using (is_admin()) with check (is_admin());
create policy "public reads settings" on public.settings for select to anon, authenticated using (true);

create table public.leads (
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(),
  name text not null check (char_length(name) >= 1 and char_length(name) <= 100),
  phone text check (char_length(phone) <= 30), email text check (char_length(email) <= 120),
  project text check (char_length(project) <= 150), message text check (char_length(message) <= 2000),
  consent boolean default false check (consent), status text default 'new');
alter table public.leads enable row level security;
create policy "admin deletes leads" on public.leads for delete to authenticated using (is_admin());
create policy "admin updates leads" on public.leads for update to authenticated using (is_admin()) with check (is_admin());
create policy "admin reads leads" on public.leads for select to authenticated using (is_admin());
create policy "anyone can send an enquiry" on public.leads for insert to anon, authenticated with check (true);

create function public.leads_guard() returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if (select count(*) from public.leads where created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'Too many enquiries right now. Please try again later.';
  end if;
  new.status := 'new'; new.created_at := now(); return new;
end $$;
create trigger leads_guard before insert on public.leads for each row execute function leads_guard();

create function public.touch_updated() returns trigger language plpgsql set search_path to '' as
  $$ begin new.updated_at := now(); return new; end $$;
create trigger projects_touch before update on public.projects for each row execute function touch_updated();
create trigger settings_touch before update on public.settings for each row execute function touch_updated();

insert into storage.buckets (id, name, public) values ('photos', 'photos', true);
create policy "admin uploads photos" on storage.objects for insert to authenticated with check (bucket_id = 'photos' and is_admin());
create policy "admin reads photos" on storage.objects for select to authenticated using (bucket_id = 'photos' and is_admin());

-- TEST FIXTURE ONLY
insert into public.settings (id, data) values (1, '{"wa":"60123456789"}');
insert into public.projects (id, slug, data) values
  ('t1', 'test-residence', '{"id":"t1","slug":"test-residence","n":"Test Residence","l":"Cheras"}'),
  ('t2', 'test-heights',   '{"id":"t2","slug":"test-heights","n":"Test Heights","l":"Setapak"}');
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-000000000001', 'owner@test.local', now()),
  ('00000000-0000-0000-0000-000000000002', 'advisor@test.local', now()),
  ('00000000-0000-0000-0000-000000000003', 'viewer@test.local', now()),
  ('00000000-0000-0000-0000-000000000004', 'unconfirmed@test.local', null),
  ('00000000-0000-0000-0000-000000000005', 'stranger@test.local', now()),
  ('00000000-0000-0000-0000-000000000006', 'manager@test.local', now());
insert into public.admins (email) values ('owner@test.local');
