import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizePhone } from "@/lib/phone";
import { condoFileName } from "@/lib/yalecom";
import { findCondoAudio } from "@/lib/condolib";

export const dynamic = "force-dynamic";

/**
 * Yalecom ถามว่าสายนี้ต้องเล่นไฟล์อะไร (Sequential audio playback)
 * body: { caller_id_number, action, secret_key, ref_1? }
 * ตอบ: { playback_list: ["tl_intro", "tl_condo_xxxxxxxx", "tl_question"] }
 * ถ้ายังไม่มีไฟล์เสียงของคอนโดนั้น → ใช้ไฟล์เปิดสายแบบไม่มีชื่อคอนโด
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  let body: Record<string, any> = {};
  try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); }

  const secret = process.env.YALECOM_PLAYBACK_SECRET;
  if (secret && String(body.secret_key ?? "") !== secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = createAdminClient();
  // หาว่าเป็นสายของห้องไหน: ref_1 ก่อน แล้วค่อยใช้เบอร์ที่กำลังโทรอยู่
  let condo: string | null = null;
  let condoId: string | null = null;
  let segment = "old";
  if (body.ref_1) {
    const { data } = await db.from("calls").select("segment, leads!calls_lead_id_fkey(*)").eq("id", String(body.ref_1)).maybeSingle();
    const l: any = data && (Array.isArray(data.leads) ? data.leads[0] : data.leads);
    condo = l?.condo ?? null;
    condoId = l?.condo_id ?? null;
    segment = data?.segment ?? l?.segment ?? segment;
  }
  if (!condo) {
    const numbers = [body.caller_id_number, body.destination_number, body.caller_destination]
      .filter(Boolean).map((n: string) => normalizePhone(String(n)));
    if (numbers.length) {
      const { data } = await db.from("leads").select("*").eq("status", "calling").in("phone", numbers).limit(1);
      condo = data?.[0]?.condo ?? null;
      condoId = data?.[0]?.condo_id ?? null;
      segment = data?.[0]?.segment ?? segment;
    }
  }

  // ไฟล์เสียงของห้องนั้น
  const { data: s } = await db.from("call_rooms").select("audio_intro, audio_question, audio_generic_intro").eq("segment", segment).maybeSingle();
  const generic = [s?.audio_generic_intro ?? "tl_intro_generic", s?.audio_question ?? "tl_question"];
  if (!condo) return NextResponse.json({ playback_list: generic });

  // ค้นเสียงชื่อคอนโดจากคลัง: มีไฟล์ในคลังแล้ว และติ๊กว่าอยู่ใน Yalecom แล้ว → เล่นชื่อคอนโด
  const audio: any = await findCondoAudio(db, { condo, condo_id: condoId });
  if (!audio?.ready) return NextResponse.json({ playback_list: generic, condo_audio_url: null });
  const url = audio.path ? db.storage.from("script-audio").getPublicUrl(audio.path).data.publicUrl : null;
  return NextResponse.json({
    playback_list: [s?.audio_intro ?? "tl_intro", audio.file_name ?? condoFileName(condo), s?.audio_question ?? "tl_question"],
    condo_audio_url: url, // เผื่อ Yalecom เล่นไฟล์จากลิงก์ได้
  });
}
