-- 0012: ลำดับไฟล์ที่เล่นในสาย (แบบเล่นต่อกันทั้งชุด เว้นช่วงให้เจ้าของตอบ)
create table if not exists public.script_playlist (
  step_key    text primary key,
  enabled     boolean not null default true,
  wait_after  int not null default 0 check (wait_after between 0 and 15),
  updated_at  timestamptz not null default now()
);
alter table public.script_playlist enable row level security;
drop policy if exists team_all_script_playlist on public.script_playlist;
create policy team_all_script_playlist on public.script_playlist for all to authenticated using (public.is_team()) with check (public.is_team());
