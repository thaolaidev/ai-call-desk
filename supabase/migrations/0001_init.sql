-- ห้องโทร AI · schema เริ่มต้น
-- รันใน Supabase Dashboard → SQL Editor (หรือ `supabase db push`)

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------
-- ทีมงานที่ล็อกอินได้ (อีเมลที่อยู่ในตารางนี้เท่านั้นที่เห็นข้อมูล)
-- ---------------------------------------------------------------
create table public.team_members (
  email      text primary key,
  name       text,
  created_at timestamptz not null default now()
);

create or replace function public.is_team()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_members where lower(email) = lower(auth.jwt() ->> 'email'));
$$;

-- ---------------------------------------------------------------
-- ตั้งค่าแคมเปญ (มีแถวเดียว id = 1)
-- ---------------------------------------------------------------
create table public.settings (
  id                    int primary key default 1 check (id = 1),
  company               text    not null default 'เท่าไหร่ดอทคอม',
  default_nationalities text    not null default 'อเมริกัน และ รัสเซีย',
  viewing_when          text    not null default 'วันนี้',
  running               boolean not null default false,
  auto_queue            boolean not null default true,
  concurrency           int     not null default 8   check (concurrency between 1 and 10),
  daily_cap             int     not null default 200 check (daily_cap between 1 and 2000),
  call_start            time    not null default '09:00',
  call_end              time    not null default '20:00',
  call_days             int[]   not null default '{1,2,3,4,5,6}', -- 0=อาทิตย์ … 6=เสาร์
  retry_gap_min         int     not null default 120,
  max_attempts          int     not null default 3,
  provider              text    not null default 'simulate' check (provider in ('simulate','vapi')),
  vapi_assistant_id     text,
  vapi_phone_number_id  text,
  updated_at            timestamptz not null default now()
);
insert into public.settings (id) values (1);

-- ---------------------------------------------------------------
-- ลีด = ห้องเช่า + เจ้าของ
-- ---------------------------------------------------------------
create table public.leads (
  id                     uuid primary key default gen_random_uuid(),
  owner_name             text not null,
  phone                  text not null,
  condo                  text not null,
  unit                   text,
  rent                   int,
  source                 text not null default 'เพิ่มเอง',
  customer_nationalities text,
  viewing_when           text,
  status                 text not null default 'new' check (status in (
                           'new','queued','calling',
                           'avail_ok','avail_profile','avail_no','not_avail',
                           'callback','dnc','wrong_number','noanswer','invalid','closed')),
  prev_status            text,
  attempts               int  not null default 0,
  next_call_at           timestamptz,
  current_lease_until    text,
  line_id                text,
  last_summary           text,
  last_call_id           uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index leads_phone_condo_uidx on public.leads (phone, condo);
create index leads_status_idx on public.leads (status, next_call_at);
create index leads_created_idx on public.leads (created_at desc);

-- ---------------------------------------------------------------
-- การโทรแต่ละสาย
-- ---------------------------------------------------------------
create table public.calls (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references public.leads (id) on delete cascade,
  provider         text not null,
  provider_call_id text unique,
  attempt          int  not null default 1,
  state            text not null default 'dialing'
                   check (state in ('dialing','ringing','in_progress','ended','failed')),
  outcome          text,
  from_status      text,
  to_status        text,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  duration_sec     int,
  cost_thb         numeric(10,2),
  transcript       jsonb not null default '[]'::jsonb,  -- [{role:'ai'|'owner'|'system', text}]
  analysis         jsonb,                               -- ผลสรุป JSON ตาม schema
  summary          text,
  next_action      text,
  recording_url    text,
  ended_reason     text,
  sim_end_at       timestamptz,                         -- ใช้เฉพาะโหมดจำลอง
  created_at       timestamptz not null default now()
);
create index calls_started_idx on public.calls (started_at desc);
create index calls_state_idx on public.calls (state);
create index calls_lead_idx on public.calls (lead_id);

alter table public.leads
  add constraint leads_last_call_fk foreign key (last_call_id) references public.calls (id) on delete set null;

-- ---------------------------------------------------------------
-- งานแอดมิน (ส่งโปรไฟล์ลูกค้าให้เจ้าของ)
-- ---------------------------------------------------------------
create table public.admin_tasks (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references public.leads (id) on delete cascade,
  call_id    uuid references public.calls (id) on delete set null,
  kind       text not null default 'send_profile',
  status     text not null default 'open' check (status in ('open','done')),
  note       text,
  created_at timestamptz not null default now(),
  done_at    timestamptz
);
create index admin_tasks_open_idx on public.admin_tasks (status, created_at desc);

-- ---------------------------------------------------------------
-- รายการห้ามโทร
-- ---------------------------------------------------------------
create table public.dnc_numbers (
  phone      text primary key,
  reason     text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- updated_at อัตโนมัติ
-- ---------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger leads_touch    before update on public.leads    for each row execute function public.touch_updated_at();
create trigger settings_touch before update on public.settings for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------
-- หยิบลีดจากคิว (ใช้โดยตัวยิงสายฝั่งเซิร์ฟเวอร์เท่านั้น)
-- ---------------------------------------------------------------
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
             or (x.status = 'noanswer' and x.attempts < v_max and x.next_call_at <= now())
             or (x.status = 'callback' and x.next_call_at <= now()))
        and not exists (select 1 from dnc_numbers d where d.phone = x.phone)
      order by case x.status when 'callback' then 0 when 'queued' then 1 else 2 end, x.created_at
      limit greatest(p_limit, 0)
      for update skip locked)
  returning l.*;
