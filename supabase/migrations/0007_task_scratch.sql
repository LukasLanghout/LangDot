-- LangDot 0.6: tussenstand van een lopende taakstap, zodat een volgende tick verdergaat i.p.v. opnieuw begint. Idempotent.
alter table public.dot_tasks add column if not exists scratch jsonb;