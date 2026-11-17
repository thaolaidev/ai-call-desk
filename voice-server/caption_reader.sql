-- ผู้ใช้ฐานข้อมูลแบบอ่านอย่างเดียว ให้ server เสียงอ่าน "คำบรรยายใต้รูป" ในกลุ่มแชท
-- อ่านได้แค่คอลัมน์ที่จำเป็น 3 ตาราง (ข้อความแชท / uuid กลุ่ม / ชื่อผู้โพสต์) แก้หรือลบอะไรไม่ได้
-- รันในฐานข้อมูลของ thaolai (ฐานเดียวกับที่ api-go ใช้) ด้วยผู้ใช้ที่เป็นเจ้าของตาราง
-- เปลี่ยน CHANGE_ME เป็นรหัสผ่านใหม่ (สร้างด้วย: openssl rand -hex 16) ห้ามส่งรหัสในแชท

CREATE ROLE ai_call_reader LOGIN PASSWORD 'CHANGE_ME' CONNECTION LIMIT 2;
GRANT USAGE ON SCHEMA public TO ai_call_reader;
GRANT SELECT (id, group_id, sender_user_id, kind, body, created_at) ON chat_message TO ai_call_reader;
GRANT SELECT (id, uuid) ON chat_group TO ai_call_reader;
GRANT SELECT (id, first_name_th, username) ON "user" TO ai_call_reader;

-- ยกเลิกทีหลัง (เมื่อ dev ลง patch แนบรูปแล้ว):
--   REVOKE ALL ON chat_message, chat_group, "user" FROM ai_call_reader; DROP ROLE ai_call_reader;
