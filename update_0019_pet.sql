-- ฟอร์มห้องชมพู "Pet : Yes/No" → จำไว้กับห้อง (บอทข้ามคำถามเลี้ยงสัตว์ และส่งไปตั้งปุ่ม Pet friendly)
alter table public.leads add column if not exists pet_friendly boolean;
