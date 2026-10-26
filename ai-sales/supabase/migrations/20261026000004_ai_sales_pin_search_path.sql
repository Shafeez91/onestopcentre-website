-- Hardening (Supabase advisor 0011): pin search_path on the AI Sales helpers that did not set it.
-- They only use built-ins and fully qualified names, so an empty search_path changes nothing else.
alter function public.ai_actor() set search_path = '';
alter function public.ai_normalize_phone(text) set search_path = '';
alter function public.ai_block_change() set search_path = '';
alter function public.ai_kl(timestamptz) set search_path = '';
