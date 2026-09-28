// signal-screener: สแกนเทรนด์รายวัน -> รายงาน Telegram -> เพิ่ม/หยุดเฝ้าใน sig_watchlist อัตโนมัติ
// เกณฑ์: ราคา > MA50 > MA200 (ขาขึ้นชัด) เรียงตามผลตอบแทน 60 วัน, 🆕 = golden cross ใน 10 วัน หรือทำ high 55 วันใน 3 วัน
import { createClient } from "npm:@supabase/supabase-js@2";

type Bar = { t: number; h: number; c: number };
type Res = { symbol: string; roc60: number; fresh: boolean; tag: string; last: number };

const env = (k: string) => Deno.env.get(k) ?? "";
const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const DAY = 86400e3, ADD_N = 3, KEEP_N = 10, SHOW_N = 5, CRYPTO_N = 30;

const MKT: Record<string, { label: string; source: string; tf: string; params: Record<string, number>; sl: number }> = {
  crypto: { label: "คริปโต", source: "binance_spot", tf: "4h", params: { fast: 20, slow: 50 }, sl: 5 },
  th:     { label: "หุ้นไทย", source: "yahoo",        tf: "1d", params: { fast: 10, slow: 30 }, sl: 5 },
  us:     { label: "หุ้น US", source: "twelvedata",   tf: "1d", params: { fast: 20, slow: 50 }, sl: 6 },
};
const display = (s: string) => s.replace(/\.BK$/, "").replace(/USDT$/, "");

async function getJSON(url: string, headers: Record<string, string> = {}) {
  for (let a = 0; a < 2; a++) {
    const r = await fetch(url, { headers });
    if (r.ok) return r.json();
    if (a === 0 && (r.status === 429 || r.status >= 500)) { await new Promise((z) => setTimeout(z, 1500)); continue; }
    throw new Error(`HTTP ${r.status} ${url.split("?")[0]}`);
  }
}

async function cryptoUniverse(): Promise<string[]> {
  const t = await getJSON("https://data-api.binance.vision/api/v3/ticker/24hr");
  const stable = /^(USDC|FDUSD|TUSD|USDP|DAI|BUSD|EUR|AEUR|EURI|USD1|PYUSD|USDE|XUSD|BFUSD|RLUSD|PAXG|WBTC|WBETH|BNSOL)USDT$/;
  return t.filter((x: Record<string, string>) => x.symbol.endsWith("USDT") && !stable.test(x.symbol) && !/(UP|DOWN|BULL|BEAR)USDT$/.test(x.symbol))
    .sort((a: Record<string, string>, b: Record<string, string>) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, CRYPTO_N).map((x: Record<string, string>) => x.symbol);
}

async function binanceDaily(sym: string): Promise<Bar[]> {
  const rows = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1d&limit=300`);
  return rows.map((r: string[]) => ({ t: +r[0], h: +r[2], c: +r[4] }));
}

async function yahooDaily(sym: string): Promise<Bar[]> {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2y`,
    { "User-Agent": "Mozilla/5.0" });
  const r = j.chart?.result?.[0];
  if (!r?.timestamp) return [];
  const q = r.indicators.quote[0];
  return r.timestamp.map((t: number, i: number) => ({ t: t * 1000, h: q.high[i], c: q.close[i] })).filter((b: Bar) => b.c != null && b.h != null);
}

function sma(a: number[], n: number) {
  const r = Array(a.length).fill(NaN); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) r[i] = s / n; }
  return r;
}

function analyze(symbol: string, raw: Bar[]): Res | null {
  const now = Date.now();
  const bars = raw.filter((b) => b.t + DAY <= now);
  if (bars.length < 210) return null;
  const c = bars.map((b) => b.c), s50 = sma(c, 50), s200 = sma(c, 200), i = c.length - 1;
  if (!(c[i] > s50[i] && s50[i] > s200[i])) return null;
  let golden = false, hi55 = false;
  for (let j = i - 9; j <= i; j++) if (s50[j - 1] <= s200[j - 1] && s50[j] > s200[j]) golden = true;
  for (let j = i - 2; j <= i; j++) {
    let mx = -Infinity; for (let k = j - 55; k < j; k++) mx = Math.max(mx, bars[k].h);
    if (c[j] >= mx) hi55 = true;
  }
  return { symbol, roc60: c[i] / c[i - 60] - 1, fresh: golden || hi55,
    tag: golden ? "Golden cross" : hi55 ? "ทำ high 55 วัน" : "", last: c[i] };
}

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []; let k = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i]); } }));
  return out;
}

