-- ค่าโทรต่อนาที (หน้าค่าใช้จ่ายค่าโทร)
alter table public.settings add column if not exists cost_per_min numeric(6,2) not null default 0.8;
