-- Snapshot of the public schema in Supabase project "Trading" (feiyuytifgiylgxtvohh), taken 2026-09-28.
-- Reference only: the live database is the source of truth. Changes go in supabase/migrations/.

create table public.sig_watchlist (
  id bigint generated always as identity not null,
  symbol text not null,
  name text,
  source text not null,
  tf text not null,
  strategy text not null,
  params jsonb not null default '{}'::jsonb,
  allow_short boolean not null default false,
  sl_pct numeric not null default 0,
  tp_pct numeric not null default 0,
  active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  auto boolean not null default false,
  market text,
  trend_filter boolean not null default true,
  vol_filter boolean not null default false,
  optimized_at timestamp with time zone,
  manual boolean not null default false,
  sl_mode text not null default 'atr'::text,
  atr_mult numeric not null default 2,
  tp_r numeric not null default 0,
  constraint sig_watchlist_pkey PRIMARY KEY (id),
  constraint sig_watchlist_sl_mode_check CHECK ((sl_mode = ANY (ARRAY['atr'::text, 'pct'::text]))),
  constraint sig_watchlist_source_check CHECK ((source = ANY (ARRAY['binance_spot'::text, 'binance_futures'::text, 'twelvedata'::text, 'yahoo'::text]))),
  constraint sig_watchlist_strategy_check CHECK ((strategy = ANY (ARRAY['ma_cross'::text, 'rsi'::text, 'breakout'::text]))),
  constraint sig_watchlist_tf_check CHECK ((tf = ANY (ARRAY['15m'::text, '1h'::text, '4h'::text, '1d'::text])))
);

create table public.sig_state (
  watch_id bigint not null,
  side smallint not null default 0,
  entry numeric not null default 0,
  last_bar timestamp with time zone,
  next_check timestamp with time zone,
  cfg_key text,
  last_error text,
  updated_at timestamp with time zone not null default now(),
  last_price numeric,
  last_test jsonb,
  trigger text,
  sl numeric,
  tp numeric,
  constraint sig_state_pkey PRIMARY KEY (watch_id),
  constraint sig_state_watch_id_fkey FOREIGN KEY (watch_id) REFERENCES sig_watchlist(id) ON DELETE CASCADE
);

create table public.sig_alerts (
  id bigint generated always as identity not null,
  watch_id bigint,
  symbol text,
  kind text,
  side smallint,
  price numeric,
  reason text,
  pnl_pct numeric,
  bar_close timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  sl numeric,
  tp numeric,
  constraint sig_alerts_pkey PRIMARY KEY (id),
  constraint sig_alerts_watch_id_fkey FOREIGN KEY (watch_id) REFERENCES sig_watchlist(id) ON DELETE SET NULL
);

create table public.sig_backtest (
  watch_id bigint not null,
  run_at timestamp with time zone not null default now(),
  cfg text,
  split_i integer,
  times jsonb,
  closes jsonb,
  trades jsonb,
  stats jsonb,
  constraint sig_backtest_pkey PRIMARY KEY (watch_id),
  constraint sig_backtest_watch_id_fkey FOREIGN KEY (watch_id) REFERENCES sig_watchlist(id) ON DELETE CASCADE
);

create table public.sig_optimize (
  id bigint generated always as identity not null,
  run_at timestamp with time zone not null default now(),
  watch_id bigint,
  symbol text,
  strategy text,
  params jsonb,
  trend_filter boolean,
  train_pct numeric,
  test_pct numeric,
  bh_test_pct numeric,
  trades integer,
  action text,
  constraint sig_optimize_pkey PRIMARY KEY (id),
  constraint sig_optimize_watch_id_fkey FOREIGN KEY (watch_id) REFERENCES sig_watchlist(id) ON DELETE SET NULL
);

create table public.sig_trades (
  id bigint generated always as identity not null,
  watch_id bigint,
  alert_id bigint,
  symbol text,
  name text,
  market text,
  side smallint,
  status text not null default 'open'::text,
  signal_price numeric,
  entry numeric,
  sl numeric,
  tp numeric,
  sl_pct numeric,
  exit numeric,
  pnl_pct numeric,
  r_mult numeric,
  be_alerted boolean not null default false,
  sl_alerted boolean not null default false,
  opened_at timestamp with time zone not null default now(),
  closed_at timestamp with time zone,
  qty numeric,
  cost numeric,
  realized numeric not null default 0,
  constraint sig_trades_pkey PRIMARY KEY (id),
  constraint sig_trades_watch_id_fkey FOREIGN KEY (watch_id) REFERENCES sig_watchlist(id) ON DELETE SET NULL,
  constraint sig_trades_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text, 'skipped'::text])))
);

