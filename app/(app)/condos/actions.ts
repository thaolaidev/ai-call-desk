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
 * นำเข้าชีทคลังคอนโด ทีละก้อน (เบราว์เซอร์ส่งมาครั้งละ ~1,000 แถว)
 * - มี condo_id นี้อยู่แล้ว → อัปเดตคำอ่าน (ถ้าชีทมีคำอ่าน และคำอ่านเปลี่ยน → ล้างเสียง Botnoi ให้อ่านใหม่)
 * - ยังไม่มี → เพิ่มเข้าคลัง (ชื่อซ้ำกับที่มีอยู่ → ข้าม)
 * ยังไม่สร้างเสียงตอนนำเข้า: ระบบจะอ่านเฉพาะคอนโดที่มีลีดจริงเท่านั้น
 */
export async function importCondoSheet(rows: SheetRow[]): Promise<{ added: number; updated: number; skipped: number; error?: string }> {
  const res = { added: 0, updated: 0, skipped: 0 };
  const sb = await team();
  if (!sb) return { ...res, error: "ไม่มีสิทธิ์" };
  const clean = rows.slice(0, 2000)
    .map((x) => ({ id: String(x.condo_id ?? "").trim() || null, name: String(x.condo_name ?? "").replace(/\s+/g, " ").trim(), text: String(x.tts_text ?? "").trim() || null }))
    .filter((x) => x.name || x.id);
  const ids = clean.map((x) => x.id).filter(Boolean) as string[];
  const existing = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from("condo_audio").select("condo, condo_id, tts_text, audio_source, path").in("condo_id", ids.slice(i, i + 200));
    if (error) return { ...res, error: `อ่านคลังไม่ได้: ${error.message} (รัน update_0010 แล้วหรือยัง)` };
    for (const r of data ?? []) existing.set(String(r.condo_id), r);
  }
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const inserts: Record<string, unknown>[] = [];
  for (const x of clean) {
    const cur = x.id ? existing.get(x.id) : null;
    if (cur) {
      if (x.text && x.text !== cur.tts_text) {
        const patch: Record<string, unknown> = { tts_text: x.text, updated_at: now };
        if (cur.audio_source !== "upload") Object.assign(patch, { path: null, tts_error: null });
        const { error } = await sb.from("condo_audio").update(patch).eq("condo", cur.condo);
        error ? res.skipped++ : res.updated++;
      } else res.skipped++;
      continue;
    }
    const name = x.name || `โครงการ #${x.id}`;
    if (seen.has(name)) { res.skipped++; continue; }
    seen.add(name);
    inserts.push({ condo: name, condo_id: x.id, tts_text: x.text, file_name: x.id ? `tl_condo_${x.id.replace(/[^\w-]/g, "")}` : condoFileName(name), ready: false, updated_at: now });
  }
  for (let i = 0; i < inserts.length; i += 500) {
    const part = inserts.slice(i, i + 500);
    const { data, error } = await sb.from("condo_audio").upsert(part, { onConflict: "condo", ignoreDuplicates: true }).select("condo");
    if (error) {
      // ก้อนนี้มีแถวชนกัน → ใส่ทีละแถว
      for (const r of part) { const { error: e } = await sb.from("condo_audio").insert(r); e ? res.skipped++ : res.added++; }
    } else {
      res.added += data?.length ?? 0;
      res.skipped += part.length - (data?.length ?? 0);
    }
  }
  revalidatePath("/condos");
  return res;
}
