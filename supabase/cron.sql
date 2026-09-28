-- pg_cron jobs as configured in the live project (times are UTC; Bangkok = UTC+7).
-- The secret is read from Supabase Vault (name: sig_cron_secret) at run time, so nothing sensitive is stored here.
-- signal-scan with no ?job= runs the default scan job.

select cron.schedule('signal-scan-every-5min', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://feiyuytifgiylgxtvohh.supabase.co/functions/v1/signal-scan',
    headers := jsonb_build_object('Content-Type','application/json','x-region','ap-southeast-1',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name='sig_cron_secret'),'')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
$$);

select cron.schedule('signal-screen-daily', '0 1 * * *', $$
  select net.http_post(
    url := 'https://feiyuytifgiylgxtvohh.supabase.co/functions/v1/signal-scan?job=screen',
    headers := jsonb_build_object('Content-Type','application/json','x-region','ap-southeast-1',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name='sig_cron_secret'),'')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$$);

select cron.schedule('signal-optimize-daily', '20 1 * * *', $$
  select net.http_post(
    url := 'https://feiyuytifgiylgxtvohh.supabase.co/functions/v1/signal-scan?job=optimize',
    headers := jsonb_build_object('Content-Type','application/json','x-region','ap-southeast-1',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name='sig_cron_secret'),'')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$$);

select cron.schedule('signal-weekly', '0 13 * * 0', $$
  select net.http_post(
    url := 'https://feiyuytifgiylgxtvohh.supabase.co/functions/v1/signal-scan?job=weekly',
    headers := jsonb_build_object('Content-Type','application/json','x-region','ap-southeast-1',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name='sig_cron_secret'),'')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$$);

select cron.schedule('signal-backtest-daily', '40 1 * * *', $$
  select net.http_post(
    url := 'https://feiyuytifgiylgxtvohh.supabase.co/functions/v1/signal-scan?job=backtest',
    headers := jsonb_build_object('Content-Type','application/json','x-region','ap-southeast-1',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name='sig_cron_secret'),'')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$$);

select cron.schedule('signal-watch-5min', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://feiyuytifgiylgxtvohh.supabase.co/functions/v1/signal-lab?job=watch',
    headers := jsonb_build_object('Content-Type','application/json','x-region','ap-southeast-1',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name='sig_cron_secret'),'')),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
$$);

select cron.schedule('signal-rank-daily', '10 2 * * *', $$
  select net.http_post(
    url := 'https://feiyuytifgiylgxtvohh.supabase.co/functions/v1/signal-lab?job=rank',
    headers := jsonb_build_object('Content-Type','application/json','x-region','ap-southeast-1',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name='sig_cron_secret'),'')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$$);

select cron.schedule('signal-equity-daily', '55 16 * * *', $$
  select net.http_post(
    url := 'https://feiyuytifgiylgxtvohh.supabase.co/functions/v1/signal-lab?job=snapshot',
    headers := jsonb_build_object('Content-Type','application/json','x-region','ap-southeast-1',
      'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name='sig_cron_secret'),'')),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
$$);
