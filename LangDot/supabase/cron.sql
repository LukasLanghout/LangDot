-- Heartbeat voor de achtergrond-worker: elke minuut roept Supabase de Vercel-app aan.
-- Draai dit NA de eerste Vercel-deploy, en vervang de twee placeholders.
--   <APP_URL>      bv. https://langdot.vercel.app
--   <CRON_SECRET>  dezelfde waarde als de env var CRON_SECRET in Vercel

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('langdot-tick')
where exists (select 1 from cron.job where jobname = 'langdot-tick');

select cron.schedule(
  'langdot-tick',
  '* * * * *',
  $$
  select net.http_post(
    url     := '<APP_URL>/api/worker/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <CRON_SECRET>'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
