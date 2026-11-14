# Thaolai Voice Server

server เสียงสำหรับโทรหาเจ้าของห้อง: เล่นไฟล์เสียง Botnoi → ฟังคำตอบ → แยกทางตามคำตอบทันที → ส่งผล + ไฟล์เสียงทั้งสายกลับเว็บ ai-call-desk

```
เว็บ (Vercel) ──POST /call──▶ voice (Node) ──ARI──▶ Asterisk ──SIP Trunk──▶ Yalecom ──▶ เจ้าของห้อง
      ▲                          │ ฟังคำตอบสั้นๆ ด้วย Gemini แล้วเลือกท่อนถัดไป
      └──POST /api/voice/result──┘ (ผลทุกข้อ + mp3 ทั้งสาย)
```

## ต้องมี
- VPS Linux ที่มี Docker + Docker Compose (RAM 1 GB พอสำหรับ 6 สายพร้อมกัน)
- ข้อมูล SIP Trunk จาก Yalecom: host, port, username, password (หรือแจ้ง IP ของ VPS ให้ Yalecom อนุญาต)
- โดเมนย่อยชี้มาที่ VPS เช่น `voice.thaolai.com` พร้อม HTTPS (เว็บต้องเรียก `https://voice.thaolai.com/call`)

## ติดตั้ง
```bash
cd voice-server
cp .env.example .env      # แก้ค่าให้ครบ
docker compose up -d --build
docker compose logs -f voice     # ต้องเห็น "ARI connected"
curl http://127.0.0.1:8090/health
```

## เปิดพอร์ต (firewall)
| พอร์ต | ใช้ทำอะไร | เปิดให้ใคร |
|---|---|---|
| 5060/tcp และ 5060/udp | SIP (Yalecom ใช้ TCP) | เฉพาะ IP ของ Yalecom |
| 10000–10200/udp | เสียง (RTP) | เฉพาะ IP ของ Yalecom |
| 8090/tcp | รับคำสั่งโทรจากเว็บ | ผ่าน reverse proxy HTTPS เท่านั้น (อย่าเปิดตรง) |
| 8088/tcp | ARI | ห้ามเปิด (ใช้ภายในเครื่อง) |

reverse proxy ตัวอย่าง (Caddy):
```
voice.thaolai.com {
  reverse_proxy 127.0.0.1:8090
}
```

## ตั้งค่าฝั่งเว็บ (Vercel → Environment Variables)
- `VOICE_SERVER_URL` = `https://voice.thaolai.com`
- `VOICE_SECRET` = ค่าเดียวกับใน `.env`
แล้วเลือก "ระบบโทร = Server เสียงของเรา (SIP)" ในหน้าตั้งค่า

## ตรวจปัญหา
- `docker compose exec asterisk asterisk -rx "pjsip show registrations"` → ต้องเป็น Registered
- `docker compose exec asterisk asterisk -rx "pjsip show endpoints"`
- โทรได้แต่ไม่มีเสียง → ส่วนใหญ่เป็น NAT/RTP: ตรวจ `PUBLIC_IP` และพอร์ต 10000–10200/udp
- โทรไม่ออก → ลองเปลี่ยน `SIP_ENDPOINT` เป็นรูปแบบที่ Yalecom กำหนด (บางที่ต้องมี prefix)

## API
- `GET /health` → `{ ok, ari, active, max }`
- `POST /call` (header `x-voice-secret`) body:
  `{ call_id, phone, audio: { "01": url, ... }, enabled: ["01", ...], titles: { "03": "..." }, condo_url, price_url }`
- `POST /hangup/<call_id>` วางสาย
