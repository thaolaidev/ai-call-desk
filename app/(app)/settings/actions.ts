"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function updateSettings(formData: FormData) {
  const supabase = await createClient();
  const p = String(formData.get("provider"));
  const provider = p === "vapi" || p === "yalecom" || p === "sip" ? p : "simulate";
  const { error } = await supabase
    .from("settings")
    .update({
      provider,
      company: String(formData.get("company") || "เท่าไหร่ดอทคอม"),
      default_nationalities: String(formData.get("default_nationalities") || ""),
      viewing_when: String(formData.get("viewing_when") || "วันนี้"),
      vapi_assistant_id: String(formData.get("vapi_assistant_id") || "") || null,
      vapi_phone_number_id: String(formData.get("vapi_phone_number_id") || "") || null,
      yalecom_caller_id: String(formData.get("yalecom_caller_id") || "").replace(/[^\d]/g, "") || null,
      yalecom_transfer_to: String(formData.get("yalecom_transfer_to") || "").trim() || null,
    })
    .eq("id", 1);
  for (const seg of ["new", "old"]) {
    const v = (k: string) => String(formData.get(`${k}_${seg}`) || "").trim();
    if (!v("audio_intro")) continue;
    await supabase
      .from("call_rooms")
      .update({ audio_intro: v("audio_intro"), audio_question: v("audio_question"), audio_generic_intro: v("audio_generic_intro") })
      .eq("segment", seg);
  }
  revalidatePath("/settings");
  if (error) {
    const hint = /provider_check/.test(error.message) ? " · ฐานข้อมูลยังไม่รู้จักระบบโทรนี้ ให้รัน update_0008-0013.sql ใน Supabase ก่อน" : "";
    redirect(`/settings?err=${encodeURIComponent(`บันทึกไม่สำเร็จ: ${error.message}${hint}`)}`);
  }
}

/** บันทึกคำอ่านชื่อคอนโด + สถานะว่าอัปโหลดไฟล์เสียงเข้า Yalecom แล้วหรือยัง */
export async function saveCondoAudio(formData: FormData) {
  const supabase = await createClient();
  const condo = String(formData.get("condo") || "");
  if (!condo) return;
  await supabase.from("condo_audio").upsert({
    condo,
    tts_text: String(formData.get("tts_text") || "").trim() || null,
    file_name: String(formData.get("file_name") || ""),
    ready: formData.get("ready") === "on",
    updated_at: new Date().toISOString(),
  });
  revalidatePath("/settings");
}

export async function testCall(_: string | null, formData: FormData): Promise<string> {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return "กรุณาเข้าสู่ระบบ";
  const { startTestCall } = await import("@/lib/testcall");
  try {
    const rent = Number(String(formData.get("rent") || "").replace(/[^\d]/g, "")) || null;
    const r = await startTestCall(String(formData.get("phone") || ""), String(formData.get("condo") || ""), formData.get("segment") === "new" ? "new" : "old", rent);
    const name = { yalecom: "Yalecom", vapi: "Vapi", sip: "Server เสียง (SIP)" }[r.provider as string] ?? "โหมดจำลอง";
    return `สั่งโทรแล้ว (${name}) · ${r.notes.join(" · ")} · รอสายจบแล้วดูผลที่หน้า "ผลการโทร"`;
  } catch (e) {
    return `โทรไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** ให้ Botnoi อ่านชื่อคอนโดใหม่ (ใช้คำอ่านในช่อง) แล้วเก็บไฟล์ไว้ใช้ซ้ำ */
export async function genCondoAudio(formData: FormData) {
  const condo = String(formData.get("condo") || "");
  if (!condo) return;
  const supabase = await createClient();
  const { data: team } = await supabase.from("settings").select("id").eq("id", 1).maybeSingle();
  if (!team) return;
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { ensureCondoAudio } = await import("@/lib/botnoi");
  await ensureCondoAudio(createAdminClient(), condo, { text: String(formData.get("tts_text") || "").trim() || null, force: true }).catch(() => null);
  revalidatePath("/settings");
}

/** ทดสอบ Botnoi: อ่านข้อความแล้วคืนลิงก์ไฟล์ให้กดฟัง (ไม่บันทึกลงคลัง) */
export async function testBotnoi(_: { url?: string; error?: string } | null, formData: FormData): Promise<{ url?: string; error?: string }> {
  const supabase = await createClient();
  const { data: team } = await supabase.from("settings").select("id").eq("id", 1).maybeSingle();
  if (!team) return { error: "ไม่มีสิทธิ์" };
  const text = String(formData.get("text") || "").trim().slice(0, 200);
  if (!text) return { error: "ใส่ข้อความที่จะให้อ่าน" };
  const { botnoiReady, botnoiTts } = await import("@/lib/botnoi");
  if (!botnoiReady()) return { error: "ยังไม่ได้ตั้ง BOTNOI_TOKEN ใน Vercel" };
  try {
    const mp3 = await botnoiTts(text);
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    const path = `test/botnoi-${Date.now()}.mp3`;
    const { error } = await admin.storage.from("script-audio").upload(path, mp3, { contentType: "audio/mpeg" });
    if (error) return { error: `เก็บไฟล์ไม่สำเร็จ: ${error.message}` };
    return { url: admin.storage.from("script-audio").getPublicUrl(path).data.publicUrl };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
