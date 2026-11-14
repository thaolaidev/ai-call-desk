import type { SupabaseClient } from "@supabase/supabase-js";
import { STEP_KEYS, yalecomName } from "./script";

/** ไฟล์เงียบ ~1 วินาที (ต้องอัปโหลดเข้า Yalecom ด้วย ชื่อ tl_wait_1s) ใช้เว้นช่วงให้เจ้าของตอบ */
export const WAIT_FILE = "tl_wait_1s";
export const SILENCE_MP3_B64 = "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA/+M4wAAAAAAAAAAAAEluZm8AAAAPAAAAEAAABVgANTU1NTU1Q0NDQ0NDUFBQUFBQXl5eXl5ea2tra2tra3l5eXl5eYaGhoaGhpSUlJSUlKGhoaGhoaGvr6+vr6+8vLy8vLzKysrKysrX19fX19fX5eXl5eXl8vLy8vLy////////AAAAAExhdmM2MC4zMQAAAAAAAAAAAAAAACQCgAAAAAAAAAVYCAAeqQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+MYxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxDsAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxHYAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxLEAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxMQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

/** ค่าเริ่มต้นของแต่ละท่อน: เล่นไหม + รอให้ตอบกี่วินาทีหลังเล่น */
export const DEFAULT_PLAY: Record<string, { enabled: boolean; wait: number }> = {
  ack: { enabled: true, wait: 0 },
  "02B": { enabled: true, wait: 0 },
  "01": { enabled: true, wait: 0 },
  "02-1": { enabled: true, wait: 0 },
  "02-2": { enabled: true, wait: 1 },
  "03": { enabled: true, wait: 1 },
  "03-1": { enabled: true, wait: 1 },
  "03-2": { enabled: true, wait: 1 },
  "04-1": { enabled: true, wait: 0 },  // เล่นเฉพาะลีดที่มีเสียงราคา
  "04-2": { enabled: true, wait: 1 },
  "05": { enabled: true, wait: 1 },
  "06A": { enabled: false, wait: 2 },
  "07-1": { enabled: false, wait: 0 },
  "07-2": { enabled: false, wait: 0 },
  "07-3": { enabled: false, wait: 0 },
  "07-4": { enabled: false, wait: 2 },
  "08": { enabled: true, wait: 0 },
  "09": { enabled: true, wait: 0 },
};

export type PlayRow = { step_key: string; enabled: boolean; wait_after: number };

export async function loadPlaylist(db: SupabaseClient) {
  const { data } = await db.from("script_playlist").select("*");
  const saved = new Map<string, PlayRow>((data ?? []).map((r: PlayRow) => [r.step_key, r]));
  return STEP_KEYS.map((k) => {
    const r = saved.get(k);
    return { key: k, enabled: r ? r.enabled : DEFAULT_PLAY[k]?.enabled ?? true, wait: r ? r.wait_after : DEFAULT_PLAY[k]?.wait ?? 0 };
  });
}

/**
 * รายชื่อไฟล์ที่ Yalecom ต้องเล่นต่อกัน (แบบ ก: เล่นทั้งชุด เว้นช่วงเงียบให้ตอบ แล้วให้ AI ฟังเสียงอัดทีหลัง)
 * condoFile = ไฟล์ชื่อคอนโดใน Yalecom (null = ไม่มี → ข้ามชื่อคอนโด)
 */
export function buildPlaybackList(steps: { key: string; enabled: boolean; wait: number }[], condoFile: string | null) {
  const list: string[] = [];
  for (const s of steps) {
    if (!s.enabled || ["ack", "02B", "04-1", "04-2"].includes(s.key)) continue; // ใช้เฉพาะระบบโทรแบบแยกทาง
    list.push(yalecomName(s.key));
    if (s.key === "02-1" && condoFile) list.push(condoFile);
    for (let i = 0; i < Math.min(15, Math.max(0, s.wait)); i++) list.push(WAIT_FILE);
  }
  return list;
}
