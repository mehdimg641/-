-- Every minute, ask the Core to deliver replies the operator approved in the inbox.
-- /outbox needs no secret: it only sends replies already approved and claimed once by the inbox.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('sepand-outbox') where exists (select 1 from cron.job where jobname = 'sepand-outbox');
select cron.schedule(
  'sepand-outbox',
  '* * * * *',
  $$select net.http_get('https://qzbfsnjekxmvesiekyxc.supabase.co/functions/v1/sepand-core/outbox', timeout_milliseconds := 30000)$$
);
