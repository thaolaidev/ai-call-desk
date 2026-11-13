import type { SupabaseClient } from "@supabase/supabase-js";
import { applyCallResult } from "./outcome";
import { analyzeAnswer } from "./stt";
import { downloadRecording, findCdrByRef, mapCallResult, yalecomTime, type Cdr } from "./yalecom";

const IN_FLIGHT = ["dialing", "ringing", "in_progress"];
const RECORDING_WAIT_MIN = 10; // รอไฟล์บันทึกเสียงได้นานสุดกี่นาทีหลังจบสาย

/**
 * ประมวลผลสาย Yalecom ที่จบแล้ว 1 สาย (เรียกจาก callback หรือจากการตรวจ CDR ใน tick)
 * รับสาย → ดึงไฟล์เสียง → เก็บใน Storage → ถอดเสียง → จัดผล → อัปเดตลีด → ยิงกลับ VPS
 */
export async function processYalecomCall(db: SupabaseClient, callId: string, cdr: Cdr) {
  // จองสายนี้ไว้ กัน callback กับ tick ประมวลผลซ้อนกัน
  const { data: claimed } = await db
    .from("calls")
    .update({ ended_reason: "processing" })
    .eq("id", callId)
    .in("state", IN_FLIGHT)
    .or("ended_reason.is.null,ended_reason.eq.waiting_recording")
    .select("id, started_at")
    .maybeSingle();
  if (!claimed) return "skipped";

  const result = mapCallResult(cdr.call_result);
  const rawDur = cdr.call_duration ?? cdr.duration;
  const duration = rawDur == null || rawDur === "" || Number.isNaN(Number(rawDur)) ? null : Number(rawDur);

  if (result !== "answered") {
    await applyCallResult(db, {
      callId,
      outcome: result === "failed" ? "invalid" : "noanswer",
      durationSec: duration,
      summary: result === "failed" ? "โทรไม่ติด (เบอร์ปิดหรือไม่มีในระบบ)" : "ไม่รับสาย",
      endedReason: String(cdr.call_result ?? ""),
      transcript: [{ role: "system", text: `Yalecom: ${cdr.call_result ?? "ไม่ทราบผล"}` }],
    });
    return "done";
  }

  // รับสายแต่ไม่มีเสียงสนทนาเลย (เช่น โอนสายไม่สำเร็จ) → ไม่ต้องรอไฟล์เสียง
  if (duration === 0) {
    await applyCallResult(db, {
      callId,
      outcome: "unclear",
      durationSec: 0,
      summary: `รับสายแต่ไม่มีเสียงสนทนา (โอนไป ${cdr.destination_number ?? "-"} ไม่สำเร็จ หรือวางสายทันที)`,
      endedReason: "answered_no_talk",
      transcript: [{ role: "system", text: "Yalecom: Answered แต่ duration = 0 วินาที ไม่มีไฟล์เสียง" }],
    });
    return "done";
  }

  const audio = await downloadRecording(cdr.xml_cdr_uuid);
  if (!audio) {
    const endedMs = yalecomTime(cdr.end_stamp) || Date.now();
    if (Date.now() - endedMs < RECORDING_WAIT_MIN * 60_000) {
      await db.from("calls").update({ ended_reason: "waiting_recording" }).eq("id", callId);
      return "waiting";
    }
  }

  let recordingPath: string | null = null;
  if (audio) {
    const path = `${callId}.mp3`;
    const { error } = await db.storage.from("recordings").upload(path, audio, { contentType: "audio/mpeg", upsert: true });
    if (!error) recordingPath = path;
  }

  const c = await analyzeAnswer(audio);
  const full = c.transcript;
  const sttError = c.error;
  await applyCallResult(db, {
    callId,
    outcome: c.outcome,
    durationSec: duration,
    summary: c.summary || null,
    endedReason: sttError ? `answered (STT error: ${sttError})` : "answered",
    analysis: {
      call_outcome: c.outcome,
      room_available: c.outcome === "avail" ? true : c.outcome === "not_avail" ? false : null,
      current_lease_until: c.current_lease_until,
      summary_th: c.summary,
      answer_text: c.answer_text,
      transcript_full: full,
      xml_cdr_uuid: cdr.xml_cdr_uuid,
    },
    transcript: [
      { role: "system", text: "เล่นเสียงอัด: ถามว่าห้องยังว่างไหม" },
      ...(c.answer_text ? [{ role: "owner" as const, text: c.answer_text }] : [{ role: "system" as const, text: audio ? "ไม่ได้ยินคำตอบ" : "ไม่มีไฟล์บันทึกเสียง" }]),
    ],
  });
  if (recordingPath) await db.from("calls").update({ recording_path: recordingPath }).eq("id", callId);
  return "done";
}

/** ทางสำรอง: ถาม CDR ของ Yalecom ว่าสายที่ค้างจบหรือยัง (กรณี callback ไม่มา) */
export async function pollYalecom(db: SupabaseClient, limit = 5) {
  if (!process.env.YALECOM_COMPANY_ID || !process.env.YALECOM_KEY) return 0;
  const { data } = await db
    .from("calls")
    .select("id")
    .eq("provider", "yalecom")
    .in("state", IN_FLIGHT)
    .lt("started_at", new Date(Date.now() - 60_000).toISOString())
    .order("started_at")
    .limit(limit);
  let n = 0;
  for (const c of data ?? []) {
    const cdr = await findCdrByRef(c.id).catch(() => null);
    if (cdr?.end_stamp || cdr?.call_result) { await processYalecomCall(db, c.id, cdr); n++; }
  }
  return n;
}
