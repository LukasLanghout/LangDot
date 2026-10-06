-- LangDot 0.7: actietype schedule_delete (schema verwijderen via goedkeuringskaart). Draai na 0007. Idempotent.
alter table public.pending_actions drop constraint if exists pending_actions_type_check;
alter table public.pending_actions add constraint pending_actions_type_check
  check (type in ('gmail_send', 'calendar_create_event', 'schedule_auto_send', 'schedule_delete'));