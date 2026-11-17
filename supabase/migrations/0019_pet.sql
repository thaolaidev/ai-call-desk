-- ฟอร์มห้องชมพู
-- pet_friendly: "Pet : ใช่/ไม่" → จำไว้กับห้อง (บอทข้ามคำถามเลี้ยงสัตว์ และส่งไปตั้งปุ่ม Pet friendly)
-- alt_phone:    "Phone 2" → เบอร์สำรอง เบอร์แรกไม่รับ/ไม่ติด ระบบสลับไปโทรเบอร์นี้
alter table public.leads add column if not exists pet_friendly boolean;
alter table public.leads add column if not exists alt_phone text;
