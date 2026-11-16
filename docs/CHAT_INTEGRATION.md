# แชท "Check สถานะห้อง" → AI โทร → ผลกลับขึ้นการ์ดห้อง

สำหรับ dev ฝั่ง thaolai (Backend/api-go) · มีแพตช์ให้แล้ว: `thaolai-ai-call-chat.patch`

## ภาพรวม

```
ทีมกดค้นห้อง (ฟอร์ม หรือรหัสห้อง) / ดูเพิ่ม / ส่งซ้ำ ในกลุ่มที่ตั้งไว้ใน AI_CALL_CHAT_GROUPS
  → backend ส่งการ์ดเข้ากลุ่ม (เหมือนเดิม)
  → backend ส่งห้องชุดที่เพิ่งแสดง (≤10 ห้อง) ไปที่ห้องโทร POST {AI_CALL_DESK_URL}/api/chat/push   (เบื้องหลัง ไม่โพสต์อะไรในกลุ่ม)
  → AI เริ่มโทรห้องไหน: ห้องโทร POST /ai-call/calling → การ์ดห้องขึ้น "กำลังโทร"
  → สายจบ: ห้องโทร POST /ai-call/results ทันที
       ติดต่อได้ (ว่าง/ไม่ว่าง) → อัปเดตสถานะห้อง + การ์ดขึ้น "โทรแล้ว"
       ติดต่อไม่ได้           → ยกเลิกรายการ "กำลังโทร" การ์ดกลับเป็น "ยังไม่ได้โทร" (สถานะห้องไม่เปลี่ยน)
  → การ์ดในแชทรีเฟรชเองภายใน ~15 วินาที (ไม่มีข้อความแจ้งในกลุ่ม)
```

## แพตช์ทำอะไรบ้าง (12 ไฟล์ ไม่มี migration)

| ไฟล์ | เปลี่ยน |
|---|---|
| `config/config.go` | env ใหม่ `AI_CALL_DESK_URL`, `AI_CALL_DESK_KEY`, `AI_CALL_CHAT_GROUPS` |
| `service/ai_call_chat.go` (ใหม่) | ส่งห้องให้ห้องโทร (เบื้องหลัง, log อย่างเดียว) |
| `service/chat_service.go` + `service/chat_room_code.go` | เรียก `pushToAICall` ใน SearchRooms / ค้นตามรหัสห้อง / ShowMoreListings / ResendListings |
| `service/ai_call_service.go` | GET leads มี `price`, `location_id` · `MarkCalling` · ผล "ติดต่อไม่ได้" = ยกเลิกรายการกำลังโทร (เดิมบันทึก "ติดต่อไม่ได้") · ใส่ `user_id` = AI_CALL_BOT_USER_ID ในประวัติโทร |
| `repository/ai_call_repository.go` | `ListLeadsFiltered` (listed_after / listed_before / updated_before) · `LeadsByAssetIDs` · `CancelLatestCalling` · ดึง price, ref_location_id |
| `handler/ai_call_handler.go` + `app/router.go` | ใหม่ `POST /ai-call/calling` { id, chat_group_uuid?, asset_uuid? } → บันทึกประวัติโทร "กำลังโทร" (เหมือนกดปุ่มโทรบนการ์ด) |
| `handler/ai_call_handler.go` | GET `/ai-call/leads` รับ `listed_after`, `listed_before`, `updated_before` (ISO 8601), `page`, `per_page` — ไม่ส่ง = ทำงานแบบเดิมทุกอย่าง |
| `service/ai_call_text.go` (ใหม่) | กลุ่ม "Check ทรัพย์ใหม่": ข้อความที่มีเบอร์ + ชื่อคอนโด → ส่งให้ AI โทร · ผลโทรตั้งเป็นปุ่มสถานะใต้ข้อความ |
| `service/chat_service.go` (PostText) | เรียก `pushTextToAICall` หลังโพสต์ข้อความ |
| `app/app.go` | ผูก ChatService ↔ AICallService |
| `Docker/nginx/default.conf` | เพิ่ม server block `voice.thaolai-check.online` (server เสียงของห้องโทร) — เดิมเพิ่มบน PRD ตรง ๆ แล้วถูก Jenkins sync ทับหาย |

ของเดิมไม่เปลี่ยนพฤติกรรม: กลุ่มที่ไม่อยู่ใน `AI_CALL_CHAT_GROUPS` หรือไม่ได้ตั้ง env = ไม่ส่งอะไรเลย · GET leads แบบเดิม (status/min_days/limit/offset) ยังเหมือนเดิม

แพตช์เขียนจากโค้ดใน repo แต่ยัง **build/test ไม่ได้** (เครื่องที่เขียนดาวน์โหลด Go module ไม่ได้) — รบกวนรัน `go build ./... && go test ./internal/...` ก่อน deploy

## ติดตั้ง

```bash
cd THAOLAI
git checkout -b ai-call-chat
git apply thaolai-ai-call-chat.patch
cd Backend/api-go && gofmt -w internal/service/ai_call_chat.go && go build ./... && go test ./internal/...
```

env บน PRD (ไฟล์ .env ของ api):

