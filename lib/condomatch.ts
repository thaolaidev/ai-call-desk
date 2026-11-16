import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * จับคู่ชื่อคอนโดที่พิมพ์มา (เช่น "Ideo mobi Asoke", "ไอดีโอ โมบิ อโศก") กับคลังชื่อคอนโด
 * คลังเก็บชื่อแบบ "Ideo Mobi Asoke / ไอดีโอ โมบิ อโศก" + condo_id → ได้ชื่อเต็ม + id → ใช้เสียงชื่อไทยที่ถูกต้อง
 */
const STOP = new Set(["condo", "คอนโด", "the", "เดอะ", "residence", "เรสซิเดนซ์", "by"]);
const words = (s: string) =>
  s.toLowerCase().replace(/\*/g, " ").replace(/[^\p{L}\p{N}฀-๿]+/gu, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
const squash = (s: string) => words(s).join("");

/** ความเหมือน 0–1 ของชื่อที่พิมพ์ กับชื่อ 1 ส่วนในคลัง (อังกฤษหรือไทย) */
function similar(input: string, part: string) {
  const a = squash(input), b = squash(part);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const wa = words(input), wb = words(part);
  const common = wa.filter((w) => wb.includes(w)).length;
  let score = (2 * common) / (wa.length + wb.length);
  // ไทยเขียนติดกัน/เว้นวรรคต่างกัน: "ไอดีโอโมบิอโศก" vs "ไอดีโอ โมบิ อโศก"
  if (a.length >= 6 && (b.includes(a) || a.includes(b))) score = Math.max(score, Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.1);
  return Math.min(score, 0.99);
}

export type CondoMatch = { condo: string; condo_id: string | null; score: number };

export async function matchCondo(db: SupabaseClient, typed: string): Promise<CondoMatch | null> {
  const ws = words(typed);
  if (!ws.length) return null;
  // หาผู้สมัครจากคำที่ยาวที่สุด 2 คำ (เร็ว ไม่ต้องดึงทั้งคลัง)
  const keys = [...ws].sort((x, y) => y.length - x.length).slice(0, 2).filter((w) => w.length >= 3);
  if (!keys.length) return null;
  const or = keys.map((k) => `condo.ilike.%${k.replace(/[%_,()]/g, "")}%`).join(",");
  const { data } = await db.from("condo_audio").select("condo, condo_id, path").or(or).limit(300);
  // คะแนนเท่ากัน: เลือกแถวจากคลัง (มี condo_id) ก่อน แล้วค่อยแถวที่มีเสียงแล้ว
  const rank = (x: { condo_id: unknown; path: unknown }) => (x.condo_id ? 2 : 0) + (x.path ? 1 : 0);
  let best: (CondoMatch & { rank: number }) | null = null;
  for (const r of data ?? []) {
    const parts = String(r.condo).split(/\s+\/\s+/);
    const score = Math.max(...parts.map((p) => similar(typed, p)));
    const better = !best || score > best.score || (score === best.score && rank(r) > best.rank);
    if (better) best = { condo: r.condo, condo_id: r.condo_id ? String(r.condo_id) : null, score, rank: rank(r) };
  }
  return best && best.score >= 0.75 ? { condo: best.condo, condo_id: best.condo_id, score: best.score } : null;
}
