-- ห้องจากแชท: auto = รับแล้วโทรทันที · queue = รับเข้าคิว รอกดโทรเอง · off = ไม่รับ
alter table public.settings add column if not exists chat_mode text not null default 'auto' check (chat_mode in ('auto', 'queue', 'off'));
update public.settings set chat_mode = 'off' where chat_enabled = false;
