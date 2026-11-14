"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensurePriceAudio, fillMissingPriceAudio, priceFile } from "@/lib/priceaudio";

const MAX_BYTES = 4 * 1024 * 1024;

async function team() {
  const sb = await createClient();
  const { data } = await sb.from("settings").select("id").eq("id", 1).maybeSingle();
  return data ? sb : null;
}

export async function savePrice(formData: FormData) {
  const sb = await team();
  const price = Math.round(Number(formData.get("price")));
  if (!sb || !(price > 0)) return;
  await sb.from("price_audio").upsert({ price, tts_text: String(formData.get("tts_text") || "").trim() || null, updated_at: new Date().toISOString() });
  revalidatePath("/prices");
}

export async function regenPrice(formData: FormData) {
  const sb = await team();
  const price = Math.round(Number(formData.get("price")));
  if (!sb || !(price > 0)) return;
  await ensurePriceAudio(createAdminClient(), price, { text: String(formData.get("tts_text") || "").trim() || null, force: true }).catch(() => null);
  revalidatePath("/prices");
}

export async function fillMissingPrices() {
  let msg: string;
  if (!(await team())) msg = "ไม่มีสิทธิ์";
  else {
    const r = await fillMissingPriceAudio(createAdminClient(), 15);
    msg = `สร้างเสียงราคาแล้ว ${r.made} ราคา${r.failed ? ` · ไม่สำเร็จ ${r.failed}` : ""}`;
  }
  revalidatePath("/prices");
  redirect(`/prices?msg=${encodeURIComponent(msg)}`);
}

export async function uploadPriceFile(_: string | null, formData: FormData): Promise<string> {
  const sb = await team();
  if (!sb) return "ไม่มีสิทธิ์";
  const price = Math.round(Number(formData.get("price")));
  const file = formData.get("file");
  if (!(price > 0)) return "ราคาไม่ถูกต้อง";
  if (!(file instanceof File) || !file.size) return "กรุณาเลือกไฟล์เสียง";
  if (file.size > MAX_BYTES) return "ไฟล์ใหญ่เกิน 4 MB";
  const ext = (file.name.match(/\.(\w+)$/)?.[1] ?? "mp3").toLowerCase();
  const path = `price/${priceFile(price)}.${ext}`;
  const { error: upErr } = await createAdminClient().storage.from("script-audio").upload(path, file, { contentType: file.type || "audio/mpeg", upsert: true });
  if (upErr) return `อัปโหลดไม่สำเร็จ: ${upErr.message}`;
  const now = new Date().toISOString();
  const { error } = await sb.from("price_audio").upsert({ price, path, audio_source: "upload", tts_error: null, generated_at: now, updated_at: now });
  if (error) return `บันทึกไม่สำเร็จ: ${error.message}`;
  revalidatePath("/prices");
  return "อัปโหลดแล้ว";
}

/** นำเข้ารายการราคา (ตัดซ้ำแล้ว) เข้าคลัง — ยังไม่สร้างเสียง */
export async function importPrices(prices: number[]): Promise<{ added: number; error?: string }> {
  const sb = await team();
  if (!sb) return { added: 0, error: "ไม่มีสิทธิ์" };
  const uniq = [...new Set(prices.map((p) => Math.round(Number(p))).filter((p) => p > 0))].slice(0, 5000);
  let added = 0;
  for (let i = 0; i < uniq.length; i += 1000) {
    const { data, error } = await sb.from("price_audio").upsert(uniq.slice(i, i + 1000).map((price) => ({ price })), { onConflict: "price", ignoreDuplicates: true }).select("price");
    if (error) return { added, error: error.message.includes("price_audio") ? "ยังไม่ได้รัน update_0014_price_audio.sql" : error.message };
    added += data?.length ?? 0;
  }
  revalidatePath("/prices");
  return { added };
}
