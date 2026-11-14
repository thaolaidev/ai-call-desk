"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { STEPS } from "@/lib/script";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DIRECT = 25 * 1024 * 1024;
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

/**
 * อัปโหลดตรงจากเบราว์เซอร์ไป Storage (ไม่ผ่านเซิร์ฟเวอร์เว็บ → ไฟล์ใหญ่ได้ถึง 25 MB, ไม่ติดลิมิต 4.5 MB ของ Vercel)
 * ขั้น 1: ขอลิงก์อัปโหลด · ขั้น 2: เบราว์เซอร์ PUT ไฟล์ · ขั้น 3: finishStepUpload บันทึกลงตาราง
 */
export async function prepareStepUpload(step: string, fileName: string, size: number): Promise<{ error?: string; path?: string; url?: string }> {
  if (!STEPS[step]) return { error: "ไม่พบท่อนนี้" };
  if (!size) return { error: "ไฟล์ว่าง" };
  if (size > MAX_DIRECT) return { error: "ไฟล์ใหญ่เกิน 25 MB · แนะนำส่งออกจาก Botnoi เป็น mp3" };
  if (!/\.(mp3|wav|m4a|ogg|aac|flac)$/i.test(fileName)) return { error: "รองรับเฉพาะไฟล์เสียง mp3 / wav / m4a / ogg" };
  const sb = await createClient();
  const { data: team } = await sb.from("settings").select("id").eq("id", 1).maybeSingle();
  if (!team) return { error: "ไม่มีสิทธิ์ (อีเมลไม่อยู่ในทีม)" };
  const ext = (fileName.match(/\.(\w+)$/)?.[1] ?? "mp3").toLowerCase();
  const path = `new/${step}-${Date.now()}.${ext}`;
  const { data, error } = await createAdminClient().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { error: `ขอลิงก์อัปโหลดไม่ได้: ${error?.message ?? "-"}` };
  return { path, url: data.signedUrl };
}

export async function finishStepUpload(step: string, path: string, fileName: string, size: number): Promise<string> {
  if (!STEPS[step] || !path.startsWith(`new/${step}-`)) return "ข้อมูลไม่ถูกต้อง";
  const sb = await createClient();
  const { data: auth } = await sb.auth.getUser();
  const { data: old, error: tblErr } = await sb.from("script_audio").select("path").eq("step_key", step).maybeSingle();
  if (tblErr) return "ยังไม่ได้รัน update_0008-0013.sql ใน Supabase";
  const { error } = await sb.from("script_audio").upsert({
    step_key: step, path, file_name: fileName, size_bytes: size, uploaded_at: new Date().toISOString(), uploaded_by: auth.user?.email ?? null,
  });
  if (error) return `บันทึกไม่สำเร็จ: ${error.message}`;
  if (old?.path && old.path !== path) await createAdminClient().storage.from(BUCKET).remove([old.path]);
  revalidatePath("/script");
  return "อัปโหลดแล้ว";
}
