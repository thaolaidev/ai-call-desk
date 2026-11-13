"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { STEPS } from "@/lib/script";

const MAX_BYTES = 4 * 1024 * 1024;
const BUCKET = "script-audio";

export async function uploadStepAudio(_: string | null, formData: FormData): Promise<string> {
  const key = String(formData.get("step") || "");
  const file = formData.get("file");
  if (!STEPS[key]) return "ไม่พบท่อนนี้";
  if (!(file instanceof File) || !file.size) return "กรุณาเลือกไฟล์เสียง";
  if (file.size > MAX_BYTES) return "ไฟล์ใหญ่เกิน 4 MB";
  if (!/^audio\//.test(file.type) && !/\.(mp3|wav|m4a|ogg)$/i.test(file.name)) return "รองรับเฉพาะไฟล์เสียง mp3 / wav / m4a / ogg";

  const sb = await createClient();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return "กรุณาเข้าสู่ระบบ";
  const { data: team } = await sb.from("settings").select("id").eq("id", 1).maybeSingle();
  if (!team) return "ไม่มีสิทธิ์ (อีเมลไม่อยู่ในทีม)";
  const { data: old, error: tblErr } = await sb.from("script_audio").select("path").eq("step_key", key).maybeSingle();
  if (tblErr) return "ยังไม่ได้รัน update_0008_script_audio.sql ใน Supabase";

  const ext = (file.name.match(/\.(\w+)$/)?.[1] ?? "mp3").toLowerCase();
  const path = `new/${key}-${Date.now()}.${ext}`;
  const admin = createAdminClient();
  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, file, { contentType: file.type || "audio/mpeg", upsert: false });
  if (upErr) return `อัปโหลดไม่สำเร็จ: ${upErr.message}`;

  const { error } = await sb.from("script_audio").upsert({
    step_key: key, path, file_name: file.name, size_bytes: file.size, uploaded_at: new Date().toISOString(), uploaded_by: auth.user.email ?? null,
  });
  if (error) {
    await admin.storage.from(BUCKET).remove([path]);
    return `บันทึกไม่สำเร็จ: ${error.message}`;
  }
  if (old?.path) await admin.storage.from(BUCKET).remove([old.path]);
  revalidatePath("/script");
  return "อัปโหลดแล้ว";
}

export async function deleteStepAudio(formData: FormData) {
  const key = String(formData.get("step") || "");
  const sb = await createClient();
  const { data: row } = await sb.from("script_audio").select("path").eq("step_key", key).maybeSingle();
  if (!row) return;
  const { error } = await sb.from("script_audio").delete().eq("step_key", key);
  if (!error) await createAdminClient().storage.from(BUCKET).remove([row.path]);
  revalidatePath("/script");
}

/** บันทึกลำดับที่เล่นในสาย: เล่นท่อนไหน + รอให้ตอบกี่วินาที */
export async function savePlaylist(formData: FormData) {
  const sb = await createClient();
  const now = new Date().toISOString();
  const rows = Object.keys(STEPS).map((k) => ({
    step_key: k,
    enabled: formData.get(`on_${k}`) === "on",
    wait_after: Math.min(15, Math.max(0, Math.round(Number(formData.get(`wait_${k}`)) || 0))),
    updated_at: now,
  }));
  await sb.from("script_playlist").upsert(rows);
  revalidatePath("/script");
}
