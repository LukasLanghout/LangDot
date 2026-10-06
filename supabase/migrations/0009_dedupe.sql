-- LangDot 0.8: documenten ontdubbelen op inhoud, en bijhouden welke nieuwslinks al zijn gemaild. Draai na 0008. Idempotent.

alter table public.documents add column if not exists sha256 text;
-- Dezelfde inhoud twee keer? Eén rij per gebruiker. Oude rijen zonder hash blijven ongemoeid.
create unique index if not exists documents_user_sha_idx on public.documents(user_id, sha256) where sha256 is not null;

create table if not exists public.sent_links (
  user_id  uuid not null references auth.users(id) on delete cascade,
  url      text not null,
  sent_at  timestamptz not null default now(),
  primary key (user_id, url)
);
create index if not exists sent_links_recent_idx on public.sent_links(user_id, sent_at desc);

-- Alleen de server (service role) gebruikt deze tabel; de browser heeft er geen toegang toe.
alter table public.sent_links enable row level security;
revoke all on public.sent_links from anon, authenticated;
