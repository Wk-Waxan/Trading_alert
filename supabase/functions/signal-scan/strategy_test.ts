import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  type Bar, costOf, ema, entryFilters, evaluate, htfTrend, MIN_TRAIN_TRADES, passes, pickBest, rawSignals, type Res, sim, type Sim, step,
} from "./strategy.ts";

const H = 3600e3;
// แท่งจากราคาปิด: open = ปิดก่อนหน้า, high/low ห่างจาก max/min ของ open-close เท่ากับ wick
function mkBars(closes: number[], stepMs = H, t0 = Date.UTC(2025, 0, 6), wick = 0.2): Bar[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: t0 + i * stepMs, o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c, v: 100 };
  });
}
// random walk แบบกำหนด seed (ผลเหมือนเดิมทุกครั้ง)
function walk(n: number, drift: number, seed = 1) {
  let x = seed, p = 100; const out: number[] = [];
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) % 2147483648; p *= 1 + drift + (x / 2147483648 - 0.5) * 0.02; out.push(p); }
  return out;
}
const wave = (n: number, drift: number, amp = 3, period = 40) => Array.from({ length: n }, (_, i) => 100 + drift * i + amp * Math.sin(i * 2 * Math.PI / period));

Deno.test("ema starts from SMA seed and follows the standard recursion", () => {
  const e = ema([1, 2, 3, 4, 5], 3);
  assert(isNaN(e[1]));
  assertEquals(e[2], 2);
  assertEquals(e[3], 3);   // 4*0.5 + 2*0.5
  assertEquals(e[4], 4);
});

Deno.test("htfTrend never uses a higher-timeframe bar before it has closed", () => {
  for (const [tf, stepMs, n] of [["1h", H, 700], ["1d", 24 * H, 500]] as const) {
    const bars = mkBars(wave(n, 0.05, 4, 90), stepMs);
    const full = htfTrend(bars, tf);
    for (let i = 0; i < n; i += 7) {
      const partial = htfTrend(bars.slice(0, i + 1), tf);
      assertEquals(partial[i], full[i], `${tf} bar ${i} changed when future bars were removed`);
    }
    assert(full.some((x) => x === 1), `${tf} should detect an uptrend on a rising series`);
  }
});

Deno.test("htfTrend is 0 until the higher timeframe has enough history", () => {
  const bars = mkBars(wave(150, 0.1), H);   // 150 1h bars = 37 4h bars < EMA50 warm-up
  assert(htfTrend(bars, "1h").every((x) => x === 0));
});

Deno.test("trend_mode htf blocks longs in a downtrend and shorts in an uptrend", () => {
  const up = mkBars(wave(800, 0.05), H), dn = mkBars(wave(800, -0.05).map((x) => x + 60), H);
  const w = { tf: "1h", trend_filter: true, trend_mode: "htf" };
  const fu = entryFilters(up, w), fd = entryFilters(dn, w);
  assert(fu.okL.at(-1) && !fu.okS.at(-1));
  assert(fd.okS.at(-1) && !fd.okL.at(-1));
});

Deno.test("legacy trend filter (no trend_mode) still uses MA200 of the same timeframe", () => {
  const bars = mkBars(wave(300, 0.05), H);
  const f = entryFilters(bars, { tf: "1h", trend_filter: true });
  assert(!f.okL[150], "MA200 is not defined yet at bar 150, so entries are blocked");
  assert(f.okL.at(-1));
});

Deno.test("pullback fires a long after a dip to EMA20 in an uptrend, not while price runs away", () => {
  // ขาขึ้นชัน 80 แท่ง → ย่อ 6 แท่งลงต่ำกว่า EMA20 → ดีดกลับ
  const closes: number[] = [];
  for (let i = 0; i < 80; i++) closes.push(100 + i);
  for (let i = 0; i < 6; i++) closes.push(closes.at(-1)! - 2.5);
  for (let i = 0; i < 4; i++) closes.push(closes.at(-1)! + 3);
  const bars = mkBars(closes);
  const sig = rawSignals(bars, "pullback", { fast: 20, slow: 50 });
  const firstL = sig.findIndex((s) => s === "L");
  assert(firstL >= 86, `expected first long after the dip, got index ${firstL}`);
  assertEquals(sig.slice(0, 80).filter(Boolean).length, 0, "no signal during the uninterrupted run-up");
});

Deno.test("sim charges round-trip cost by market", () => {
  const bars = mkBars([100, 100, 100, 100, 110, 110]);
  const pre = { sig: [null, "L", null, null, "S", null], okL: Array(6).fill(true), okS: Array(6).fill(true), atr: Array(6).fill(NaN) };
  const fx = { symbol: "EURUSD=X", source: "yahoo", allow_short: false, sl_mode: "pct", sl_pct: 0 };
  const cr = { symbol: "BTCUSDT", source: "binance_spot", allow_short: false, sl_mode: "pct", sl_pct: 0 };
  assertAlmostEquals(sim(bars, fx, 0, 5, pre).ret, 0.1 - 2 * costOf(fx), 1e-12);
  assertAlmostEquals(sim(bars, cr, 0, 5, pre).ret, 0.1 - 2 * costOf(cr), 1e-12);
  assert(costOf(fx) < costOf(cr));
});

Deno.test("step exits at the stop loss before looking at new signals", () => {
  const w = { allow_short: false, sl_mode: "pct", sl_pct: 2, tp_pct: 0 };
  const [pos, ev] = step({ side: 1, entry: 100, sl: 98 }, { t: 0, o: 99, h: 99, l: 97, c: 98.5, v: 0 }, null, w, true, true);
  assertEquals(pos.side, 0);
  assertEquals(ev[0].reason, "โดน Stop loss");
  assertEquals(ev[0].price, 98);
});

const S = (trades: number, pf: number, ret: number): Sim => ({ ret, trades, wins: 0, dd: 0, pf, avg: 0 });
Deno.test("optimizer ignores candidates with too few trades and ranks by profit factor", () => {
  const res: Res[] = [
    { id: "lucky", tr: S(4, 9, 3.0), te: S(2, 5, 1.0) },            // กำไรสูงแต่ไม่กี่ไม้ → ไม่นับ
    { id: "steady", tr: S(40, 1.6, 0.3), te: S(12, 1.4, 0.08) },
    { id: "big-ret", tr: S(30, 1.2, 0.5), te: S(10, 1.3, 0.05) },
  ];
  assertEquals(pickBest(res)?.id, "steady");
  assert(passes(res[1]));
  assert(!passes({ tr: S(40, 2, 1), te: S(3, 3, 0.2) }), "too few test trades");
  assert(!passes({ tr: S(40, 2, 1), te: S(10, 1.05, 0.01) }), "test PF below 1.1");
  assert(MIN_TRAIN_TRADES >= 15);
});

Deno.test("evaluate runs every candidate on the same train/test split", () => {
  const bars = mkBars(walk(1200, 0.0005, 7), H, Date.UTC(2025, 0, 6), 0.3);
  const w = { symbol: "BTCUSDT", source: "binance_spot", tf: "1h", allow_short: false, sl_mode: "atr", atr_mult: 2, tp_r: 0 };
  const res = evaluate(bars, w);
  assert(res.length > 20);
  for (const r of res) assert(isFinite(r.tr.ret) && isFinite(r.te.ret));
  assert(res.some((r) => r.strategy === "pullback" && r.tr.trades > 0));
});
