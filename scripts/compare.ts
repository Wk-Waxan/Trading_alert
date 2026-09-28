// เทียบผล backtest "ก่อน" (logic เดิมที่ deploy อยู่) กับ "หลัง" (logic ใหม่) ด้วยข้อมูลจริง
// deno task compare  → พิมพ์ตาราง และเขียน reports/compare-<วันที่>.md
//
// ก่อน: 1,000 แท่ง · ค่าธรรมเนียม 0.1%/ฝั่งทุกตลาด · กรองเทรนด์ด้วย MA200 TF เดียวกัน · เลือกจากกำไรช่วงเรียนรู้ (≥3 ไม้), ผ่านถ้าช่วงทดสอบ > 0
// หลัง: 3,000 แท่ง · ต้นทุนตามตลาด · กรองเทรนด์ด้วย TF ใหญ่ · เพิ่ม pullback · เลือกจาก PF (≥15 ไม้), ผ่านถ้าช่วงทดสอบ ≥5 ไม้, PF ≥ 1.1, กำไร > 0
//
// ใช้แหล่งข้อมูลสาธารณะที่ไม่ต้องมี key: Binance (คริปโต/ทอง) และ Yahoo (หุ้น/FX)
// ตัวที่ระบบจริงดึงจาก Twelve Data (หุ้น US) ใช้ข้อมูล Yahoo แทน ผลจึงใกล้เคียงแต่อาจไม่ตรงทุกแท่ง
// deno-lint-ignore-file no-explicit-any
import {
  type Bar, CANDS, costOf, describe, evaluate, passes, pickBest, prep, type Res, sim, type Sim, TF_SEC,
} from "../supabase/functions/signal-scan/strategy.ts";

const OLD_BARS = 1000, NEW_BARS = 3000, OLD_FEE = 0.001;
const OLD_CANDS = CANDS.filter((c) => c.strategy !== "pullback");
const NEW_CANDS = CANDS.map((c) => ({ ...c, trend_mode: c.trend_filter ? "htf" : "ma200" }));

async function getJSON(url: string) {
  for (let a = 0; a < 3; a++) {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (r.ok) return r.json();
    if (r.status === 429 || r.status >= 500) { await new Promise((z) => setTimeout(z, 2000 * (a + 1))); continue; }
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

async function yahoo(sym: string, tf: string, n: number): Promise<Bar[]> {
  const iv = tf === "4h" ? "1h" : tf;
  const range = tf === "4h" ? "2y" : ({ "15m": "60d", "1h": "1y", "1d": n > 1000 ? "10y" : "5y" } as any)[iv];
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&range=${range}`);
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
  const raw = w.source.startsWith("binance") ? await binance(w.symbol, w.tf, w.source === "binance_futures", n + 1) : await yahoo(w.symbol, w.tf, n);
  const now = Date.now(), step = TF_SEC[w.tf] * 1000;
  return raw.filter((b) => b.t + step <= now).slice(-n);
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const pf = (x: number) => !isFinite(x) ? "∞" : x.toFixed(2);
const stat = (s: Sim) => `${pct(s.ret)} · PF ${pf(s.pf)} · ${s.trades} ไม้`;

function oldPick(bars: Bar[], w: any) {
  const n = bars.length, split = Math.floor(n * 0.7);
  const res: Res[] = OLD_CANDS.map((c) => { const t = { ...w, ...c }, pr = prep(bars, t);
    return { ...c, tr: sim(bars, t, 0, split - 1, pr, undefined, OLD_FEE), te: sim(bars, t, split, n - 1, pr, undefined, OLD_FEE) }; });
  const best = res.filter((r) => r.tr.trades >= 3).sort((a, b) => b.tr.ret - a.tr.ret)[0];
  return { best, pass: !!best && best.te.ret > 0 };
}

const watch = JSON.parse(await Deno.readTextFile(new URL("./watchlist.json", import.meta.url)));
const lines: string[] = [], rows: string[][] = [];
for (const w of watch) {
  const label = `${w.symbol} ${w.tf}`;
  try {
    const oldBars = await closedBars(w, OLD_BARS), newBars = await closedBars(w, NEW_BARS);
    const on = oldBars.length, os = Math.floor(on * 0.7), nn = newBars.length, ns = Math.floor(nn * 0.7);
    // กลยุทธ์ที่ใช้อยู่ตอนนี้ ภายใต้กติกาเดิม vs ต้นทุนจริงและข้อมูลยาวขึ้น (ยังเป็นกลยุทธ์เดิม)
    const curOld = sim(oldBars, w, os, on - 1, prep(oldBars, w), undefined, OLD_FEE);
    const curNew = sim(newBars, w, ns, nn - 1, prep(newBars, w), undefined, costOf(w));
    const o = oldPick(oldBars, w), nb = pickBest(evaluate(newBars, w, NEW_CANDS)), npass = !!nb && passes(nb);
    const verdict = (b: any, ok: boolean, auto: boolean) => !b ? (auto ? "ปิดเฝ้า (ไม่มีตัวเลือก)" : "ไม่ผ่าน") : ok ? "ผ่าน" : auto ? "ปิดเฝ้า" : "ไม่ผ่าน";
    rows.push([label, `${on}→${nn}`, stat(curOld), stat(curNew),
      o.best ? `${describe({ ...w, ...o.best })} · ทดสอบ ${stat(o.best.te)} → ${verdict(o.best, o.pass, w.auto)}` : verdict(null, false, w.auto),
      nb ? `${describe({ ...w, ...nb })} · ทดสอบ ${stat(nb.te)} → ${verdict(nb, npass, w.auto)}` : verdict(null, false, w.auto)]);
    console.log(`✔ ${label}`);
  } catch (e) {
    rows.push([label, "-", "-", "-", "-", `ดึงข้อมูลไม่ได้: ${e instanceof Error ? e.message : e}`]);
    console.log(`✘ ${label}: ${e}`);
  }
}

const day = new Date().toISOString().slice(0, 10);
lines.push(`# เทียบ backtest ก่อน/หลัง · ${day}`, "",
  "ช่วงทดสอบ = 30% ล่าสุดของข้อมูล (ไม่ได้ใช้ตอนเลือกกลยุทธ์)", "",
  "| ตัว | แท่ง (เดิม→ใหม่) | กลยุทธ์ปัจจุบัน · กติกาเดิม | กลยุทธ์ปัจจุบัน · ต้นทุนจริง+ข้อมูลยาว | optimizer เดิมเลือก | optimizer ใหม่เลือก |",
  "|---|---|---|---|---|---|", ...rows.map((r) => `| ${r.join(" | ")} |`));
await Deno.mkdir(new URL("../reports/", import.meta.url), { recursive: true });
const out = new URL(`../reports/compare-${day}.md`, import.meta.url);
await Deno.writeTextFile(out, lines.join("\n") + "\n");
console.log("\n" + lines.join("\n") + `\n\nบันทึกที่ ${out.pathname}`);
