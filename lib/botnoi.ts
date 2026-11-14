import type { SupabaseClient } from "@supabase/supabase-js";
import { condoFileName } from "./yalecom";

const BASE = "https://api-voice.botnoi.ai/openapi/v1";
/**
 * v1 = Classic, v2 = Premium (ค่าเริ่มต้น), v4 = Expressive, clone = เสียงโคลน/เสียงชุมชน (รหัสยาว เช่น 510559)
 * รหัสผู้พูดของแต่ละรุ่นไม่ตรงกัน
 */
const VERSION = (process.env.BOTNOI_VERSION ?? "v2").toLowerCase();
const ENDPOINT = { v1: "generate_audio", v4: "generate_audio_v4", clone: "generate_audio_clone" }[VERSION] ?? "generate_audio_v2";
const DEFAULT_SPEAKER = VERSION === "v4" ? "2" : VERSION === "v1" ? "1" : "8"; // Ava
const BUCKET = "script-audio";

export const botnoiReady = () => !!process.env.BOTNOI_TOKEN;

/**
 * คำอ่านเริ่มต้น = ชื่อภาษาไทยอย่างเดียว
 * "Metro sky วุฒกาศ / เมโทร สกาย วุฒากาศ" → "เมโทร สกาย วุฒากาศ" · "PLUM CONDO SUKHUMVIT97/1 / พลัมคอนโด สุขุมวิท 97/1" → "พลัมคอนโด สุขุมวิท 97/1"
 * ไม่มีภาษาไทยเลย → null (ไม่สร้างเสียงอัตโนมัติ ต้องใส่คำอ่านเอง)
 */
export function defaultReading(condo: string): string | null {
  const parts = condo.split(/\s+\/\s+/).map((p) => p.replace(/\*/g, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const thai = parts.filter((p) => /[\u0E00-\u0E7F]/.test(p));
  return thai.length ? thai[thai.length - 1] : null;
}

/** สร้างไฟล์เสียงจาก Botnoi → ได้ไฟล์ mp3 */
async function botnoiTts(text: string): Promise<ArrayBuffer> {
  const speaker = process.env.BOTNOI_SPEAKER || DEFAULT_SPEAKER;
  const body: Record<string, unknown> = VERSION === "clone"
    ? { text, speaker, type_media: "mp3", save_file: "True", language: "th" }
    : { text, speaker, volume: VERSION === "v4" ? 100 : 1, speed: Number(process.env.BOTNOI_SPEED || 1), type_media: "mp3", save_file: "True", language: "th" };
  if (VERSION === "v4") Object.assign(body, { split_english: true, trim_breath: true });

  const call = () => fetch(`${BASE}/${ENDPOINT}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "botnoi-token": process.env.BOTNOI_TOKEN! },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  let res = await call();
  // 429 = มีสายอื่นกำลังสร้างอยู่ / เกิน 30 ครั้งต่อนาที → รอแล้วลองอีกครั้ง
  if (res.status === 429 || res.status === 502) {
    const wait = Math.min(8, Number(res.headers.get("retry-after")) || 3);
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await call();
  }
  const raw = await res.text();
  if (!res.ok) {
    const why: Record<number, string> = { 402: "พอยต์ไม่พอ", 401: "BOTNOI_TOKEN ไม่ถูกต้อง", 403: "พอยต์ไม่พอ หรือใช้เสียงนี้ไม่ได้", 404: VERSION === "clone" ? "ไม่พบเสียงโคลนรหัสนี้" : "พอยต์ไม่พอ หรือไม่พบรหัสผู้พูด", 422: "ข้อมูลไม่ครบ หรือข้อความยาวเกิน", 429: "เรียกถี่เกินไป ลองใหม่อีกครั้ง" };
    throw new Error(`Botnoi ${res.status}${why[res.status] ? ` (${why[res.status]})` : ""}: ${raw.slice(0, 150)}`);
  }
  let url: string | undefined;
  try { url = JSON.parse(raw).audio_url; } catch {}
  if (!url) throw new Error(`Botnoi ไม่ส่ง audio_url กลับมา: ${raw.slice(0, 200)}`);
  const audio = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!audio.ok) throw new Error(`ดาวน์โหลดเสียงจาก Botnoi ไม่ได้ (HTTP ${audio.status})`);
  return audio.arrayBuffer();
}

/**
 * ให้คอนโดนี้มีไฟล์เสียงชื่อ: ถ้ามีอยู่แล้วใช้ของเดิม (ไม่เรียก Botnoi ซ้ำ)
 * force = true → สร้างใหม่ (เช่น แก้คำอ่าน)
 */
export async function ensureCondoAudio(db: SupabaseClient, condo: string, opts: { text?: string | null; force?: boolean; condo_id?: string | null } = {}) {
  const { data: row } = await db.from("condo_audio").select("*").eq("condo", condo).maybeSingle();
  if (row?.path && !opts.force) return { reused: true, path: row.path as string };
  if (!botnoiReady()) throw new Error("ยังไม่ได้ตั้ง BOTNOI_TOKEN");

  const text = ((opts.text ?? row?.tts_text ?? "").trim() || defaultReading(condo) || "").slice(0, 200);
  if (!text) {
    await db.from("condo_audio").upsert({ condo, ...(opts.condo_id && !row?.condo_id ? { condo_id: opts.condo_id } : {}), file_name: row?.file_name ?? condoFileName(condo), tts_error: "ไม่มีชื่อภาษาไทย · ใส่คำอ่านเอง", updated_at: new Date().toISOString(), ready: row?.ready ?? false });
    throw new Error("ไม่มีชื่อภาษาไทย");
  }
  const file_name = row?.file_name ?? (opts.condo_id ? `tl_condo_${opts.condo_id.replace(/[^\w-]/g, "")}` : condoFileName(condo));
  const idPatch = opts.condo_id && !row?.condo_id ? { condo_id: opts.condo_id } : {};
  try {
    const mp3 = await botnoiTts(text);
    const path = `condo/${file_name}.mp3`;
    const { error } = await db.storage.from(BUCKET).upload(path, mp3, { contentType: "audio/mpeg", upsert: true });
    if (error) throw new Error(`เก็บไฟล์ไม่สำเร็จ: ${error.message}`);
    const now = new Date().toISOString();
    await db.from("condo_audio").upsert({
      condo, ...idPatch, tts_text: text, file_name, path, audio_source: "botnoi", tts_error: null, generated_at: now, updated_at: now, ready: row?.ready ?? false,
    });
    return { reused: false, path };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("condo_audio").upsert({ condo, ...idPatch, tts_text: text, file_name, tts_error: msg.slice(0, 300), updated_at: new Date().toISOString(), ready: row?.ready ?? false });
    throw e;
  }
}

/** สร้างเสียงให้คอนโดในคลังที่ยังไม่มี ครั้งละไม่เกิน limit โครงการ (ข้ามตัวที่เคยพัง จนกว่าจะกด "อ่านใหม่" เอง) */
export async function fillMissingCondoAudio(db: SupabaseClient, limit = 10) {
  if (!botnoiReady()) return { made: 0, failed: 0 };
  const { buildLibrary } = await import("./condolib");
  const todo = (await buildLibrary(db)).filter((e) => !e.a?.path && !e.a?.tts_error).slice(0, limit);
  let made = 0, failed = 0;
  for (const e of todo) {
    try { await ensureCondoAudio(db, e.condo, { condo_id: e.condo_id }); made++; } catch { failed++; }
  }
  return { made, failed };
}
