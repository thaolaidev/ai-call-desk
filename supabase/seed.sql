-- ข้อมูลตั้งต้นสำหรับทดลอง (รันหลัง 0001_init.sql)
-- 1) เปลี่ยนอีเมลเป็นของทีมคุณ แล้วสร้างผู้ใช้อีเมลเดียวกันใน Authentication → Users
insert into public.team_members (email, name) values
  ('somjeedai@gmail.com', 'แอดมิน')
on conflict do nothing;

-- 2) ห้องตัวอย่าง 12 ห้อง (เบอร์สมมติ ใช้กับโหมดจำลองเท่านั้น)
insert into public.leads (owner_name, phone, condo, unit, rent, source, customer_nationalities, viewing_when, status) values
  ('ศิริพร',   '0810000001', 'Ideo Mobi Asoke',           '1 ห้องนอน 35 ตร.ม. ชั้น 18', 18000, 'Livinginsider', 'อเมริกัน และ รัสเซีย', 'วันนี้', 'queued'),
  ('ณัฐพล',    '0810000002', 'Life Asoke',                'Studio 26 ตร.ม. ชั้น 12',    15500, 'DDproperty',    'อังกฤษ และ เกาหลี',   'วันนี้', 'queued'),
  ('กนกวรรณ',  '0810000003', 'Ashton Asoke',              '1 ห้องนอน 34 ตร.ม. ชั้น 28', 42000, 'Hipflat',       'อเมริกัน และ อังกฤษ', 'วันนี้', 'queued'),
  ('ธนวัฒน์',  '0810000004', 'Edge Sukhumvit 23',         '1 ห้องนอน 30 ตร.ม. ชั้น 20', 28000, 'กลุ่ม Facebook', 'รัสเซีย และ เกาหลี',  'พรุ่งนี้', 'queued'),
  ('วิภาวดี',  '0810000005', 'Rhythm Sukhumvit 36-38',    '1 ห้องนอน 35 ตร.ม. ชั้น 15', 22000, 'Livinginsider', 'ญี่ปุ่น และ อเมริกัน', 'วันนี้', 'queued'),
  ('อนุชา',    '0810000006', 'The Base Park West',        'Studio 26 ตร.ม. ชั้น 9',     15000, 'DDproperty',    'อเมริกัน และ รัสเซีย', 'วันนี้', 'queued'),
  ('จิราพร',   '0810000007', 'Noble Revolve Ratchada',    '1 ห้องนอน 30 ตร.ม. ชั้น 22', 17000, 'Livinginsider', 'อังกฤษ และ เกาหลี',   'วันนี้', 'queued'),
  ('เอกชัย',   '0810000008', 'Lumpini Suite Phetchaburi', '1 ห้องนอน 30 ตร.ม. ชั้น 7',  13500, 'Hipflat',       'อเมริกัน และ อังกฤษ', 'วันนี้', 'queued'),
  ('ปวีณา',    '0810000009', 'Q Chidlom',                 '2 ห้องนอน 52 ตร.ม. ชั้น 22', 39500, 'DDproperty',    'อเมริกัน และ รัสเซีย', 'วันนี้', 'new'),
  ('ศุภชัย',   '0810000010', 'Park Origin Phrom Phong',   '1 ห้องนอน 35 ตร.ม. ชั้น 31', 34000, 'กลุ่ม Facebook', 'ญี่ปุ่น และ อเมริกัน', 'วันนี้', 'new'),
  ('มณีรัตน์', '0810000011', 'Ideo Mobi Asoke',           'Studio 24 ตร.ม. ชั้น 9',     16000, 'Livinginsider', 'อังกฤษ และ เกาหลี',   'วันนี้', 'new'),
  ('วรวุฒิ',   '0810000012', 'Life Asoke',                '1 ห้องนอน 32 ตร.ม. ชั้น 25', 19000, 'Hipflat',       'รัสเซีย และ เกาหลี',  'วันนี้', 'new')
on conflict do nothing;
