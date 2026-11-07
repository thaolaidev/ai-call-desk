-- สถานะห้องจาก VPS (ว่าง / ไม่ว่าง / รอติดต่อ) + วันที่อัปเดตล่าสุด + เกณฑ์ทรัพย์เก่า

alter table public.leads
  add column if not exists vps_status     text,          -- สถานะบนเว็บ ณ ตอนที่ VPS ส่งมา
  add column if not exists vps_updated_at timestamptz,   -- วันที่อัปเดตล่าสุดบนเว็บ
  add column if not exists last_called_at timestamptz;   -- เราโทรครั้งล่าสุดเมื่อไหร่

update public.leads l set last_called_at = c.started_at
  from public.calls c where c.id = l.last_call_id and l.last_called_at is null;

alter table public.settings
  add column if not exists stale_days int not null default 30 check (stale_days between 1 and 365);

-- view ต้องสร้างใหม่ทั้งหมดเพราะคอลัมน์ของ leads เปลี่ยน
drop function if exists public.lead_tab_counts();
drop view if exists public.leads_v;

create view public.leads_v with (security_invoker = true) as
select
  l.*,
  (
    l.status in ('queued', 'calling')
    or (l.status in ('noanswer', 'callback')
        and l.next_call_at < ((date_trunc('day', now() at time zone 'Asia/Bangkok') + interval '1 day') at time zone 'Asia/Bangkok'))
  ) as due_today,
  (l.attempts > 0 and l.status not in ('new', 'queued', 'calling')) as called
from public.leads l;

create function public.lead_tab_counts()
returns table (segment text, status text, due_today boolean, called boolean, n bigint)
language sql stable as $$
  select v.segment, v.status, v.due_today, v.called, count(*) from public.leads_v v group by 1, 2, 3, 4;
$$;
