// signal-scan v11 - ระบบสัญญาณเทรดทั้งหมดในไฟล์เดียว เลือกงานด้วย ?job=
//   scan (ค่าเริ่มต้น, ทุก 5 นาที) | screen (สแกนเทรนด์ + สถานะรายวัน) | optimize (backtest เลือกกลยุทธ์)
//   weekly (สรุปรายสัปดาห์) | bot (Telegram webhook) | setup (ตั้ง webhook + เมนูคำสั่ง)
// Secrets: TG_TOKEN, TG_CHAT_ID, TWELVEDATA_KEY, CRON_SECRET, ANTHROPIC_API_KEY (ไม่บังคับ: อ่านรูปใบซื้อขาย)
// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
type Pos = { side: number; entry: number; sl?: number; tp?: number };
type Ev = { kind: "ENTRY" | "EXIT"; side: number; price: number; reason: string; sl?: number; tp?: number };

const TF_SEC: Record<string, number> = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const DAY = 86400e3, FEE = 0.001, BARS = 1000;
const env = (k: string) => Deno.env.get(k) ?? "";
const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FN_URL = "https://feiyuytifgiylgxtvohh.supabase.co/functions/v1/signal-scan";

// =============================== data ===============================
async function getJSON(url: string, headers: Record<string, string> = {}) {
  for (let a = 0; a < 2; a++) {
    const r = await fetch(url, { headers });
    if (r.ok) return r.json();
    if (a === 0 && (r.status === 429 || r.status >= 500)) { await sleep(1500); continue; }
    throw new Error(`HTTP ${r.status} ${url.split("?")[0]} ${(await r.text()).slice(0, 120)}`);
  }
}

async function fetchBinance(sym: string, tf: string, futures: boolean): Promise<Bar[]> {
  const base = futures ? "https://fapi.binance.com/fapi/v1/klines" : "https://data-api.binance.vision/api/v3/klines";
  const rows = await getJSON(`${base}?symbol=${sym}&interval=${tf}&limit=${BARS}`);
  return rows.map((r: any[]) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
}

async function fetchTwelve(sym: string, tf: string): Promise<Bar[]> {
  const iv = ({ "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day" } as any)[tf];
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${iv}` +
    `&outputsize=${BARS}&timezone=UTC&order=asc&apikey=${env("TWELVEDATA_KEY")}`;
  let j = await getJSON(url);
  if (j.code === 429) { await sleep(12000); j = await getJSON(url); }
  if (j.status === "error") throw new Error("Twelve Data: " + j.message);
  return j.values.map((v: any) => ({
    t: Date.parse(v.datetime.length === 10 ? v.datetime + "T00:00:00Z" : v.datetime.replace(" ", "T") + "Z"),
    o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +(v.volume ?? 0),
  }));
}

async function fetchYahoo(sym: string, tf: string): Promise<Bar[]> {
  const iv = tf === "4h" ? "1h" : tf;
  const range = tf === "4h" ? "2y" : ({ "15m": "60d", "1h": "1y", "1d": "5y" } as any)[iv];
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&range=${range}`,
    { "User-Agent": "Mozilla/5.0" });
  const r = j.chart?.result?.[0];
  if (!r?.timestamp) throw new Error("Yahoo ไม่มีข้อมูล " + sym);
  const q = r.indicators.quote[0];
  let bars: Bar[] = r.timestamp.map((t: number, i: number) => ({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] ?? 0 }))
    .filter((b: Bar) => b.o != null && b.c != null && b.h != null && b.l != null);
  if (tf === "4h") bars = aggregate(bars, 4 * 3600e3);
  return bars;
}

function aggregate(bars: Bar[], size: number): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const t = Math.floor(b.t / size) * size, last = out[out.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v || 0; }
    else out.push({ ...b, t, v: b.v || 0 });
  }
  return out;
}

function fetchBars(w: any) {
  if (w.source === "binance_spot") return fetchBinance(w.symbol, w.tf, false);
  if (w.source === "binance_futures") return fetchBinance(w.symbol, w.tf, true);
  if (w.source === "twelvedata") return fetchTwelve(w.symbol, w.tf);
  return fetchYahoo(w.symbol, w.tf);
}

async function closedBars(w: any) {
  const now = Date.now(), step = TF_SEC[w.tf] * 1000;
  return (await fetchBars(w)).filter((b) => b.t + step <= now).slice(-BARS);
}

