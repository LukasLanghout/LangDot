-- LangDot 0.3: push-meldingen en Google Calendar-acties. Draai na 0003. Idempotent.

-- ───────────────────────── Push-abonnementen (web push, per apparaat) ─────────────────────────

create table if not exists public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;
-- Lezen en verwijderen van eigen apparaten mag; aanmaken gaat via de server-route.
revoke insert, update on public.push_subscriptions from anon, authenticated;
drop policy if exists "push_read_own" on public.push_subscriptions;
create policy "push_read_own" on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "push_delete_own" on public.push_subscriptions;
create policy "push_delete_own" on public.push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()));

-- ───────────────────────── Nieuw actietype: afspraak inplannen ─────────────────────────

alter table public.pending_actions drop constraint if exists pending_actions_type_check;
alter table public.pending_actions add constraint pending_actions_type_check
  check (type in ('gmail_send', 'calendar_create_event'));
