import { vpsBase } from "./vps";

/**
 * ทำแทนปุ่มในแชทด้วยบัญชีผู้ใช้ "AI Call" ของเว็บเท่าไหร่ (เหมือนคนในทีมกดเอง) — ใช้ตอนหลังบ้านยังไม่รองรับสถานะ "ยังไม่แน่นอน"
 * ต้องตั้ง AI_CALL_BOT_USERNAME / AI_CALL_BOT_PASSWORD ใน Vercel และบัญชีนี้ต้องเป็นสมาชิกทั้ง 2 กลุ่ม
 * API หลัก = VPS_API_URL ตัด /ai-call ออก (เช่น https://thaolai.com/service/api/v1) หรือตั้ง THAOLAI_API_URL เอง
 */
const root = () => (process.env.THAOLAI_API_URL ?? vpsBase().replace(/\/ai-call$/, "")).replace(/\/+$/, "");
export const chatBotReady = () => !!(root() && process.env.AI_CALL_BOT_USERNAME && process.env.AI_CALL_BOT_PASSWORD);

let cached: { token: string; at: number } | null = null;

async function login(): Promise<string> {
  const res = await fetch(`${root()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: process.env.AI_CALL_BOT_USERNAME, password: process.env.AI_CALL_BOT_PASSWORD }),
    signal: AbortSignal.timeout(10_000),
  });
  const j: any = await res.json().catch(() => null);
  const token = j?.data?.access_token;
  if (!res.ok || !token) throw new Error(`เข้าสู่ระบบบัญชี AI Call ไม่ได้ (HTTP ${res.status})`);
  cached = { token, at: Date.now() };
  return token;
}

async function api(path: string, body: unknown): Promise<any> {
  let token = cached && Date.now() - cached.at < 10 * 60_000 ? cached.token : await login();
  const send = () => fetch(`${root()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  let res = await send();
  if (res.status === 401) { token = await login(); res = await send(); }
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

/**
 * ไม่รับสาย/ต้องโทรซ้ำ → ตั้งในแชทให้เหมือนคนกด:
 *  - ห้องในหลังบ้าน (การ์ดห้อง): สถานะห้อง "ยังไม่แน่นอน" + โทรแล้ว + หมายเหตุ
 *  - ห้องจากข้อความ (msg-…): ปุ่มใต้ข้อความ "โทรแล้ว" + "รอตอบ"
 * คืน true เมื่อทำสำเร็จ
 */
export async function botMarkUnsure(lead: any, call: any, note: string): Promise<boolean> {
  if (!chatBotReady()) return false;
  const group = call?.chat_group_uuid ?? lead?.chat_group_uuid;
  if (!group) return false;
  const ext = String(lead?.external_id ?? "");
  const msg = ext.match(/^msg-(\d+)/);
  if (msg) {
    const path = `/chat/groups/${group}/messages/${msg[1]}/mark`;
    // กดสถานะเดิมซ้ำ = ยกเลิก → กดเฉพาะชั้นที่ยังไม่ใช่สถานะนั้น
    const r1 = await api(path, { status: "called" });
    const marks = r1?.data?.message?.marks ?? {};
    if (marks?.contact?.status !== "called") await api(path, { status: "called" }).catch(() => null);
    if (marks?.result?.status !== "waiting") await api(path, { status: "waiting" });
    return true;
  }
  const asset = call?.chat_asset_uuid ?? lead?.chat_asset_uuid ?? (/^[0-9a-f-]{36}$/i.test(ext) ? ext : null);
  if (!asset) return false;
  await api(`/chat/groups/${group}/rooms/${asset}/status`, { status_id: 2, call_result: "", note: note.slice(0, 200) });
  return true;
}
