-- LangDot 0.2: tokenbudget, stappenlimiet, connectors (Gmail) en pending actions.
-- Draai na 0001 en 0002. Idempotent.

-- ───────────────────────── Tokenbudget per gebruiker per dag ─────────────────────────

create table if not exists public.dot_usage (
  user_id            uuid not null references auth.users(id) on delete cascade,
  day                date not null,
  prompt_tokens      bigint not null default 0,
  completion_tokens  bigint not null default 0,
  total_tokens       bigint not null default 0,
  requests           int not null default 0,
  primary key (user_id, day)
);
alter table public.dot_usage enable row level security;
drop policy if exists "dot_usage_read" on public.dot_usage;
create policy "dot_usage_read" on public.dot_usage for select to authenticated
  using (user_id = (select auth.uid()));

-- Atomisch optellen (alleen de server/service role mag dit aanroepen).
create or replace function public.dot_add_usage(p_user uuid, p_day date, p_prompt bigint, p_completion bigint)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.dot_usage (user_id, day, prompt_tokens, completion_tokens, total_tokens, requests)
  values (p_user, p_day, p_prompt, p_completion, p_prompt + p_completion, 1)
  on conflict (user_id, day) do update set
    prompt_tokens     = dot_usage.prompt_tokens + excluded.prompt_tokens,
    completion_tokens = dot_usage.completion_tokens + excluded.completion_tokens,
    total_tokens      = dot_usage.total_tokens + excluded.total_tokens,
    requests          = dot_usage.requests + 1;
$$;
revoke execute on function public.dot_add_usage(uuid, date, bigint, bigint) from public, anon, authenticated;

-- ───────────────────────── Taken en berichten ─────────────────────────

-- Aantal LLM-aanroepen per taak (begrensd via MAX_TASK_STEPS).
alter table public.dot_tasks add column if not exists step_count int not null default 0;

-- Een antwoord hoort hard bij het gebruikersbericht waarop het reageert.
alter table public.dot_messages add column if not exists reply_to uuid references public.dot_messages(id) on delete set null;

-- ───────────────────────── Connectors ─────────────────────────

create table if not exists public.connectors (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users(id) on delete cascade,
  provider                  text not null,
  account_email             text,
  scopes                    text[] not null default '{}',
  encrypted_access_token    text,
  encrypted_refresh_token   text,
  expires_at                timestamptz,
  status                    text not null default 'active' check (status in ('active','needs_reauth','revoked')),
  last_used_at              timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (user_id, provider)
);
alter table public.connectors enable row level security;

-- De browser mag eigen rijen lezen, maar NOOIT de (versleutelde) tokens: kolomrechten.
revoke all on public.connectors from anon, authenticated;
grant select (id, user_id, provider, account_email, scopes, expires_at, status, last_used_at, created_at, updated_at)
  on public.connectors to authenticated;
drop policy if exists "connectors_read_own" on public.connectors;
create policy "connectors_read_own" on public.connectors for select to authenticated
  using (user_id = (select auth.uid()));
-- Schrijven gebeurt alleen serverside met de service role.

-- ───────────────────────── Pending actions (goedkeuring vereist) ─────────────────────────

create table if not exists public.pending_actions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  task_id      uuid references public.dot_tasks(id) on delete set null,
  type         text not null check (type in ('gmail_send')),
  payload      jsonb not null,               -- { to: string[], subject: string, body: string }
  status       text not null default 'pending'
               check (status in ('pending','approved','rejected','executed','expired')),
  error        text,                         -- nette melding als versturen na goedkeuring mislukte
  result       jsonb,                        -- bv. { gmail_message_id }
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  executed_at  timestamptz
);
create index if not exists pending_actions_user_idx on public.pending_actions(user_id, created_at desc);
create index if not exists pending_actions_exec_idx on public.pending_actions(user_id, status, executed_at);

alter table public.pending_actions enable row level security;
revoke insert, update, delete on public.pending_actions from anon, authenticated;
drop policy if exists "pending_actions_read_own" on public.pending_actions;
create policy "pending_actions_read_own" on public.pending_actions for select to authenticated
  using (user_id = (select auth.uid()));
-- Status wijzigen kan alleen via de server-routes (goedkeuren = klik van de ingelogde gebruiker).

-- Realtime voor de goedkeuringskaarten (connectors bewust NIET: die bevatten tokens).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pending_actions'
  ) then
    alter publication supabase_realtime add table public.pending_actions;
  end if;
end $$;
