-- 0013: ระบบโทรแบบ server เสียงของเราเอง (SIP)
alter table public.settings drop constraint if exists settings_provider_check;
alter table public.settings add constraint settings_provider_check check (provider in ('simulate','vapi','yalecom','sip'));
