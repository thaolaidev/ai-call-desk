-- 0007: เชื่อม API เว็บเท่าไหร่ (GET /leads, POST /results)
alter table public.leads add column if not exists code text;
alter table public.leads add column if not exists listed_at timestamptz;
alter table public.leads add column if not exists vps_updated_by text;
alter table public.settings add column if not exists new_days int not null default 7;
alter table public.settings add column if not exists last_pull_at timestamptz;
alter table public.settings add column if not exists pull_time text not null default '09:00';
alter table public.settings add column if not exists sync_every_min int not null default 30;
alter table public.settings add column if not exists last_sync_at timestamptz;
