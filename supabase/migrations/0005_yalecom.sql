-- โทรผ่าน Yalecom: เล่นไฟล์เสียง → อัดคำตอบ → ถอดเสียง → จัดผล
-- รันซ้ำได้

-- ผลแบบใหม่: avail (ว่าง โดยไม่ได้ถามเรื่องต่างชาติ) และ unclear (รับสายแต่ฟังคำตอบไม่ชัด)
alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads add constraint leads_status_check check (status in (
  'new','queued','calling',
  'avail','avail_ok','avail_profile','avail_no','not_avail',
  'callback','dnc','wrong_number','noanswer','unclear','invalid','closed'));

-- ระบบโทร + ค่าของ Yalecom
alter table public.settings drop constraint if exists settings_provider_check;
alter table public.settings add constraint settings_provider_check check (provider in ('simulate','vapi','yalecom'));
alter table public.settings
  add column if not exists yalecom_caller_id   text,                                    -- เบอร์โทรออกของเราใน Yalecom
  add column if not exists yalecom_transfer_to text,                                    -- เบอร์ภายใน (IVR) ที่เล่นเสียง + อัดคำตอบ
  add column if not exists audio_intro         text not null default 'tl_intro',        -- ไฟล์เปิดสาย (ก่อนชื่อคอนโด)
  add column if not exists audio_question      text not null default 'tl_question',     -- ไฟล์คำถาม + เสียงสัญญาณ
  add column if not exists audio_generic_intro text not null default 'tl_intro_generic';-- ไฟล์เปิดสายแบบไม่มีชื่อคอนโด

alter table public.calls add column if not exists recording_path text;  -- ไฟล์เสียงที่เก็บใน Supabase Storage

-- ไฟล์เสียงชื่อคอนโด (1 ไฟล์ต่อโครงการ)
create table if not exists public.condo_audio (
  condo      text primary key,
  tts_text   text,                       -- คำอ่านภาษาไทย เช่น "ไอดีโอ โมบิ อโศก"
  file_name  text not null,              -- ชื่อไฟล์ในระบบ Yalecom
  ready      boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.condo_audio enable row level security;
drop policy if exists team_all_condo_audio on public.condo_audio;
create policy team_all_condo_audio on public.condo_audio for all to authenticated using (public.is_team()) with check (public.is_team());

-- ที่เก็บไฟล์บันทึกเสียง (ส่วนตัว)
insert into storage.buckets (id, name, public) values ('recordings', 'recordings', false)
on conflict (id) do nothing;

-- คิวโทรซ้ำ: รวมสาย "ฟังไม่ชัด" ด้วย
create or replace function public.claim_leads(p_limit int)
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
      where (x.status = 'queued'
             or (x.status in ('noanswer', 'unclear') and x.attempts < v_max and x.next_call_at <= now())
             or (x.status = 'callback' and x.next_call_at <= now()))
        and not exists (select 1 from dnc_numbers d where d.phone = x.phone)
      order by case x.status when 'callback' then 0 when 'queued' then 1 else 2 end, x.created_at
      limit greatest(p_limit, 0)
      for update skip locked)
  returning l.*;
end $$;
revoke execute on function public.claim_leads(int) from public, anon, authenticated;

create or replace function public.calls_by_hour(p_from timestamptz, p_to timestamptz)
returns table (h int, ok bigint, fail bigint)
language sql stable as $$
  select extract(hour from c.started_at at time zone 'Asia/Bangkok')::int,
         count(*) filter (where c.outcome not in ('noanswer','invalid','unclear')),
         count(*) filter (where c.outcome in ('noanswer','invalid','unclear'))
    from calls c
   where c.state = 'ended' and c.started_at >= p_from and c.started_at < p_to
   group by 1 order by 1;
$$;

drop function if exists public.lead_tab_counts();
drop view if exists public.leads_v;
create view public.leads_v with (security_invoker = true) as
select
  l.*,
  (
    l.status in ('queued', 'calling')
    or (l.status in ('noanswer', 'unclear', 'callback')
        and l.next_call_at < ((date_trunc('day', now() at time zone 'Asia/Bangkok') + interval '1 day') at time zone 'Asia/Bangkok'))
  ) as due_today,
  (l.attempts > 0 and l.status not in ('new', 'queued', 'calling')) as called
from public.leads l;
create function public.lead_tab_counts()
returns table (segment text, status text, due_today boolean, called boolean, n bigint)
language sql stable as $$
  select v.segment, v.status, v.due_today, v.called, count(*) from public.leads_v v group by 1, 2, 3, 4;
$$;
