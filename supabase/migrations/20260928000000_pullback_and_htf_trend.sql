-- Needed by signal-scan's new optimizer before it is deployed:
--  * strategy 'pullback' (trend pullback on EMA)
--  * trend_mode: 'ma200' = price vs MA200 on the same timeframe (existing behaviour, default)
--                'htf'   = trend of the next higher timeframe (1h→4h, 4h→1d, 1d→1w)
alter table public.sig_watchlist drop constraint sig_watchlist_strategy_check;
alter table public.sig_watchlist add constraint sig_watchlist_strategy_check
  check (strategy = any (array['ma_cross', 'rsi', 'breakout', 'pullback']));

alter table public.sig_watchlist add column trend_mode text not null default 'ma200';
alter table public.sig_watchlist add constraint sig_watchlist_trend_mode_check
  check (trend_mode = any (array['ma200', 'htf']));
