// signal-compare - เทียบ backtest logic เดิม (ที่ deploy อยู่) กับ logic ใหม่ ด้วยข้อมูลจริง · อ่านอย่างเดียว ไม่เขียน DB ไม่ส่ง Telegram
// POST ?ids=1,2,3[&tf=4h] (header x-cron-secret) → JSON ต่อ 1 ตัวในรายการเฝ้า · แบ่งเป็นชุดเล็กเพื่อไม่ให้เกินเวลา CPU ต่อ request
// ก่อน: 1,000 แท่ง · ค่าธรรมเนียม 0.1%/ฝั่ง · กรองเทรนด์ MA200 · เลือกจากกำไรช่วงเรียนรู้ (≥3 ไม้) ผ่านถ้าช่วงทดสอบ > 0
// หลัง: 3,000 แท่ง · ต้นทุนตามตลาด · กรองเทรนด์ TF ใหญ่ · มี pullback · เลือกจาก PF (≥15 ไม้) ผ่านถ้าช่วงทดสอบ ≥5 ไม้, PF ≥ 1.1, กำไร > 0
// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  type Bar, CANDS, costOf, describe, evaluate, passes, pickBest, prep, type Res, sim, type Sim, TF_SEC,
} from "../signal-scan/strategy.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const OLD_BARS = 1000, NEW_BARS = 3000, OLD_FEE = 0.001;
const OLD_CANDS = CANDS.filter((c) => c.strategy !== "pullback");
const NEW_CANDS = CANDS.map((c) => ({ ...c, trend_mode: c.trend_filter ? "htf" : "ma200" }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url: string, headers: Record<string, string> = {}) {
  for (let a = 0; a < 3; a++) {
    const r = await fetch(url, { headers });
    if (r.ok) return r.json();
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * (a + 1)); continue; }
    throw new Error(`HTTP ${r.status} ${url.split("?")[0]}`);
  }
  throw new Error(`retries exhausted ${url.split("?")[0]}`);
}

async function binance(sym: string, tf: string, futures: boolean, n: number): Promise<Bar[]> {
  const base = futures ? "https://fapi.binance.com/fapi/v1/klines" : "https://data-api.binance.vision/api/v3/klines";
  let out: Bar[] = [], end = 0;
  while (out.length < n) {
    const lim = Math.min(1000, n - out.length);
    const rows = await getJSON(`${base}?symbol=${sym}&interval=${tf}&limit=${lim}${end ? `&endTime=${end}` : ""}`);
    const bars: Bar[] = rows.map((r: any[]) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
    out = [...bars, ...out];
    if (bars.length < lim) break;
    end = bars[0].t - 1;
  }
  return out;
}

async function twelve(sym: string, tf: string, n: number): Promise<Bar[]> {
  const iv = ({ "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day" } as any)[tf];
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${iv}` +
    `&outputsize=${Math.min(n, 5000)}&timezone=UTC&order=asc&apikey=${env("TWELVEDATA_KEY")}`;
  let j = await getJSON(url);
  if (j.code === 429) { await sleep(15000); j = await getJSON(url); }
  if (j.status === "error") throw new Error("Twelve Data: " + j.message);
  return j.values.map((v: any) => ({
    t: Date.parse(v.datetime.length === 10 ? v.datetime + "T00:00:00Z" : v.datetime.replace(" ", "T") + "Z"),
    o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +(v.volume ?? 0),
  }));
}

async function yahoo(sym: string, tf: string, n: number): Promise<Bar[]> {
  const iv = tf === "4h" ? "1h" : tf;
  const range = tf === "4h" ? "2y" : ({ "15m": "60d", "1h": "1y", "1d": n > 1000 ? "10y" : "5y" } as any)[iv];
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&range=${range}`,
    { "User-Agent": "Mozilla/5.0" });
  const r = j.chart?.result?.[0];
  if (!r?.timestamp) throw new Error("Yahoo ไม่มีข้อมูล " + sym);
  const q = r.indicators.quote[0];
  let bars: Bar[] = r.timestamp.map((t: number, i: number) => ({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] ?? 0 }))
    .filter((b: Bar) => b.o != null && b.c != null && b.h != null && b.l != null);
  if (tf === "4h") {
    const size = 4 * 3600e3, agg: Bar[] = [];
    for (const b of bars) {
      const t = Math.floor(b.t / size) * size, last = agg[agg.length - 1];
      if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v || 0; }
      else agg.push({ ...b, t, v: b.v || 0 });
    }
    bars = agg;
  }
  return bars;
}

