// กลยุทธ์ + backtest แบบ pure function (ไม่มี I/O) ใช้ร่วมกันระหว่าง signal-scan, เทสต์ และสคริปต์เทียบผล
// deno-lint-ignore-file no-explicit-any

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Pos = { side: number; entry: number; sl?: number; tp?: number };
export type Ev = { kind: "ENTRY" | "EXIT"; side: number; price: number; reason: string; sl?: number; tp?: number };

export const TF_SEC: Record<string, number> = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
export const DAY = 86400e3;

// ประเภทตลาดของแต่ละตัวในรายการเฝ้า
export const mk = (w: any) => w.source === "binance_futures" ? "gold" : w.source === "binance_spot" ? "crypto"
  : w.symbol.endsWith("=X") ? "fx" : (w.source === "yahoo" && w.symbol.endsWith(".BK")) ? "th" : "us";

// ต้นทุนต่อฝั่ง (ค่าคอม + spread โดยประมาณ) แยกตามตลาด
// crypto: Binance 0.1% · ทอง XAUUSD ~0.02% · FX คู่หลัก ~0.01% · หุ้น US ~0.05% (spread/ค่าแปลงเงิน) · หุ้นไทย ~0.17% (คอม+VAT)
export const COST: Record<string, number> = { crypto: 0.001, gold: 0.0002, fx: 0.0001, us: 0.0005, th: 0.0017 };
export const costOf = (w: any) => COST[mk(w)] ?? 0.001;

