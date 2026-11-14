import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyCallResult } from "@/lib/outcome";
import { analyzeAnswer } from "@/lib/stt";
import type { Outcome } from "@/lib/status";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const OUTCOMES: Outcome[] = ["avail", "avail_ok", "avail_profile", "avail_no", "not_avail", "callback", "dnc", "wrong_number", "noanswer", "unclear", "invalid"];

/**
 * ผลจาก server เสียง (voice-server) หลังจบสาย
 * multipart: json = { call_id, status, duration_sec, answers[], live{} } · recording = mp3 ทั้งสาย (ถ้ามี)
 */
export async function POST(req: NextRequest) {
  if (!process.env.VOICE_SECRET || req.headers.get("x-voice-secret") !== process.env.VOICE_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const form = await req.formData().catch(() => null);
  let r: any = null;
  try { r = JSON.parse(String(form?.get("json") ?? "")); } catch {}
  if (!r?.call_id) return NextResponse.json({ error: "ไม่มี call_id" }, { status: 400 });

  const db = createAdminClient();
  const { data: call } = await db.from("calls").select("id, state").eq("id", r.call_id).maybeSingle();
  if (!call) return NextResponse.json({ ok: true, note: "ไม่พบสายนี้" });
  if (call.state === "ended") return NextResponse.json({ ok: true, note: "ประมวลผลไปแล้ว" });

  if (r.status !== "answered") {
    await applyCallResult(db, {
      callId: call.id,
      outcome: r.status === "invalid" ? "invalid" : "noanswer",
      endedReason: `sip:${r.status} cause ${r.cause ?? "-"}`,
      transcript: [{ role: "system", text: r.status === "invalid" ? "เบอร์ไม่ถูกต้อง/ติดต่อไม่ได้" : "ไม่รับสาย" }],
    });
    return NextResponse.json({ ok: true });
  }

  // เก็บไฟล์เสียงทั้งสาย + ให้ AI สรุปละเอียดอีกรอบ (คำตอบรายข้อจากระหว่างสายใช้เป็นหลัก)
  const file = form?.get("recording");
  let recordingPath: string | null = null;
  let full: Awaited<ReturnType<typeof analyzeAnswer>> | null = null;
  if (file instanceof File && file.size) {
    const buf = await file.arrayBuffer();
    recordingPath = `voice/${call.id}.mp3`;
    const { error } = await db.storage.from("recordings").upload(recordingPath, buf, { contentType: "audio/mpeg", upsert: true });
    if (error) recordingPath = null;
    full = await analyzeAnswer(buf).catch(() => null);
  }

  const live = (r.live ?? {}) as Record<string, any>;
  const liveOutcome = OUTCOMES.includes(live.outcome) ? (live.outcome as Outcome) : "unclear";
  const outcome: Outcome = liveOutcome !== "unclear" ? liveOutcome : full?.outcome ?? "unclear";
  const answers: any[] = Array.isArray(r.answers) ? r.answers : [];
  const pick = (k: string) => live[k] ?? (full?.details as any)?.[k] ?? null;

  await applyCallResult(db, {
    callId: call.id,
    outcome,
    durationSec: Number(r.duration_sec) || null,
    summary: full?.summary || answers.map((a) => a.text).filter(Boolean).join(" · ") || null,
    endedReason: "answered (sip)",
    analysis: {
      call_outcome: outcome,
      room_available: outcome.startsWith("avail") ? true : outcome === "not_avail" ? false : null,
      ready_now: pick("ready_now"),
      available_from: pick("available_from"),
      price_confirmed: pick("price_confirmed"),
      owner_price: pick("owner_price"),
      accepts_foreigners: pick("accepts_foreigners"),
      current_lease_until: full?.current_lease_until ?? null,
      summary_th: full?.summary ?? null,
      answer_text: answers.map((a) => a.text).filter(Boolean).join(" / "),
      transcript_full: full?.transcript ?? null,
    },
    transcript: answers.flatMap((a) => [
      { role: "system" as const, text: a.question ?? a.step },
      { role: "owner" as const, text: a.text || "(ไม่ได้ยินคำตอบ)" },
    ]),
  });
  if (recordingPath) await db.from("calls").update({ recording_path: recordingPath }).eq("id", call.id);
  return NextResponse.json({ ok: true, outcome });
}
