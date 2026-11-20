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
  const { data: call } = await db.from("calls").select("id, state, segment, lead_id").eq("id", r.call_id).maybeSingle();
  if (!call) return NextResponse.json({ ok: true, note: "ไม่พบสายนี้" });
  if (call.state === "ended") return NextResponse.json({ ok: true, note: "ประมวลผลไปแล้ว" });

  if (r.status !== "answered") {
    // สายไม่ได้คุย แยก 3 แบบ (ตามที่ server เสียงอ่านจาก cause):
    //  declined    = ตัดสายตั้งแต่ยังไม่ได้คุย → ยังไม่แน่นอน + โทรซ้ำ · ตัดสายครบ 3 ครั้ง → ไม่ว่าง (ทั้ง 2 ห้อง)
    //  noanswer    = ดังแต่ไม่รับ → ยังไม่แน่นอน + โทรซ้ำ
    //  unreachable = โทรไม่ติดเลย (ปิดเครื่อง/เบอร์ไม่มี/ไม่มีสัญญาณ) → ยังไม่แน่นอน + โทรซ้ำ
    //  error       = server เสียงโทรออกไม่สำเร็จ → นับเป็นไม่รับสาย ลองใหม่ตามรอบ
    const kind = r.status === "invalid" ? "unreachable" : String(r.status ?? "noanswer");
    let declines = 0;
    if (kind === "declined") {
      const { count } = await db.from("calls").select("id", { count: "exact", head: true })
        .eq("lead_id", call.lead_id).neq("id", call.id).like("ended_reason", "sip:declined%");
      declines = (count ?? 0) + 1;
    }
    const declinedOld = kind === "declined" && declines >= 3; // ชื่อเดิม: ตัดสายแล้วปรับเป็นไม่ว่าง
    const TEXT: Record<string, string> = { declined: "เจ้าของตัดสาย", unreachable: "โทรไม่ติด (ปิดเครื่อง/เบอร์ไม่มี/ไม่มีสัญญาณ)", error: "server เสียงโทรออกไม่สำเร็จ", noanswer: "ไม่รับสาย" };
    await applyCallResult(db, {
      callId: call.id,
      outcome: declinedOld ? "not_avail" : "noanswer",
      summary: r.status === "error" ? `โทรออกไม่สำเร็จ: ${String(r.error ?? "").slice(0, 200)}`
        : declinedOld ? `เจ้าของตัดสายครบ ${declines} ครั้ง → ปรับห้องเป็นไม่ว่าง` : kind === "declined" ? `เจ้าของตัดสาย (ครั้งที่ ${declines})` : TEXT[kind] ?? "ไม่รับสาย",
      endedReason: `sip:${kind} ${r.status === "error" ? String(r.error ?? "").slice(0, 120) : `cause ${r.cause ?? "-"}`}`,
      transcript: [{ role: "system", text: TEXT[kind] ?? "ไม่รับสาย" }],
      analysis: { call_kind: kind },
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
  // ผลหลัก: AI ที่ฟังเสียงทั้งสายหลังจบ (รุ่นใหญ่กว่า เห็นบริบทครบ) · ถ้าฟังทั้งสายไม่ได้ ใช้คำตอบที่ฟังระหว่างสาย
  const fullOutcome = full && !full.error ? full.outcome : null;
  const groupOf = (o?: string | null) => (o?.startsWith("avail") ? "avail" : o ?? "");
  const disagree = !!fullOutcome && fullOutcome !== "unclear" && liveOutcome !== "unclear" && groupOf(fullOutcome) !== groupOf(liveOutcome);
  // ตรงกัน → ใช้ผลระหว่างสาย (ละเอียดกว่า เช่น ว่าง · รับต่างชาติ) · ขัดกัน → เชื่อผลฟังทั้งสาย
  let outcome: Outcome = disagree ? (fullOutcome as Outcome) : liveOutcome !== "unclear" ? liveOutcome : fullOutcome ?? "unclear";
  const answers: any[] = Array.isArray(r.answers) ? r.answers : [];
  // ตรวจซ้ำกับข้อความจริง: ผลออกมา "ว่าง" แต่คำตอบเรื่องห้องว่าง หรือสรุปของ AI บอกว่าไม่ว่าง → ใช้ "ไม่ว่าง" และให้ฟังซ้ำ
  const availText = [...answers].reverse().find((a) => a.step === "avail" && a.text)?.text ?? "";
  const NEG_AVAIL = /ไม่ว่าง|ไม่ได้ว่าง|มี(คน|ผู้)(เช่า|อยู่|จอง)|ผู้เช่า(อยู่|แล้ว)|เช่า(ไป)?แล้ว|ขาย(ไป)?แล้ว|ปล่อย(ไป)?แล้ว|ไม่มีห้อง|ติด(ผู้เช่า|สัญญา|จอง)|จองแล้ว/;
  const NEG_SUMMARY = /ห้อง(ยัง)?ไม่ว่าง|ไม่ว่างแล้ว|แจ้งว่าไม่ว่าง|ตอบว่าไม่ว่าง|มี(คน|ผู้)เช่า(แล้ว|อยู่)/;
  const textSaysNo = NEG_AVAIL.test(availText.replace(/\s+/g, "")) || NEG_SUMMARY.test(String(full?.summary ?? "").replace(/\s+/g, ""));
  const textConflict = groupOf(outcome) === "avail" && textSaysNo;
  if (textConflict) outcome = "not_avail";
  // ฟังไม่ชัด แต่คำตอบเรื่องห้องว่างบอกชัดว่ามีผู้เช่าแล้ว/ไม่ว่าง → ไม่ว่าง
  if (outcome === "unclear" && NEG_AVAIL.test(availText.replace(/\s+/g, ""))) outcome = "not_avail";
  // ยังไม่ได้คำตอบเรื่องห้องว่างจริง (เจ้าของวางสาย / ถามกลับ / ไม่ตอบ) แต่ AI ฟังทั้งสายสรุปว่า "ว่าง"
  // → ไม่เชื่อ (อาจเดาจากคำพูดของบอทเอง) ให้เป็น "ไม่ได้คำตอบ" แล้วโทรซ้ำตามรอบ
  const availAnswered = answers.some((a) => a.step === "avail" && (a.intent === "yes" || a.intent === "no"));
  const unconfirmedAvail = groupOf(outcome) === "avail" && liveOutcome === "unclear" && !availAnswered;
  if (unconfirmedAvail) outcome = "unclear";
  // รับสายแล้วเจ้าของวางสายเองก่อนตอบเรื่องห้องว่าง = "ตัดสาย" (เหมือนตัดสายตอนเรียกเข้า)
  //  → ยังไม่แน่นอน + โทรซ้ำ ทั้ง 2 ห้อง (ไม่ใช่ฟังไม่ชัด)
  const ownerHungUp = r.owner_hangup === true && outcome === "unclear" && !availAnswered;
  if (ownerHungUp) outcome = "noanswer"; // รับสายแล้ววางก่อนตอบ → ยังไม่แน่นอน + โทรซ้ำ (ทั้ง 2 ห้อง)
  const pick = (k: string) => live[k] ?? (full?.details as any)?.[k] ?? null;
  // ถ้าระหว่างสายกับหลังจบได้ผลไม่ตรงกัน (เช่น "ยังว่าง" กับ "ไม่ว่าง") → ใช้ผลหลังจบ และติดธงให้แอดมินฟังซ้ำ
  const conflict = disagree || textConflict;
  const liveSummary = answers.filter((a) => a.text).map((a) => `${a.question ?? a.step}: "${a.text}"`).join(" · ");

  await applyCallResult(db, {
    callId: call.id,
    outcome,
    durationSec: Number(r.duration_sec) || null,
    summary: ownerHungUp
      ? "เจ้าของรับสายแล้ววางก่อนตอบเรื่องห้องว่าง"
      : `${unconfirmedAvail ? "⚠️ เจ้าของยังไม่ได้ตอบว่าห้องว่าง · " : conflict ? "⚠️ ควรฟังซ้ำ · " : ""}${full?.summary || (liveSummary ? `เจ้าของตอบ — ${liveSummary}` : "")}` || null,
    endedReason: "answered (sip)",
    analysis: {
      ...(ownerHungUp ? { call_kind: "hangup" } : {}),
      call_outcome: outcome,
      room_available: outcome.startsWith("avail") ? true : outcome === "not_avail" ? false : null,
      ready_now: pick("ready_now"),
      available_from: pick("available_from"),
      price_confirmed: pick("price_confirmed"),
      owner_price: pick("owner_price"),
      accepts_foreigners: pick("accepts_foreigners"),
      owner_agreed_profile: pick("owner_agreed_profile"),
      rules_explained: live.accepted_after_rules || pick("accepts_foreigners") === false ? true : null,
      accepted_after_rules: live.accepted_after_rules ?? null,
      nationality_told: live.nationality_told ?? null,
      pet_friendly: typeof live.pet_friendly === "boolean" ? live.pet_friendly : null,
      pet_note: live.pet_note ?? null,
      foreign_exclude: Array.isArray(live.foreign_exclude) ? live.foreign_exclude.join(", ") : (full?.details as any)?.excluded_nationalities ?? null,
      current_lease_until: full?.current_lease_until ?? null,
      summary_th: full?.summary ?? null,
      live_outcome: liveOutcome,
      needs_review: unconfirmedAvail
        ? `AI ฟังทั้งสายสรุปว่า "${fullOutcome}" แต่ระหว่างสายเจ้าของยังไม่ได้ตอบว่าห้องว่าง — ระบบไม่นับเป็นว่าง จะโทรซ้ำ`
        : textConflict
        ? `ผลจัดเป็น "ว่าง" แต่คำตอบ/สรุปบอกว่าไม่ว่าง${availText ? ` ("${availText}")` : ""} — ระบบเปลี่ยนเป็นไม่ว่าง ควรฟังเสียงซ้ำ`
        : conflict ? `ระหว่างสายได้ยินว่า "${liveOutcome}" แต่ฟังทั้งสายได้ "${fullOutcome}" — ควรฟังเสียงซ้ำ` : null,
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
