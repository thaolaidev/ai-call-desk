-- แยกห้องโทร 2 ห้อง: ทรัพย์ใหม่ / ทรัพย์เดิม · อัปเดต
-- แต่ละห้องมีสาย เป้าต่อวัน ปุ่มเริ่ม-หยุด และไฟล์เสียงของตัวเอง · รันซ้ำได้

create table if not exists public.call_rooms (
  segment             text primary key check (segment in ('new','old')),
  name                text not null,
  running             boolean not null default false,
  concurrency         int  not null default 3   check (concurrency between 0 and 10),
  daily_cap           int  not null default 100 check (daily_cap between 0 and 2000),
  audio_intro         text not null default 'tl_intro',
  audio_question      text not null default 'tl_question',
  audio_generic_intro text not null default 'tl_intro_generic',
  updated_at          timestamptz not null default now()
);

insert into public.call_rooms (segment, name, audio_intro, audio_question, audio_generic_intro)
values ('new', 'ทรัพย์ใหม่', 'tl_new_intro', 'tl_new_question', 'tl_new_intro_generic')
on conflict (segment) do nothing;

insert into public.call_rooms (segment, name, audio_intro, audio_question, audio_generic_intro)
select 'old', 'ทรัพย์เดิม · อัปเดต', s.audio_intro, s.audio_question, s.audio_generic_intro
from public.settings s where s.id = 1
on conflict (segment) do nothing;

alter table public.call_rooms enable row level security;
drop policy if exists team_all_rooms on public.call_rooms;
create policy team_all_rooms on public.call_rooms for all to authenticated using (public.is_team()) with check (public.is_team());

-- สายแต่ละสายรู้ว่าเป็นของห้องไหน
alter table public.calls add column if not exists segment text;
update public.calls c set segment = l.segment from public.leads l where l.id = c.lead_id and c.segment is null;
create index if not exists calls_segment_idx on public.calls (segment, started_at);

-- หยิบคิวแยกตามห้อง
drop function if exists public.claim_leads(int);
create or replace function public.claim_leads(p_limit int, p_segment text)
returns setof public.leads
language plpgsql security definer set search_path = public as $$
declare v_max int;
begin
  select max_attempts into v_max from settings where id = 1;
  return query
  update leads l
     set prev_status = l.status, status = 'calling'
   where l.id in (
     select x.id from leads x
      where x.segment = p_segment
        and (x.status = 'queued'
             or (x.status in ('noanswer', 'unclear') and x.attempts < v_max and x.next_call_at <= now())
             or (x.status = 'callback' and x.next_call_at <= now()))
        and not exists (select 1 from dnc_numbers d where d.phone = x.phone)
      order by case x.status when 'callback' then 0 when 'queued' then 1 else 2 end, x.created_at
      limit greatest(p_limit, 0)
      for update skip locked)
  returning l.*;
end $$;
revoke execute on function public.claim_leads(int, text) from public, anon, authenticated;

-- ปุ่มเริ่ม/หยุดแบบเดิม (ทั้งระบบ) เลิกใช้ ให้ปิดไว้
update public.settings set running = false where id = 1;