create table public.sig_settings (
  id integer not null default 1,
  balance_usd numeric not null default 1000,
  balance_thb numeric not null default 30000,
  risk_pct numeric not null default 1,
  markets jsonb not null default '{"fx": true, "th": false, "us": false, "gold": true, "crypto": true}'::jsonb,
  board_msg_id bigint,
  max_same_dir integer not null default 3,
  daily_loss_pct numeric not null default 3,
  news_fetched_at timestamp with time zone,
  max_lev numeric not null default 10,
  constraint sig_settings_pkey PRIMARY KEY (id),
  constraint sig_settings_id_check CHECK ((id = 1))
);

create table public.sig_pending (
  msg_id bigint not null,
  action text not null,
  ref_id bigint,
  created_at timestamp with time zone not null default now(),
  data jsonb,
  constraint sig_pending_pkey PRIMARY KEY (msg_id)
);

create table public.sig_news (
  key text not null,
  title text,
  country text,
  at timestamp with time zone,
  impact text,
  alerted boolean not null default false,
  constraint sig_news_pkey PRIMARY KEY (key)
);

create table public.sig_universe (
  symbol text not null,
  market text not null,
  active boolean not null default true,
  constraint sig_universe_pkey PRIMARY KEY (symbol),
  constraint sig_universe_market_check CHECK ((market = ANY (ARRAY['th'::text, 'us'::text])))
);

create table public.sig_screen (
  id bigint generated always as identity not null,
  run_date date not null default CURRENT_DATE,
  market text,
  symbol text,
  rank integer,
  roc60_pct numeric,
  tag text,
  last_price numeric,
  created_at timestamp with time zone not null default now(),
  constraint sig_screen_pkey PRIMARY KEY (id)
);

create table public.sig_rank (
  market text not null,
  rank integer not null,
  symbol text not null,
  name text,
  side smallint not null default 1,
  score numeric,
  price numeric,
  chg1d numeric,
  roc30 numeric,
  roc90 numeric,
  rsi numeric,
  atr_pct numeric,
  flags text[] not null default '{}'::text[],
  lines text,
  metrics jsonb,
  run_at timestamp with time zone not null default now(),
  constraint sig_rank_pkey PRIMARY KEY (market, rank)
);

create table public.sig_rank_meta (
  market text not null,
  run_at timestamp with time zone not null default now(),
  universe integer,
  passed integer,
  summary text,
  stats jsonb,
  constraint sig_rank_meta_pkey PRIMARY KEY (market)
);

create table public.sig_health_state (
  key text not null,
  ok boolean not null default true,
  fails integer not null default 0,
  since timestamp with time zone not null default now(),
  detail text,
  alerted_at timestamp with time zone,
  constraint sig_health_state_pkey PRIMARY KEY (key)
);

create table public.sig_equity (
  day date not null,
  total numeric,
  cash numeric,
  value numeric,
  cost numeric,
  unreal numeric,
  realized numeric,
  open_n integer,
  holdings jsonb,
  created_at timestamp with time zone not null default now(),
  constraint sig_equity_pkey PRIMARY KEY (day)
);

-- Used by signal-lab's watchdog (/health).
CREATE OR REPLACE FUNCTION public.sig_health()
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'last_scan_ok', (select max(created) from net._http_response
                     where status_code = 200 and content like '{"ok":true,"report"%'),
    'bad_recent', (select coalesce(jsonb_agg(jsonb_build_object('t', created, 'code', status_code,
                     'err', coalesce(error_msg, ''), 'body', left(coalesce(content, ''), 120)) order by created desc), '[]'::jsonb)
                   from (select * from net._http_response
                         where created > now() - interval '30 minutes'
                           and (status_code is null or status_code >= 400 or error_msg is not null or timed_out)
                         order by created desc limit 5) b),
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object('name', jobname, 'active', active, 'schedule', schedule)), '[]'::jsonb)
             from cron.job where jobname like 'signal-%'),
    'cron_last', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
                    select distinct on (d.jobid) j.jobname, d.status,
                           left(coalesce(d.return_message, ''), 120) as return_message, d.end_time
                    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
                    where j.jobname like 'signal-%'
                    order by d.jobid, d.start_time desc) x)
  );
$function$;
