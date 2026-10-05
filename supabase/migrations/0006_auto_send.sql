-- LangDot 0.5: staande toestemming om vanuit een schema automatisch naar JEZELF te mailen. Draai na 0005. Idempotent.

-- Per schema: mag de dot zonder per-keer-goedkeuring mailen, en naar welk (eigen) adres.
alter table public.dot_schedules add column if not exists auto_send boolean not null default false;
alter table public.dot_schedules add column if not exists auto_send_to text;
alter table public.dot_schedules add column if not exists auto_send_granted_at timestamptz;

-- Wie keurde een actie goed: 'user' (klik) of 'standing' (staande toestemming van een schema).
alter table public.pending_actions add column if not exists approved_by text;

-- Nieuw actietype: de eenmalige toestemmingskaart zelf.
alter table public.pending_actions drop constraint if exists pending_actions_type_check;
alter table public.pending_actions add constraint pending_actions_type_check
  check (type in ('gmail_send', 'calendar_create_event', 'schedule_auto_send'));
