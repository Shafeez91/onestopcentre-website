-- AI Sales module — archive appointments to keep the Appointments list focused. ADDITIVE ONLY.
-- Archiving only hides a row from the list (it can be restored); it never changes the status, so it sends no
-- Telegram alert or WhatsApp message and leaves reminders alone. Nothing is deleted.
alter table public.ai_appointments add column if not exists archived_at timestamptz;
alter table public.ai_appointments add column if not exists archived_by text;
