-- LangDot 0.4: documenten (uploaden, lezen, vastzetten, als bijlage mailen). Draai na 0004. Idempotent.

create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  mime          text not null default 'application/octet-stream',
  size          bigint not null default 0,
  storage_path  text,                 -- null voor documenten die als tekst zijn geplakt
  text          text,                 -- geëxtraheerde tekst (afgekapt)
  text_chars    int not null default 0,
  status        text not null default 'ready' check (status in ('ready', 'unsupported', 'failed')),
  error         text,
  pinned        boolean not null default false,  -- "altijd meenemen" in elke prompt
  created_at    timestamptz not null default now()
);
create index if not exists documents_user_idx on public.documents(user_id, created_at desc);

alter table public.documents enable row level security;
-- Lezen, vastzetten en verwijderen van eigen documenten; aanmaken gaat via de server (die de tekst extraheert).
revoke insert on public.documents from anon, authenticated;
drop policy if exists "documents_read_own" on public.documents;
create policy "documents_read_own" on public.documents for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "documents_update_own" on public.documents;
create policy "documents_update_own" on public.documents for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "documents_delete_own" on public.documents;
create policy "documents_delete_own" on public.documents for delete to authenticated using (user_id = (select auth.uid()));

-- ───────────────────────── Opslag (privé bucket, max 25 MB per bestand) ─────────────────────────

insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = 26214400;

-- Iedereen alleen in zijn eigen map: documents/<user_id>/...
drop policy if exists "documents_storage_read_own" on storage.objects;
create policy "documents_storage_read_own" on storage.objects for select to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "documents_storage_insert_own" on storage.objects;
create policy "documents_storage_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "documents_storage_delete_own" on storage.objects;
create policy "documents_storage_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Realtime voor het Documenten-paneel.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'documents'
  ) then
    alter publication supabase_realtime add table public.documents;
  end if;
end $$;
