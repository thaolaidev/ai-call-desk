import type { SupabaseClient } from "@supabase/supabase-js";
import { botnoiReady, botnoiTts } from "./botnoi";
import { thaiNumber } from "./thainum";

const BUCKET = "script-audio";
export const priceFile = (price: number) => `tl_price_${Math.round(price)}`;

/** ราคาทั้งหมดในกองลีด (ไม่ซ้ำ) พร้อมจำนวนลีด */
export async function leadPrices(db: SupabaseClient) {
  const m = new Map<number, number>();
  for (let from = 0; from < 50_000; from += 1000) {
    const { data } = await db.from("leads").select("rent").not("rent", "is", null).order("id").range(from, from + 999);
    for (const r of data ?? []) { const p = Math.round(Number(r.rent)); if (p > 0) m.set(p, (m.get(p) ?? 0) + 1); }
    if ((data?.length ?? 0) < 1000) break;
  }
  return m;
}

/** ให้ราคานี้มีไฟล์เสียง: มีแล้วใช้ของเดิม · force = อ่านใหม่ */
export async function ensurePriceAudio(db: SupabaseClient, price: number, opts: { text?: string | null; force?: boolean } = {}) {
  const p = Math.round(price);
  const { data: row } = await db.from("price_audio").select("*").eq("price", p).maybeSingle();
  if (row?.path && !opts.force) return { reused: true, path: row.path as string };
  if (!botnoiReady()) throw new Error("ยังไม่ได้ตั้ง BOTNOI_TOKEN");
  const text = ((opts.text ?? row?.tts_text ?? "").trim() || thaiNumber(p)).slice(0, 200);
  try {
    const mp3 = await botnoiTts(text);
    const path = `price/${priceFile(p)}.mp3`;
    const { error } = await db.storage.from(BUCKET).upload(path, mp3, { contentType: "audio/mpeg", upsert: true });
    if (error) throw new Error(`เก็บไฟล์ไม่สำเร็จ: ${error.message}`);
    const now = new Date().toISOString();
    await db.from("price_audio").upsert({ price: p, tts_text: text, path, audio_source: "botnoi", tts_error: null, generated_at: now, updated_at: now });
    return { reused: false, path };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("price_audio").upsert({ price: p, tts_text: text, tts_error: msg.slice(0, 300), updated_at: new Date().toISOString() });
    throw e;
  }
}

/** อ่านเฉพาะราคาที่มีในลีดและยังไม่มีเสียง ครั้งละไม่เกิน limit */
export async function fillMissingPriceAudio(db: SupabaseClient, limit = 10) {
  if (!botnoiReady()) return { made: 0, failed: 0 };
  const prices = [...(await leadPrices(db)).keys()];
  const done = new Set<number>();
  for (let i = 0; i < prices.length; i += 300) {
    const { data } = await db.from("price_audio").select("price, path, tts_error").in("price", prices.slice(i, i + 300));
    for (const r of data ?? []) if (r.path || r.tts_error) done.add(Number(r.price));
  }
  let made = 0, failed = 0;
  for (const p of prices.filter((x) => !done.has(x)).slice(0, limit)) {
    try { await ensurePriceAudio(db, p); made++; } catch { failed++; }
  }
  return { made, failed };
}

/** ตอนโทร: หาเสียงราคาของลีด */
export async function findPriceAudio(db: SupabaseClient, rent: number | null | undefined) {
  if (!rent || rent <= 0) return null;
  const { data } = await db.from("price_audio").select("*").eq("price", Math.round(rent)).maybeSingle();
  return data?.path ? data : null;
}
