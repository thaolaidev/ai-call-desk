# ห้องโทร AI

ระบบให้ AI โทรหาเจ้าของคอนโด ถามว่าห้องว่างไหม รับลูกค้าต่างชาติไหม แล้วอัปเดตสถานะห้องและส่งงานให้แอดมินอัตโนมัติ

Next.js 15 (App Router) + Supabase (Postgres, Auth, RLS) + Vapi สำหรับโทรจริง (ใส่ทีหลังได้ ระหว่างนี้ใช้โหมดจำลอง)

## เริ่มใช้งาน

### 1. ตั้งฐานข้อมูล Supabase

1. เปิด Supabase Dashboard → SQL Editor ของโปรเจกต์
2. รันไฟล์ `supabase/migrations/0001_init.sql`
3. แก้อีเมลใน `supabase/seed.sql` เป็นอีเมลทีมคุณ แล้วรันไฟล์นี้ (จะได้ห้องตัวอย่าง 12 ห้องด้วย)
4. Authentication → Users → Add user ด้วยอีเมลเดียวกับใน `team_members` และตั้งรหัสผ่าน
5. แนะนำ: Authentication → Sign In / Providers → ปิด "Allow new users to sign up"

> เข้าระบบได้เฉพาะอีเมลที่อยู่ในตาราง `team_members` เพิ่มคนในทีมด้วย
> `insert into team_members (email, name) values ('someone@company.com', 'ชื่อ');`

### 2. รันบนเครื่อง

```bash
cp .env.example .env.local   # ใส่ค่า Supabase 3 ตัวแรก (Project Settings → API)
npm install
npm run dev                  # http://localhost:3000
```

### 3. ลองระบบด้วยโหมดจำลอง

1. เข้าสู่ระบบ → หน้า **แคมเปญโทร** → กด **เริ่มโทร**
2. ระบบหยิบห้องจากคิวตามจำนวนสายพร้อมกัน แต่ละสายจะจบเองใน 20–75 วินาที
3. ดูผลได้ที่ **ผลการโทร** (บทสนทนา + สรุป AI) และ **แดชบอร์ด** (งานแอดมิน ส่งโปรไฟล์)

ระหว่างเปิดหน้าแดชบอร์ดหรือหน้าแคมเปญไว้ เว็บจะสั่งตัวยิงสายทุก 5–8 วินาที ถ้าจะให้โทรต่อแม้ปิดหน้าเว็บ ต้องตั้ง Cron (ข้อ 5)

## ใส่ระบบโทรจริง (Vapi)

1. ซื้อ / นำเข้าเบอร์ไทยผ่าน SIP Trunk ใน Vapi → Phone Numbers แล้วจด **Phone Number ID**
2. Vapi → Assistants → สร้างใหม่ แล้วคัดลอกจากหน้า **ตั้งค่าระบบ** ในแอป:
   - First Message และ System Prompt
   - Analysis → Structured Data: วาง JSON Schema
   - เสียง: Azure `th-TH` หรือ ElevenLabs · Transcriber: ภาษาไทย
   - Server URL: `https://<โดเมน>/api/vapi/webhook` และตั้ง Server URL Secret
3. ใส่ env: `VAPI_API_KEY`, `VAPI_WEBHOOK_SECRET` (ค่าเดียวกับ Secret ในข้อ 2)
4. หน้า **ตั้งค่าระบบ** ใส่ Assistant ID + Phone Number ID แล้วเปลี่ยนระบบโทรเป็น **Vapi**

ถ้าเรียก Vapi ไม่สำเร็จ ระบบจะหยุดแคมเปญเองทันที และแสดงสาเหตุในผลการโทรของสายนั้น

## Deploy (Vercel)

1. Push ขึ้น GitHub แล้ว Import เข้า Vercel
2. ใส่ Environment Variables ตาม `.env.example` (ตั้ง `NEXT_PUBLIC_SITE_URL` เป็นโดเมนจริง)
3. `vercel.json` ตั้ง Cron ให้เรียก `/api/dialer/tick` ทุกนาที
   - Cron ทุกนาทีต้องใช้ Vercel Pro ถ้าใช้แผน Hobby ให้ใช้ cron ภายนอก (เช่น cron-job.org) ยิง
     `GET /api/dialer/tick` พร้อม header `Authorization: Bearer <CRON_SECRET>`

## รับลีดจากแหล่งอื่น

`POST /api/leads/ingest` พร้อม header `x-ingest-key: <INGEST_API_KEY>`

```json
[{ "owner_name": "ศิริพร", "phone": "081-234-5678", "condo": "Ideo Mobi Asoke",
   "unit": "1 ห้องนอน 35 ตร.ม. ชั้น 18", "rent": 18000, "source": "Livinginsider",
   "customer_nationalities": "อเมริกัน และ รัสเซีย" }]
```

ต่อกับ n8n / Make / Zapier ที่ดึงประกาศจาก Livinginsider, DDproperty, Hipflat หรือ Google Sheet ได้ เบอร์ + คอนโดที่ซ้ำจะถูกข้าม

## โครงสร้าง

```
app/
  (app)/page.tsx            แดชบอร์ด
  (app)/leads/              กองลีด (เพิ่ม, นำเข้า CSV, ส่งเข้าคิว)
  (app)/calling/            แคมเปญ: สายพร้อมกัน, เป้าต่อวัน, เวลาโทร, คิว
  (app)/results/            บทสนทนา + สรุป AI + สถานะที่เปลี่ยน
  (app)/settings/           ระบบโทร, Vapi IDs, บทของเอเจนต์
  api/dialer/tick           ตัวยิงสาย (Cron + หน้าเว็บ)
  api/vapi/webhook          รับผลหลังวางสายจาก Vapi
  api/leads/ingest          รับลีดจากระบบภายนอก
lib/
  dialer.ts                 หยิบคิว → โทร → ปิดสายจำลอง/สายค้าง
  outcome.ts                ผลการโทร → สถานะห้อง, งานแอดมิน, รายการห้ามโทร, LINE
  prompt.ts                 First message, System prompt, JSON schema
  providers/simulate.ts     โหมดจำลอง (บทสนทนาตามบทจริง)
  providers/vapi.ts         โทรผ่าน Vapi
supabase/
  migrations/0001_init.sql  ตาราง, ฟังก์ชัน, RLS
  seed.sql                  ทีมงาน + ห้องตัวอย่าง
```

## ผลการโทร → สถานะห้อง

| ผล | สถานะ | ระบบทำต่อ |
|---|---|---|
| `avail_ok` | ว่าง · รับต่างชาติ | สร้างงานส่งโปรไฟล์ + แจ้ง LINE |
| `avail_profile` | ว่าง · ขอดูโปรไฟล์ | สร้างงานส่งโปรไฟล์ + แจ้ง LINE |
| `avail_no` | ว่าง · ไม่รับต่างชาติ | เก็บไว้เสนอลูกค้าคนไทย |
| `not_avail` | ไม่ว่าง | บันทึกวันหมดสัญญาผู้เช่าเดิม |
| `callback` | ขอให้โทรกลับ | เข้าคิวตามเวลาที่ขอ |
| `noanswer` | ไม่รับสาย | โทรซ้ำทุก N นาที สูงสุด M ครั้ง แล้วปิด |
| `dnc` | ขอไม่ให้โทร | เพิ่มเข้ารายการห้ามโทร |
| `wrong_number` / `invalid` | เบอร์ผิด / ติดต่อไม่ได้ | รอตรวจเบอร์ |
