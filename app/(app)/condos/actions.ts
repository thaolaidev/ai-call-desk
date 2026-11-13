"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureCondoAudio, fillMissingCondoAudio } from "@/lib/botnoi";
import { condoFileName } from "@/lib/yalecom";

const MAX_BYTES = 4 * 1024 * 1024;

async function team() {
  const sb = await createClient();
  const { data } = await sb.from("settings").select("id").eq("id", 1).maybeSingle();
  return data ? sb : null;
}

/** บันทึกคำอ่าน + ติ๊ก "อยู่ใน Yalecom แล้ว" */
export async function saveCondo(formData: FormData) {
  const sb = await team();
  const condo = String(formData.get("condo") || "");
  if (!sb || !condo) return;
  const condo_id = String(formData.get("condo_id") || "") || null;
  const { data: row } = await sb.from("condo_audio").select("file_name, condo_id").eq("condo", condo).maybeSingle();
  await sb.from("condo_audio").upsert({
    condo,
    ...(condo_id && !row?.condo_id ? { condo_id } : {}),
    tts_text: String(formData.get("tts_text") || "").trim() || null,
    file_name: row?.file_name ?? condoFileName(condo),
    ready: formData.get("ready") === "on",
    updated_at: new Date().toISOString(),
  });
  revalidatePath("/condos");
}

/** ให้ Botnoi อ่านใหม่ด้วยคำอ่านในช่อง */
export async function regenCondo(formData: FormData) {
  const sb = await team();
  const condo = String(formData.get("condo") || "");
  if (!sb || !condo) return;
  await ensureCondoAudio(createAdminClient(), condo, { text: String(formData.get("tts_text") || "").trim() || null, force: true, condo_id: String(formData.get("condo_id") || "") || null }).catch(() => null);
  revalidatePath("/condos");
}

/** ปุ่ม "สร้างเสียงที่ยังขาด" */
export async function fillMissing() {
  let msg: string;
  if (!(await team())) msg = "ไม่มีสิทธิ์";
  else {
    const r = await fillMissingCondoAudio(createAdminClient(), 10);
    msg = `สร้างแล้ว ${r.made} โครงการ${r.failed ? ` · ไม่สำเร็จ ${r.failed}` : ""}`;
  }
  revalidatePath("/condos");
  redirect(`/condos?msg=${encodeURIComponent(msg)}`);
}

/** อัปโหลดไฟล์เสียงชื่อคอนโดเอง (ทับของ Botnoi) */
export async function uploadCondoFile(_: string | null, formData: FormData): Promise<string> {
  const sb = await team();
  if (!sb) return "ไม่มีสิทธิ์";
  const condo = String(formData.get("condo") || "");
  const file = formData.get("file");
  if (!condo) return "ไม่พบคอนโด";
  if (!(file instanceof File) || !file.size) return "กรุณาเลือกไฟล์เสียง";
  if (file.size > MAX_BYTES) return "ไฟล์ใหญ่เกิน 4 MB";
  if (!/^audio\//.test(file.type) && !/\.(mp3|wav|m4a|ogg)$/i.test(file.name)) return "รองรับเฉพาะไฟล์เสียง";

  const condo_id = String(formData.get("condo_id") || "") || null;
  const { data: row } = await sb.from("condo_audio").select("*").eq("condo", condo).maybeSingle();
  const file_name = row?.file_name ?? (condo_id ? `tl_condo_${condo_id.replace(/[^\w-]/g, "")}` : condoFileName(condo));
  const ext = (file.name.match(/\.(\w+)$/)?.[1] ?? "mp3").toLowerCase();
  const path = `condo/${file_name}.${ext}`;
  const admin = createAdminClient();
  const { error: upErr } = await admin.storage.from("script-audio").upload(path, file, { contentType: file.type || "audio/mpeg", upsert: true });
  if (upErr) return `อัปโหลดไม่สำเร็จ: ${upErr.message}`;
  if (row?.path && row.path !== path) await admin.storage.from("script-audio").remove([row.path]);
  const now = new Date().toISOString();
  const { error } = await sb.from("condo_audio").upsert({
    condo, ...(condo_id && !row?.condo_id ? { condo_id } : {}), file_name, path, audio_source: "upload", tts_text: row?.tts_text ?? null, tts_error: null, generated_at: now, updated_at: now, ready: row?.ready ?? false,
  });
  if (error) return `บันทึกไม่สำเร็จ: ${error.message}`;
  revalidatePath("/condos");
  return "อัปโหลดแล้ว";
}

export type SheetRow = { condo_id: string; condo_name: string; tts_text: string };

/**
 * นำเข้าชีท (condo_id, ชื่อคอนโด, คำอ่าน)
 * - เจอ condo_id หรือชื่อเดิม → อัปเดตคำอ่าน (ถ้าคำอ่านเปลี่ยนและเสียงมาจาก Botnoi → ล้างเสียงให้ระบบอ่านใหม่)
 * - ไม่เจอ → เพิ่มเข้าคลัง
 */
export async function importCondoSheet(rows: SheetRow[]): Promise<string> {
  const sb = await team();
  if (!sb) return "ไม่มีสิทธิ์";
  const { data: existing, error } = await sb.from("condo_audio").select("condo, condo_id, tts_text, audio_source, path");
  if (error) return `อ่านคลังไม่ได้: ${error.message} (รัน update_0010_condo_id.sql แล้วหรือยัง)`;
  const byId = new Map((existing ?? []).filter((r: any) => r.condo_id).map((r: any) => [String(r.condo_id), r]));
  const byName = new Map((existing ?? []).map((r: any) => [r.condo, r]));
  let added = 0, updated = 0, redo = 0, failed = 0;
  const now = new Date().toISOString();
  for (const x of rows.slice(0, 5000)) {
    const id = x.condo_id.trim() || null;
    const name = x.condo_name.trim();
    const text = x.tts_text.trim() || null;
    if (!id && !name) continue;
    const cur: any = (id && byId.get(id)) || (name && byName.get(name)) || null;
    if (cur) {
      const changed = (text ?? "") !== (cur.tts_text ?? "");
      const patch: Record<string, unknown> = { updated_at: now };
      if (text) patch.tts_text = text;
      if (id && !cur.condo_id) patch.condo_id = id;
      if (changed && text && cur.audio_source !== "upload") { Object.assign(patch, { path: null, tts_error: null }); if (cur.path) redo++; }
      const { error: e } = await sb.from("condo_audio").update(patch).eq("condo", cur.condo);
      e ? failed++ : updated++;
    } else {
      const condo = name || `โครงการ #${id}`;
      const { error: e } = await sb.from("condo_audio").insert({
        condo, condo_id: id, tts_text: text, file_name: id ? `tl_condo_${id.replace(/[^\w-]/g, "")}` : condoFileName(condo), ready: false, updated_at: now,
      });
      e ? failed++ : added++;
    }
  }
  revalidatePath("/condos");
  return `เพิ่ม ${added} · อัปเดต ${updated}${redo ? ` (คำอ่านเปลี่ยน ${redo} โครงการ จะอ่านใหม่)` : ""}${failed ? ` · ไม่สำเร็จ ${failed}` : ""}`;
}
