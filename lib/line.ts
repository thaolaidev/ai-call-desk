/** ส่งข้อความเข้า LINE กลุ่มแอดมิน (LINE Messaging API) — ไม่ได้ตั้งค่า = ข้าม */
export async function notifyLine(text: string) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const to = process.env.LINE_TARGET_ID;
  if (!token || !to) return;
  try {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
    });
  } catch (e) {
    console.error("LINE notify failed", e);
  }
}