end $$;
revoke execute on function public.claim_leads(int) from public, anon, authenticated;

-- ---------------------------------------------------------------
-- สถิติสำหรับแดชบอร์ด
-- ---------------------------------------------------------------
create or replace function public.call_stats(p_from timestamptz, p_to timestamptz)
returns table (outcome text, n bigint, talk_sec bigint, cost numeric)
language sql stable as $$
  select coalesce(c.outcome, case when c.state = 'failed' then 'failed' else 'pending' end), count(*), coalesce(sum(c.duration_sec), 0), coalesce(sum(c.cost_thb), 0)
    from calls c
   where c.started_at >= p_from and c.started_at < p_to
   group by 1;
$$;

create or replace function public.calls_by_hour(p_from timestamptz, p_to timestamptz)
returns table (h int, ok bigint, fail bigint)
language sql stable as $$
  select extract(hour from c.started_at at time zone 'Asia/Bangkok')::int,
         count(*) filter (where c.outcome not in ('noanswer','invalid')),
         count(*) filter (where c.outcome in ('noanswer','invalid'))
    from calls c
   where c.state = 'ended' and c.started_at >= p_from and c.started_at < p_to
   group by 1 order by 1;
$$;

create or replace function public.lead_counts()
returns table (status text, n bigint)
language sql stable as $$
  select l.status, count(*) from leads l group by 1;
$$;

-- ---------------------------------------------------------------
-- RLS: เฉพาะอีเมลใน team_members
-- (service role ของเซิร์ฟเวอร์ข้าม RLS อยู่แล้ว)
-- ---------------------------------------------------------------
alter table public.team_members enable row level security;
alter table public.settings     enable row level security;
alter table public.leads        enable row level security;
alter table public.calls        enable row level security;
alter table public.admin_tasks  enable row level security;
alter table public.dnc_numbers  enable row level security;

create policy team_read_members on public.team_members for select to authenticated using (public.is_team());
create policy team_all_settings on public.settings    for all to authenticated using (public.is_team()) with check (public.is_team());
create policy team_all_leads    on public.leads       for all to authenticated using (public.is_team()) with check (public.is_team());
create policy team_all_calls    on public.calls       for all to authenticated using (public.is_team()) with check (public.is_team());
create policy team_all_tasks    on public.admin_tasks for all to authenticated using (public.is_team()) with check (public.is_team());
create policy team_all_dnc      on public.dnc_numbers for all to authenticated using (public.is_team()) with check (public.is_team());
