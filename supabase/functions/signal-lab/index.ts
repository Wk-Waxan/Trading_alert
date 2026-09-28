// signal-lab v1 - Top 20 พร้อมบทวิเคราะห์ · ตัวเฝ้าระบบ (watchdog) · บันทึกพอร์ตรายวัน
// Telegram webhook เข้าที่ฟังก์ชันนี้: /top /health จัดการเอง คำสั่งอื่นส่งต่อไป signal-scan ทั้งก้อน
// ?job= watch (ทุก 5 นาที) | rank (รายวัน) | snapshot (รายวัน) | setup | run (ทดสอบคำสั่ง) | bot (Telegram)
// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

const DAY = 86400e3;
const env = (k: string) => Deno.env.get(k) ?? "";
const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const BASE = "https://feiyuytifgiylgxtvohh.supabase.co/functions/v1";
const LAB_URL = `${BASE}/signal-lab`, SCAN_URL = `${BASE}/signal-scan`;
const LINE = "━━━━━━━━━━━━";
const TF_SEC: Record<string, number> = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============================== helpers ==============================
const px = (v: number) => v == null || !isFinite(v) ? "-" : v.toLocaleString("en-US", { maximumSignificantDigits: 6 });
const money = (v: number) => !isFinite(v) ? "-" : v.toLocaleString("en-US", { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 });
const pct = (v: number) => !isFinite(v) ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const bkk = (t: number) => new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const bkkDay = (t: number) => new Date(t + 7 * 3600e3).toISOString().slice(0, 10);
const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const display = (s: string) => s.replace(/\.BK$/, "").replace(/USDT$/, "").replace(/=X$/, "");
const mk = (w: any) => w.source === "binance_futures" ? "gold" : w.source === "binance_spot" ? "crypto"
  : w.symbol.endsWith("=X") ? "fx" : (w.source === "yahoo" && w.symbol.endsWith(".BK")) ? "th" : "us";
const MK_DEFAULT: Record<string, boolean> = { crypto: true, gold: true, fx: true, th: false, us: false };
const mkOn = (S: any, m: string) => ({ ...MK_DEFAULT, ...(S.markets ?? {}) })[m] !== false;

