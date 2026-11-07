-- แยกทรัพย์ใหม่ / ทรัพย์เก่า + มุมมองสำหรับแท็บ "จะโทรวันนี้" และ "โทรแล้ว"

alter table public.leads
  add column if not exists segment text not null default 'new' check (segment in ('new', 'old'));
create index if not exists leads_segment_idx on public.leads (segment, status);

create or replace view public.leads_v with (security_invoker = true) as
select
  l.*,
  c.started_at as last_called_at,
  (
    l.status in ('queued', 'calling')
    or (l.status in ('noanswer', 'callback')
        and l.next_call_at < ((date_trunc('day', now() at time zone 'Asia/Bangkok') + interval '1 day') at time zone 'Asia/Bangkok'))
  ) as due_today,
  (l.attempts > 0 and l.status not in ('new', 'queued', 'calling')) as called
from public.leads l
left join public.calls c on c.id = l.last_call_id;

create or replace function public.lead_tab_counts()
returns table (segment text, status text, due_today boolean, called boolean, n bigint)
language sql stable as $$
  select v.segment, v.status, v.due_today, v.called, count(*) from public.leads_v v group by 1, 2, 3, 4;
$$;

-- (ตัวอย่าง) ให้ห้องทดลองบางห้องเป็นทรัพย์เก่า ลบบรรทัดนี้ได้ถ้าไม่ได้ใช้ seed.sql
update public.leads set segment = 'old'
 where phone in ('0810000005','0810000006','0810000007','0810000008','0810000011','0810000012');