async function closedBars(w: any, n: number) {
  const raw = w.source === "twelvedata" ? await twelve(w.symbol, w.tf, n + 1)
    : w.source.startsWith("binance") ? await binance(w.symbol, w.tf, w.source === "binance_futures", n + 1) : await yahoo(w.symbol, w.tf, n);
  const now = Date.now(), step = TF_SEC[w.tf] * 1000;
  return raw.filter((b) => b.t + step <= now).slice(-n);
}

const fin = (x: number) => isFinite(x) ? +x.toFixed(3) : null;
const out = (s: Sim) => ({ ret: +s.ret.toFixed(4), pf: fin(s.pf), trades: s.trades, wins: s.wins, dd: +s.dd.toFixed(4) });
const pick = (w: any, r: Res | undefined, ok: boolean) => r ? { cfg: describe({ ...w, ...r }), tr: out(r.tr), te: out(r.te), pass: ok } : null;

async function compare(w: any) {
  const newBars = await closedBars(w, NEW_BARS), oldBars = newBars.slice(-OLD_BARS);
  const on = oldBars.length, os = Math.floor(on * 0.7), nn = newBars.length, ns = Math.floor(nn * 0.7);
  const cur = { ...w, trend_mode: undefined };   // กลยุทธ์ที่ใช้อยู่จริงตอนนี้ (ยังเป็น MA200)
  const curOld = sim(oldBars, cur, os, on - 1, prep(oldBars, cur), undefined, OLD_FEE);
  const curNew = sim(newBars, cur, ns, nn - 1, prep(newBars, cur), undefined, costOf(w));
  const oldRes: Res[] = OLD_CANDS.map((c) => { const t = { ...cur, ...c }, pr = prep(oldBars, t);
    return { ...c, tr: sim(oldBars, t, 0, os - 1, pr, undefined, OLD_FEE), te: sim(oldBars, t, os, on - 1, pr, undefined, OLD_FEE) }; });
  const ob = oldRes.filter((r) => r.tr.trades >= 3).sort((a, b) => b.tr.ret - a.tr.ret)[0];
  const nb = pickBest(evaluate(newBars, cur, NEW_CANDS));
  return {
    id: w.id, symbol: w.symbol, tf: w.tf, auto: w.auto, current: describe(cur), bars: { old: on, new: nn },
    days: { old: Math.round((oldBars[on - 1].t - oldBars[0].t) / 864e5), new: Math.round((newBars[nn - 1].t - newBars[0].t) / 864e5) },
    bh_test: { old: +(oldBars[on - 1].c / oldBars[os].c - 1).toFixed(4), new: +(newBars[nn - 1].c / newBars[ns].c - 1).toFixed(4) },
    cur_old: out(curOld), cur_new: out(curNew),
    opt_old: pick(cur, ob, !!ob && ob.te.ret > 0), opt_new: pick(cur, nb, !!nb && passes(nb)),
  };
}

Deno.serve(async (req) => {
  if (!env("CRON_SECRET") || req.headers.get("x-cron-secret") !== env("CRON_SECRET")) return new Response("unauthorized", { status: 401 });
  const url = new URL(req.url), tf = url.searchParams.get("tf");   // ?tf=4h ลองทั้งชุดด้วย TF อื่น
  const ids = (url.searchParams.get("ids") ?? "").split(",").map(Number).filter((x) => x > 0);
  let q = sb.from("sig_watchlist").select("*").eq("active", true).order("id");
  if (ids.length) q = q.in("id", ids);
  const { data: ws, error } = await q;
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  const rows: any[] = [];
  for (const w0 of ws ?? []) {
    const w = tf && TF_SEC[tf] ? { ...w0, tf } : w0;
    try { rows.push(await compare(w)); } catch (e) { rows.push({ id: w.id, symbol: w.symbol, tf: w.tf, error: e instanceof Error ? e.message : String(e) }); }
  }
  return Response.json({ ok: true, rows });
});
