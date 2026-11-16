-- ห้องที่ส่งมาจากแชททีม (กลุ่ม "Check สถานะห้อง") → AI โทรทันที แล้วส่งผลกลับไปที่การ์ดห้องในแชท
alter table public.leads add column if not exists chat_group_uuid text;
alter table public.leads add column if not exists chat_asset_uuid text;
alter table public.leads add column if not exists chat_requested_by text;
alter table public.leads add column if not exists chat_requested_at timestamptz;
create index if not exists leads_chat_idx on public.leads (chat_requested_at) where chat_requested_at is not null;

alter table public.calls add column if not exists via_chat boolean not null default false;
alter table public.calls add column if not exists chat_group_uuid text;
alter table public.calls add column if not exists chat_asset_uuid text;

alter table public.settings add column if not exists chat_enabled boolean not null default true;
alter table public.settings add column if not exists chat_concurrency int not null default 3 check (chat_concurrency between 1 and 6);
alter table public.settings add column if not exists chat_recall_hours int not null default 12 check (chat_recall_hours between 0 and 720);

-- หยิบห้องจากแชทที่รอโทร (ใหม่ก่อน → โทรซ้ำที่ถึงเวลา)
create or replace function public.claim_chat_leads(p_limit int)
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
      where x.chat_requested_at is not null
        and (x.status = 'queued'
             or (x.status in ('noanswer', 'unclear') and x.attempts < v_max and x.next_call_at <= now())
             or (x.status = 'callback' and x.next_call_at <= now()))
        and not exists (select 1 from dnc_numbers d where d.phone = x.phone)
      order by case x.status when 'queued' then 0 when 'callback' then 1 else 2 end, x.chat_requested_at
      limit greatest(p_limit, 0)
      for update skip locked)
  returning l.*;
end $$;
revoke execute on function public.claim_chat_leads(int) from public, anon, authenticated;

-- ห้องโทรปกติ (ทรัพย์ใหม่/เดิม) ไม่หยิบห้องที่มาจากแชท
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
        and x.chat_requested_at is null
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
