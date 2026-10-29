-- Paste this whole file into the Supabase SQL Editor and press Run (choose "Run without RLS" if asked). Safe to run twice.
-- AI Sales module — cache of Google Maps results for the AI's distance answers (2026-10-29). ADDITIVE ONLY.
--
--   ai_geo_cache   one row per looked-up item: a project's resolved map pin, a place found by search, or a route
--                  (origin → destination → travel mode). value holds what the AI may state (distance, duration, kind
--                  of distance, provider); fetched_at says when; expires_at when it must be looked up again.
-- No customer data is stored here: keys are project ids, place queries and coordinates. Only the server (service
-- role) reads and writes it; staff never need it directly.

create table if not exists public.ai_geo_cache (
  key         text primary key,
  kind        text not null check (kind in ('project','place','route')),
  value       jsonb not null,
  provider    text not null default 'google',
  fetched_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists ai_geo_cache_expires on public.ai_geo_cache (expires_at);
alter table public.ai_geo_cache enable row level security;
revoke all on public.ai_geo_cache from anon, authenticated;
grant all on public.ai_geo_cache to service_role;
comment on table public.ai_geo_cache is 'AI Sales: Google Maps lookups (project pins, places, routes) cached with provider and time; server only.';
