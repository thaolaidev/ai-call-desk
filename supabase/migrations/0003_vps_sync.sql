-- เชื่อมกับระบบทรัพย์บน VPS: รหัสทรัพย์ภายนอก + สถานะการส่งผลกลับ

alter table public.leads add column if not exists external_id text;
create unique index if not exists leads_external_id_uidx on public.leads (external_id);

alter table public.calls
  add column if not exists sync_status   text not null default 'pending' check (sync_status in ('pending','sent','failed','skipped')),
  add column if not exists sync_attempts int  not null default 0,
  add column if not exists next_sync_at  timestamptz,
  add column if not exists synced_at     timestamptz,
  add column if not exists sync_error    text;
create index if not exists calls_sync_idx on public.calls (sync_status, next_sync_at);

-- สายที่จบไปก่อนเชื่อมระบบ ไม่ต้องส่งย้อนหลัง
update public.calls set sync_status = 'skipped' where state in ('ended','failed');

-- view ของแท็บกองลีดต้องสร้างใหม่ เพื่อให้เห็นคอลัมน์ external_id
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