// ============================ indicators ============================
export function sma(a: number[], n: number) {
  const r = Array(a.length).fill(NaN); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) r[i] = s / n; }
  return r;
}
// EMA เริ่มจาก SMA ของ n ตัวแรก
export function ema(a: number[], n: number) {
  const r = Array(a.length).fill(NaN), k = 2 / (n + 1);
  if (a.length < n) return r;
  let e = 0; for (let i = 0; i < n; i++) e += a[i];
  e /= n; r[n - 1] = e;
  for (let i = n; i < a.length; i++) { e = a[i] * k + e * (1 - k); r[i] = e; }
  return r;
}
export function rsi(a: number[], n: number) {
  const r = Array(a.length).fill(NaN); let g = 0, l = 0;
  for (let i = 1; i < a.length; i++) {
    const d = a[i] - a[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; r[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; r[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return r;
}
export function atrArr(bars: Bar[], n = 14) {
  const r = Array(bars.length).fill(NaN); let a = 0;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    if (i <= n) { a += tr; if (i === n) { a /= n; r[i] = a; } } else { a = (a * (n - 1) + tr) / n; r[i] = a; }
  }
  return r;
}

// ============================ signals ============================
export const STRATEGIES = ["ma_cross", "rsi", "breakout", "pullback"] as const;

export function rawSignals(bars: Bar[], strategy: string, p: any): (string | null)[] {
  const c = bars.map((b) => b.c), sig: (string | null)[] = Array(bars.length).fill(null);
  if (strategy === "ma_cross") {
    const f = sma(c, p.fast ?? 20), s = sma(c, p.slow ?? 50);
    for (let i = 1; i < c.length; i++) {
      if (f[i - 1] <= s[i - 1] && f[i] > s[i]) sig[i] = "L";
      else if (f[i - 1] >= s[i - 1] && f[i] < s[i]) sig[i] = "S";
    }
  } else if (strategy === "rsi") {
    const r = rsi(c, p.n ?? 14), lo = p.low ?? 30, hi = p.high ?? 70;
    for (let i = 1; i < c.length; i++) {
      if (r[i - 1] < lo && r[i] >= lo) sig[i] = "L";
      else if (r[i - 1] > hi && r[i] <= hi) sig[i] = "S";
    }
  } else if (strategy === "breakout") {
    const n = p.n ?? 20;
    for (let i = n; i < c.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let k = i - n; k < i; k++) { hh = Math.max(hh, bars[k].h); ll = Math.min(ll, bars[k].l); }
      if (c[i] > hh) sig[i] = "L"; else if (c[i] < ll) sig[i] = "S";
    }
  } else if (strategy === "pullback") {
    // ตามเทรนด์ + รอย่อ: EMA เร็ว > EMA ช้า, ภายใน look แท่งล่าสุดราคาย่อลงแตะ EMA เร็ว,
    // แล้วแท่งนี้ปิดเหนือ EMA เร็วและเหนือ high แท่งก่อน (ย่อจบ เริ่มกลับตัวตามเทรนด์) · Short กลับด้าน
    const fN = p.fast ?? 20, sN = p.slow ?? 50, look = p.look ?? 5;
    const f = ema(c, fN), s = ema(c, sN);
    for (let i = Math.max(sN, look); i < c.length; i++) {
      if (!isFinite(f[i]) || !isFinite(s[i])) continue;
      let touchDn = false, touchUp = false;
      for (let k = i - look + 1; k <= i; k++) { if (bars[k].l <= f[k]) touchDn = true; if (bars[k].h >= f[k]) touchUp = true; }
      if (f[i] > s[i] && c[i] > f[i] && c[i] > bars[i - 1].h && touchDn) sig[i] = "L";
      else if (f[i] < s[i] && c[i] < f[i] && c[i] < bars[i - 1].l && touchUp) sig[i] = "S";
    }
  }
  return sig;
}

// ============================ trend filter ============================
// TF ใหญ่กว่าที่ใช้ดูเทรนด์: 15m→1h, 1h→4h, 4h→1d, 1d→1w
export const HTF_OF: Record<string, string> = { "15m": "1h", "1h": "4h", "4h": "1d", "1d": "1w" };
const HTF_MS: Record<string, number> = { "1h": 3600e3, "4h": 4 * 3600e3, "1d": DAY, "1w": 7 * DAY };
const WEEK_OFFSET = 4 * DAY;   // 1970-01-01 เป็นวันพฤหัส → เลื่อนให้สัปดาห์เริ่มวันจันทร์

// เทรนด์จาก TF ใหญ่ (+1 ขึ้น / -1 ลง / 0 ไม่ชัดหรือข้อมูลไม่พอ) ต่อแท่งของ TF หลัก
// ขึ้น = close > EMA50 และ EMA20 > EMA50 ของ TF ใหญ่ · ใช้เฉพาะแท่ง TF ใหญ่ที่ "ปิดแล้ว" ณ เวลาปิดของแท่งนั้น (ไม่แอบดูอนาคต)
export function htfTrend(bars: Bar[], tf: string, fast = 20, slow = 50): number[] {
  const out = Array(bars.length).fill(0), htf = HTF_OF[tf];
  if (!htf) return out;
  const size = HTF_MS[htf], off = htf === "1w" ? WEEK_OFFSET : 0, step = TF_SEC[tf] * 1000;
  const start = (t: number) => Math.floor((t - off) / size) * size + off;
  const hc: number[] = [], hs: number[] = [];
  for (const b of bars) {
    const s = start(b.t);
    if (hs.length && hs[hs.length - 1] === s) hc[hc.length - 1] = b.c; else { hs.push(s); hc.push(b.c); }
  }
  const ef = ema(hc, fast), es = ema(hc, slow);
  const trend = hc.map((c, k) => !isFinite(es[k]) ? 0 : c > es[k] && ef[k] > es[k] ? 1 : c < es[k] && ef[k] < es[k] ? -1 : 0);
  let k = -1;
  for (let i = 0; i < bars.length; i++) {
    const closeT = bars[i].t + step;
    while (k + 1 < hs.length && hs[k + 1] + size <= closeT) k++;
    out[i] = k >= 0 ? trend[k] : 0;
  }
  return out;
}

// ตัวกรองสำหรับ "เข้า" เท่านั้น (ออกไม่กรอง)
// เทรนด์: trend_mode 'htf' = เทรนด์ TF ใหญ่ · อื่นๆ (ค่าเดิม 'ma200') = เหนือ/ใต้ MA200 ของ TF เดียวกัน
// volume = สูงกว่าเฉลี่ย 20 แท่ง 1.2 เท่า
export function entryFilters(bars: Bar[], w: any) {
  const c = bars.map((b) => b.c);
  const vol = bars.map((b) => b.v || 0), va = sma(vol, 20), hasVol = vol.some((x) => x > 0);
  const volOk = (i: number) => !w.vol_filter || !hasVol || vol[i] > 1.2 * va[i];
  if (w.trend_filter && w.trend_mode === "htf") {
    const tr = htfTrend(bars, w.tf);
    return { okL: bars.map((_, i) => tr[i] > 0 && volOk(i)), okS: bars.map((_, i) => tr[i] < 0 && volOk(i)) };
  }
  const s200 = sma(c, 200);
  return {
    okL: bars.map((_, i) => (!w.trend_filter || c[i] > s200[i]) && volOk(i)),
    okS: bars.map((_, i) => (!w.trend_filter || c[i] < s200[i]) && volOk(i)),
  };
}

export function describe(w: any) {
  const p = w.params || {};
  const base = w.strategy === "ma_cross" ? `MA ${p.fast ?? 20}/${p.slow ?? 50}`
    : w.strategy === "rsi" ? `RSI ${p.n ?? 14} (${p.low ?? 30}/${p.high ?? 70})`
    : w.strategy === "pullback" ? `Pullback EMA ${p.fast ?? 20}/${p.slow ?? 50}` : `Breakout ${p.n ?? 20}`;
  const trend = w.trend_mode === "htf" ? `กรองเทรนด์ ${HTF_OF[w.tf] ?? "TF ใหญ่"}` : "กรองเทรนด์";
  const f = [w.trend_filter ? trend : "", w.vol_filter ? "กรอง volume" : ""].filter(Boolean).join("+");
  return f ? `${base} · ${f}` : base;
}

// ============================ position ============================
// ระยะ SL: ATR × ตัวคูณ (ปรับตามความผันผวน) หรือ % คงที่
export function slDist(w: any, entry: number, atrV?: number) {
  if (w.sl_mode !== "pct" && atrV && atrV > 0) return atrV * (+w.atr_mult || 2);
  return w.sl_pct ? entry * w.sl_pct / 100 : 0;
}
export const tpR = (w: any) => w.sl_mode !== "pct" ? (+w.tp_r || 0) : (w.tp_pct && w.sl_pct ? w.tp_pct / w.sl_pct : 0);
export const slDesc = (w: any) => w.sl_mode !== "pct" ? `${+w.atr_mult || 2}×ATR` : `${w.sl_pct}%`;

export function step(pos: Pos, b: Bar, s: string | null, w: any, okL: boolean, okS: boolean, atrV?: number): [Pos, Ev[]] {
  const ev: Ev[] = []; let { side, entry, sl, tp } = pos;
  if (side) {
    if (sl && (side > 0 ? b.l <= sl : b.h >= sl)) { ev.push({ kind: "EXIT", side, price: sl, reason: "โดน Stop loss" }); side = 0; }
    else if (tp && (side > 0 ? b.h >= tp : b.l <= tp)) { ev.push({ kind: "EXIT", side, price: tp, reason: "ถึง Take profit" }); side = 0; }
  }
  if (s) {
    const want = s === "L" ? 1 : (w.allow_short ? -1 : 0);
    if (side && side !== want) { ev.push({ kind: "EXIT", side, price: b.c, reason: "สัญญาณกลับทาง" }); side = 0; }
    const ok = want === 1 ? okL : want === -1 ? okS : false;
    if (want && !side && ok) {
      side = want; entry = b.c;
      const d = slDist(w, entry, atrV), r = tpR(w);
      sl = d ? entry - side * d : 0; tp = d && r ? entry + side * d * r : 0;
      ev.push({ kind: "ENTRY", side, price: entry, reason: describe(w), sl, tp });
    }
  }
  if (!side) { sl = 0; tp = 0; }
  return [{ side, entry, sl, tp }, ev];
}

// ============================ backtest ============================
export type Sim = { ret: number; trades: number; wins: number; dd: number; pf: number; avg: number };
export type Prep = { sig: (string | null)[]; okL: boolean[]; okS: boolean[]; atr: number[] };

export function prep(bars: Bar[], w: any): Prep { return { sig: rawSignals(bars, w.strategy, w.params), ...entryFilters(bars, w), atr: atrArr(bars) }; }

// จำลองเทรดช่วง [from, to] · fee = ต้นทุนต่อฝั่ง (ค่าเริ่มต้นตามตลาด)
export function sim(bars: Bar[], w: any, from: number, to: number, pre = prep(bars, w), log?: any[], fee = costOf(w)): Sim {
  const { sig, okL, okS, atr } = pre;
  let pos: Pos = { side: 0, entry: 0 }, eq = 1, trades = 0, wins = 0, ei = 0, peak = 1, dd = 0, gw = 0, gl = 0, sum = 0;
  const close = (i: number, px_: number, why: string) => {
    const r = pos.side * (px_ / pos.entry - 1) - 2 * fee; eq *= 1 + r; trades++; sum += r;
    if (r > 0) { wins++; gw += r; } else gl -= r;
    peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1);
    log?.push({ ei, xi: i, side: pos.side, entry: +pos.entry.toPrecision(7), exit: +px_.toPrecision(7), sl: pos.sl ? +pos.sl.toPrecision(7) : null, r: +(r * 100).toFixed(2), why });
  };
  for (let i = from; i <= to; i++) {
    const prev = { ...pos }; let evs: Ev[];
    [pos, evs] = step(pos, bars[i], sig[i], w, okL[i], okS[i], atr[i]);
    for (const e of evs) {
      if (e.kind === "EXIT") { const cur = pos; pos = prev; close(i, e.price, e.reason); pos = cur; }
      else { ei = i; }
    }
  }
  if (pos.side) close(to, bars[to].c, "จบข้อมูล");
  return { ret: eq - 1, trades, wins, dd, pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0, avg: trades ? sum / trades : 0 };
}

// ============================ optimizer ============================
export const CANDS = [
  ...[[9, 21], [10, 30], [20, 50]].map(([fast, slow]) => ({ strategy: "ma_cross", params: { fast, slow } })),
  ...[[30, 70], [25, 75], [35, 65]].map(([low, high]) => ({ strategy: "rsi", params: { n: 14, low, high } })),
  ...[10, 20, 55].map((n) => ({ strategy: "breakout", params: { n } })),
  ...[[20, 50], [10, 30]].map(([fast, slow]) => ({ strategy: "pullback", params: { fast, slow } })),
].flatMap((c) => [{ ...c, trend_filter: true }, { ...c, trend_filter: false }]);

// เกณฑ์เลือกกลยุทธ์: ต้องมีจำนวนเทรดพอให้เชื่อถือได้ · เรียงตาม Profit factor ช่วงเรียนรู้ (ไม่ใช่กำไรรวม ซึ่งมักได้จากไม่กี่ไม้)
// ผ่านเมื่อช่วงทดสอบ (ข้อมูลที่ไม่เคยเห็น) มีเทรดพอ, PF ≥ 1.1 และกำไรเป็นบวก
export const MIN_TRAIN_TRADES = 15, MIN_TEST_TRADES = 5, MIN_TEST_PF = 1.1, PF_CAP = 10;
export type Res = { tr: Sim; te: Sim; [k: string]: any };
const pfScore = (s: Sim) => Math.min(s.pf, PF_CAP);

export function ranked<T extends Res>(res: T[]): T[] {
  return res.filter((r) => r.tr.trades >= MIN_TRAIN_TRADES).sort((a, b) => (pfScore(b.tr) - pfScore(a.tr)) || (b.tr.ret - a.tr.ret));
}
export const passes = (r: Res) => r.te.trades >= MIN_TEST_TRADES && r.te.pf >= MIN_TEST_PF && r.te.ret > 0;
export function pickBest<T extends Res>(res: T[]): T | undefined { return ranked(res)[0]; }

// ประเมินทุกตัวเลือก: เรียนรู้ 70% แรก ทดสอบ 30% หลัง
export function evaluate(bars: Bar[], w: any, cands: any[] = CANDS) {
  const n = bars.length, split = Math.floor(n * 0.7);
  return cands.map((c) => { const t = { ...w, ...c }, pr = prep(bars, t); return { ...c, tr: sim(bars, t, 0, split - 1, pr), te: sim(bars, t, split, n - 1, pr) }; });
}