// ราคาปัจจุบัน (live) ของหลายตัวพร้อมกัน
async function livePrices(ws: any[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const bySrc = (s: string) => ws.filter((w) => w.source === s).map((w) => w.symbol);
  const spot = bySrc("binance_spot");
  if (spot.length) {
    try {
      const all = await getJSON("https://data-api.binance.vision/api/v3/ticker/price");
      for (const x of all) if (spot.includes(x.symbol)) out.set(x.symbol, +x.price);
    } catch (_) { /* ignore */ }
  }
  await Promise.all(bySrc("binance_futures").map(async (s) => {
    try { out.set(s, +(await getJSON(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${s}`)).price); } catch (_) { /* */ }
  }));
  await Promise.all(bySrc("yahoo").map(async (s) => {
    try {
      const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=5d`, { "User-Agent": "Mozilla/5.0" });
      const p = j.chart?.result?.[0]?.meta?.regularMarketPrice; if (p) out.set(s, +p);
    } catch (_) { /* */ }
  }));
  const td = bySrc("twelvedata");
  if (td.length) {
    try {
      const j = await getJSON(`https://api.twelvedata.com/price?symbol=${td.join(",")}&apikey=${env("TWELVEDATA_KEY")}`);
      if (td.length === 1) { if (j.price) out.set(td[0], +j.price); }
      else for (const s of td) if (j[s]?.price) out.set(s, +j[s].price);
    } catch (_) { /* */ }
  }
  return out;
}

// ============================ indicators ============================
function sma(a: number[], n: number) {
  const r = Array(a.length).fill(NaN); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) r[i] = s / n; }
  return r;
}
function rsi(a: number[], n: number) {
  const r = Array(a.length).fill(NaN); let g = 0, l = 0;
  for (let i = 1; i < a.length; i++) {
    const d = a[i] - a[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; r[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; r[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return r;
}

function atrArr(bars: Bar[], n = 14) {
  const r = Array(bars.length).fill(NaN); let a = 0;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    if (i <= n) { a += tr; if (i === n) { a /= n; r[i] = a; } } else { a = (a * (n - 1) + tr) / n; r[i] = a; }
  }
  return r;
}

function rawSignals(bars: Bar[], strategy: string, p: any): (string | null)[] {
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
  }
  return sig;
}

// ตัวกรองสำหรับ "เข้า" เท่านั้น (ออกไม่กรอง): เทรนด์ = เหนือ/ใต้ MA200, volume = สูงกว่าเฉลี่ย 20 แท่ง 1.2 เท่า
function entryFilters(bars: Bar[], w: any) {
  const c = bars.map((b) => b.c), s200 = sma(c, 200);
  const vol = bars.map((b) => b.v || 0), va = sma(vol, 20), hasVol = vol.some((x) => x > 0);
  const volOk = (i: number) => !w.vol_filter || !hasVol || vol[i] > 1.2 * va[i];
  return {
    okL: bars.map((_, i) => (!w.trend_filter || c[i] > s200[i]) && volOk(i)),
    okS: bars.map((_, i) => (!w.trend_filter || c[i] < s200[i]) && volOk(i)),
  };
}

function describe(w: any) {
  const p = w.params || {};
  const base = w.strategy === "ma_cross" ? `MA ${p.fast ?? 20}/${p.slow ?? 50}`
    : w.strategy === "rsi" ? `RSI ${p.n ?? 14} (${p.low ?? 30}/${p.high ?? 70})` : `Breakout ${p.n ?? 20}`;
  const f = [w.trend_filter ? "กรองเทรนด์" : "", w.vol_filter ? "กรอง volume" : ""].filter(Boolean).join("+");
  return f ? `${base} · ${f}` : base;
}

// ระยะ SL: ATR × ตัวคูณ (ปรับตามความผันผวน) หรือ % คงที่
function slDist(w: any, entry: number, atrV?: number) {
  if (w.sl_mode !== "pct" && atrV && atrV > 0) return atrV * (+w.atr_mult || 2);
  return w.sl_pct ? entry * w.sl_pct / 100 : 0;
}
const tpR = (w: any) => w.sl_mode !== "pct" ? (+w.tp_r || 0) : (w.tp_pct && w.sl_pct ? w.tp_pct / w.sl_pct : 0);
const slDesc = (w: any) => w.sl_mode !== "pct" ? `${+w.atr_mult || 2}×ATR` : `${w.sl_pct}%`;

function step(pos: Pos, b: Bar, s: string | null, w: any, okL: boolean, okS: boolean, atrV?: number): [Pos, Ev[]] {
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

// ============================ formatting ============================
const px = (v: number) => v == null || !isFinite(v) ? "-" : v.toLocaleString("en-US", { maximumSignificantDigits: 6 });
const money = (v: number) => !isFinite(v) ? "-" : v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : 2 });
const pct = (v: number) => !isFinite(v) ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const bkk = (t: number) => new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const display = (s: string) => s.replace(/\.BK$/, "").replace(/USDT$/, "").replace(/=X$/, "");
const mk = (w: any) => w.source === "binance_futures" ? "gold" : w.source === "binance_spot" ? "crypto"
  : w.symbol.endsWith("=X") ? "fx" : (w.source === "yahoo" && w.symbol.endsWith(".BK")) ? "th" : "us";
const MARKETS = ["crypto", "gold", "fx", "th", "us"];
const MK_LABEL: Record<string, string> = { crypto: "คริปโต", gold: "ทองคำ/โลหะ", fx: "Forex", th: "หุ้นไทย", us: "หุ้น US" };
const MK_DEFAULT: Record<string, boolean> = { crypto: true, gold: true, fx: true, th: false, us: false };
const mkOn = (S: any, m: string) => ({ ...MK_DEFAULT, ...(S.markets ?? {}) })[m] !== false;
const isOn = (S: any, w: any) => mkOn(S, mk(w));
const WHERE: Record<string, string> = { crypto: "Binance Spot", gold: "Binance Futures (XAUUSDT) หรือ XAUUSD ใน MT4/Exness",
  fx: "MT4/Exness",
  th: "แอปหุ้นไทย เช่น Streaming", us: "แอปหุ้น US เช่น Dime" };

// เหตุผลภาษาคน
function why(w: any, side: number) {
  const p = w.params || {};
  if (w.strategy === "ma_cross") return side > 0 ? `เส้นเฉลี่ย ${p.fast ?? 20} ตัดขึ้นเหนือเส้น ${p.slow ?? 50} → แนวโน้มเริ่มขึ้น`
    : `เส้นเฉลี่ย ${p.fast ?? 20} ตัดลงใต้เส้น ${p.slow ?? 50} → แนวโน้มเริ่มลง`;
  if (w.strategy === "rsi") return side > 0 ? `RSI เด้งขึ้นจากโซนขายมากเกิน (${p.low ?? 30}) → มีโอกาสเด้งกลับ`
    : `RSI ลงจากโซนซื้อมากเกิน (${p.high ?? 70}) → มีโอกาสย่อตัว`;
  return side > 0 ? `ราคาทะลุจุดสูงสุด ${p.n ?? 20} แท่ง → แรงซื้อเข้า` : `ราคาหลุดจุดต่ำสุด ${p.n ?? 20} แท่ง → แรงขายเข้า`;
}
const EXIT_WHY: Record<string, string> = { "โดน Stop loss": "ราคาแตะจุดตัดขาดทุน (SL)", "ถึง Take profit": "ราคาถึงเป้ากำไร (TP) 🎉",
  "สัญญาณกลับทาง": "สัญญาณกลับทาง แนวโน้มเปลี่ยนแล้ว" };

async function tg(text: string, html = false) {
  const r = await fetch(`https://api.telegram.org/bot${env("TG_TOKEN")}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env("TG_CHAT_ID"), text, ...(html ? { parse_mode: "HTML" } : {}) }),
  });
  if (!r.ok) console.error("telegram", r.status, await r.text());
}

async function tgApi(method: string, body: any) {
  const r = await fetch(`https://api.telegram.org/bot${env("TG_TOKEN")}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: env("TG_CHAT_ID"), ...body }) });
  return r.json();
}

async function settings() {
  const { data } = await sb.from("sig_settings").select("*").eq("id", 1).maybeSingle();
  return data ?? { balance_usd: 1000, balance_thb: 30000, risk_pct: 1 };
}

function sizeInfo(w: any, entry: number, S: any, slPct: number) {
  if (!(slPct > 0)) return null;
  const m = mk(w), bal = m === "th" ? +S.balance_thb : +S.balance_usd, cur = m === "th" ? "บาท" : "USD";
  const q0 = bal * +S.risk_pct / 100 / (entry * slPct / 100);
  let qty: number, unit: string;
  if (m === "th") { qty = Math.floor(q0 / 100) * 100; unit = "หุ้น"; }
  else if (m === "us") { qty = Math.floor(q0 * 100) / 100; unit = "หุ้น"; }
  else if (m === "gold") { qty = Math.floor(q0 * 1000) / 1000; unit = "oz"; }
  else if (m === "fx") {
    const pair = display(w.symbol), base = pair.slice(0, 3), quote = pair.slice(3, 6);
    const risk = bal * +S.risk_pct / 100, dist = entry * slPct / 100;
    const perLot = quote === "USD" ? 100000 * dist : base === "USD" ? 100000 * dist / entry : NaN;
    if (!isFinite(perLot)) return { line: "คู่นี้ให้คำนวณ lot ใน MT4 (เสี่ยงไม่เกิน " + money(risk) + " USD)", warn: null };
    const lots = Math.floor(risk / perLot * 100) / 100;
    if (lots < 0.01) return { line: `0.01 lot (ขั้นต่ำ) · ถ้าโดน SL เสีย ~${money(perLot * 0.01)} USD`, warn: "⚠️ เกินความเสี่ยงที่ตั้งไว้ พอร์ตเล็กเกินสำหรับ SL นี้" };
    return { line: `${lots.toFixed(2)} lot · ถ้าโดน SL เสีย ~${money(perLot * lots)} USD`, warn: null };
  }
  else { const p = 10 ** (3 - Math.floor(Math.log10(q0))); qty = Math.floor(q0 * p) / p; unit = display(w.symbol); }
  if (!(qty > 0)) return { line: `พอร์ต ${px(bal)} ${cur} เล็กเกินสำหรับ SL นี้ ข้ามไม้นี้`, warn: null };
  const notional = qty * entry;
  return { line: `${px(qty)} ${unit} (~${money(notional)} ${cur}) · ถ้าโดน SL เสีย ~${money(notional * slPct / 100)} ${cur}`,
    warn: notional > bal ? `⚠️ มูลค่าเกินพอร์ต ต้องใช้ leverage ~${(notional / bal).toFixed(1)}x` : null };
}

// แนะนำ leverage สำหรับ Futures (คริปโต/ทอง): ใช้เท่าที่จำเป็น และจุด liquidation ต้องห่างอย่างน้อย 3 เท่าของ SL
function levHint(w: any, entry: number, side: number, slPct: number, S: any) {
  const m = mk(w);
  if (!(m === "crypto" || m === "gold") || !(slPct > 0)) return [];
  const cap = +S.max_lev || 10, bal = +S.balance_usd, notional = bal * +S.risk_pct / slPct;
  const maxL = Math.min(cap, Math.floor(100 / (3 * slPct)));
  if (maxL < 1) return [`⚙️ Futures: SL กว้าง ${slPct.toFixed(1)}% ไม่ควรใช้ leverage ไม้นี้ (ใช้ Spot)`];
  const need = Math.max(1, Math.ceil(notional / bal));
  const L = Math.min(need, maxL), liq = entry * (1 - side * (1 / L - 0.005));
  const out = [`⚙️ ถ้าใช้ Futures (Isolated): แนะนำ ${L}x · สูงสุดไม่เกิน ${maxL}x`,
    L === 1 ? "     1x = เหมือน Spot ไม่มีความเสี่ยงถูก liquidate" : `     จุด liquidation ≈ ${px(liq)} (${pct((liq / entry - 1) * 100)}) · SL จะโดนก่อน ✅`];
  if (need > maxL) out.push(`⚠️ ขนาดไม้นี้ต้องใช้ ~${need}x ซึ่งเกินเพดาน ${maxL}x → ลดขนาดไม้ลง หรือข้ามไม้นี้`);
  return out;
}

function alertText(w: any, e: Ev, closeT: number, prevEntry: number, livePx: number | undefined, S: any) {
  const name = w.name || display(w.symbol), m = mk(w), d = e.side > 0 ? "Long" : "Short";
  const L: string[] = []; let pnl: number | null = null;
  if (e.kind === "ENTRY") {
    const long = e.side > 0;
    L.push(`${long ? "🟢 ซื้อ" : "🔴 ขาย"} ${name} (${d}) · ${w.tf}`, "━━━━━━━━━━━━",
      `👉 ทำอะไร: เปิด ${long ? "Long (ซื้อ)" : "Short (ขายก่อน)"} ที่ราคาประมาณ ${px(e.price)}`);
    const slPct = e.sl ? Math.abs(e.sl / e.price - 1) * 100 : 0;
    const sz = sizeInfo(w, e.price, S, slPct);
    if (sz) { L.push(`📦 ขนาด: ${sz.line}`); if (sz.warn) L.push(sz.warn); }
    if (e.sl) L.push(`🛑 ตั้ง Stop loss: ${px(e.sl)} (${pct((e.sl / e.price - 1) * 100)} · ${slDesc(w)})`);
    L.push(...levHint(w, e.price, e.side, slPct, S));
    L.push(e.tp ? `🎯 ตั้ง Take profit: ${px(e.tp)} (${pct((e.tp / e.price - 1) * 100)} · ${+tpR(w).toFixed(2)}R)`
      : "🎯 Take profit: ไม่ต้องตั้ง รอ alert ปิดไม้");
    L.push(`🏦 เทรดที่: ${WHERE[m]}`);
    if (livePx) {
      const mv = (livePx / e.price - 1) * 100, fav = e.side * mv;
      L.push(`💲 ราคาตอนนี้: ${px(livePx)} (${pct(mv)} จากราคาสัญญาณ)`);
      if (slPct && fav <= -slPct) L.push("⛔ ราคาเลย SL ไปแล้ว ข้ามไม้นี้");
      else if (slPct && fav > slPct / 2) L.push("⚠️ ราคาวิ่งไปไกลแล้ว ถ้ายังไม่ได้เข้า ควรข้ามไม้นี้");
    }
    L.push(`💡 เหตุผล: ${why(w, e.side)}`);
  } else {
    pnl = prevEntry ? e.side * (e.price / prevEntry - 1) * 100 : 0;
    L.push(`⚪ ปิด ${d} ${name} · ${w.tf}`, "━━━━━━━━━━━━",
      `👉 ทำอะไร: ถ้ายังถือ ${d} ${name} อยู่ ให้ปิดไม้`,
      `💡 เหตุผล: ${EXIT_WHY[e.reason] ?? e.reason}`,
      `📊 ผล: เข้า ${px(prevEntry)} → ออก ${px(e.price)} = ${pct(pnl)} ${pnl >= 0 ? "✅" : "❌"}`);
    if (livePx) L.push(`💲 ราคาตอนนี้: ${px(livePx)}`);
  }
  L.push(`🕒 แท่งปิด ${bkk(closeT)} (เวลาไทย)`);
  return { text: L.join("\n"), pnl };
}

const cfgOf = (w: any) => JSON.stringify([w.symbol, w.source, w.tf, w.strategy, w.params, w.allow_short, w.sl_pct, w.tp_pct,
  w.trend_filter, w.vol_filter, w.sl_mode, w.atr_mult, w.tp_r]);

// ================================ scan ================================
async function jobScan() {
  const { data: watches, error } = await sb.from("sig_watchlist").select("*").eq("active", true).order("id");
  if (error) throw error;
  const { data: states } = await sb.from("sig_state").select("*");
  const S = await settings();
  const now = Date.now(), report: string[] = [];
  const active = (watches ?? []).filter((w) => isOn(S, w));
  try { await refreshNews(S); await newsAlerts(S, active); } catch (e) { console.error("news", e); }
  let live: Map<string, number> | null = null;
  const getLive = async () => live ??= await livePrices(active.filter((w) => w.source !== "twelvedata"));

  for (const w of active) {
    const st = states?.find((s) => s.watch_id === w.id);
    const cfgKey = cfgOf(w);
    const fresh = !st || st.cfg_key !== cfgKey;
    if (!fresh && st.next_check && Date.parse(st.next_check) > now) continue;
    const stepMs = TF_SEC[w.tf] * 1000;
    try {
      const bars = await closedBars(w);
      if (bars.length < 60) throw new Error(`ข้อมูลไม่พอ (${bars.length} แท่ง)`);
      const sig = rawSignals(bars, w.strategy, w.params), { okL, okS } = entryFilters(bars, w), atr = atrArr(bars);
      const lastT = bars[bars.length - 1].t, lastC = bars[bars.length - 1].c;
      let pos: Pos = { side: 0, entry: 0 };
      const rows: any[] = [];

      // กลับมาเปิดตลาดหลังปิดไว้นาน = sync เงียบๆ ไม่ส่ง alert ย้อนหลัง
      const gap = !fresh && bars.filter((b) => b.t > Date.parse(st.last_bar)).length > 3;
      if (fresh || gap) {
        for (let i = 0; i < bars.length; i++) [pos] = step(pos, bars[i], sig[i], w, okL[i], okS[i], atr[i]);
        const lp = (await getLive()).get(w.symbol) ?? lastC;
        await tg(`${gap ? "🔁 กลับมาเฝ้า" : "▶️ เริ่มเฝ้า"}\n${card(w, bars, pos.side, pos.entry, lp, pos.sl, pos.tp)}`, true);
      } else {
        pos = { side: st.side, entry: Number(st.entry), sl: +st.sl || 0, tp: +st.tp || 0 };
        const last = Date.parse(st.last_bar);
        for (let i = 0; i < bars.length; i++) {
          if (bars[i].t <= last) continue;
          let prevEntry = pos.entry, evs: Ev[];
          [pos, evs] = step(pos, bars[i], sig[i], w, okL[i], okS[i], atr[i]);
          for (const e of evs) {
            const lp = (await getLive()).get(w.symbol);
            const m = alertText(w, e, bars[i].t + stepMs, prevEntry, lp, S);
            const { data: ar } = await sb.from("sig_alerts").insert({ watch_id: w.id, symbol: w.symbol, kind: e.kind, side: e.side, price: e.price,
              reason: e.reason, pnl_pct: m.pnl, sl: e.sl ?? null, tp: e.tp ?? null, bar_close: new Date(bars[i].t + stepMs).toISOString() }).select("id").single();
            await sendAlert(w, e, m.text, ar?.id, lp ?? e.price, S, bars.slice(0, i + 1), prevEntry);
            rows.push(ar?.id);
            if (e.kind === "ENTRY") prevEntry = e.price;
          }
        }
      }
      const found = fresh || gap || lastT > Date.parse(st.last_bar);
      const next = found ? lastT + 2 * stepMs + 60e3 : now + Math.max(300e3, Math.min(stepMs, 3600e3));
      await sb.from("sig_state").upsert({ watch_id: w.id, side: pos.side, entry: pos.entry, sl: pos.sl || null, tp: pos.tp || null, last_bar: new Date(lastT).toISOString(),
        next_check: new Date(next).toISOString(), cfg_key: cfgKey, last_error: null, last_price: lastC, trigger: trigShort(w, bars),
        updated_at: new Date().toISOString() });
      report.push(`${w.symbol}: ok${rows.length ? ` (${rows.length})` : ""}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (st) await sb.from("sig_state").update({ last_error: msg, next_check: new Date(now + 600e3).toISOString() }).eq("watch_id", w.id);
      report.push(`${w.symbol}: ERROR ${msg}`);
    }
  }
  try { await monitorTrades(); } catch (e) { console.error("trades", e); }
  try { await jobBoard(); } catch (e) { console.error("board", e); }
  return report;
}

// ======================= ไม้จริง · ความเสี่ยง · ข่าว =======================
const bkkMidnight = () => { const n = Date.now() + 7 * 3600e3; return Math.floor(n / DAY) * DAY - 7 * 3600e3; };
const ccyOf = (w: any) => mk(w) === "fx" ? [display(w.symbol).slice(0, 3), display(w.symbol).slice(3, 6)] : mk(w) === "gold" ? ["USD"] : [];
const sideTxt = (s: number) => s > 0 ? "Long" : "Short";

async function openTradeOf(watchId: number) {
  const { data } = await sb.from("sig_trades").select("*").eq("watch_id", watchId).eq("status", "open").order("opened_at", { ascending: false }).limit(1);
  return data?.[0] ?? null;
}
async function todayR() {
  const { data } = await sb.from("sig_trades").select("r_mult").eq("status", "closed").gte("closed_at", new Date(bkkMidnight()).toISOString());
  return (data ?? []).reduce((a, t) => a + (+t.r_mult || 0), 0);
}
async function nearNews(ccys: string[], mins: number) {
  if (!ccys.length) return null;
  const now = Date.now();
  const { data } = await sb.from("sig_news").select("*").in("country", ccys)
    .gte("at", new Date(now - mins * 60e3).toISOString()).lte("at", new Date(now + mins * 60e3).toISOString()).order("at").limit(1);
  return data?.[0] ?? null;
}

async function entryWarnings(w: any, side: number, S: any) {
  const out: string[] = [], m = mk(w), max = +(S.max_same_dir ?? 3), lim = +(S.daily_loss_pct ?? 3);
  const { data: open } = await sb.from("sig_trades").select("side,market").eq("status", "open");
  const same = (open ?? []).filter((t) => t.market === m && t.side === side).length;
  if (same >= max) out.push(`⚠️ มี ${sideTxt(side)} ${MK_LABEL[m]} ถือจริงอยู่แล้ว ${same} ไม้ (เพดาน ${max}) · ควรข้ามไม้นี้`);
  const lossPct = (await todayR()) * +S.risk_pct;
  if (lossPct <= -lim) out.push(`⛔ วันนี้ขาดทุนรวม ${lossPct.toFixed(1)}% ถึงเพดาน ${lim}% แล้ว · หยุดเข้าไม้ใหม่วันนี้`);
  const ev = await nearNews(ccyOf(w), 60);
  if (ev) out.push(`📰 ข่าวแรง ${ev.title} (${ev.country}) ${bkk(Date.parse(ev.at))} · ราคาอาจกระชาก ควรรอหลังข่าว`);
  return out;
}

async function sendAlert(w: any, e: Ev, text: string, alertId: number | undefined, p: number, S: any, bars: Bar[] = [], prevEntry = 0) {
  let kb: any = null;
  if (e.kind === "ENTRY") {
    const warn = await entryWarnings(w, e.side, S);
    if (warn.length) text += "\n" + warn.join("\n");
    if (alertId) kb = [[{ text: "✅ เข้าแล้ว (ใส่ราคา)", callback_data: `in:${alertId}` }, { text: "⏭ ข้าม", callback_data: `skip:${alertId}` }]];
  } else {
    const t = await openTradeOf(w.id);
    if (t) {
      text += `\n💼 ไม้จริงของคุณ: ${sideTxt(t.side)} @${px(+t.entry)} → ${px(p)} (${pct(t.side * (p / +t.entry - 1) * 100)})`;
      kb = [[{ text: "✅ ปิดแล้ว (ใส่ราคา)", callback_data: `close:${t.id}` }, { text: "ยังถือต่อ", callback_data: "keep" }]];
    }
  }
  const marks = e.kind === "ENTRY" ? { entry: e.price, sl: e.sl, tp: e.tp } : { entry: prevEntry, exit: e.price };
  const png = bars.length ? await chartPng(w, bars, marks).catch(() => null) : null;
  if (png) { if (await tgPhoto(png, text, kb)) return; }
  await tgApi("sendMessage", { text, ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}) });
}

// ---------- รูปกราฟ (QuickChart) ----------
async function chartPng(w: any, bars: Bar[], m: { entry?: number; sl?: number; tp?: number; exit?: number }) {
  const last = bars.slice(-80), name = w.name || display(w.symbol);
  const line = (v: number | undefined, color: string, label: string) => v ? { type: "line", yMin: v, yMax: v, borderColor: color, borderWidth: 2,
    borderDash: label === "Entry" ? [] : [6, 4], label: { display: true, enabled: true, content: `${label} ${px(v)}`, position: "start", backgroundColor: color } } : null;
  const ann: any = {};
  for (const [k, v] of Object.entries({ entry: line(m.entry, "#2563eb", "Entry"), sl: line(m.sl, "#dc2626", "SL"), tp: line(m.tp, "#16a34a", "TP"), exit: line(m.exit, "#6b7280", "Exit") }))
    if (v) ann[k] = v;
  const lbl = last.map((b) => new Date(b.t).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", day: "2-digit", month: "2-digit", hour: "2-digit" }));
  const cfgs = [
    { type: "candlestick", data: { datasets: [{ label: name, data: last.map((b) => ({ x: b.t, o: b.o, h: b.h, l: b.l, c: b.c })) }] },
      options: { plugins: { legend: { display: false }, title: { display: true, text: `${name} · ${w.tf}` }, annotation: { annotations: ann } } } },
    { type: "line", data: { labels: lbl, datasets: [{ label: name, data: last.map((b) => b.c), borderColor: "#111827", pointRadius: 0, borderWidth: 2, fill: false }] },
      options: { plugins: { legend: { display: false }, title: { display: true, text: `${name} · ${w.tf}` }, annotation: { annotations: ann } } } },
  ];
  for (const chart of cfgs) {
    try {
      const r = await fetch("https://quickchart.io/chart", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: "3", width: 800, height: 420, backgroundColor: "white", format: "png", chart }) });
      if (r.ok && (r.headers.get("content-type") ?? "").includes("image")) return new Uint8Array(await r.arrayBuffer());
    } catch (_) { /* ลองแบบถัดไป */ }
  }
  return null;
}

async function tgPhoto(png: Uint8Array, text: string, kb: any) {
  const fd = new FormData();
  fd.append("chat_id", env("TG_CHAT_ID"));
  fd.append("photo", new Blob([png], { type: "image/png" }), "chart.png");
  const long = text.length > 1000;
  fd.append("caption", long ? text.split("\n")[0] : text);
  if (kb && !long) fd.append("reply_markup", JSON.stringify({ inline_keyboard: kb }));
  const r = await (await fetch(`https://api.telegram.org/bot${env("TG_TOKEN")}/sendPhoto`, { method: "POST", body: fd })).json();
  if (!r.ok) return false;
  if (long) await tgApi("sendMessage", { text, ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}) });
  return true;
}

// เฝ้าไม้จริง: เตือนเลื่อน SL มาคุ้มทุนเมื่อกำไรถึง 1R และเตือนเมื่อราคาแตะ SL
async function monitorTrades() {
  const { data: tr } = await sb.from("sig_trades").select("*").eq("status", "open");
  if (!tr?.length) return;
  const { data: ws } = await sb.from("sig_watchlist").select("*").in("id", tr.map((t) => t.watch_id ?? -1));
  const live = await livePrices((ws ?? []).filter((w) => w.source !== "twelvedata"));
  for (const t of tr) {
    const w = ws?.find((x) => x.id === t.watch_id), p = w ? live.get(w.symbol) : undefined;
    if (!p) continue;
    const entry = +t.entry, name = t.name || display(t.symbol), r = t.sl_pct ? t.side * (p / entry - 1) * 100 / +t.sl_pct : 0;
    if (!t.be_alerted && t.sl_pct && r >= 1 && +t.sl !== entry) {
      await tgApi("sendMessage", { text: [`🔒 ${name} ${sideTxt(t.side)} กำไรถึง 1R แล้ว`, LINE,
        `👉 ทำอะไร: เลื่อน Stop loss มาที่ราคาเข้า ${px(entry)} ไม้นี้จะไม่ขาดทุนแล้ว`,
        `💲 ราคาตอนนี้: ${px(p)} (${pct(t.side * (p / entry - 1) * 100)})`].join("\n"),
        reply_markup: { inline_keyboard: [[{ text: "✅ เลื่อน SL แล้ว", callback_data: `be:${t.id}` }]] } });
      await sb.from("sig_trades").update({ be_alerted: true }).eq("id", t.id);
    }
    if (!t.sl_alerted && t.sl && (t.side > 0 ? p <= +t.sl : p >= +t.sl)) {
      await tgApi("sendMessage", { text: [`🛑 ${name} ราคาแตะ SL ${px(+t.sl)} แล้ว`, LINE,
        "👉 ทำอะไร: ถ้าโบรกปิดไม้ให้แล้ว กดปุ่มด้านล่างเพื่อบันทึกผล", `💲 ราคาตอนนี้: ${px(p)}`].join("\n"),
        reply_markup: { inline_keyboard: [[{ text: "✅ ปิดแล้ว (ใส่ราคา)", callback_data: `close:${t.id}` }]] } });
      await sb.from("sig_trades").update({ sl_alerted: true }).eq("id", t.id);
    }
  }
}

// ปฏิทินข่าวแรง (ForexFactory feed) ดึงทุก 6 ชม.
async function refreshNews(S: any) {
  if (!mkOn(S, "gold") && !mkOn(S, "fx")) return;
  if (S.news_fetched_at && Date.now() - Date.parse(S.news_fetched_at) < 6 * 3600e3) return;
  await sb.from("sig_settings").update({ news_fetched_at: new Date().toISOString() }).eq("id", 1);
  const ev = await getJSON("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { "User-Agent": "Mozilla/5.0" });
  const rows = (ev ?? []).filter((x: any) => x.impact === "High" && x.date).map((x: any) => ({
    key: `${x.country}|${x.date}|${x.title}`, title: x.title, country: x.country, at: new Date(x.date).toISOString(), impact: x.impact }));
  if (rows.length) await sb.from("sig_news").upsert(rows, { onConflict: "key", ignoreDuplicates: true });
}
async function newsAlerts(S: any, active: any[]) {
  const ccys = [...new Set(active.flatMap(ccyOf))];
  if (!ccys.length) return;
  const now = Date.now();
  const { data } = await sb.from("sig_news").select("*").eq("alerted", false).in("country", ccys)
    .gt("at", new Date(now).toISOString()).lte("at", new Date(now + 60 * 60e3).toISOString());
  for (const ev of data ?? []) {
    const affected = active.filter((w) => ccyOf(w).includes(ev.country)).map((w) => w.name || display(w.symbol));
    await tg([`📰 ข่าวแรงอีก ${Math.round((Date.parse(ev.at) - now) / 60e3)} นาที`, LINE, `${ev.title} (${ev.country}) · ${bkk(Date.parse(ev.at))}`,
      `กระทบ: ${affected.join(", ")}`, "👉 ทำอะไร: พักเข้าไม้ใหม่จนหลังข่าว 30 นาที · ไม้ที่ถืออยู่เช็กว่าตั้ง SL แล้ว"].join("\n"));
    await sb.from("sig_news").update({ alerted: true }).eq("key", ev.key);
  }
}

async function tradesText() {
  const { data: tr } = await sb.from("sig_trades").select("*").eq("status", "open").order("opened_at");
  const S = await settings(), r = await todayR();
  const L = ["<b>💼 ไม้จริงที่ถืออยู่</b>", LINE];
  let tv = 0, tpl = 0;
  if (tr?.length) {
    const { data: ws } = await sb.from("sig_watchlist").select("*").in("id", tr.map((t) => t.watch_id ?? -1));
    const live = await livePrices(ws ?? []);
    for (const t of tr) {
      const w = ws?.find((x) => x.id === t.watch_id), p = w ? live.get(w.symbol) ?? NaN : NaN, e = +t.entry;
      L.push(`${t.side > 0 ? "🟢" : "🔴"} <b>${esc(t.name || display(t.symbol))}</b> ${sideTxt(t.side)} @${px(e)} → ${px(p)} <b>${pct(t.side * (p / e - 1) * 100)}</b>` +
        (t.sl ? ` · SL ${px(+t.sl)}${+t.sl === e ? " 🔒" : ""}` : ""));
      if (+t.qty && isFinite(p)) {
        const val = +t.qty * p, pl = t.side * +t.qty * (p - e); tv += val; tpl += pl;
        L.push(`     ${px(+t.qty)} หน่วย ≈ ${money(val)} USD (${pl >= 0 ? "+" : ""}${money(pl)} USD)`);
      }
    }
    if (tv) L.push("", `💰 มูลค่ารวม ≈ <b>${money(tv)} USD</b> · กำไร/ขาดทุนที่ยังไม่ปิด ${tpl >= 0 ? "+" : ""}${money(tpl)} USD`);
  } else L.push("ยังไม่มี · กด ✅ เข้าแล้ว ใต้ alert · ส่งรูปใบซื้อขาย · หรือพิมพ์ /in BTC 65000");
  L.push("", `วันนี้ปิดไปแล้ว: ${r >= 0 ? "+" : ""}${r.toFixed(2)}R (${pct(r * +S.risk_pct)} ของพอร์ต) · เพดานขาดทุน/วัน ${S.daily_loss_pct}%`);
  return L.join("\n");
}

async function openTrade(w: any, side: number, entry: number, alert: any, extra: { qty?: number; cost?: number; at?: string } = {}) {
  let d = alert?.sl ? Math.abs(+alert.price - +alert.sl) : 0;
  if (!d) { try { const b = await closedBars(w), a = atrArr(b); d = slDist(w, entry, a[a.length - 1]); } catch (_) { d = slDist(w, entry); } }
  const r = tpR(w), sl = d ? entry - side * d : null, tp = d && r ? entry + side * d * r : null, slPct = d ? d / entry * 100 : 0;
  const { data: t } = await sb.from("sig_trades").insert({ watch_id: w.id, alert_id: alert?.id ?? null, symbol: w.symbol, name: w.name || display(w.symbol),
    market: mk(w), side, entry, sl, tp, sl_pct: slPct || null, signal_price: alert?.price ?? null, status: "open",
    qty: extra.qty ?? null, cost: extra.cost ?? null, ...(extra.at ? { opened_at: extra.at } : {}) }).select("*").single();
  const S = await settings(), sz = sizeInfo(w, entry, S, slPct);
  const L = [`💼 บันทึกไม้จริง ${t.name} ${sideTxt(side)}`, LINE, `📍 เข้าที่: ${px(entry)}` +
    (alert?.price ? ` (ต่างจากราคาสัญญาณ ${pct((entry / +alert.price - 1) * 100)})` : "")];
  if (extra.qty) {
    L.push(`📦 ขนาดจริง: ${px(extra.qty)} หน่วย (~${money(extra.qty * entry)} USD)` + (sl ? ` · ถ้าโดน SL เสีย ~${money(extra.qty * Math.abs(entry - sl))} USD` : ""));
    if (sz) L.push(`     ระบบแนะนำ: ${sz.line}`);
  } else if (sz) L.push(`📦 ขนาดที่ควรใช้: ${sz.line}`);
  if (sl) L.push(`🛑 ตั้ง Stop loss: ${px(sl)} (${pct((sl / entry - 1) * 100)} · ${slDesc(w)})`);
  L.push(...levHint(w, entry, side, slPct, S));
  L.push(tp ? `🎯 ตั้ง Take profit: ${px(tp)} (${+r.toFixed(2)}R)` : "🎯 Take profit: รอ alert ปิดไม้");
  L.push("🤖 ระบบจะเตือนเลื่อน SL เมื่อกำไรถึง 1R และเตือนเมื่อแตะ SL");
  return L.join("\n");
}

async function closeTrade(t: any, exit: number) {
  const pnl = t.side * (exit / +t.entry - 1) * 100, r = t.sl_pct ? pnl / +t.sl_pct : 0;
  const cash = +t.qty ? t.side * +t.qty * (exit - +t.entry) : 0;
  await sb.from("sig_trades").update({ status: "closed", exit, pnl_pct: pnl, r_mult: r, closed_at: new Date().toISOString(),
    realized: (+t.realized || 0) + cash }).eq("id", t.id);
  const day = await todayR();
  return [`${pnl >= 0 ? "✅" : "❌"} ปิดไม้จริง ${t.name} ${sideTxt(t.side)}`, LINE, `📊 ${px(+t.entry)} → ${px(exit)} = ${pct(pnl)} (${r >= 0 ? "+" : ""}${r.toFixed(2)}R)` +
    (cash ? ` · ${cash >= 0 ? "+" : ""}${money(cash)} USD` : ""),
    `วันนี้รวม: ${day >= 0 ? "+" : ""}${day.toFixed(2)}R`].join("\n");
}

const parsePrice = (s: string) => parseFloat(String(s).replace(/[, ]/g, ""));

async function handleCallback(cb: any) {
  const [act, idS] = String(cb.data || "").split(":"), id = +idS, msgId = cb.message?.message_id;
  const answer = (text: string) => tgApi("answerCallbackQuery", { callback_query_id: cb.id, text });
  const clearKb = () => tgApi("editMessageReplyMarkup", { message_id: msgId, reply_markup: { inline_keyboard: [] } });
  if (act === "keep") return answer("โอเค ถือต่อ");
  if (act === "ocr" || act === "ocrno") {
    const { data: p } = await sb.from("sig_pending").select("*").eq("msg_id", msgId).maybeSingle();
    await clearKb();
    if (!p) return answer("รายการนี้หมดอายุหรือบันทึกไปแล้ว");
    await sb.from("sig_pending").delete().eq("msg_id", msgId);
    if (act === "ocrno") return answer("ยกเลิกแล้ว");
    await answer("กำลังบันทึก…");
    return tg(await applyReceipt(p.data));
  }
  if (act === "in" || act === "skip") {
    const { data: a } = await sb.from("sig_alerts").select("*").eq("id", id).maybeSingle();
    if (!a) return answer("ไม่พบ alert นี้");
    const { data: ex } = await sb.from("sig_trades").select("id,status").eq("alert_id", id).limit(1);
    if (ex?.length) { await clearKb(); return answer("บันทึกไว้แล้ว"); }
    const { data: w } = await sb.from("sig_watchlist").select("*").eq("id", a.watch_id).maybeSingle();
    if (act === "skip") {
      await sb.from("sig_trades").insert({ watch_id: a.watch_id, alert_id: id, symbol: a.symbol, name: w?.name || display(a.symbol),
        market: w ? mk(w) : null, side: a.side, signal_price: a.price, status: "skipped" });
      await clearKb(); return answer("ข้ามไม้นี้แล้ว");
    }
    const q = await tgApi("sendMessage", { text: `💬 ตอบกลับข้อความนี้ด้วยราคาที่เข้าจริงของ ${w?.name || display(a.symbol)} ${sideTxt(a.side)}\nเช่น ${px(+a.price)} · หรือพิมพ์ = เพื่อใช้ราคาสัญญาณ`,
      reply_markup: { force_reply: true, input_field_placeholder: "ราคาที่เข้า" } });
    if (q.ok) await sb.from("sig_pending").upsert({ msg_id: q.result.message_id, action: "in", ref_id: id });
    await clearKb(); return answer("ใส่ราคาที่เข้าได้เลย");
  }
  if (act === "close") {
    const { data: t } = await sb.from("sig_trades").select("*").eq("id", id).maybeSingle();
    if (!t || t.status !== "open") { await clearKb(); return answer("ไม้นี้ปิดไปแล้ว"); }
    const q = await tgApi("sendMessage", { text: `💬 ตอบกลับข้อความนี้ด้วยราคาที่ปิดจริงของ ${t.name} ${sideTxt(t.side)}\nหรือพิมพ์ = เพื่อใช้ราคาตอนนี้`,
      reply_markup: { force_reply: true, input_field_placeholder: "ราคาที่ปิด" } });
    if (q.ok) await sb.from("sig_pending").upsert({ msg_id: q.result.message_id, action: "close", ref_id: id });
    await clearKb(); return answer("ใส่ราคาที่ปิดได้เลย");
  }
  if (act === "be") {
    const { data: t } = await sb.from("sig_trades").select("*").eq("id", id).maybeSingle();
    if (t) await sb.from("sig_trades").update({ sl: t.entry }).eq("id", id);
    await clearKb(); await answer("บันทึก SL = ราคาเข้าแล้ว");
    return tg(`🔒 ${t?.name} SL อยู่ที่ราคาเข้า ${px(+t?.entry)} แล้ว ไม้นี้ไม่ขาดทุน`);
  }
  return answer("");
}

async function handleReply(msg: any) {
  const { data: pend } = await sb.from("sig_pending").select("*").eq("msg_id", msg.reply_to_message.message_id).maybeSingle();
  if (!pend) return false;
  const raw = msg.text.trim();
  if (pend.action === "in") {
    const { data: a } = await sb.from("sig_alerts").select("*").eq("id", pend.ref_id).maybeSingle();
    const { data: w } = a ? await sb.from("sig_watchlist").select("*").eq("id", a.watch_id).maybeSingle() : { data: null };
    const price = raw === "=" ? +a?.price : parsePrice(raw);
    if (!a || !w || !(price > 0)) { await tg("❌ ราคาไม่ถูกต้อง ลองตอบกลับใหม่ เช่น 65120"); return true; }
    await sb.from("sig_pending").delete().eq("msg_id", pend.msg_id);
    await tg(await openTrade(w, a.side, price, a));
    return true;
  }
  if (pend.action === "close") {
    const { data: t } = await sb.from("sig_trades").select("*").eq("id", pend.ref_id).maybeSingle();
    if (!t || t.status !== "open") { await tg("ไม้นี้ปิดไปแล้ว"); return true; }
    let price = parsePrice(raw);
    if (raw === "=") {
      const { data: w } = await sb.from("sig_watchlist").select("*").eq("id", t.watch_id).maybeSingle();
      price = w ? (await livePrices([w])).get(w.symbol) ?? NaN : NaN;
    }
    if (!(price > 0)) { await tg("❌ ราคาไม่ถูกต้อง ลองตอบกลับใหม่"); return true; }
    await sb.from("sig_pending").delete().eq("msg_id", pend.msg_id);
    await tg(await closeTrade(t, price));
    return true;
  }
  return false;
}

// =============================== พอร์ต ===============================
async function portText() {
  const S = await settings();
  const { data: all } = await sb.from("sig_trades").select("*").neq("status", "skipped");
  const open = (all ?? []).filter((t) => t.status === "open"), closed = (all ?? []).filter((t) => t.status === "closed");
  const { data: ws } = await sb.from("sig_watchlist").select("*").in("id", open.map((t) => t.watch_id ?? -1));
  const live = await livePrices(ws ?? []);
  const { data: st } = await sb.from("sig_state").select("watch_id,last_price").in("watch_id", open.map((t) => t.watch_id ?? -1));
  const rows: any[] = [];
  for (const t of open) {
    const w = ws?.find((x) => x.id === t.watch_id), e = +t.entry, q = +t.qty || 0;
    const p = (w && live.get(w.symbol)) || +(st?.find((x) => x.watch_id === t.watch_id)?.last_price ?? 0) || e;
    rows.push({ t, p, e, q, cur: w && mk(w) === "th" ? "บาท" : "USD", cost: q ? (+t.cost || q * e) : 0, val: q ? q * p : 0, pl: q ? t.side * q * (p - e) : 0, pct: t.side * (p / e - 1) * 100 });
  }
  const usd = rows.filter((r) => r.cur === "USD" && r.q), cost = usd.reduce((a, r) => a + r.cost, 0), val = usd.reduce((a, r) => a + r.val, 0);
  const unreal = usd.reduce((a, r) => a + r.pl, 0);
  const realized = (all ?? []).reduce((a, t) => a + (+t.realized || 0), 0);
  const bal = +S.balance_usd, cash = bal - cost, equity = cash + val;
  const L = [`<b>💼 สรุปพอร์ต</b> · ${bkk(Date.now())}`, LINE];
  if (!rows.length) L.push("ยังไม่มีสินทรัพย์ที่ถืออยู่");
  for (const r of rows.sort((a, b) => b.val - a.val)) {
    const name = esc(r.t.name || display(r.t.symbol));
    L.push(`${r.pct >= 0 ? "🟢" : "🔴"} <b>${name}</b> ${px(r.p)} (${pct(r.pct)})`);
    if (r.q) L.push(`     ${px(r.q)} หน่วย · ต้นทุน ${money(r.cost)} → ${money(r.val)} ${r.cur} (${r.pl >= 0 ? "+" : ""}${money(r.pl)})` +
      (r.cur === "USD" && equity > 0 ? ` · ${(r.val / equity * 100).toFixed(0)}% ของพอร์ต` : ""));
    else L.push(`     เข้า @${px(r.e)} · ยังไม่มีจำนวน (พิมพ์ /buy หรือ /in แบบใส่จำนวน)`);
  }
  L.push("", `💰 มูลค่าที่ถือ: <b>${money(val)} USD</b> · ต้นทุน ${money(cost)}`,
    `📈 กำไร/ขาดทุนที่ยังไม่ปิด: <b>${unreal >= 0 ? "+" : ""}${money(unreal)} USD</b>${cost ? ` (${pct(unreal / cost * 100)})` : ""}`,
    `✅ กำไร/ขาดทุนที่ปิดแล้ว: ${realized >= 0 ? "+" : ""}${money(realized)} USD`);
  const wins = closed.filter((t) => +t.pnl_pct > 0).length, sumR = closed.reduce((a, t) => a + (+t.r_mult || 0), 0);
  if (closed.length) L.push(`🎯 ปิดไปแล้ว ${closed.length} ไม้ · ชนะ ${wins}/${closed.length} · รวม ${sumR >= 0 ? "+" : ""}${sumR.toFixed(2)}R`);
  L.push("", `🏦 พอร์ตตั้งไว้ ${money(bal)} USD → เงินสดคงเหลือ ≈ ${money(cash)} · มูลค่ารวม ≈ <b>${money(equity + realized)} USD</b>`,
    `     (${pct((equity + realized - bal) / bal * 100)} จากที่ตั้งไว้ · ตั้งใหม่ด้วย /bal)`);
  return L.join("\n");
}

// ===================== อ่านรูปใบยืนยันการซื้อขาย =====================
function b64(u8: Uint8Array) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); }

const OCR_PROMPT = `This image is a screenshot of a trade receipt / order detail from a trading app (may be in Thai, may use Buddhist-era years like 2569).
Extract the executed trade and reply with ONLY one JSON object, no other text:
{"ok":true,"side":"buy|sell","base":"<asset bought or sold, e.g. BTC, NEAR, XAU, AAPL>","quote":"<pricing currency, e.g. USDT, USD, THB>","base_qty":<number>,"quote_amount":<number>,"price":<quote per 1 base>,"fee":<number or null>,"fee_ccy":"<string or null>","time":"YYYY-MM-DD HH:mm"}
Rules: price is quote per 1 base; if the app shows "1 USDT = x BASE" then price = 1/x. base_qty is the amount actually received (buy) or sold (sell).
Convert Buddhist-era years to Gregorian by subtracting 543. Thai words: ซื้อ = buy, ขาย = sell, ได้รับ = received, ชำระเงิน = paid.
If the image is not a completed trade, reply {"ok":false,"reason":"<short reason in Thai>"}.`;

async function readReceipt(fileId: string) {
  const f = await tgApi("getFile", { file_id: fileId });
  if (!f.ok) throw new Error("ดึงรูปจาก Telegram ไม่ได้");
  const path = f.result.file_path as string;
  const img = new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${env("TG_TOKEN")}/${path}`)).arrayBuffer());
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: /\.png$/i.test(path) ? "image/png" : "image/jpeg", data: b64(img) } },
      { type: "text", text: OCR_PROMPT }] }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("อ่านรูปไม่สำเร็จ: " + (j.error?.message ?? r.status));
  const txt = (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("อ่านรูปไม่สำเร็จ");
  const d = JSON.parse(m[0]);
  if (d.ok && +d.base_qty > 0 && +d.quote_amount > 0) d.price = +d.quote_amount / +d.base_qty;   // คำนวณราคาเฉลี่ยเองให้แม่น
  return d;
}

async function handlePhoto(msg: any) {
  if (!env("ANTHROPIC_API_KEY")) return tg("🧾 บอทยังไม่เปิดอ่านรูป · พิมพ์ตัวเลขจากใบแทนได้เลย\n/buy NEAR 17.263883 89.656\n(ชื่อ · จำนวนที่ได้รับ · ยอดที่จ่าย) ขายใช้ /sell แบบเดียวกัน");
  await tgApi("sendChatAction", { action: "typing" });
  const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
  let d: any;
  try { d = await readReceipt(fileId); } catch (e) { return tg("❌ " + (e instanceof Error ? e.message : e) + "\nลองส่งหน้ารายละเอียดธุรกรรมที่เห็นจำนวนและราคาชัดๆ หรือพิมพ์ /in แทน"); }
  if (!d.ok || !(+d.price > 0)) return tg(`❌ อ่านรายการซื้อขายจากรูปไม่ได้${d.reason ? ` (${d.reason})` : ""}\nลองส่งหน้ารายละเอียดธุรกรรม หรือพิมพ์ /in แทน`);
  const base = String(d.base).toUpperCase(), quote = String(d.quote || "").toUpperCase();
  const key = ["USDT", "USDC", "FDUSD", "BUSD"].includes(quote) && base !== "XAU" ? base + "USDT" : base;
  const r = await resolveSymbol(key);
  const { data: w } = await sb.from("sig_watchlist").select("*").eq("symbol", r.symbol).maybeSingle();
  const t = w ? await openTradeOf(w.id) : null, side = d.side === "sell" ? -1 : 1;
  const L = ["🧾 อ่านจากรูปได้แบบนี้", LINE, `${side > 0 ? "🟢 ซื้อ" : "🔴 ขาย"} ${display(r.symbol)}`,
    `จำนวน: ${px(+d.base_qty)} ${base}`, `${side > 0 ? "จ่าย" : "ได้รับ"}: ${px(+d.quote_amount)} ${quote}`, `ราคาเฉลี่ย: ${px(+d.price)}`];
  if (d.fee) L.push(`ค่าธรรมเนียม: ${px(+d.fee)} ${d.fee_ccy ?? ""}`);
  if (d.time) L.push(`เวลา: ${d.time}`);
  if (side > 0 && t && t.side > 0) L.push("", +t.qty ? `➕ มี ${display(r.symbol)} ถืออยู่ @${px(+t.entry)} · จะเฉลี่ยราคาเข้าให้`
    : Math.abs(+d.price / +t.entry - 1) < 0.005 ? `🔗 ตรงกับไม้ที่บันทึกไว้ @${px(+t.entry)} · จะเติมจำนวนให้` : `➕ มีไม้เดิม @${px(+t.entry)} · จะเฉลี่ยราคาเข้าให้`);
  else if (side < 0) L.push("", t && t.side > 0 ? `⚪ จะปิด/ลดไม้ ${display(r.symbol)} ที่เข้า @${px(+t.entry)}` : `⚠️ ไม่พบไม้ ${display(r.symbol)} ที่ถืออยู่ · จะบันทึกไม่ได้`);
  else if (!w) L.push("", `➕ ${display(r.symbol)} ยังไม่ได้เฝ้า · จะเพิ่มเข้าเฝ้าให้ด้วย`);
  L.push("", "👉 ถูกต้องไหม?");
  const sent = await tgApi("sendMessage", { text: L.join("\n"), reply_markup: { inline_keyboard: [[{ text: "✅ ยืนยันบันทึก", callback_data: "ocr:0" }, { text: "❌ ยกเลิก", callback_data: "ocrno:0" }]] } });
  if (sent.ok) await sb.from("sig_pending").upsert({ msg_id: sent.result.message_id, action: "ocr", data: { ...d, symbol: r.symbol, key } });
}

async function applyReceipt(d: any) {
  const qty = +d.base_qty, price = +d.price, cost = +d.quote_amount;
  const at = d.time && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(d.time) ? new Date(d.time.replace(" ", "T") + ":00+07:00").toISOString() : undefined;
  let { data: w } = await sb.from("sig_watchlist").select("*").eq("symbol", d.symbol ?? "").maybeSingle();
  const r = w ? { symbol: w.symbol } as any : await resolveSymbol(d.key);
  if (!w) ({ data: w } = await sb.from("sig_watchlist").select("*").eq("symbol", r.symbol).maybeSingle());
  let note = "";
  if (!w) {
    ({ data: w } = await sb.from("sig_watchlist").insert({ symbol: r.symbol, name: r.symbol === "XAUUSDT" ? "ทองคำ" : display(r.symbol), source: r.source, tf: r.tf,
      strategy: "ma_cross", params: { fast: 20, slow: 50 }, allow_short: r.market === "gold" || r.market === "fx", sl_pct: r.sl, tp_pct: 0, market: r.market, active: true })
      .select("*").single());
    note = `\n➕ เพิ่ม ${display(r.symbol)} เข้าเฝ้าแล้ว (ระบบจะ backtest เลือกกลยุทธ์ให้พรุ่งนี้เช้า)`;
  } else if (!w.active) { await sb.from("sig_watchlist").update({ active: true }).eq("id", w.id); note = `\n▶️ เปิดการเฝ้า ${display(r.symbol)} อีกครั้ง`; }
  const t = await openTradeOf(w.id);
  if (d.side !== "sell") {
    if (t && t.side > 0) {
      const q0 = +t.qty || 0;
      if (!q0 && Math.abs(price / +t.entry - 1) < 0.005) {
        await sb.from("sig_trades").update({ qty, cost, ...(at ? { opened_at: at } : {}) }).eq("id", t.id);
        return `🔗 เติมจำนวนเข้าไม้ ${t.name} เดิมแล้ว\n📦 ${px(qty)} หน่วย @${px(+t.entry)} (~${money(cost)} USD)` + note;
      }
      const nq = (q0 || 0) + qty, ne = q0 ? (q0 * +t.entry + qty * price) / nq : (+t.entry + price) / 2;
      const slPct = t.sl ? Math.abs(ne - +t.sl) / ne * 100 : t.sl_pct;
      await sb.from("sig_trades").update({ entry: ne, qty: q0 ? nq : qty, cost: (+t.cost || 0) + cost, sl_pct: slPct }).eq("id", t.id);
      return `➕ เพิ่มจำนวน ${t.name} แล้ว\n📍 ราคาเฉลี่ยใหม่: ${px(ne)} · รวม ${px(q0 ? nq : qty)} หน่วย` + (t.sl ? `\n🛑 SL เดิม ${px(+t.sl)} (ห่าง ${slPct.toFixed(2)}%)` : "") + note;
    }
    if (t && t.side < 0) return await closeTrade(t, price) + note;
    return await openTrade(w, 1, price, null, { qty, cost, at }) + note;
  }
  if (!t || t.side < 0) return `⚠️ ไม่พบไม้ ${display(r.symbol)} ที่ถืออยู่ บันทึกการขายไม่ได้`;
  const held = +t.qty || 0;
  if (held && qty < held * 0.98) {
    await sb.from("sig_trades").update({ qty: held - qty, cost: (+t.cost || 0) * (held - qty) / held,
      realized: (+t.realized || 0) + qty * (price - +t.entry) }).eq("id", t.id);
    return `⚪ ขาย ${t.name} บางส่วน ${px(qty)} หน่วย @${px(price)} (${pct((price / +t.entry - 1) * 100)})\n` +
      `💵 กำไร/ขาดทุนที่ปิดแล้ว: ${money(qty * (price - +t.entry))} USD\n📦 เหลือถือ ${px(held - qty)} หน่วย`;
  }
  return await closeTrade(t, price);
}

// =============================== status ===============================
const LINE = "━━━━━━━━━━━━";

// เงื่อนไขที่จะเกิดสัญญาณถัดไป + ระยะห่างจากตอนนี้
function triggers(w: any, bars: Bar[]) {
  const c = bars.map((b) => b.c), i = c.length - 1, p = w.params || {}, out: string[] = [];
  const s200 = sma(c, 200)[i];
  let L = "", Sx = "";
  if (w.strategy === "ma_cross") {
    const fN = p.fast ?? 20, sN = p.slow ?? 50, f = sma(c, fN)[i], s = sma(c, sN)[i], gap = Math.abs(f / s - 1) * 100;
    L = f < s ? `เส้น ${fN} ตัดขึ้นเหนือเส้น ${sN} (ตอนนี้ยังต่ำกว่า ${gap.toFixed(2)}%)` : `เส้น ${fN} อยู่เหนือเส้น ${sN} แล้ว รอรอบตัดใหม่`;
    Sx = f > s ? `เส้น ${fN} ตัดลงใต้เส้น ${sN} (ตอนนี้ยังสูงกว่า ${gap.toFixed(2)}%)` : `เส้น ${fN} อยู่ใต้เส้น ${sN} แล้ว รอรอบตัดใหม่`;
  } else if (w.strategy === "rsi") {
    const r = rsi(c, p.n ?? 14)[i];
    L = `RSI ลงต่ำกว่า ${p.low ?? 30} แล้วเด้งกลับขึ้น (ตอนนี้ RSI ${r.toFixed(0)})`;
    Sx = `RSI ขึ้นเกิน ${p.high ?? 70} แล้วย่อกลับลง (ตอนนี้ RSI ${r.toFixed(0)})`;
  } else {
    const n = p.n ?? 20; let hh = -Infinity, ll = Infinity;
    for (let k = i - n + 1; k <= i; k++) { hh = Math.max(hh, bars[k].h); ll = Math.min(ll, bars[k].l); }
    L = `ราคาปิดเหนือ ${px(hh)} (ห่าง ${pct((hh / c[i] - 1) * 100)})`;
    Sx = `ราคาปิดต่ำกว่า ${px(ll)} (ห่าง ${pct((ll / c[i] - 1) * 100)})`;
  }
  const blockL = w.trend_filter && !(c[i] > s200), blockS = w.trend_filter && !(c[i] < s200);
  out.push(`🎯 เข้า Long เมื่อ: ${L}` + (blockL ? `\n     ⛔ และราคาต้องกลับขึ้นเหนือ MA200 (${px(s200)}) ก่อน` : ""));
  if (w.allow_short) out.push(`🎯 เข้า Short เมื่อ: ${Sx}` + (blockS ? `\n     ⛔ และราคาต้องลงใต้ MA200 (${px(s200)}) ก่อน` : ""));
  return out;
}

function card(w: any, bars: Bar[], side: number, entry: number, p: number, slP?: number, tpP?: number) {
  const name = esc(w.name || display(w.symbol)), L: string[] = [];
  if (side) {
    const long = side > 0, sl = slP || NaN;
    const toSl = slP ? side * (p / sl - 1) * 100 : Infinity;
    L.push(`${long ? "🟢" : "🔴"} ถือ ${long ? "Long" : "Short"} ${name} · ${w.tf}`, LINE,
      `👉 ทำอะไร: ${toSl < 1 ? "⚠️ ราคาใกล้ SL เช็กว่าตั้ง SL ไว้แล้ว" : "ถ้าถืออยู่ ถือต่อ รอ alert ปิด"} · ถ้ายังไม่ได้เข้า ไม่ต้องไล่ราคา`,
      `📍 เข้าที่: ${px(entry)} → ตอนนี้ ${px(p)} (<b>${pct(side * (p / entry - 1) * 100)}</b>)`);
    if (slP) L.push(`🛑 Stop loss: ${px(sl)} (ห่าง ${toSl.toFixed(2)}% · ${slDesc(w)})`);
    L.push(tpP ? `🎯 Take profit: ${px(tpP)}` : "🎯 Take profit: รอ alert ปิดไม้");
    L.push(`🏦 เทรดที่: ${WHERE[mk(w)]}`, `💡 เหตุผล: ${why(w, side)}`);
  } else {
    L.push(`⏳ รอ ${name} · ${w.tf}`, LINE, "👉 ทำอะไร: ยังไม่ต้องทำ รอ alert เข้า", `💲 ราคาตอนนี้: ${px(p)}`,
      ...triggers(w, bars), `🏦 เทรดที่: ${WHERE[mk(w)]}`, `📐 กลยุทธ์: ${describe(w)}`,
      `🛑 SL แบบ ${slDesc(w)}` + (w.sl_mode !== "pct" ? ` (ตอนนี้ ≈ ${(slDist(w, p, atrArr(bars).at(-1)) / p * 100).toFixed(2)}%)` : "") +
      (tpR(w) ? ` · TP ${+tpR(w).toFixed(2)}R` : ""));
  }
  return L.join("\n");
}

// คืนหลายข้อความ: สรุป + การ์ดทุกตัว (แบ่งข้อความไม่ให้เกินลิมิต Telegram)
async function statusText(): Promise<string[]> {
  const S = await settings();
  const { data: all } = await sb.from("sig_watchlist").select("*").eq("active", true).order("id");
  const ws = (all ?? []).filter((w) => isOn(S, w));
  const { data: st } = await sb.from("sig_state").select("*");
  const live = await livePrices(ws);
  const cards = await mapLimit(ws, 4, async (w) => {
    const s = st?.find((x) => x.watch_id === w.id), side = s?.side ?? 0, entry = s ? +s.entry : 0;
    try {
      const bars = await closedBars(w), p = live.get(w.symbol) ?? bars[bars.length - 1].c;
      const toSl = side && s?.sl ? side * (p / +s.sl - 1) * 100 : Infinity;
      return { m: mk(w), side, near: toSl < 1, text: card(w, bars, side, entry, p, +s?.sl || 0, +s?.tp || 0) };
    } catch (_) { return { m: mk(w), side, near: false, text: `❗ ${esc(w.name || display(w.symbol))}: ดึงข้อมูลไม่ได้ชั่วคราว` }; }
  });
  const hold = cards.filter((c) => c.side).length, near = cards.filter((c) => c.near).length;
  const onList = MARKETS.filter((m) => mkOn(S, m)).map((m) => MK_LABEL[m]).join(", ");
  const head = [`<b>📊 สรุป ${bkk(Date.now())}</b>`, `ตลาดที่เฝ้า: ${onList || "-"}`,
    `สัญญาณเปิดอยู่ ${hold} ตัว · รอสัญญาณ ${cards.length - hold} ตัว`,
    "👉 " + (near ? `มี ${near} ตัวราคาใกล้ SL ดูการ์ดที่มี ⚠️` : hold ? "ถือตามแผน ไม่ต้องทำอะไร รอ alert" : "ยังไม่ต้องทำอะไร รอ alert เข้า")].join("\n");
  const msgs = [head];
  let buf = "";
  for (const m of MARKETS) {
    const group = cards.filter((c) => c.m === m).sort((a, b) => Math.abs(b.side) - Math.abs(a.side));
    if (!group.length) continue;
    const block = [`<b>── ${MK_LABEL[m]} ──</b>`, ...group.map((c) => c.text)].join("\n\n");
    if (buf && (buf + "\n\n" + block).length > 3800) { msgs.push(buf); buf = ""; }
    buf = buf ? buf + "\n\n" + block : block;
    while (buf.length > 3800) { const cut = buf.lastIndexOf("\n\n", 3800); msgs.push(buf.slice(0, cut)); buf = buf.slice(cut + 2); }
  }
  if (buf) msgs.push(buf);
  return msgs;
}
async function sendStatus() { for (const m of await statusText()) await tg(m, true); }

// ============================ กระดานปักหมุด ============================
// เงื่อนไขสัญญาณถัดไปแบบสั้น (บรรทัดเดียว) เก็บไว้ใน sig_state.trigger ทุกครั้งที่แท่งปิด
function trigShort(w: any, bars: Bar[]) {
  const c = bars.map((b) => b.c), i = c.length - 1, p = w.params || {}, s200 = sma(c, 200)[i];
  const blk = (side: number) => w.trend_filter && !(side > 0 ? c[i] > s200 : c[i] < s200) ? " ⛔MA200" : "";
  if (w.strategy === "ma_cross") {
    const fN = p.fast ?? 20, sN = p.slow ?? 50, f = sma(c, fN)[i], s = sma(c, sN)[i], g = Math.abs(f / s - 1) * 100;
    if (f < s) return `Long เมื่อ MA${fN} ตัดขึ้น MA${sN} (ห่าง ${g.toFixed(2)}%)${blk(1)}`;
    return w.allow_short ? `Short เมื่อ MA${fN} ตัดลง MA${sN} (ห่าง ${g.toFixed(2)}%)${blk(-1)}` : `รอ MA${fN} ตัดลงแล้วตัดขึ้นรอบใหม่`;
  }
  if (w.strategy === "rsi") {
    const r = rsi(c, p.n ?? 14)[i];
    return `RSI ${r.toFixed(0)} · Long เมื่อลงต่ำกว่า ${p.low ?? 30} แล้วเด้ง` + (w.allow_short ? ` · Short เมื่อเกิน ${p.high ?? 70} แล้วย่อ` : "");
  }
  const n = p.n ?? 20; let hh = -Infinity, ll = Infinity;
  for (let k = i - n + 1; k <= i; k++) { hh = Math.max(hh, bars[k].h); ll = Math.min(ll, bars[k].l); }
  return `Long เมื่อปิดเหนือ ${px(hh)} (${pct((hh / c[i] - 1) * 100)})${blk(1)}` +
    (w.allow_short ? ` · Short เมื่อปิดใต้ ${px(ll)} (${pct((ll / c[i] - 1) * 100)})${blk(-1)}` : "");
}

async function boardText() {
  const S = await settings();
  const { data: all } = await sb.from("sig_watchlist").select("*").eq("active", true).order("id");
  const ws = (all ?? []).filter((w) => isOn(S, w));
  const { data: st } = await sb.from("sig_state").select("*");
  const live = await livePrices(ws);
  // ตัวที่ยังไม่มีเงื่อนไขเก็บไว้ คำนวณครั้งเดียวแล้วบันทึก
  await mapLimit(ws.filter((w) => !st?.find((x) => x.watch_id === w.id)?.trigger), 3, async (w) => {
    try {
      const t = trigShort(w, await closedBars(w)), s = st?.find((x) => x.watch_id === w.id);
      if (s) { s.trigger = t; await sb.from("sig_state").update({ trigger: t }).eq("watch_id", w.id); }
    } catch (_) { /* ข้าม */ }
  });
  let near = 0, hold = 0;
  const L = [`📌 <b>กระดานสถานะ</b> · อัปเดต ${bkk(Date.now())}`, LINE];
  const { data: tr } = await sb.from("sig_trades").select("*").eq("status", "open").order("opened_at");
  if (tr?.length) {
    const extra = (all ?? []).filter((w) => tr.some((t) => t.watch_id === w.id) && !live.has(w.symbol));
    if (extra.length) (await livePrices(extra)).forEach((v, k) => live.set(k, v));
    const r = await todayR();
    L.push(`<b>💼 ไม้จริง (${tr.length})</b> · วันนี้ ${r >= 0 ? "+" : ""}${r.toFixed(2)}R`);
    for (const t of tr) {
      const w = (all ?? []).find((x) => x.id === t.watch_id), p = w ? live.get(w.symbol) ?? NaN : NaN, e = +t.entry;
      const toSl = t.sl ? t.side * (p / +t.sl - 1) * 100 : Infinity;
      if (toSl < 1) near++;
      L.push(`${t.side > 0 ? "🟢" : "🔴"} <b>${esc(t.name || display(t.symbol))}</b> ${px(p)} · ${sideTxt(t.side)} @${px(e)} <b>${pct(t.side * (p / e - 1) * 100)}</b>` +
        (t.sl ? ` · SL ${px(+t.sl)}${+t.sl === e ? "🔒" : ""}${toSl < 1 ? " ⚠️ใกล้" : ""}` : ""));
    }
    L.push("", "<b>📡 สัญญาณ</b>");
  }
  for (const m of MARKETS) {
    const group = ws.filter((w) => mk(w) === m);
    if (!group.length) continue;
    L.push(`<b>${MK_LABEL[m]}</b>`);
    for (const w of group) {
      const s = st?.find((x) => x.watch_id === w.id), side = s?.side ?? 0, entry = s ? +s.entry : 0;
      const p = live.get(w.symbol) ?? (s?.last_price ? +s.last_price : NaN), name = esc(w.name || display(w.symbol));
      if (side) {
        hold++;
        const sl = +s?.sl || 0, toSl = sl ? side * (p / sl - 1) * 100 : Infinity;
        if (toSl < 1) near++;
        L.push(`${side > 0 ? "🟢" : "🔴"} <b>${name}</b> ${px(p)} · ${side > 0 ? "Long" : "Short"} @${px(entry)} <b>${pct(side * (p / entry - 1) * 100)}</b>` +
          (sl ? ` · SL ${px(sl)}${toSl < 1 ? " ⚠️ใกล้" : ""}` : ""));
      } else L.push(`⏳ <b>${name}</b> ${px(p)} · ${esc(s?.trigger ?? "กำลังคำนวณ")}`);
    }
    L.push("");
  }
  L.push("👉 " + (near ? `${near} ตัวใกล้ SL เช็กว่าตั้ง SL ไว้แล้ว` : hold ? "ถือตามแผน รอ alert" : "ยังไม่ต้องทำอะไร รอ alert เข้า"),
    "🟢 Long 🔴 Short ⏳ รอสัญญาณ · รายละเอียด /status");
  let text = L.join("\n");
  if (text.length > 4000) text = text.slice(0, 3990) + "…";
  return text;
}

async function jobBoard(fresh = false) {
  const S = await settings(), text = await boardText();
  if (S.board_msg_id && !fresh) {
    const r = await tgApi("editMessageText", { message_id: S.board_msg_id, text, parse_mode: "HTML" });
    if (r.ok || /not modified/i.test(r.description ?? "")) return { ok: true, edited: true };
  }
  if (S.board_msg_id) await tgApi("unpinChatMessage", { message_id: S.board_msg_id });
  const sent = await tgApi("sendMessage", { text, parse_mode: "HTML", disable_notification: true });
  if (!sent.ok) throw new Error("board send: " + sent.description);
  await tgApi("pinChatMessage", { message_id: sent.result.message_id, disable_notification: true });
  await sb.from("sig_settings").update({ board_msg_id: sent.result.message_id }).eq("id", 1);
  return { ok: true, created: sent.result.message_id };
}

// ============================== screener ==============================
const SCR: Record<string, { label: string; source: string; tf: string; params: any; sl: number }> = {
  crypto: { label: "คริปโต", source: "binance_spot", tf: "4h", params: { fast: 20, slow: 50 }, sl: 5 },
  th: { label: "หุ้นไทย", source: "yahoo", tf: "1d", params: { fast: 10, slow: 30 }, sl: 5 },
  us: { label: "หุ้น US", source: "twelvedata", tf: "1d", params: { fast: 20, slow: 50 }, sl: 6 },
};

function analyzeDaily(symbol: string, raw: Bar[]) {
  const bars = raw.filter((b) => b.t + DAY <= Date.now());
  if (bars.length < 210) return null;
  const c = bars.map((b) => b.c), s50 = sma(c, 50), s200 = sma(c, 200), i = c.length - 1;
  if (!(c[i] > s50[i] && s50[i] > s200[i])) return null;
  let golden = false, hi55 = false;
  for (let j = i - 9; j <= i; j++) if (s50[j - 1] <= s200[j - 1] && s50[j] > s200[j]) golden = true;
  for (let j = i - 2; j <= i; j++) { let mx = -Infinity; for (let k = j - 55; k < j; k++) mx = Math.max(mx, bars[k].h); if (c[j] >= mx) hi55 = true; }
  return { symbol, roc60: c[i] / c[i - 60] - 1, fresh: golden || hi55, tag: golden ? "Golden cross" : hi55 ? "ทำ high 55 วัน" : "", last: c[i] };
}

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []; let k = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i]); } }));
  return out;
}

async function jobScreen() {
  const S = await settings();
  const t = await getJSON("https://data-api.binance.vision/api/v3/ticker/24hr");
  const stable = /^(USDC|FDUSD|TUSD|USDP|DAI|BUSD|EUR|AEUR|EURI|USD1|PYUSD|USDE|XUSD|BFUSD|RLUSD|PAXG|WBTC|WBETH|BNSOL)USDT$/;
  const crypto = t.filter((x: any) => x.symbol.endsWith("USDT") && !stable.test(x.symbol) && !/(UP|DOWN|BULL|BEAR)USDT$/.test(x.symbol))
    .sort((a: any, b: any) => +b.quoteVolume - +a.quoteVolume).slice(0, 30).map((x: any) => x.symbol);
  const { data: uni } = await sb.from("sig_universe").select("symbol,market").eq("active", true);
  const lists: Record<string, string[]> = { crypto, th: (uni ?? []).filter((u) => u.market === "th").map((u) => u.symbol),
    us: (uni ?? []).filter((u) => u.market === "us").map((u) => u.symbol) };
  const { data: wl } = await sb.from("sig_watchlist").select("id,symbol,auto,active,market");
  const { data: st } = await sb.from("sig_state").select("watch_id,side");
  const sideOf = (id: number) => st?.find((s) => s.watch_id === id)?.side ?? 0;
  const L = [`🔎 สแกนเทรนด์ ${bkk(Date.now()).slice(0, 5)}`, "เกณฑ์: ราคา > MA50 > MA200 เรียงตามผลตอบแทน 60 วัน", "🆕 = เพิ่ง Golden cross หรือทำ high 55 วัน"];
  const rows: any[] = [];

  for (const m of ["crypto", "th", "us"].filter((m) => mkOn(S, m))) {
    const cfg = SCR[m];
    const res = await mapLimit(lists[m], 5, async (s) => {
      try { return analyzeDaily(s, m === "crypto" ? await fetchBinance(s, "1d", false) : await fetchYahoo(s, "1d")); } catch { return null; }
    });
    const pass = res.filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => (+b.fresh - +a.fresh) || (b.roc60 - a.roc60));
    const keep = new Set(pass.slice(0, 10).map((r) => r.symbol)), added: string[] = [], removed: string[] = [];
    for (const r of pass.slice(0, 3)) {
      const row = wl?.find((w) => w.symbol === r.symbol);
      if (!row) {
        await sb.from("sig_watchlist").insert({ symbol: r.symbol, name: display(r.symbol), source: cfg.source, tf: cfg.tf, strategy: "ma_cross",
          params: cfg.params, allow_short: false, sl_pct: cfg.sl, tp_pct: 0, auto: true, market: m, active: true });
        added.push(display(r.symbol));
      } else if (row.auto && !row.active) { await sb.from("sig_watchlist").update({ active: true }).eq("id", row.id); added.push(display(r.symbol)); }
    }
    for (const w of (wl ?? []).filter((w) => w.auto && w.active && w.market === m)) {
      if (!keep.has(w.symbol) && sideOf(w.id) === 0) { await sb.from("sig_watchlist").update({ active: false }).eq("id", w.id); removed.push(display(w.symbol)); }
    }
    L.push("", `${cfg.label} (ผ่านเกณฑ์ ${pass.length}/${lists[m].length})`);
    pass.slice(0, 5).forEach((r, i) => L.push(`${i + 1}. ${display(r.symbol)}  💲${px(r.last)}  60 วัน ${pct(r.roc60 * 100)}${r.fresh ? ` 🆕 ${r.tag}` : ""}`));
    if (!pass.length) L.push("ไม่มีตัวที่เข้าเกณฑ์วันนี้");
    if (added.length) L.push(`➕ เพิ่มเข้าเฝ้า: ${added.join(", ")}`);
    if (removed.length) L.push(`➖ หยุดเฝ้า (หลุดเกณฑ์): ${removed.join(", ")}`);
    pass.slice(0, 10).forEach((r, i) => rows.push({ market: m, symbol: r.symbol, rank: i + 1, roc60_pct: +(r.roc60 * 100).toFixed(2), tag: r.tag || null, last_price: r.last }));
  }
  L.push("", "👉 ไม่ต้องทำอะไร ระบบเฝ้าตัวที่เพิ่มให้แล้ว รอ alert", "คัดตามเกณฑ์เทรนด์อัตโนมัติ ไม่ใช่คำแนะนำให้ซื้อ");
  if (rows.length) await sb.from("sig_screen").insert(rows);
  await tg(L.join("\n"));
  await sendStatus();
  return { ok: true, rows: rows.length };
}

// ============================== optimizer ==============================
const CANDS = [
  ...[[9, 21], [10, 30], [20, 50]].map(([fast, slow]) => ({ strategy: "ma_cross", params: { fast, slow } })),
  ...[[30, 70], [25, 75], [35, 65]].map(([low, high]) => ({ strategy: "rsi", params: { n: 14, low, high } })),
  ...[10, 20, 55].map((n) => ({ strategy: "breakout", params: { n } })),
].flatMap((c) => [{ ...c, trend_filter: true }, { ...c, trend_filter: false }]);

function prep(bars: Bar[], w: any) { return { sig: rawSignals(bars, w.strategy, w.params), ...entryFilters(bars, w), atr: atrArr(bars) }; }
function sim(bars: Bar[], w: any, from: number, to: number, pre = prep(bars, w), log?: any[]) {
  const { sig, okL, okS, atr } = pre;
  let pos: Pos = { side: 0, entry: 0 }, eq = 1, trades = 0, wins = 0, ei = 0, peak = 1, dd = 0;
  const close = (i: number, px_: number, why: string) => {
    const r = pos.side * (px_ / pos.entry - 1) - 2 * FEE; eq *= 1 + r; trades++; if (r > 0) wins++;
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
  return { ret: eq - 1, trades, wins, dd };
}

async function jobOptimize(force = false) {
  const { data: ws } = await sb.from("sig_watchlist").select("*").eq("active", true).order("id");
  const { data: st } = await sb.from("sig_state").select("watch_id,side");
  const S = await settings();
  const weekAgo = Date.now() - 7 * DAY, L: string[] = [];
  let tdCalls = 0;
  for (const w of ws ?? []) {
    if (!isOn(S, w) || w.manual) continue;
    if (!force && w.optimized_at && Date.parse(w.optimized_at) > weekAgo) continue;
    try {
      if (w.source === "twelvedata" && tdCalls++ > 0) await sleep(8000);
      const bars = await closedBars(w), n = bars.length;
      if (n < 150) continue;
      const split = Math.floor(n * 0.7);
      const res = CANDS.map((c) => { const t = { ...w, ...c }, pr = prep(bars, t); return { ...c, tr: sim(bars, t, 0, split - 1, pr), te: sim(bars, t, split, n - 1, pr) }; });
      const best = res.filter((r) => r.tr.trades >= 3).sort((a, b) => b.tr.ret - a.tr.ret)[0];
      const bh = bars[n - 1].c / bars[split].c - 1, side = st?.find((s) => s.watch_id === w.id)?.side ?? 0;
      const name = w.name || display(w.symbol);
      let action: string;
      if (best && best.te.ret > 0) {
        const changed = best.strategy !== w.strategy || JSON.stringify(best.params) !== JSON.stringify(w.params) || best.trend_filter !== w.trend_filter;
        if (!changed) action = "kept";
        else if (side !== 0) action = "pending";
        else {
          await sb.from("sig_watchlist").update({ strategy: best.strategy, params: best.params, trend_filter: best.trend_filter }).eq("id", w.id);
          action = "changed";
        }
        const icon = action === "changed" ? "🔄" : action === "pending" ? "⏳" : "✅";
        L.push(`${icon} ${name}: ${describe({ ...w, ...best })}  ทดสอบ ${pct(best.te.ret * 100)} (ถือยาว ${pct(bh * 100)})` +
          (action === "pending" ? " รอเปลี่ยนหลังปิดไม้" : ""));
      } else if (w.auto && side === 0) {
        await sb.from("sig_watchlist").update({ active: false }).eq("id", w.id);
        action = "disabled"; L.push(`⛔ ${name}: ไม่มีกลยุทธ์ผ่านเกณฑ์ หยุดเฝ้า`);
      } else { action = "no_pass"; L.push(`⚠️ ${name}: ไม่มีกลยุทธ์ผ่านเกณฑ์ (ตัวที่คุณเพิ่มเอง ยังเฝ้าต่อ)`); }
      if (action !== "pending") await sb.from("sig_watchlist").update({ optimized_at: new Date().toISOString() }).eq("id", w.id);
      await sb.from("sig_optimize").insert({ watch_id: w.id, symbol: w.symbol, strategy: best?.strategy ?? null, params: best?.params ?? null,
        trend_filter: best?.trend_filter ?? null, train_pct: best ? +(best.tr.ret * 100).toFixed(2) : null,
        test_pct: best ? +(best.te.ret * 100).toFixed(2) : null, bh_test_pct: +(bh * 100).toFixed(2), trades: best?.te.trades ?? 0, action });
    } catch (e) { L.push(`❗ ${w.symbol}: ${e instanceof Error ? e.message : e}`); }
  }
  if (L.length) await tg(["🧪 Backtest เลือกกลยุทธ์", "เรียนรู้จากข้อมูล 70% แรก แล้วทดสอบกับ 30% ล่าสุดที่ไม่เคยเห็น", "ใช้ได้ต่อเมื่อผลช่วงทดสอบเป็นบวก", "", ...L].join("\n"));
  return { ok: true, checked: L.length };
}

// บันทึก backtest ของกลยุทธ์ที่ใช้อยู่ทุกตัว ไว้ให้หน้า Dashboard ดูย้อนหลัง
async function jobBacktest() {
  const S = await settings();
  const { data: ws } = await sb.from("sig_watchlist").select("*").eq("active", true).order("id");
  let n = 0;
  for (const w of (ws ?? []).filter((w) => isOn(S, w))) {
    try {
      const bars = await closedBars(w), N = bars.length;
      if (N < 150) continue;
      const split = Math.floor(N * 0.7), log: any[] = [], pr = prep(bars, w);
      const all = sim(bars, w, 0, N - 1, pr, log), te = sim(bars, w, split, N - 1, pr);
      await sb.from("sig_backtest").upsert({ watch_id: w.id, run_at: new Date().toISOString(), cfg: `${describe(w)} · SL ${slDesc(w)}${tpR(w) ? ` · TP ${+tpR(w).toFixed(2)}R` : ""}`,
        split_i: split, times: bars.map((b) => b.t), closes: bars.map((b) => +b.c.toPrecision(7)), trades: log,
        stats: { ret: all.ret, trades: all.trades, wins: all.wins, dd: all.dd, test_ret: te.ret, bh: bars[N - 1].c / bars[0].c - 1 } });
      n++;
    } catch (e) { console.error("bt", w.symbol, e); }
  }
  return { ok: true, saved: n };
}

// ===================== ทดสอบกลยุทธ์ให้เลือกเอง (/test) =====================
async function findWatch(q: string) {
  const Q = q.toUpperCase().replace("/", "").replace(/=X$/, "");
  const { data: ws } = await sb.from("sig_watchlist").select("*");
  return (ws ?? []).find((x) => display(x.symbol).toUpperCase() === Q || x.symbol.toUpperCase() === Q || (x.name || "").toUpperCase() === Q ||
    ["ทอง", "GOLD", "XAU"].includes(Q) && x.symbol === "XAUUSDT");
}

async function testText(q: string) {
  const w = await findWatch(q);
  if (!w) return `ไม่พบ ${q} ในรายการ เพิ่มก่อนด้วย /add ${q}`;
  const bars = await closedBars(w), n = bars.length;
  if (n < 150) return `ข้อมูล ${display(w.symbol)} ยังไม่พอ (${n} แท่ง)`;
  const split = Math.floor(n * 0.7), bh = bars[n - 1].c / bars[split].c - 1;
  const res = CANDS.map((c) => { const t = { ...w, ...c }, pr = prep(bars, t); return { ...c, tr: sim(bars, t, 0, split - 1, pr), te: sim(bars, t, split, n - 1, pr) }; })
    .filter((r) => r.tr.trades >= 3).sort((a, b) => b.tr.ret - a.tr.ret).slice(0, 6);
  const cp = prep(bars, w), cur = { tr: sim(bars, w, 0, split - 1, cp), te: sim(bars, w, split, n - 1, cp) };
  await sb.from("sig_state").update({ last_test: res.map((r) => ({ strategy: r.strategy, params: r.params, trend_filter: r.trend_filter })) }).eq("watch_id", w.id);
  const name = w.name || display(w.symbol), ok = (x: number) => x > 0 ? "✅" : "❌";
  const L = [`🧪 ทดสอบกลยุทธ์ ${name} · ${w.tf} (${n} แท่ง)`, `ถือยาวเฉยๆ ช่วงทดสอบ: ${pct(bh * 100)}`, "",
    `ใช้อยู่: ${describe(w)} (${w.manual ? "เลือกเอง" : "อัตโนมัติ"})`, `   ทดสอบ ${pct(cur.te.ret * 100)} ${ok(cur.te.ret)} · ชนะ ${cur.te.wins}/${cur.te.trades}`, "",
    "ตัวเลือก (เรียงตามช่วงเรียนรู้):"];
  res.forEach((r, i) => L.push(`${i + 1}. ${describe({ ...w, ...r })}`,
    `   เรียนรู้ ${pct(r.tr.ret * 100)} · ทดสอบ ${pct(r.te.ret * 100)} ${ok(r.te.ret)} · ชนะ ${r.te.wins}/${r.te.trades}`));
  L.push("", `👉 เลือกข้อ 2: /use ${display(w.symbol)} 2`, `👉 ให้ระบบเลือกเอง: /auto ${display(w.symbol)}`,
    "ช่วงทดสอบ = ข้อมูล 30% ล่าสุดที่ไม่ได้ใช้ตอนเลือก ✅ คือยังทำกำไรในช่วงนั้น");
  return L.join("\n");
}

// ================================ weekly ================================
async function weeklyText(days = 7) {
  const since = new Date(Date.now() - days * DAY).toISOString();
  const { data: al } = await sb.from("sig_alerts").select("*").gte("created_at", since);
  const { data: ws } = await sb.from("sig_watchlist").select("id,source,symbol,name");
  const exits = (al ?? []).filter((a) => a.kind === "EXIT"), entries = (al ?? []).filter((a) => a.kind === "ENTRY");
  const L = [`<b>📅 สรุป ${days} วันที่ผ่านมา</b>`, `สัญญาณเข้า ${entries.length} ครั้ง · ปิดไม้ ${exits.length} ไม้`];
  if (exits.length) {
    const p = exits.map((e) => +e.pnl_pct), wins = p.filter((x) => x > 0).length, sum = p.reduce((a, b) => a + b, 0);
    L.push(`ชนะ ${wins}/${exits.length} (${(wins / exits.length * 100).toFixed(0)}%) · รวม ${pct(sum)} · เฉลี่ย ${pct(sum / exits.length)}/ไม้`, "");
    const byM: Record<string, number[]> = {};
    for (const e of exits) { const w = ws?.find((x) => x.id === e.watch_id); const m = w ? mk(w) : "crypto"; (byM[m] ??= []).push(+e.pnl_pct); }
    for (const [m, arr] of Object.entries(byM)) L.push(`${MK_LABEL[m]}: ${arr.length} ไม้ รวม ${pct(arr.reduce((a, b) => a + b, 0))}`);
    const sorted = [...exits].sort((a, b) => +b.pnl_pct - +a.pnl_pct);
    L.push("", `ดีสุด: ${display(sorted[0].symbol)} ${pct(+sorted[0].pnl_pct)}`, `แย่สุด: ${display(sorted[sorted.length - 1].symbol)} ${pct(+sorted[sorted.length - 1].pnl_pct)}`);
  } else L.push("ยังไม่มีไม้ที่ปิดในช่วงนี้");
  L.push("", "% คือผลต่อไม้ ถ้าทำตามทุกสัญญาณ (ยังไม่รวมค่าธรรมเนียม)");
  const { data: rt } = await sb.from("sig_trades").select("*").gte("opened_at", since);
  const closed = (rt ?? []).filter((t) => t.status === "closed"), skipped = (rt ?? []).filter((t) => t.status === "skipped").length;
  L.push("", "<b>💼 ที่คุณทำจริง</b>");
  if (closed.length) {
    const sumR = closed.reduce((a, t) => a + (+t.r_mult || 0), 0), w = closed.filter((t) => +t.pnl_pct > 0).length;
    L.push(`ปิด ${closed.length} ไม้ · ชนะ ${w}/${closed.length} · รวม ${sumR >= 0 ? "+" : ""}${sumR.toFixed(2)}R`);
  } else L.push("ยังไม่มีไม้จริงที่ปิด");
  L.push(`เข้า ${(rt ?? []).filter((t) => t.status !== "skipped").length} · ข้าม ${skipped} จากสัญญาณเข้า ${entries.length}`);
  return L.join("\n");
}

// ============================= telegram bot =============================
const HELP = [
  "<b>คำสั่ง</b>",
  "/status ดูราคาปัจจุบันและสถานะทุกตัว (การ์ดเต็ม)",
  "/board สร้างกระดานปักหมุดใหม่ (อัปเดตเองทุก 5 นาที)",
  "/add BTCUSDT เพิ่มคริปโต (ลงท้าย USDT)",
  "/add PTT หุ้นไทย · /add NVDA หุ้น US · /add ทอง · /add EURUSD",
  "/add SOLUSDT 1h ระบุ timeframe (15m 1h 4h 1d)",
  "/stop ENA หยุดเฝ้า",
  "/scan ผลสแกนเทรนด์ล่าสุด",
  "/report สรุป 7 วัน",
  "/bal 1000 usd หรือ /bal 30000 thb ตั้งเงินในพอร์ต",
  "/risk 1 ตั้ง % เสี่ยงต่อไม้",
  "/settings ดูค่าที่ตั้งไว้",
  "/limit 3 ถือทิศเดียวกันสูงสุดกี่ไม้ต่อตลาด",
  "/dayloss 3 เพดานขาดทุนต่อวัน (%)",
  "/slmode BTC atr 2 · SL ตามความผันผวน (หรือ pct 3)",
  "/tp BTC 2 · TP = 2 เท่าระยะ SL (0 = ไม่ตั้ง)",
  "/maxlev 5 เพดาน leverage ที่ระบบจะแนะนำ (คริปโต/ทอง)",
  "/market ดูตลาดที่เปิด-ปิด",
  "/on ทอง · /off หุ้นไทย · /on forex · /off คริปโต",
  "",
  "<b>ไม้จริง</b>",
  "กด ✅ เข้าแล้ว ใต้ alert แล้วตอบกลับด้วยราคาที่เข้า",
  "/port สรุปพอร์ต: มูลค่า ต้นทุน กำไร/ขาดทุน สัดส่วน",
  "/buy NEAR 17.26 89.66 บันทึกซื้อ (จำนวนที่ได้ · ยอดที่จ่าย) ลอกจากใบซื้อได้เลย",
  "/sell NEAR 17.26 95.10 บันทึกขาย (ขายบางส่วนได้)",
  "/in BTC 65120 0.0015 บันทึกเข้าเอง (ราคา จำนวน · เติม short ถ้าเป็น Short)",
  "/out BTC 66000 บันทึกปิดเอง",
  "/trades ดูไม้จริงที่ถืออยู่",
  "",
  "<b>กลยุทธ์</b>",
  "/test BTC เทียบกลยุทธ์ทั้งหมดของตัวนั้น",
  "/use BTC 2 เลือกกลยุทธ์ข้อ 2 เอง",
  "/auto BTC ให้ระบบเลือกกลยุทธ์ให้ทุกสัปดาห์",
].join("\n");
const MK_ALIAS: Record<string, string> = { crypto: "crypto", "คริปโต": "crypto", coin: "crypto", gold: "gold", "ทอง": "gold",
  fx: "fx", forex: "fx", "ฟอเร็กซ์": "fx", "ค่าเงิน": "fx",
  th: "th", thai: "th", set: "th", "หุ้นไทย": "th", us: "us", usa: "us", "หุ้นus": "us", "หุ้นนอก": "us" };

async function resolveSymbol(raw: string) {
  const s = raw.toUpperCase();
  if (["ทอง", "GOLD", "XAU", "XAUUSD", "XAUUSDT"].includes(s)) return { symbol: "XAUUSDT", source: "binance_futures", market: "gold", tf: "1h", sl: 1 };
  if (["SILVER", "XAG", "XAGUSDT", "เงิน"].includes(s)) return { symbol: "XAGUSDT", source: "binance_futures", market: "gold", tf: "1h", sl: 1.5 };
  const CCY = ["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF"], fx = s.replace("/", "");
  if (fx.length === 6 && CCY.includes(fx.slice(0, 3)) && CCY.includes(fx.slice(3)))
    return { symbol: `${fx}=X`, source: "yahoo", market: "fx", tf: "1h", sl: 0.5 };
  if (s.endsWith("USDT")) return { symbol: s, source: "binance_spot", market: "crypto", tf: "4h", sl: 5 };
  if (s.endsWith(".BK")) return { symbol: s, source: "yahoo", market: "th", tf: "1d", sl: 5 };
  const { data } = await sb.from("sig_universe").select("symbol").eq("symbol", s + ".BK").maybeSingle();
  if (data) return { symbol: s + ".BK", source: "yahoo", market: "th", tf: "1d", sl: 5 };
  return { symbol: s, source: "twelvedata", market: "us", tf: "1d", sl: 6 };
}

async function handleBot(req: Request) {
  const u = await req.json().catch(() => ({}));
  if (u.callback_query) {
    if (String(u.callback_query.message?.chat?.id) !== env("TG_CHAT_ID")) return;
    return handleCallback(u.callback_query);
  }
  const msg = u.message;
  if (msg && String(msg.chat?.id) === env("TG_CHAT_ID") && (msg.photo || /^image\//.test(msg.document?.mime_type ?? ""))) return handlePhoto(msg);
  if (!msg?.text || String(msg.chat?.id) !== env("TG_CHAT_ID")) return;
  if (msg.reply_to_message && await handleReply(msg)) return;
  const [head, ...args] = msg.text.trim().split(/\s+/);
  const cmd = head.split("@")[0].toLowerCase();

  if (cmd === "/start" || cmd === "/help") return tg(HELP, true);
  if (cmd === "/status") return sendStatus();
  if (cmd === "/board") { await jobBoard(true); return; }
  if (cmd === "/report") return tg(await weeklyText(7), true);
  if (cmd === "/trades") return tg(await tradesText(), true);
  if (cmd === "/port" || cmd === "/portfolio") return tg(await portText(), true);
  if (cmd === "/buy" || cmd === "/sell") {
    const q = parsePrice(args[1] ?? ""), total = parsePrice(args[2] ?? "");
    if (!args[0] || !(q > 0) || !(total > 0))
      return tg(`ใช้แบบนี้: ${cmd} NEAR 17.263883 89.656\n(ชื่อ · จำนวนที่${cmd === "/buy" ? "ได้รับ" : "ขาย"} · ยอดเงิน USDT ที่${cmd === "/buy" ? "จ่าย" : "ได้รับ"})`);
    const w = await findWatch(args[0]), raw = args[0].toUpperCase();
    const key = w ? w.symbol : /USDT$|\.BK$|=X$/.test(raw) || ["ทอง", "GOLD", "XAU"].includes(raw) ? raw : raw + "USDT";
    const d = { side: cmd === "/buy" ? "buy" : "sell", base_qty: q, quote_amount: total, price: total / q, key, symbol: w?.symbol };
    return tg(`🧾 ${cmd === "/buy" ? "ซื้อ" : "ขาย"} ${px(q)} × ${px(total / q)} = ${px(total)}\n` + await applyReceipt(d));
  }
  if (cmd === "/in") {
    const w = args[0] ? await findWatch(args[0]) : null, price = parsePrice(args[1] ?? "");
    if (!w || !(price > 0)) return tg("ใช้แบบนี้: /in BTC 65120 (ใส่ short ต่อท้ายถ้าเป็น Short)");
    if (await openTradeOf(w.id)) return tg(`${w.name || display(w.symbol)} มีไม้จริงเปิดอยู่แล้ว ปิดก่อนด้วย /out`);
    const { data: s } = await sb.from("sig_state").select("side").eq("watch_id", w.id).maybeSingle();
    const rest = args.slice(2).join(" "), qn = args.slice(2).map(parsePrice).find((x) => x > 0);
    const side = /short|sell|ขาย/i.test(rest) ? -1 : /long|buy|ซื้อ/i.test(rest) ? 1 : (s?.side || 1);
    return tg(await openTrade(w, side, price, null, qn ? { qty: qn, cost: qn * price } : {}));
  }
  if (cmd === "/out") {
    const w = args[0] ? await findWatch(args[0]) : null, price = parsePrice(args[1] ?? "");
    if (!w || !(price > 0)) return tg("ใช้แบบนี้: /out BTC 66000");
    const t = await openTradeOf(w.id);
    if (!t) return tg(`${w.name || display(w.symbol)} ไม่มีไม้จริงเปิดอยู่`);
    return tg(await closeTrade(t, price));
  }
  if (cmd === "/slmode") {
    const w = args[0] ? await findWatch(args[0]) : null, mode = (args[1] || "").toLowerCase(), v = parseFloat(args[2]);
    if (!w || !["atr", "pct"].includes(mode) || !(v > 0)) return tg("ใช้แบบนี้: /slmode BTC atr 2 (2×ATR) หรือ /slmode BTC pct 3 (3%)");
    await sb.from("sig_watchlist").update(mode === "atr" ? { sl_mode: "atr", atr_mult: v } : { sl_mode: "pct", sl_pct: v }).eq("id", w.id);
    return tg(`✅ ${w.name || display(w.symbol)} ใช้ SL แบบ ${mode === "atr" ? `${v}×ATR` : `${v}%`} แล้ว`);
  }
  if (cmd === "/tp") {
    const w = args[0] ? await findWatch(args[0]) : null, v = parseFloat(args[1]);
    if (!w || !(v >= 0)) return tg("ใช้แบบนี้: /tp BTC 2 (TP = 2 เท่าของระยะ SL) · /tp BTC 0 = ไม่ตั้ง TP");
    await sb.from("sig_watchlist").update({ tp_r: v, tp_pct: 0 }).eq("id", w.id);
    return tg(`✅ ${w.name || display(w.symbol)} TP = ${v ? `${v}R` : "ไม่ตั้ง (รอสัญญาณออก)"}`);
  }
  if (cmd === "/maxlev") {
    const n = parseFloat(args[0]);
    if (!(n >= 1 && n <= 50)) return tg("ใช้แบบนี้: /maxlev 5 (เพดาน leverage ที่ระบบจะแนะนำ)");
    await sb.from("sig_settings").update({ max_lev: n }).eq("id", 1);
    return tg(`✅ ระบบจะแนะนำ leverage ไม่เกิน ${n}x`);
  }
  if (cmd === "/limit") {
    const n = parseInt(args[0]);
    if (!(n >= 1 && n <= 20)) return tg("ใช้แบบนี้: /limit 3 (จำนวนไม้ทิศเดียวกันต่อตลาดสูงสุด)");
    await sb.from("sig_settings").update({ max_same_dir: n }).eq("id", 1);
    return tg(`✅ ถือทิศเดียวกันได้สูงสุด ${n} ไม้ต่อตลาด`);
  }
  if (cmd === "/dayloss") {
    const n = parseFloat(args[0]);
    if (!(n > 0 && n <= 20)) return tg("ใช้แบบนี้: /dayloss 3 (% ขาดทุนสูงสุดต่อวัน)");
    await sb.from("sig_settings").update({ daily_loss_pct: n }).eq("id", 1);
    return tg(`✅ เพดานขาดทุนต่อวัน ${n}% ของพอร์ต`);
  }
  if (cmd === "/settings") {
    const S = await settings();
    return tg(`⚙️ พอร์ต USD: ${px(+S.balance_usd)} · พอร์ตบาท: ${px(+S.balance_thb)} · เสี่ยงต่อไม้: ${S.risk_pct}%\n` +
      `ถือทิศเดียวกันสูงสุด ${S.max_same_dir} ไม้/ตลาด · เพดานขาดทุน ${S.daily_loss_pct}%/วัน · leverage ไม่เกิน ${S.max_lev}x`);
  }
  if (cmd === "/bal") {
    const amt = parseFloat(args[0]), cur = (args[1] || "usd").toLowerCase();
    if (!(amt > 0)) return tg("ใช้แบบนี้: /bal 1000 usd หรือ /bal 30000 thb");
    await sb.from("sig_settings").update(cur === "thb" ? { balance_thb: amt } : { balance_usd: amt }).eq("id", 1);
    return tg(`✅ ตั้งพอร์ต ${cur === "thb" ? "บาท" : "USD"} = ${px(amt)}`);
  }
  if (cmd === "/risk") {
    const r = parseFloat(args[0]);
    if (!(r > 0 && r <= 5)) return tg("ใส่ 0.1–5 เช่น /risk 1 (แนะนำไม่เกิน 1–2%)");
    await sb.from("sig_settings").update({ risk_pct: r }).eq("id", 1);
    return tg(`✅ เสี่ยงต่อไม้ = ${r}%`);
  }
  if (cmd === "/market") {
    const S = await settings();
    return tg(["🗂 ตลาดที่เฝ้า", ...MARKETS.map((m) => `${mkOn(S, m) ? "✅ เปิด" : "⛔ ปิด"}  ${MK_LABEL[m]}`),
      "", "เปิด/ปิด: /on ทอง · /off หุ้นไทย · /on หุ้นus"].join("\n"));
  }
  if (cmd === "/on" || cmd === "/off") {
    const m = MK_ALIAS[(args[0] || "").toLowerCase()];
    if (!m) return tg("ใช้แบบนี้: /on คริปโต · /on ทอง · /on forex · /off หุ้นไทย · /off หุ้นus");
    const S = await settings(), on = cmd === "/on";
    await sb.from("sig_settings").update({ markets: { ...MK_DEFAULT, ...(S.markets ?? {}), [m]: on } }).eq("id", 1);
    let note = on ? "\nจะกลับมาเฝ้าภายใน 5 นาที" : "";
    if (!on) {
      const { data: ws } = await sb.from("sig_watchlist").select("id,source,symbol,name").eq("active", true);
      const ids = (ws ?? []).filter((w) => mk(w) === m).map((w) => w.id);
      const { data: st } = await sb.from("sig_state").select("watch_id,side").in("watch_id", ids.length ? ids : [-1]);
      const open = (st ?? []).filter((x) => x.side).length;
      if (open) note = `\n⚠️ มี ${open} ตัวที่สัญญาณยังเปิดอยู่ จะไม่ได้ alert ปิดไม้ ถ้าถือจริงอยู่ต้องดูเอง`;
    }
    return tg(`${on ? "✅ เปิด" : "⛔ ปิด"}การเฝ้า ${MK_LABEL[m]} แล้ว${note}`);
  }
  if (cmd === "/test") {
    if (!args[0]) return tg("ใช้แบบนี้: /test BTC หรือ /test EURUSD");
    await tg("⏳ กำลังทดสอบ 18 แบบ...");
    return tg(await testText(args[0]));
  }
  if (cmd === "/use") {
    const w = args[0] ? await findWatch(args[0]) : null, k = parseInt(args[1]);
    if (!w || !(k >= 1)) return tg("ใช้แบบนี้: /use BTC 2 (ดูเลขข้อจาก /test BTC ก่อน)");
    const { data: s } = await sb.from("sig_state").select("last_test,side").eq("watch_id", w.id).maybeSingle();
    const c = s?.last_test?.[k - 1];
    if (!c) return tg(`ยังไม่มีผลทดสอบข้อ ${k} พิมพ์ /test ${display(w.symbol)} ก่อน`);
    await sb.from("sig_watchlist").update({ strategy: c.strategy, params: c.params, trend_filter: c.trend_filter, manual: true,
      optimized_at: new Date().toISOString() }).eq("id", w.id);
    return tg(`✅ ${w.name || display(w.symbol)} ใช้ ${describe({ ...w, ...c })} แล้ว (เลือกเอง ระบบจะไม่เปลี่ยนให้)` +
      (s?.side ? "\nสถานะค้างจะถูกคำนวณใหม่ตามกลยุทธ์นี้" : "") + "\nจะได้ข้อความ \"เริ่มเฝ้า\" ใน 5 นาที");
  }
  if (cmd === "/auto") {
    const w = args[0] ? await findWatch(args[0]) : null;
    if (!w) return tg("ใช้แบบนี้: /auto BTC");
    await sb.from("sig_watchlist").update({ manual: false, optimized_at: null }).eq("id", w.id);
    return tg(`🤖 ${w.name || display(w.symbol)} กลับเป็นโหมดอัตโนมัติ ระบบจะ backtest เลือกกลยุทธ์ให้พรุ่งนี้เช้า`);
  }
  if (cmd === "/scan") {
    const { data } = await sb.from("sig_screen").select("*").order("created_at", { ascending: false }).limit(30);
    if (!data?.length) return tg("ยังไม่มีผลสแกน");
    const day = data[0].run_date, L = [`🔎 ผลสแกนล่าสุด ${day}`];
    for (const m of ["crypto", "th", "us"]) {
      const rows = data.filter((r) => r.run_date === day && r.market === m && r.rank <= 5).sort((a, b) => a.rank - b.rank);
      if (rows.length) L.push("", SCR[m].label, ...rows.map((r) => `${r.rank}. ${display(r.symbol)} 💲${px(+r.last_price)} ${pct(+r.roc60_pct)}${r.tag ? " 🆕" : ""}`));
    }
    return tg(L.join("\n"));
  }
  if (cmd === "/add") {
    if (!args[0]) return tg("ใช้แบบนี้: /add BTCUSDT หรือ /add PTT หรือ /add NVDA");
    const r = await resolveSymbol(args[0]);
    const tf = args[1] && TF_SEC[args[1]] ? args[1] : r.tf;
    const w: any = { symbol: r.symbol, source: r.source, tf };
    try { const b = await fetchBars(w); if (b.length < 60) throw new Error("ข้อมูลน้อย"); w.last = b[b.length - 1].c; }
    catch (e) { return tg(`❌ หา ${r.symbol} ไม่เจอหรือข้อมูลไม่พอ (${e instanceof Error ? e.message : e})`); }
    const { data: ex } = await sb.from("sig_watchlist").select("id,active").eq("symbol", r.symbol).maybeSingle();
    if (ex) {
      if (ex.active) return tg(`${r.symbol === "XAUUSDT" ? "ทองคำ" : display(r.symbol)} อยู่ในรายการเฝ้าอยู่แล้ว`);
      await sb.from("sig_watchlist").update({ active: true, tf, optimized_at: null }).eq("id", ex.id);
    } else {
      await sb.from("sig_watchlist").insert({ symbol: r.symbol, name: r.symbol === "XAUUSDT" ? "ทองคำ" : display(r.symbol), source: r.source, tf,
        strategy: "ma_cross", params: { fast: 20, slow: 50 }, allow_short: r.market === "gold" || r.market === "fx", sl_pct: r.sl,
        tp_pct: r.market === "fx" ? 1 : 0, market: r.market, active: true });
    }
    return tg(`✅ เพิ่ม ${display(r.symbol)} (${tf}) แล้ว 💲${px(w.last)}\nจะได้ข้อความ "เริ่มเฝ้า" ใน 5 นาที\nระบบจะ backtest เลือกกลยุทธ์ที่เหมาะให้พรุ่งนี้เช้า`);
  }
  if (cmd === "/stop") {
    if (!args[0]) return tg("ใช้แบบนี้: /stop ENA");
    const q = args[0].toUpperCase();
    const { data: ws } = await sb.from("sig_watchlist").select("id,symbol,name").eq("active", true);
    const w = ws?.find((x) => x.symbol === q || display(x.symbol) === q || (x.name || "").toUpperCase() === q);
    if (!w) return tg(`ไม่พบ ${q} ในรายการที่เฝ้าอยู่`);
    const { data: s } = await sb.from("sig_state").select("side").eq("watch_id", w.id).maybeSingle();
    await sb.from("sig_watchlist").update({ active: false }).eq("id", w.id);
    return tg(`⏹ หยุดเฝ้า ${display(w.symbol)} แล้ว` + (s?.side ? "\n⚠️ ตัวนี้มีสถานะค้างอยู่ จะไม่ได้ alert ออกแล้ว" : ""));
  }
  return tg("ไม่รู้จักคำสั่งนี้ พิมพ์ /help เพื่อดูคำสั่งทั้งหมด");
}

async function jobSetup() {
  const api = `https://api.telegram.org/bot${env("TG_TOKEN")}`;
  const post = async (m: string, body: any) => (await fetch(`${api}/${m}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  const a = await post("setWebhook", { url: `${FN_URL}?job=bot`, secret_token: env("CRON_SECRET"), allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
  const b = await post("setMyCommands", { commands: [
    { command: "status", description: "ราคาปัจจุบันและสถานะทุกตัว" }, { command: "board", description: "สร้างกระดานปักหมุดใหม่" }, { command: "scan", description: "ผลสแกนเทรนด์ล่าสุด" },
    { command: "report", description: "สรุป 7 วัน" }, { command: "add", description: "เพิ่มตัวที่เฝ้า เช่น /add BTCUSDT" },
    { command: "stop", description: "หยุดเฝ้า เช่น /stop ENA" }, { command: "bal", description: "ตั้งเงินในพอร์ต" },
    { command: "risk", description: "ตั้ง % เสี่ยงต่อไม้" }, { command: "settings", description: "ดูค่าที่ตั้งไว้" },
    { command: "market", description: "ดูตลาดที่เปิด-ปิด" }, { command: "on", description: "เปิดตลาด เช่น /on ทอง" },
    { command: "off", description: "ปิดตลาด เช่น /off หุ้นไทย" }, { command: "test", description: "เทียบกลยุทธ์ เช่น /test BTC" },
    { command: "use", description: "เลือกกลยุทธ์เอง เช่น /use BTC 2" }, { command: "auto", description: "ให้ระบบเลือกกลยุทธ์ เช่น /auto BTC" },
    { command: "port", description: "สรุปพอร์ต มูลค่า กำไรขาดทุน" }, { command: "buy", description: "บันทึกซื้อ เช่น /buy NEAR 17.26 89.66" },
    { command: "sell", description: "บันทึกขาย เช่น /sell NEAR 17.26 95.1" }, { command: "trades", description: "ไม้จริงที่ถืออยู่" }, { command: "in", description: "บันทึกเข้าไม้จริง เช่น /in BTC 65120" },
    { command: "out", description: "บันทึกปิดไม้จริง เช่น /out BTC 66000" }, { command: "limit", description: "จำกัดไม้ทิศเดียวกัน" },
    { command: "dayloss", description: "เพดานขาดทุนต่อวัน" }, { command: "slmode", description: "แบบ SL เช่น /slmode BTC atr 2" },
    { command: "tp", description: "TP เป็นเท่าของ SL เช่น /tp BTC 2" }, { command: "maxlev", description: "เพดาน leverage เช่น /maxlev 5" }, { command: "help", description: "คำสั่งทั้งหมด" }] });
  if (a.ok) await tg("🤖 อัปเดตคำสั่งแล้ว พิมพ์ /status หรือ /market ได้เลย");
  return { webhook: a, commands: b };
}

// ================================ server ================================
Deno.serve(async (req) => {
  const url = new URL(req.url), secret = env("CRON_SECRET"), job = url.searchParams.get("job") ?? "scan";
  if (job === "bot") {
    if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("unauthorized", { status: 401 });
    try { await handleBot(req); } catch (e) { console.error("bot", e); await tg("❗ เกิดข้อผิดพลาด: " + String(e)).catch(() => {}); }
    return new Response("ok");
  }
  if (!secret || req.headers.get("x-cron-secret") !== secret) return new Response("unauthorized", { status: 401 });
  try {
    if (url.searchParams.get("test")) { await tg("✅ ทดสอบ alert จาก Supabase สำเร็จ"); return Response.json({ ok: true }); }
    if (job === "screen") return Response.json(await jobScreen());
    if (job === "optimize") return Response.json(await jobOptimize(url.searchParams.get("force") === "1"));
    if (job === "weekly") { await tg(await weeklyText(7), true); await tg(await portText(), true); await sendStatus(); return Response.json({ ok: true }); }
    if (job === "setup") return Response.json(await jobSetup());
    if (job === "board") return Response.json(await jobBoard(url.searchParams.get("fresh") === "1"));
    if (job === "backtest") return Response.json(await jobBacktest());
    if (job === "port") { await tg(await portText(), true); return Response.json({ ok: true }); }
    if (job === "chartdemo") {
      const S = await settings(), { data: ws } = await sb.from("sig_watchlist").select("*").eq("active", true).order("id");
      const w = (ws ?? []).find((x) => isOn(S, x)), bars = await closedBars(w), a = atrArr(bars), c = bars.at(-1)!.c, d = slDist(w, c, a.at(-1));
      const png = await chartPng(w, bars, { entry: c, sl: c - d, tp: tpR(w) ? c + d * tpR(w) : undefined });
      const ok = png ? await tgPhoto(png, `🖼 ตัวอย่างรูปกราฟที่จะแนบใน alert\n${w.name || display(w.symbol)} · เส้นน้ำเงิน = เข้า · แดง = SL · เขียว = TP`, null) : false;
      return Response.json({ ok, png: !!png });
    }
    return Response.json({ ok: true, report: await jobScan() });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
