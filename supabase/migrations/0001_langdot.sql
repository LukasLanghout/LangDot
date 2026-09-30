-- LangDot schema. Alle tabellen hebben prefix dot_ zodat ze naast bestaande tabellen kunnen leven.

-- ───────────────────────── Tabellen ─────────────────────────

create table if not exists public.dot_profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  name        text not null,
  handle      text not null,
  shape       text not null default 'circle',
  color       text not null default '#7c5cff',
  eyes        text not null default 'round',
  accessory   text not null default 'none',
  paused      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.dot_tasks (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  title          text not null,
  instructions   text not null default '',
  status         text not null default 'pending'
                 check (status in ('pending','running','needs_input','done','cancelled','failed')),
  steps          jsonb not null default '[]'::jsonb,  -- [{title, status, result}]
  current_step   int not null default 0,
  question       text,
  options        jsonb,                                -- [{label, approves}]
  answer         text,
  pending_action jsonb,                                -- actie die pas na "ja" wordt uitgevoerd
  result         text,
  error          text,
  source         text not null default 'chat',         -- chat | schedule
  schedule_id    uuid,
  attempts       int not null default 0,
  locked_until   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists dot_tasks_user_idx on public.dot_tasks(user_id, created_at desc);
create index if not exists dot_tasks_status_idx on public.dot_tasks(status);

create table if not exists public.dot_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('user','assistant')),
  content     text not null,
  task_id     uuid references public.dot_tasks(id) on delete set null,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists dot_messages_user_idx on public.dot_messages(user_id, created_at desc);

create table if not exists public.dot_memories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null default 'fact' check (kind in ('preference','decision','work','fact')),
  content     text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists dot_memories_user_idx on public.dot_memories(user_id, updated_at desc);

create table if not exists public.dot_schedules (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  title        text not null,
  prompt       text not null,
  days         int[] not null default '{1,2,3,4,5}',  -- ISO: 1=ma … 7=zo
  time_of_day  text not null default '09:00',         -- HH:MM
  timezone     text not null default 'Europe/Amsterdam',
  active       boolean not null default true,
  next_run_at  timestamptz,
  last_run_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists dot_schedules_due_idx on public.dot_schedules(active, next_run_at);

create table if not exists public.dot_drafts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  task_id     uuid references public.dot_tasks(id) on delete set null,
  channel     text not null default 'email',
  recipient   text,
  subject     text,
  body        text not null,
  status      text not null default 'draft' check (status in ('draft','approved','rejected')),
  created_at  timestamptz not null default now()
);
create index if not exists dot_drafts_user_idx on public.dot_drafts(user_id, created_at desc);

create table if not exists public.dot_audit (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  actor       text not null check (actor in ('agent','user','system')),
  action      text not null,
  tool        text,
  task_id     uuid,
  input       jsonb,
  output      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists dot_audit_user_idx on public.dot_audit(user_id, created_at desc);

-- ───────────────────────── RLS ─────────────────────────
-- De browser mag alleen eigen rijen zien. De worker gebruikt de service-role key.

alter table public.dot_profiles  enable row level security;
alter table public.dot_tasks     enable row level security;
alter table public.dot_messages  enable row level security;
alter table public.dot_memories  enable row level security;
alter table public.dot_schedules enable row level security;
alter table public.dot_drafts    enable row level security;
alter table public.dot_audit     enable row level security;

do $$
declare t text;
begin
  foreach t in array array['dot_profiles','dot_tasks','dot_messages','dot_memories','dot_schedules','dot_drafts'] loop
    execute format('drop policy if exists "%1$s_own" on public.%1$s', t);
    execute format(
      'create policy "%1$s_own" on public.%1$s for all to authenticated
         using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

-- Audit-log: alleen lezen en toevoegen, nooit wijzigen of verwijderen.
drop policy if exists "dot_audit_read" on public.dot_audit;
create policy "dot_audit_read" on public.dot_audit for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "dot_audit_insert" on public.dot_audit;
create policy "dot_audit_insert" on public.dot_audit for insert to authenticated
  with check (user_id = (select auth.uid()) and actor = 'user');

-- ───────────────────────── Realtime ─────────────────────────

do $$
declare t text;
begin
  foreach t in array array['dot_profiles','dot_tasks','dot_messages','dot_memories','dot_schedules','dot_drafts','dot_audit'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
