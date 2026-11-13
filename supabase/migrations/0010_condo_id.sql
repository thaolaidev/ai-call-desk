-- 0010: จับคู่เสียงชื่อคอนโดด้วยรหัสโครงการ (condo_id) จาก VPS / ชีท
alter table public.leads add column if not exists condo_id text;
create index if not exists leads_condo_id_idx on public.leads (condo_id);
alter table public.condo_audio add column if not exists condo_id text;
create unique index if not exists condo_audio_condo_id_key on public.condo_audio (condo_id) where condo_id is not null;
