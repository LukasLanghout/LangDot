-- Koppeling met Caura (gedeeld geheugen): onthoud per notitie het Caura-id zodat bewerken/verwijderen synchroniseert.
alter table public.dot_memories add column if not exists caura_id text;