```
AI_CALL_DESK_URL=https://ai-call-desk.vercel.app
AI_CALL_DESK_KEY=<ค่าเดียวกับ CHAT_API_KEY ใน Vercel ของห้องโทร>
AI_CALL_CHAT_GROUPS=<uuid ของกลุ่ม "Check สถานะห้อง">
AI_CALL_TEXT_GROUPS=<uuid ของกลุ่ม "Check ทรัพย์ใหม่">
AI_CALL_BOT_USER_ID=<id ของผู้ใช้หลังบ้านชื่อ "AI Call">   # มีอยู่แล้ว — ตั้งไว้ให้การ์ด/หลังบ้านขึ้นชื่อผู้อัปเดตเป็น AI Call
```

ผลที่เว็บ: ผลโทรเขียนสถานะลงตาราง `asset` ผ่าน `AssetStatusService.Update` ตัวเดียวกับปุ่มบนการ์ดและหน้าหลังบ้าน
→ หน้าเว็บ thaolai.com, หลังบ้าน และการ์ดในแชท เห็นสถานะใหม่ตรงกัน (การ์ดในแชทรีเฟรชเองภายใน ~15 วินาที)

uuid ของกลุ่ม: `SELECT uuid, name FROM chat_group WHERE name LIKE 'Check สถานะ%';`

## API ที่ห้องโทรรับ (อ้างอิง)

`POST {AI_CALL_DESK_URL}/api/chat/push` · header `X-API-Key: <AI_CALL_DESK_KEY>`

```json
{ "group_uuid": "…", "requested_by": "Namtan",
  "rooms": [{ "id": "<asset uuid>", "asset_uuid": "<asset uuid>", "code": "B2932", "condo_name": "Oka Haus Sukhumvit 36",
              "location_id": 881, "phone": "0812345678", "price": 12000,
              "listed_at": "…", "status": "ว่าง", "updated_at": "…" }] }
```

ตอบ `202`: `{ "queued": 8, "started": 3, "waiting": null, "rooms": [{ "id": "…", "state": "queued" | "skipped", "reason": "…" }] }`
ห้องที่ AI เพิ่งโทรภายใน 12 ชม. / กำลังโทร / ขอไม่ให้ติดต่อ จะถูกข้าม

## ผลโทรที่ห้องโทรส่งกลับ (POST /ai-call/results)

- `status` = `ว่าง` / `ไม่ว่าง` / `ติดต่อไม่ได้` เสมอ (ไม่ส่ง null แล้ว)
- `available_date` = `YYYY-MM-DD` เฉพาะเมื่อแปลงจากคำพูดเจ้าของได้ (ไม่ได้ = อยู่ใน `note`)
- ห้องจากแชท: มี `via_chat: true`, `chat_group_uuid`, `asset_uuid` ติดมาด้วย (backend ไม่ต้องใช้)
- ฟิลด์อื่นที่ส่งมาด้วย (backend ไม่ใช้ก็ได้): `summary`, `outcome`, `accepts_foreigners`, `owner_agreed_profile`, `owner_price`, `available_text`, `attempt`

## กลุ่ม "Check ทรัพย์ใหม่" — พิมพ์เบอร์ + ชื่อคอนโด

กลุ่มใน `AI_CALL_TEXT_GROUPS`: ทุกข้อความที่พิมพ์ในแชทเว็บ (PostText) ถ้ามีเบอร์โทร → ส่งให้ AI โทรทันที (1 บรรทัดที่มีเบอร์ = 1 ห้อง)

| ข้อความ | อ่านได้ |
|---|---|
| `0812345678 Ideo Mobi Asoke 15000` | เบอร์ 0812345678 · Ideo Mobi Asoke · 15,000 |
| `Ideo Mobi Asoke 081-234-5678 ราคา 15,000 บาท` | เบอร์ 0812345678 · Ideo Mobi Asoke · 15,000 |
| `ไอดีโอ โมบิ อโศก` ↵ `โทร 089 123 4567` | เบอร์ 0891234567 · ไอดีโอ โมบิ อโศก (ชื่อจากบรรทัดก่อน) |
| `Life Asoke 12k 0923334444` | 0923334444 · Life Asoke · 12,000 |
| `เบอร์ 0812345678` (ไม่มีชื่อ) / ไม่มีเบอร์ | ไม่ส่ง |

id ที่ส่ง = `msg-<message id>-<ลำดับ>` (ยังไม่มีในหลังบ้าน) → `/ai-call/calling` และ `/ai-call/results` ของ id แบบนี้จะ**ตั้งปุ่มสถานะใต้ข้อความ**แทนการแก้สถานะห้อง:

- เริ่มโทร → ชั้นติดต่อ = กำลังโทร
- ติดต่อได้ → ชั้นติดต่อ = โทรแล้ว · ชั้นผล = ว่าง / ไม่ว่าง
- ติดต่อไม่ได้ → ล้างชั้นติดต่อ (= ยังไม่ได้โทร)

ปุ่มใต้ข้อความแสดงเมื่อกลุ่มเปิด **call_buttons** (เปิดที่หน้าจัดการกลุ่ม) · ข้อความที่มาจาก LINE (mirror) ยังไม่ส่ง