async function screen(market: string, symbols: string[]) {
  const fetcher = market === "crypto" ? binanceDaily : yahooDaily;
  const res = await mapLimit(symbols, 5, async (s) => { try { return analyze(s, await fetcher(s)); } catch { return null; } });
  const pass = res.filter((x): x is Res => !!x)
    .sort((a, b) => (Number(b.fresh) - Number(a.fresh)) || (b.roc60 - a.roc60));
  return { total: symbols.length, pass };
}

async function tg(text: string) {
  await fetch(`https://api.telegram.org/bot${env("TG_TOKEN")}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env("TG_CHAT_ID"), text }),
  });
}

async function run() {
  const { data: uni } = await sb.from("sig_universe").select("symbol,market").eq("active", true);
  const lists: Record<string, string[]> = {
    crypto: await cryptoUniverse(),
    th: (uni ?? []).filter((u) => u.market === "th").map((u) => u.symbol),
    us: (uni ?? []).filter((u) => u.market === "us").map((u) => u.symbol),
  };

  const { data: wl } = await sb.from("sig_watchlist").select("id,symbol,auto,active,market");
  const { data: st } = await sb.from("sig_state").select("watch_id,side");
  const sideOf = (id: number) => st?.find((s) => s.watch_id === id)?.side ?? 0;
  const today = new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Bangkok", day: "2-digit", month: "2-digit" });
  const lines = [`🔎 สแกนเทรนด์ ${today}`, "เกณฑ์: ราคา > MA50 > MA200 เรียงตามผลตอบแทน 60 วัน", "🆕 = เพิ่ง Golden cross หรือทำ high 55 วัน"];
  const screenRows: Record<string, unknown>[] = [];

  for (const m of ["crypto", "th", "us"]) {
    const cfg = MKT[m], { total, pass } = await screen(m, lists[m]);
    const add = pass.slice(0, ADD_N).map((r) => r.symbol);
    const keep = new Set(pass.slice(0, KEEP_N).map((r) => r.symbol));
    const added: string[] = [], removed: string[] = [];

    for (const sym of add) {
      const row = wl?.find((w) => w.symbol === sym);
      if (!row) {
        await sb.from("sig_watchlist").insert({ symbol: sym, name: display(sym), source: cfg.source, tf: cfg.tf, strategy: "ma_cross",
          params: cfg.params, allow_short: false, sl_pct: cfg.sl, tp_pct: 0, auto: true, market: m, active: true });
        added.push(display(sym));
      } else if (row.auto && !row.active) {
        await sb.from("sig_watchlist").update({ active: true }).eq("id", row.id);
        added.push(display(sym));
      }
    }
    for (const w of (wl ?? []).filter((w) => w.auto && w.active && w.market === m)) {
      if (!keep.has(w.symbol) && sideOf(w.id) === 0) {        // ไม่ถอดตัวที่ยังถือสถานะอยู่
        await sb.from("sig_watchlist").update({ active: false }).eq("id", w.id);
        removed.push(display(w.symbol));
      }
    }

    lines.push("", `${cfg.label} (ผ่านเกณฑ์ ${pass.length}/${total})`);
    pass.slice(0, SHOW_N).forEach((r, i) =>
      lines.push(`${i + 1}. ${display(r.symbol)} ${r.roc60 >= 0 ? "+" : ""}${(r.roc60 * 100).toFixed(1)}%${r.fresh ? ` 🆕 ${r.tag}` : ""}`));
    if (!pass.length) lines.push("ไม่มีตัวที่เข้าเกณฑ์วันนี้");
    if (added.length) lines.push(`➕ เพิ่มเข้าเฝ้า: ${added.join(", ")}`);
    if (removed.length) lines.push(`➖ หยุดเฝ้า (หลุดเกณฑ์): ${removed.join(", ")}`);
    pass.slice(0, KEEP_N).forEach((r, i) => screenRows.push({ market: m, symbol: r.symbol, rank: i + 1,
      roc60_pct: +(r.roc60 * 100).toFixed(2), tag: r.tag || null, last_price: r.last }));
  }

  lines.push("", "คัดตามเกณฑ์เทรนด์อัตโนมัติ ไม่ใช่คำแนะนำให้ซื้อ");
  if (screenRows.length) await sb.from("sig_screen").insert(screenRows);
  await tg(lines.join("\n"));
  return { ok: true, rows: screenRows.length };
}

Deno.serve(async (req) => {
  if (!env("CRON_SECRET") || req.headers.get("x-cron-secret") !== env("CRON_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  try { return Response.json(await run()); }
  catch (e) { return Response.json({ ok: false, error: String(e) }, { status: 500 }); }
});
