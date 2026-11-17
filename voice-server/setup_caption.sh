#!/usr/bin/env bash
# ตั้งค่าให้ server เสียงอ่าน "ข้อความใต้รูป" ในกลุ่ม Check ทรัพย์ใหม่ — รันบน VPS ครั้งเดียว: bash /opt/voice-server/setup_caption.sh
# - สร้างผู้ใช้ฐานข้อมูล ai_call_reader แบบอ่านอย่างเดียว (อ่านได้แค่ข้อความแชท / uuid กลุ่ม / ชื่อคนโพสต์ แก้หรือลบอะไรไม่ได้)
# - เขียนค่าลง /opt/voice-server/.env ให้เอง (รหัสผ่านสร้างอัตโนมัติ ไม่แสดงบนจอ)
# รันซ้ำได้ (เปลี่ยนรหัสผ่านใหม่ให้)
set -euo pipefail

PG=postgis                                   # container ฐานข้อมูลของ thaolai (Docker/docker-compose.yml)
ENVF=/opt/voice-server/.env
GROUP=777a33d4-ee6d-4fdd-a95a-2f0bd821aa13   # กลุ่ม Check ทรัพย์ใหม่

docker ps --format '{{.Names}}' | grep -qx "$PG" || { echo "ไม่เจอ container $PG"; docker ps --format '{{.Names}}  {{.Image}}'; exit 1; }
U=$(docker exec "$PG" printenv POSTGRES_USER)
D=$(docker exec "$PG" printenv POSTGRES_DB)
q() { docker exec -i "$PG" psql -U "$U" -d "$D" -v ON_ERROR_STOP=1 -qtA "$@"; }

[ "$(q -c "SELECT to_regclass('public.chat_message') IS NOT NULL")" = "t" ] || { echo "ฐาน $D ไม่มีตาราง chat_message — หยุด"; exit 1; }
echo "ฐานข้อมูล: $D (container $PG)"

PASS=$(openssl rand -hex 16)
q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_call_reader') THEN
    CREATE ROLE ai_call_reader LOGIN PASSWORD '$PASS' CONNECTION LIMIT 2;
  ELSE
    ALTER ROLE ai_call_reader LOGIN PASSWORD '$PASS' CONNECTION LIMIT 2;
  END IF;
END \$\$;
GRANT USAGE ON SCHEMA public TO ai_call_reader;
GRANT SELECT (id, group_id, sender_user_id, kind, body, created_at) ON chat_message TO ai_call_reader;
GRANT SELECT (id, uuid) ON chat_group TO ai_call_reader;
GRANT SELECT (id, first_name_th, username) ON "user" TO ai_call_reader;
SQL
echo "สร้างผู้ใช้ ai_call_reader (อ่านอย่างเดียว) แล้ว"

# ทดสอบเข้าด้วยผู้ใช้ใหม่ผ่านพอร์ตเดียวกับที่ server เสียงจะใช้
docker exec -e PGPASSWORD="$PASS" "$PG" psql -h 127.0.0.1 -U ai_call_reader -d "$D" -qtAc \
  "SELECT 'อ่านได้ ' || count(*) || ' ข้อความ' FROM chat_message WHERE id > (SELECT max(id) - 10 FROM chat_message)" \
  || { echo "เข้าด้วย ai_call_reader ไม่ได้ (pg_hba?) — หยุด"; exit 1; }

touch "$ENVF"
sed -i '/^CAPTION_DB_URL=/d;/^CAPTION_GROUPS=/d' "$ENVF"
echo "CAPTION_DB_URL=postgres://ai_call_reader:$PASS@127.0.0.1:5432/$D" >> "$ENVF"
echo "CAPTION_GROUPS=$GROUP" >> "$ENVF"

if ! grep -q '^CHAT_API_KEY=.' "$ENVF"; then
  read -rsp "วาง CHAT_API_KEY (ค่าเดียวกับใน Vercel) แล้วกด Enter (ไม่แสดงบนจอ): " KEY; echo
  [ -n "$KEY" ] || { echo "ยังไม่ได้ใส่ CHAT_API_KEY — รันใหม่อีกครั้ง"; exit 1; }
  sed -i '/^CHAT_API_KEY=/d' "$ENVF"
  echo "CHAT_API_KEY=$KEY" >> "$ENVF"
fi
chmod 600 "$ENVF"
echo "ใส่ค่าใน $ENVF แล้ว"

cd /opt/voice-server && docker compose --progress plain up -d --build voice >/dev/null 2>&1 < /dev/null
echo "build server เสียงใหม่แล้ว รอ 15 วินาที..."
sleep 15
docker compose logs --tail 40 voice | grep -E "caption" || echo "(ยังไม่เห็นบรรทัด caption — ดูด้วย: docker compose logs --tail 50 voice)"
