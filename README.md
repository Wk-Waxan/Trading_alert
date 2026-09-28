# Trading_alert

ระบบแจ้งเตือนสัญญาณเทรดผ่าน Telegram รันบน Supabase (Edge Functions + pg_cron) โปรเจกต์ **Trading** (`feiyuytifgiylgxtvohh`)
ครอบคลุม คริปโต · ทอง/เงิน · Forex · หุ้น US · หุ้นไทย

## โครงสร้าง

| ไฟล์ | หน้าที่ |
|---|---|
| `supabase/functions/signal-scan/index.ts` | งานหลัก: สแกนสัญญาณทุก 5 นาที, optimize/backtest รายวัน, สรุปรายสัปดาห์, บอท Telegram |
| `supabase/functions/signal-scan/strategy.ts` | กลยุทธ์ + backtest แบบ pure function (ไม่มี I/O) ใช้ร่วมกับเทสต์และสคริปต์เทียบผล |
| `supabase/functions/signal-lab/index.ts` | Top 20 แต่ละตลาด, ตัวเฝ้าระบบ (`/health`), บันทึกพอร์ตรายวัน, รับ webhook Telegram |
| `supabase/functions/signal-screener/index.ts` | ตัวสแกนรุ่นเก่า (ไม่มี cron เรียกแล้ว — งานนี้ย้ายไป `signal-scan?job=screen`) |
| `supabase/schema.sql` | สำเนาโครงสร้างตารางปัจจุบัน (ไว้อ้างอิง) |
| `supabase/cron.sql` | งาน pg_cron ทั้งหมด (secret อ่านจาก Vault ตอนรัน ไม่มีในไฟล์) |
| `supabase/migrations/` | การเปลี่ยนแปลง schema ที่ต้อง apply ก่อน deploy โค้ดใหม่ |
| `scripts/compare.ts` | เทียบผล backtest logic เดิม vs ใหม่ ด้วยข้อมูลจริง |

## กลยุทธ์ (`strategy.ts`)

- `ma_cross` เส้นค่าเฉลี่ยตัดกัน · `rsi` เด้งจากโซน RSI · `breakout` ทะลุ high/low N แท่ง
- `pullback` ตามเทรนด์ + รอย่อ: EMA20 > EMA50, ราคาย่อแตะ EMA20 แล้วปิดเหนือ high แท่งก่อน
- ตัวกรองเทรนด์ `trend_mode`: `ma200` (เดิม: เหนือ/ใต้ MA200 TF เดียวกัน) หรือ `htf` (เทรนด์ TF ใหญ่ 1h→4h, 4h→1d, 1d→1w ใช้เฉพาะแท่งที่ปิดแล้ว)
- ต้นทุนต่อฝั่งแยกตามตลาด: คริปโต 0.1% · ทอง 0.02% · FX 0.01% · หุ้น US 0.05% · หุ้นไทย 0.17%
- Optimizer: ใช้ข้อมูล 3,000 แท่ง เรียนรู้ 70% / ทดสอบ 30% · เรียงตาม Profit factor (ต้อง ≥15 ไม้) · ผ่านเมื่อช่วงทดสอบ ≥5 ไม้, PF ≥ 1.1, กำไร > 0

## พัฒนา

```sh
deno task test      # unit test ของ strategy.ts
deno task compare   # เทียบ backtest เดิม/ใหม่ → reports/compare-<วันที่>.md (ต้องเข้าถึง Binance/Yahoo ได้)
```

## Deploy (ลำดับสำคัญ)

1. apply `supabase/migrations/20260928000000_pullback_and_htf_trend.sql` (เพิ่ม `pullback` และคอลัมน์ `trend_mode`)
2. deploy `signal-scan` (ต้องส่งทั้ง `index.ts` และ `strategy.ts`)

ถ้า deploy โค้ดก่อน migration: optimizer และ `/use` จะเขียน `trend_mode`/`pullback` ไม่สำเร็จ

Secrets ของฟังก์ชัน: `TG_TOKEN`, `TG_CHAT_ID`, `TWELVEDATA_KEY`, `CRON_SECRET`, `ANTHROPIC_API_KEY` (ไม่บังคับ) · cron อ่าน `sig_cron_secret` จาก Vault
