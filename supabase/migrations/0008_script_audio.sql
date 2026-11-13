-- 0008: ไฟล์เสียงบทโทร (หน้า "บทโทร")
create table if not exists public.script_audio (
  step_key     text primary key,
  path         text not null,
  file_name    text,
  size_bytes   int,
  uploaded_at  timestamptz not null default now(),
  uploaded_by  text
);
alter table public.script_audio enable row level security;
drop policy if exists team_all_script_audio on public.script_audio;
create policy team_all_script_audio on public.script_audio for all to authenticated using (public.is_team()) with check (public.is_team());

-- ไฟล์เสียงบทพูด ไม่ใช่ข้อมูลลับ เปิดให้ฟัง/ดาวน์โหลดผ่านลิงก์ได้ (อัปโหลด/ลบผ่านเซิร์ฟเวอร์เท่านั้น)
insert into storage.buckets (id, name, public) values ('script-audio', 'script-audio', true)
on conflict (id) do update set public = true;
