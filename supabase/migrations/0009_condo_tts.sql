-- 0009: สร้างเสียงชื่อคอนโดอัตโนมัติด้วย Botnoi แล้วเก็บไว้ใช้ซ้ำ
alter table public.condo_audio add column if not exists path text;          -- ไฟล์ใน storage bucket script-audio
alter table public.condo_audio add column if not exists audio_source text;  -- botnoi / upload
alter table public.condo_audio add column if not exists tts_error text;
alter table public.condo_audio add column if not exists generated_at timestamptz;