async function getJSON(url: string, headers: Record<string, string> = {}) {
  for (let a = 0; a < 2; a++) {
    const r = await fetch(url, { headers });
    if (r.ok) return r.json();
    if (a === 0 && (r.status === 429 || r.status >= 500)) { await sleep(1500); continue; }
    throw new Error(`HTTP ${r.status} ${url.split("?")[0]}`);
  }
}
async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []; let k = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i]); } }));
  return out;
}
async function tg(text: string, markup?: any) {
  const r = await fetch(`https://api.telegram.org/bot${env("TG_TOKEN")}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env("TG_CHAT_ID"), text, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) }),
  });
  if (!r.ok) console.error("telegram", r.status, await r.text());
}
async function tgRaw(method: string, body: any) {
  const r = await fetch(`https://api.telegram.org/bot${env("TG_TOKEN")}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

// ============================== data ==============================
async function binanceDaily(sym: string): Promise<Bar[]> {
  const rows = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1d&limit=400`);
  const now = Date.now();
  return rows.map((r: any[]) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })).filter((b: Bar) => b.t + DAY <= now);
}
async function yahooDaily(sym: string): Promise<Bar[]> {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2y`, { "User-Agent": "Mozilla/5.0" });
  const r = j.chart?.result?.[0];
  if (!r?.timestamp) throw new Error("Yahoo ไม่มีข้อมูล " + sym);
  const q = r.indicators.quote[0];
  return r.timestamp.map((t: number, i: number) => ({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] ?? 0 }))
    .filter((b: Bar) => b.o != null && b.c != null && b.h != null && b.l != null);
}
async function livePrices(ws: any[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const by = (s: string) => ws.filter((w) => w.source === s).map((w) => w.symbol);
  const spot = by("binance_spot");
  if (spot.length) { try { for (const x of await getJSON("https://data-api.binance.vision/api/v3/ticker/price")) if (spot.includes(x.symbol)) out.set(x.symbol, +x.price); } catch (_) { /* */ } }
  await Promise.all(by("binance_futures").map(async (s) => {
    try { out.set(s, +(await getJSON(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${s}`)).price); } catch (_) { /* */ } }));
  await Promise.all(by("yahoo").map(async (s) => {
    try { const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=5d`, { "User-Agent": "Mozilla/5.0" });
      const p = j.chart?.result?.[0]?.meta?.regularMarketPrice; if (p) out.set(s, +p); } catch (_) { /* */ } }));
  const td = by("twelvedata");
  if (td.length) {
    try { const j = await getJSON(`https://api.twelvedata.com/price?symbol=${td.join(",")}&apikey=${env("TWELVEDATA_KEY")}`);
      if (td.length === 1) { if (j.price) out.set(td[0], +j.price); } else for (const s of td) if (j[s]?.price) out.set(s, +j[s].price);
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

// ============================ Top 20 ============================
const MKS = ["crypto", "gold", "fx", "th", "us"];
const LABEL: Record<string, string> = { crypto: "คริปโต", gold: "ทอง/โลหะ/พลังงาน", fx: "Forex", th: "หุ้นไทย", us: "หุ้น US" };
const ALIAS: Record<string, string> = { crypto: "crypto", "คริปโต": "crypto", coin: "crypto", gold: "gold", "ทอง": "gold", "โลหะ": "gold", commodity: "gold",
  fx: "fx", forex: "fx", "ฟอเร็กซ์": "fx", "ค่าเงิน": "fx", th: "th", thai: "th", "หุ้นไทย": "th", set: "th", us: "us", usa: "us", "หุ้นus": "us", "หุ้นนอก": "us" };
const COMMO: [string, string][] = [["GC=F", "ทองคำ"], ["SI=F", "เงิน"], ["PL=F", "แพลทินัม"], ["PA=F", "แพลเลเดียม"], ["HG=F", "ทองแดง"],
  ["CL=F", "น้ำมัน WTI"], ["BZ=F", "น้ำมัน Brent"], ["NG=F", "ก๊าซธรรมชาติ"], ["GLD", "GLD (ETF ทอง)"], ["SLV", "SLV (ETF เงิน)"],
  ["GDX", "GDX (หุ้นเหมืองทอง)"], ["GDXJ", "GDXJ (เหมืองทองเล็ก)"], ["PPLT", "PPLT (ETF แพลทินัม)"], ["CPER", "CPER (ETF ทองแดง)"],
  ["USO", "USO (ETF น้ำมัน)"], ["UNG", "UNG (ETF ก๊าซ)"]];
const WATCH_MAP: Record<string, string> = { "GC=F": "XAUUSDT", "SI=F": "XAGUSDT" };
const ATR_HI: Record<string, number> = { crypto: 7, gold: 3.5, fx: 1.2, th: 4, us: 4.5 };

type U = { sym: string; name: string; src: "b" | "y"; short: boolean; watch: string };
function fxPairs() {
  const o = ["EUR", "GBP", "AUD", "NZD", "USD", "CAD", "CHF", "JPY"], out: string[] = [];
  for (let i = 0; i < o.length; i++) for (let j = i + 1; j < o.length; j++) out.push(o[i] + o[j]);
  return out;
}
async function universe(m: string): Promise<U[]> {
  if (m === "crypto") {
    const t = await getJSON("https://data-api.binance.vision/api/v3/ticker/24hr");
    const stable = /^(USDC|FDUSD|TUSD|USDP|DAI|BUSD|EUR|AEUR|EURI|USD1|PYUSD|USDE|XUSD|BFUSD|RLUSD|PAXG|WBTC|WBETH|BNSOL)USDT$/;
    return t.filter((x: any) => x.symbol.endsWith("USDT") && !stable.test(x.symbol) && !/(UP|DOWN|BULL|BEAR)USDT$/.test(x.symbol))
      .sort((a: any, b: any) => +b.quoteVolume - +a.quoteVolume).slice(0, 60)
      .map((x: any) => ({ sym: x.symbol, name: display(x.symbol), src: "b" as const, short: false, watch: x.symbol }));
  }
  if (m === "gold") return COMMO.map(([sym, name]) => ({ sym, name, src: "y" as const, short: sym.endsWith("=F"), watch: WATCH_MAP[sym] ?? sym }));
  if (m === "fx") return fxPairs().map((p) => ({ sym: `${p}=X`, name: `${p.slice(0, 3)}/${p.slice(3)}`, src: "y" as const, short: true, watch: `${p}=X` }));
  const { data } = await sb.from("sig_universe").select("symbol").eq("market", m).eq("active", true);
  return (data ?? []).map((u: any) => ({ sym: u.symbol, name: display(u.symbol), src: "y" as const, short: false, watch: u.symbol }));
}

function metrics(b: Bar[]) {
  const n = b.length;
  if (n < 210) return null;
  const c = b.map((x) => x.c), i = n - 1, s20 = sma(c, 20), s50 = sma(c, 50), s200 = sma(c, 200), r = rsi(c, 14), a = atrArr(b, 14);
  if (![s20[i], s20[i - 5], s50[i], s200[i], r[i], a[i]].every((x) => isFinite(x))) return null;
  const hi = (k: number) => Math.max(...b.slice(-k).map((x) => x.h)), lo = (k: number) => Math.min(...b.slice(-k).map((x) => x.l));
  let newHigh = false, newLow = false, golden = false, death = false;
  for (let j = i - 2; j <= i; j++) {
    let mx = -Infinity, mn = Infinity;
    for (let k = j - 55; k < j; k++) { mx = Math.max(mx, b[k].h); mn = Math.min(mn, b[k].l); }
    if (c[j] >= mx) newHigh = true; if (c[j] <= mn) newLow = true;
  }
  for (let j = i - 9; j <= i; j++) {
    if (s50[j - 1] <= s200[j - 1] && s50[j] > s200[j]) golden = true;
    if (s50[j - 1] >= s200[j - 1] && s50[j] < s200[j]) death = true;
  }
  const vol = b.map((x) => x.v || 0), avg = (x: number[]) => x.reduce((p, q) => p + q, 0) / x.length, v50 = avg(vol.slice(-50)), v10 = avg(vol.slice(-10));
  const roc = (k: number) => c[i] / c[i - k] - 1;
  return { c: c[i], chg1d: roc(1), roc30: roc(30), roc60: roc(60), roc90: roc(90), s20: s20[i], s20b: s20[i - 5], s50: s50[i], s200: s200[i],
    rsi: r[i], atr: a[i], atrPct: a[i] / c[i] * 100, hi55: hi(55), lo55: lo(55), newHigh, newLow, golden, death, vr: v50 > 0 ? v10 / v50 : NaN };
}

// คะแนน 0-100 = เทรนด์ (40) + โมเมนตัมเทียบกลุ่ม (30) + คุณภาพจุดเข้า: RSI/ไม่ไกลจาก MA50/ใกล้จุดสูง-ต่ำ (30)
function score(m: any, s: number, p: number) {
  let trend = 0;
  if (s * (m.c - m.s200) > 0) trend += 10;
  if (s * (m.c - m.s50) > 0) trend += 10;
  if (s * (m.s50 - m.s200) > 0) trend += 10;
  if (s * (m.s20 - m.s20b) > 0) trend += 10;
  const mom = p * 30, rv = s > 0 ? m.rsi : 100 - m.rsi;
  let q = rv >= 50 && rv <= 70 ? 10 : (rv >= 42 && rv < 50) || (rv > 70 && rv <= 78) ? 5 : 0;
  const ext = s * (m.c - m.s50) / m.atr;
  q += ext >= 0 && ext <= 4 ? 10 : ext > 4 && ext <= 7 ? 5 : 0;
  const near = s > 0 ? m.c / m.hi55 : m.lo55 / m.c;
  q += near >= 0.92 ? 10 : near >= 0.85 ? 5 : 0;
  return { trend, total: Math.round(trend + mom + q) };
}

function explain(m: any, sc: any, s: number, mkt: string) {
  const up = s > 0, pos = `${m.c > m.s50 ? "เหนือ" : "ใต้"} MA50 · ${m.c > m.s200 ? "เหนือ" : "ใต้"} MA200`;
  const tl = sc.trend >= 40 ? (up ? "ขาขึ้นเต็มรูปแบบ" : "ขาลงเต็มรูปแบบ") : sc.trend >= 30 ? (up ? "ขาขึ้นค่อนข้างดี" : "ขาลงค่อนข้างชัด")
    : sc.trend >= 20 ? "เทรนด์ยังไม่ชัด" : "เทรนด์อ่อน/สวนทาง";
  const l1 = `${tl} (${pos}) · 30 วัน ${pct(m.roc30 * 100)} · 90 วัน ${pct(m.roc90 * 100)}`;
  const rs = Math.round(m.rsi), l2: string[] = [];
  l2.push(up && rs >= 75 ? `RSI ${rs} ร้อนแรง ระวังย่อ อย่าไล่ราคา` : !up && rs <= 25 ? `RSI ${rs} ขายมากเกิน ระวังเด้ง อย่าไล่ขาย`
    : rs <= 30 ? `RSI ${rs} ขายมากเกิน` : rs >= 70 ? `RSI ${rs} ค่อนร้อน` : `RSI ${rs}`);
  l2.push(up ? (m.newHigh ? "ทำจุดสูงสุด 55 วันใหม่ 🆕" : `ห่างจุดสูง 55 วัน ${pct((m.c / m.hi55 - 1) * 100)}`)
    : (m.newLow ? "ทำจุดต่ำสุด 55 วันใหม่ 🆕" : `ห่างจุดต่ำ 55 วัน ${pct((m.c / m.lo55 - 1) * 100)}`));
  if (m.golden) l2.push("เพิ่งเกิด Golden cross"); else if (m.death) l2.push("เพิ่งเกิด Death cross");
  const l3 = [up ? `แนวรับ MA20 ${px(m.s20)} / MA50 ${px(m.s50)} (หลุด MA50 = เทรนด์อ่อนลง)` : `แนวต้าน MA20 ${px(m.s20)} / MA50 ${px(m.s50)} (ทะลุ MA50 = ขาลงอ่อนลง)`];
  l3.push(`ผันผวน ~${m.atrPct.toFixed(1)}%/วัน`);
  if (isFinite(m.vr) && m.vr > 0) { if (m.vr >= 1.5) l3.push(`วอลุ่มเร่ง ×${m.vr.toFixed(1)}`); else if (m.vr <= 0.6) l3.push("วอลุ่มแผ่ว"); }
  const hot = (up && rs >= 75) || (!up && rs <= 25), side = up ? "Long" : "Short";
  let st = sc.total >= 75 ? (hot ? "รอย่อ/เด้งใกล้ MA20 ก่อน ไม่ไล่ราคา" : `น่าติดตามฝั่ง ${side} · รอสัญญาณเข้าจากระบบ`)
    : sc.total >= 55 ? "ดูต่อ ยังไม่เด่นพอ" : "ยังไม่น่าสนใจ ไม่เข้าเกณฑ์เข้าเทรด";
  if (m.atrPct > ATR_HI[mkt]) st += " · ผันผวนสูง ลดขนาดไม้";
  return [l1, l2.join(" · "), l3.join(" · "), `ท่าที: ${st}`];
}

function summarize(m: string, ok: any[], uniN: number) {
  const N = ok.length, up = ok.filter((x) => x.mt.c > x.mt.s50 && x.mt.s50 > x.mt.s200).length, dn = ok.filter((x) => x.mt.c < x.mt.s50 && x.mt.s50 < x.mt.s200).length;
  const a50 = ok.filter((x) => x.mt.c > x.mt.s50).length / N * 100, a200 = ok.filter((x) => x.mt.c > x.mt.s200).length / N * 100;
  const rocs = ok.map((x) => x.mt.roc30).sort((a: number, b: number) => a - b), med = rocs[Math.floor(N / 2)];
  const by = [...ok].sort((a, b) => b.mt.roc30 - a.mt.roc30), fmt = (x: any) => `${x.u.name} ${pct(x.mt.roc30 * 100)}`;
  const L = [`📊 ภาพรวม${LABEL[m]} · วิเคราะห์ได้ ${N}/${uniN} ตัว`,
    `• ขาขึ้นเต็มรูปแบบ ${up} ตัว (${(up / N * 100).toFixed(0)}%) · ขาลงเต็มรูปแบบ ${dn} ตัว`,
    `• เหนือ MA50 ${a50.toFixed(0)}% · เหนือ MA200 ${a200.toFixed(0)}% · 30 วันค่ากลาง ${pct(med * 100)}`,
    `• นำตลาด: ${by.slice(0, 3).map(fmt).join(", ")}`, `• ตามหลัง: ${by.slice(-3).reverse().map(fmt).join(", ")}`];
  if (m === "fx") {
    const st: Record<string, number> = {}, cn: Record<string, number> = {};
    for (const x of ok) { const b = x.u.name.slice(0, 3), q = x.u.name.slice(4, 7), r = x.mt.roc30 * 100;
      st[b] = (st[b] ?? 0) + r; st[q] = (st[q] ?? 0) - r; cn[b] = (cn[b] ?? 0) + 1; cn[q] = (cn[q] ?? 0) + 1; }
    const arr = Object.keys(st).map((k) => [k, st[k] / cn[k]] as [string, number]).sort((a, b) => b[1] - a[1]);
    L.push(`• สกุลเงิน 30 วัน (แข็ง → อ่อน): ${arr.map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${v.toFixed(1)}`).join(" · ")}`);
  }
  const sym = m === "fx" || m === "gold", share = sym ? (up + dn) / N : up / N;
  L.push("• อ่านตลาด: " + (sym
    ? (share >= 0.5 ? "หลายตัวมีเทรนด์ชัด เหมาะกับกลยุทธ์ตามเทรนด์" : "ตลาดวนไปมา (sideways) สัญญาณตามเทรนด์มักหลอก ลดขนาดไม้หรือรอ")
    : (share >= 0.6 ? "ขาขึ้นกว้าง เน้นตามเทรนด์ตัวนำได้ แต่ระวังตัวที่ร้อนเกินไป"
      : share >= 0.35 ? "ตลาดผสม เลือกเฉพาะตัวที่คะแนนสูงและเทรนด์ชัด" : "ตลาดโดยรวมอ่อน ระบบจะให้สัญญาณเข้าน้อย ลดขนาดไม้หรือรอ")));
  return { text: L.join("\n"), stats: { N, up, dn, a50, a200, med } };
}

async function rankMarket(m: string) {
  const uni = await universe(m);
  if (!uni.length) throw new Error("ไม่มีรายชื่อหุ้นให้วิเคราะห์ (ตาราง sig_universe ว่าง)");
  const res = await mapLimit(uni, m === "crypto" ? 6 : 4, async (u) => {
    try { const mt = metrics(u.src === "b" ? await binanceDaily(u.sym) : await yahooDaily(u.sym)); return mt ? { u, mt, p: 0, sc: null as any, s: 1 } : null; } catch (_) { return null; }
  });
  const ok = res.filter((x): x is NonNullable<typeof x> => !!x);
  if (ok.length < 3) throw new Error(`ข้อมูลไม่พอ (วิเคราะห์ได้ ${ok.length}/${uni.length} ตัว)`);
  const sorted = [...ok].sort((a, b) => a.mt.roc60 - b.mt.roc60);
  ok.forEach((x) => { x.p = sorted.indexOf(x) / (ok.length - 1); });
  for (const x of ok) {
    const L = score(x.mt, 1, x.p), S = x.u.short ? score(x.mt, -1, 1 - x.p) : null;
    if (S && S.total > L.total) { x.sc = S; x.s = -1; } else { x.sc = L; x.s = 1; }
  }
  ok.sort((a, b) => (b.sc.total - a.sc.total) || (b.s * b.mt.roc60 - a.s * a.mt.roc60));
  const sm = summarize(m, ok, uni.length), now = new Date().toISOString();
  const rows = ok.slice(0, 20).map((x, i) => {
    const fl: string[] = [], mt = x.mt, s = x.s;
    if ((s > 0 && mt.rsi >= 75) || (s < 0 && mt.rsi <= 25)) fl.push("🔥");
    if ((s > 0 && (mt.newHigh || mt.golden)) || (s < 0 && (mt.newLow || mt.death))) fl.push("🆕");
    if (mt.atrPct > ATR_HI[m]) fl.push("⚡");
    return { market: m, rank: i + 1, symbol: x.u.sym, name: x.u.name, side: s, score: x.sc.total, price: mt.c, chg1d: mt.chg1d * 100,
      roc30: mt.roc30 * 100, roc90: mt.roc90 * 100, rsi: mt.rsi, atr_pct: mt.atrPct, flags: fl, lines: explain(mt, x.sc, s, m).join("\n"),
      metrics: { watch: x.u.watch }, run_at: now };
  });
  await sb.from("sig_rank").delete().eq("market", m);
  await sb.from("sig_rank").insert(rows);
  await sb.from("sig_rank_meta").upsert({ market: m, run_at: now, universe: uni.length, passed: ok.length, summary: sm.text, stats: sm.stats });
  return { market: m, analyzed: ok.length, of: uni.length, top: rows.slice(0, 3).map((r) => `${r.name}(${r.score})`).join(",") };
}

async function jobRank(only: string | null) {
  const t0 = Date.now(), done: any[] = [], failed: string[] = [], skipped: string[] = [];
  for (const m of only ? [only] : MKS) {
    if (Date.now() - t0 > 110e3) { skipped.push(m); continue; }
    try { done.push(await rankMarket(m)); } catch (e) { failed.push(`${m}: ${e instanceof Error ? e.message : e}`); }
  }
  return { ok: failed.length === 0, done, failed, skipped };
}

const KB = { inline_keyboard: [[{ text: "🪙 คริปโต", callback_data: "top:crypto" }, { text: "🥇 ทอง/โลหะ", callback_data: "top:gold" }],
  [{ text: "💱 Forex", callback_data: "top:fx" }, { text: "🇹🇭 หุ้นไทย", callback_data: "top:th" }], [{ text: "🇺🇸 หุ้น US", callback_data: "top:us" }]] };

async function showTop(m: string, n = 20, force = false) {
  let { data: meta } = await sb.from("sig_rank_meta").select("*").eq("market", m).maybeSingle();
  if (!meta || force || Date.now() - Date.parse(meta.run_at) > 26 * 3600e3) {
    await tg(`⏳ กำลังวิเคราะห์${LABEL[m]} ใช้เวลาราว 10–30 วินาที…`);
    try { await rankMarket(m); ({ data: meta } = await sb.from("sig_rank_meta").select("*").eq("market", m).maybeSingle()); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!meta) return tg(`❌ วิเคราะห์${LABEL[m]}ไม่สำเร็จ: ${esc(msg)}\nลองใหม่อีกครั้งในอีกสักครู่`);
      await tg(`⚠️ วิเคราะห์ใหม่ไม่สำเร็จ (${esc(msg)}) · แสดงผลล่าสุดแทน`);
    }
  }
  const { data: rows } = await sb.from("sig_rank").select("*").eq("market", m).order("rank").limit(n);
  if (!rows?.length) return tg(`ยังไม่มีผลวิเคราะห์${LABEL[m]}`);
  const { data: wl } = await sb.from("sig_watchlist").select("symbol").eq("active", true);
  const watch = new Set((wl ?? []).map((w: any) => w.symbol));
  const item = (r: any) => {
    const em = r.score >= 75 ? "🟢" : r.score >= 55 ? "🟡" : "🟠", body = String(r.lines).split("\n").map(esc).join("\n   ");
    return `${r.rank}. ${em} <b>${esc(r.name)}</b>${r.side < 0 ? " [Short]" : ""} ${px(+r.price)} (${pct(+r.chg1d)}) · ${r.score}` +
      `${(r.flags ?? []).length ? " " + r.flags.join("") : ""}${watch.has(r.metrics?.watch) ? " 👁" : ""}\n   ${body}\n`;
  };
  const msgs: string[] = []; let buf = `<b>🏆 Top ${rows.length} ${LABEL[m]}</b> · ${bkk(Date.parse(meta.run_at))}\n${LINE}\n${esc(meta.summary)}\n`;
  for (const r of rows) { const b = item(r); if ((buf + "\n" + b).length > 3700) { msgs.push(buf); buf = ""; } buf += (buf ? "\n" : "") + b; }
  buf += "\n🟢 ≥75 · 🟡 55–74 · 🟠 ต่ำกว่า 55 คะแนน · 👁 เฝ้าอยู่ · 🆕 เพิ่งเบรก · 🔥 ร้อนแรง · ⚡ ผันผวนสูง\n" +
    "คัดจากกฎเทคนิคอัตโนมัติ (เทรนด์ + โมเมนตัม + จุดเข้าไม่ตึงเกินไป) ไม่ใช่คำแนะนำซื้อขาย · เพิ่มเข้าเฝ้า: /add ชื่อ";
  msgs.push(buf);
  for (let i = 0; i < msgs.length; i++) await tg(msgs[i], i === msgs.length - 1 ? KB : undefined);
}

// ============================ ตัวเฝ้าระบบ ============================
type Check = { key: string; label: string; ok: boolean; detail: string; need: number; hint: string };
const EXPECT_JOBS = ["signal-scan-every-5min", "signal-screen-daily", "signal-optimize-daily", "signal-weekly", "signal-backtest-daily",
  "signal-watch-5min", "signal-rank-daily", "signal-equity-daily"];

async function setWebhook() {
  return tgRaw("setWebhook", { url: `${LAB_URL}?job=bot`, secret_token: env("CRON_SECRET"), allowed_updates: ["message", "callback_query"] });
}

async function runChecks(fix: boolean): Promise<Check[]> {
  const now = Date.now(), out: Check[] = [];
  const { data: S0 } = await sb.from("sig_settings").select("*").eq("id", 1).maybeSingle(), S = S0 ?? {};

  const { data: h, error: he } = await sb.rpc("sig_health");
  if (he || !h) {
    out.push({ key: "scanner", label: "สแกนสัญญาณ", ok: false, detail: `อ่านสถานะระบบไม่ได้ (${he?.message ?? "ไม่มีข้อมูล"})`, need: 2, hint: "ตรวจ Supabase → Database ว่ายังทำงานปกติ" });
  } else {
    const last = h.last_scan_ok ? Date.parse(h.last_scan_ok) : 0, age = last ? (now - last) / 60e3 : Infinity;
    const bad = (h.bad_recent ?? []).slice(0, 2).map((b: any) => `HTTP ${b.code ?? "-"} ${b.err || String(b.body).slice(0, 60)}`).join(" | ");
    out.push({ key: "scanner", label: "สแกนสัญญาณ", ok: age <= 20, need: 1,
      detail: isFinite(age) ? `สแกนสำเร็จล่าสุด ${Math.round(age)} นาทีก่อน (ปกติทุก 5 นาที)${age > 20 && bad ? ` · ล่าสุด: ${bad}` : ""}` : "ไม่พบผลสแกนสำเร็จใน 6 ชม.ล่าสุด",
      hint: "เปิด Supabase → Edge Functions → signal-scan → Logs ดู error หรือบอกผมให้ตรวจ" });
    const missing = EXPECT_JOBS.filter((n) => !(h.jobs ?? []).some((j: any) => j.name === n && j.active));
    const failed = (h.cron_last ?? []).filter((x: any) => x.status === "failed").map((x: any) => `${x.jobname}: ${String(x.return_message).slice(0, 60)}`);
    out.push({ key: "cron", label: "งานตั้งเวลา (cron)", ok: !missing.length && !failed.length, need: 1,
      detail: missing.length || failed.length ? [missing.length ? `ไม่พบ/ถูกปิด: ${missing.join(", ")}` : "", failed.length ? `ล้มเหลว: ${failed.join("; ")}` : ""].filter(Boolean).join(" · ") : `${EXPECT_JOBS.length} งานทำงานปกติ`,
      hint: "ตรวจตาราง cron.job ใน Supabase หรือบอกผมให้สร้างงานที่หายไปใหม่" });
  }

  const { data: ws } = await sb.from("sig_watchlist").select("id,symbol,name,tf,source").eq("active", true);
  const { data: st } = await sb.from("sig_state").select("watch_id,last_error,updated_at");
  const on = (ws ?? []).filter((w: any) => mkOn(S, mk(w)));
  const stOf = (w: any) => (st ?? []).find((s: any) => s.watch_id === w.id);
  const errs = on.filter((w: any) => stOf(w)?.last_error);
  const stale = on.filter((w: any) => { const s = stOf(w); return s?.updated_at && now - Date.parse(s.updated_at) > ((TF_SEC[w.tf] ?? 3600) * 2 + 1800) * 1000; });
  out.push({ key: "data", label: "ข้อมูลราคา", ok: !errs.length && !stale.length, need: 2,
    detail: errs.length || stale.length
      ? [errs.length ? `ดึงไม่ได้: ${errs.map((w: any) => w.name || display(w.symbol)).join(", ")} (${String(stOf(errs[0])?.last_error).slice(0, 70)})` : "",
        stale.length ? `ไม่อัปเดตนานผิดปกติ: ${stale.map((w: any) => w.name || display(w.symbol)).join(", ")}` : ""].filter(Boolean).join(" · ")
      : `${on.length}/${on.length} ตัวปกติ`,
    hint: "มักเป็นแหล่งข้อมูลฟรี (Yahoo/Binance) ขัดข้องชั่วคราว ถ้าเกิน 1 ชม. บอกผมให้ตรวจ" });

  const wi = (await tgRaw("getWebhookInfo", {})).result ?? {}, pend = wi.pending_update_count ?? 0;
  let wok = true, wd = `ปกติ · รอส่ง ${pend}`;
  if (!String(wi.url ?? "").startsWith(LAB_URL)) {
    wok = false; wd = `webhook ชี้ไปที่อื่น (${String(wi.url || "ว่าง").replace(BASE, "…")})`;
    if (fix) { await setWebhook(); wd += " → ตั้งกลับมาที่ signal-lab ให้แล้ว"; }
  } else if (pend >= 3 || (wi.last_error_date && now / 1000 - wi.last_error_date < 600 && pend > 0)) {
    wok = false; wd = `Telegram ส่งคำสั่งเข้าระบบไม่สำเร็จ · ค้าง ${pend} รายการ${wi.last_error_message ? ` (${String(wi.last_error_message).slice(0, 80)})` : ""}`;
  }
  out.push({ key: "webhook", label: "Telegram webhook", ok: wok, detail: wd, need: 1, hint: "ถ้าพิมพ์คำสั่งแล้วบอทเงียบ ให้บอกผม" });

  const [bt, rk, eq] = await Promise.all([
    sb.from("sig_backtest").select("run_at").order("run_at", { ascending: false }).limit(1),
    sb.from("sig_rank_meta").select("run_at").order("run_at", { ascending: false }).limit(1),
    sb.from("sig_equity").select("day").order("day", { ascending: false }).limit(1)]);
  const hrs = (t?: string) => t ? (now - Date.parse(t)) / 3600e3 : NaN, late: string[] = [];
  const hb = hrs(bt.data?.[0]?.run_at), hr = hrs(rk.data?.[0]?.run_at), lastEq = eq.data?.[0]?.day;
  if (isFinite(hb) && hb > 30) late.push(`backtest ${Math.round(hb)} ชม.ก่อน`);
  if (isFinite(hr) && hr > 30) late.push(`จัดอันดับ ${Math.round(hr)} ชม.ก่อน`);
  if (lastEq && lastEq < bkkDay(now - DAY)) late.push(`บันทึกพอร์ตล่าสุด ${lastEq}`);
  out.push({ key: "daily", label: "งานรายวัน", ok: !late.length, need: 1,
    detail: late.length ? `เก่าเกินปกติ: ${late.join(" · ")}` : `backtest ${isFinite(hb) ? Math.round(hb) + " ชม.ก่อน" : "-"} · จัดอันดับ ${isFinite(hr) ? Math.round(hr) + " ชม.ก่อน" : "-"} · พอร์ต ${lastEq ?? "-"}`,
    hint: "ดู Supabase → Edge Functions → Logs ของงานนั้น หรือบอกผมให้ตรวจ" });
  return out;
}

async function applyAlerts(checks: Check[]) {
  const now = Date.now(), { data: rows } = await sb.from("sig_health_state").select("*"), alerts: string[] = [], recov: string[] = [];
  for (const c of checks) {
    const p = (rows ?? []).find((r: any) => r.key === c.key);
    if (c.ok) {
      if (!p) await sb.from("sig_health_state").insert({ key: c.key, ok: true, detail: c.detail });
      else if (!p.ok) {
        if (p.alerted_at) recov.push(`✅ ${c.label} กลับมาปกติแล้ว (ผิดปกตินาน ${Math.max(1, Math.round((now - Date.parse(p.since)) / 60e3))} นาที)`);
        await sb.from("sig_health_state").update({ ok: true, fails: 0, detail: c.detail, alerted_at: null }).eq("key", c.key);
      }
    } else {
      const inc = !p || p.ok, fails = (inc ? 0 : p.fails) + 1, since = inc ? new Date().toISOString() : p.since;
      let alertedAt: string | null = inc ? null : p.alerted_at;
      if (fails >= c.need && (!alertedAt || now - Date.parse(alertedAt) > 6 * 3600e3)) {
        alerts.push(`🚨 <b>${esc(c.label)}</b>: ${esc(c.detail)}\n     👉 ${esc(c.hint)}`); alertedAt = new Date().toISOString();
      }
      await sb.from("sig_health_state").upsert({ key: c.key, ok: false, fails, since, detail: c.detail, alerted_at: alertedAt });
    }
  }
  if (alerts.length) await tg(`<b>🩺 ตรวจพบความผิดปกติของระบบ</b>\n${LINE}\n${alerts.join("\n")}`);
  if (recov.length) await tg(recov.join("\n"));
}

async function jobWatch() { const c = await runChecks(true); await applyAlerts(c); return c.filter((x) => !x.ok).length; }

async function healthText() {
  const c = await runChecks(false);
  return [`<b>🩺 สถานะระบบ</b> · ${bkk(Date.now())}`, LINE, ...c.map((x) => `${x.ok ? "✅" : "🚨"} <b>${esc(x.label)}</b>: ${esc(x.detail)}`), "",
    c.every((x) => x.ok) ? "ทุกอย่างปกติ · ระบบตรวจเองทุก 5 นาที และเตือนเข้าแชทนี้ถ้าผิดปกติ" : "👉 ระบบจะเตือนซ้ำทุก 6 ชม. จนกว่าจะกลับมาปกติ"].join("\n");
}

// ============================ พอร์ตรายวัน ============================
async function computeEquity() {
  const { data: S0 } = await sb.from("sig_settings").select("*").eq("id", 1).maybeSingle(), S = S0 ?? { balance_usd: 0 };
  const { data: all } = await sb.from("sig_trades").select("*").neq("status", "skipped");
  const open = (all ?? []).filter((t: any) => t.status === "open"), ids = open.map((t: any) => t.watch_id ?? -1);
  const { data: ws } = await sb.from("sig_watchlist").select("*").in("id", ids);
  const live = await livePrices(ws ?? []);
  const { data: st } = await sb.from("sig_state").select("watch_id,last_price").in("watch_id", ids);
  const rows: any[] = [];
  for (const t of open) {
    const w = ws?.find((x: any) => x.id === t.watch_id), e = +t.entry, q = +t.qty || 0;
    if (!q || (w && mk(w) === "th")) continue;
    const p = (w && live.get(w.symbol)) || +(st?.find((x: any) => x.watch_id === t.watch_id)?.last_price ?? 0) || e;
    const cost = +t.cost || q * e, pl = t.side * q * (p - e);
    rows.push({ name: t.name, side: t.side, qty: q, entry: e, price: p, cost, value: t.side > 0 ? q * p : cost + pl, pl, pct: t.side * (p / e - 1) * 100 });
  }
  const sum = (k: string) => rows.reduce((a, r) => a + r[k], 0), cost = sum("cost"), value = sum("value");
  const realized = (all ?? []).reduce((a: number, t: any) => a + (+t.realized || 0), 0), bal = +S.balance_usd || 0;
  return { bal, cost, value, unreal: sum("pl"), realized, cash: bal - cost, total: bal - cost + value + realized, rows };
}
async function jobSnapshot() {
  const e = await computeEquity(), day = bkkDay(Date.now());
  const { error } = await sb.from("sig_equity").upsert({ day, total: e.total, cash: e.cash, value: e.value, cost: e.cost, unreal: e.unreal,
    realized: e.realized, open_n: e.rows.length, holdings: e.rows });
  if (error) throw new Error(error.message);
  return { ok: true, day, total: +e.total.toFixed(2), holdings: e.rows.length };
}

// ============================ Telegram ============================
const LAB_HELP = ["", "<b>📊 วิเคราะห์ตลาดและสถานะระบบ</b>",
  "/top เลือกประเภทด้วยปุ่ม → Top 20 พร้อมบทวิเคราะห์",
  "/top crypto · /top ทอง · /top fx · /top หุ้นไทย · /top us",
  "/top crypto 10 แสดงแค่ 10 อันดับ · /top crypto refresh วิเคราะห์ใหม่ตอนนี้",
  "/health ตรวจสถานะระบบ (ระบบเตือนเองถ้าผิดปกติ)"].join("\n");

async function forward(raw: string) {
  await fetch(`${SCAN_URL}?job=bot`, { method: "POST", headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": env("CRON_SECRET") }, body: raw });
}

async function handleBot(req: Request) {
  const raw = await req.text();
  let u: any = {}; try { u = JSON.parse(raw); } catch (_) { /* */ }
  const mine = (id: any) => String(id) === env("TG_CHAT_ID");
  const cb = u.callback_query, msg = u.message;
  if (cb && String(cb.data ?? "").startsWith("top:") && mine(cb.message?.chat?.id)) {
    await tgRaw("answerCallbackQuery", { callback_query_id: cb.id });
    const m = String(cb.data).slice(4);
    return MKS.includes(m) ? await showTop(m) : undefined;
  }
  if (msg?.text && mine(msg.chat?.id) && !msg.reply_to_message) {
    const [head, ...args] = msg.text.trim().split(/\s+/), cmd = head.split("@")[0].toLowerCase();
    if (cmd === "/top") {
      const m = ALIAS[(args[0] ?? "").toLowerCase()], n = Math.min(20, Math.max(1, parseInt(args.find((a: string) => /^\d+$/.test(a)) ?? "20")));
      if (!m) return await tg("เลือกประเภทที่อยากดู Top 20 พร้อมบทวิเคราะห์\nหรือพิมพ์ /top crypto · /top ทอง · /top fx · /top หุ้นไทย · /top us", KB);
      return await showTop(m, n, args.some((a: string) => ["refresh", "ใหม่"].includes(a.toLowerCase())));
    }
    if (cmd === "/health") return await tg(await healthText());
    if (cmd === "/help" || cmd === "/start") { await forward(raw); return await tg(LAB_HELP); }
  }
  await forward(raw);
}

async function jobSetup() {
  const a = await setWebhook();
  const cur = (await tgRaw("getMyCommands", {})).result ?? [];
  const add = [{ command: "top", description: "Top 20 แต่ละประเภท พร้อมบทวิเคราะห์" }, { command: "health", description: "ตรวจสถานะระบบ" }];
  const b = await tgRaw("setMyCommands", { commands: [...cur.filter((c: any) => !add.some((x) => x.command === c.command)), ...add] });
  return { webhook: a, commands: b, total: cur.length + add.length };
}

// ================================ server ================================
Deno.serve(async (req) => {
  const url = new URL(req.url), secret = env("CRON_SECRET"), job = url.searchParams.get("job") ?? "";
  if (job === "bot") {
    if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("unauthorized", { status: 401 });
    try { await handleBot(req); } catch (e) { console.error("bot", e); await tg("❗ signal-lab ผิดพลาด: " + esc(String(e))).catch(() => {}); }
    return new Response("ok");
  }
  if (!secret || req.headers.get("x-cron-secret") !== secret) return new Response("unauthorized", { status: 401 });
  try {
    if (job === "watch") return Response.json({ ok: true, failing: await jobWatch() });
    if (job === "rank") return Response.json(await jobRank(url.searchParams.get("m")));
    if (job === "snapshot") return Response.json(await jobSnapshot());
    if (job === "setup") return Response.json(await jobSetup());
    if (job === "run") {   // ทดสอบ/สั่งงานเหมือนพิมพ์ในแชท เช่น ?job=run&cmd=/top fx
      const cmd = url.searchParams.get("cmd") ?? "";
      await handleBot(new Request("http://local/", { method: "POST", body: JSON.stringify({ message: { text: cmd, chat: { id: env("TG_CHAT_ID") } } }) }));
      return Response.json({ ok: true, ran: cmd });
    }
    return Response.json({ ok: false, error: "unknown job" }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
