-- ห้องโทร 2 ห้อง = 2 กลุ่มแชท · แต่ละห้องมีโหมด (โทรทันที / รอกดโทร / ปิดรับ) สายพร้อมกัน และคิวของตัวเอง
--   new = กลุ่ม "Check ทรัพย์ใหม่" (แอดมินพิมพ์เบอร์ + ชื่อคอนโด)
--   old = กลุ่ม "Check สถานะห้อง" (ค้นห้อง / รหัสห้องจากเว็บ)
alter table public.call_rooms add column if not exists chat_mode text not null default 'queue' check (chat_mode in ('auto', 'queue', 'off'));
alter table public.call_rooms add column if not exists chat_group_uuid text;

update public.call_rooms
   set name = 'Check ทรัพย์ใหม่', chat_group_uuid = '777a33d4-ee6d-4fdd-a95a-2f0bd821aa13',
       chat_mode = coalesce((select chat_mode from public.settings where id = 1), 'queue'), running = false
 where segment = 'new';
update public.call_rooms
   set name = 'Check สถานะห้อง', chat_group_uuid = '47f816c0-eb71-40b6-935a-109fb5e1b59e',
       chat_mode = coalesce((select chat_mode from public.settings where id = 1), 'queue'), running = false
 where segment = 'old';

-- ห้องจากแชทที่รออยู่ → ย้ายเข้าห้องตามกลุ่มที่มา
update public.leads set segment = 'new' where chat_requested_at is not null and external_id like 'msg-%';
update public.leads set segment = 'old' where chat_requested_at is not null and (external_id is null or external_id not like 'msg-%');

-- หยิบห้องจากแชทของห้องโทรหนึ่งห้อง
create or replace function public.claim_chat_leads(p_limit int, p_segment text)
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
      where x.chat_requested_at is not null and x.segment = p_segment
        and (x.status = 'queued'
             or (x.status in ('noanswer', 'unclear') and x.attempts < v_max and x.next_call_at <= now())
             or (x.status = 'callback' and x.next_call_at <= now()))
        and not exists (select 1 from dnc_numbers d where d.phone = x.phone)
      order by case x.status when 'queued' then 0 when 'callback' then 1 else 2 end, x.chat_requested_at
      limit greatest(p_limit, 0)
      for update skip locked)
  returning l.*;
end $$;
revoke execute on function public.claim_chat_leads(int, text) from public, anon, authenticated;
