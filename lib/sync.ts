import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/** หน่วงก่อนส่งซ้ำ (นาที) หลังส่งไม่สำเร็จครั้งที่ 1, 2, 3, 4, 5 */
const BACKOFF_MIN = [1, 5, 15, 60, 180];

/** ผลการโทร → สถานะห้องบน VPS (null = ยืนยันไม่ได้ ให้ VPS คงสถานะเดิม) */
export const VPS_STATUS: Record<string, "ว่าง" | "ไม่ว่าง" | null> = {
  avail: "ว่าง", avail_ok: "ว่าง", avail_profile: "ว่าง", avail_no: "ว่าง", not_avail: "ไม่ว่าง",
  callback: null, noanswer: null, unclear: null, invalid: null, wrong_number: null, dnc: null,
};

const FAIL_NOTE: Record<string, string> = {
  noanswer: "โทรแล้วไม่รับสาย",
  unclear: "รับสายแต่ไม่ได้คำตอบที่ชัดเจน",
  invalid: "โทรแล้วติดต่อไม่ได้ (เบอร์ปิดหรือไม่มีในระบบ)",
  wrong_number: "โทรแล้วคนรับไม่ใช่เจ้าของ ต้องตรวจเบอร์",
  callback: "เจ้าของไม่สะดวกคุย ขอให้โทรกลับ",
  dnc: "เจ้าของขอไม่ให้ติดต่ออีก",
};

/**
 * ข้อมูลที่ส่งกลับไปให้ VPS ต่อ 1 สาย (ใช้ทั้ง webhook และ API ดึงย้อนหลัง)
 * - ติดต่อได้: status = ว่าง/ไม่ว่าง และ status_updated_at = เวลาที่ยิงกลับ → VPS เขียนทับสถานะ + วันที่อัปเดตล่าสุด
 * - ติดต่อไม่ได้: status = null, status_updated_at = null → VPS คงสถานะเดิม บันทึกแค่ note
 */
export function buildResultPayload(call: any, lead: any, sentAt = new Date().toISOString()) {
  const a = (call.analysis ?? {}) as Record<string, any>;
  const status = VPS_STATUS[call.outcome] ?? null;
  const willRetry = call.to_status === "noanswer" || call.to_status === "unclear" || call.to_status === "callback";
  const note = status
    ? call.summary ?? null
    : `${FAIL_NOTE[call.outcome] ?? "โทรแล้วติดต่อไม่ได้"} (ครั้งที่ ${call.attempt})${willRetry ? " ระบบจะโทรใหม่อัตโนมัติ" : call.outcome === "dnc" ? "" : " รอดึงมาโทรใหม่รอบหน้า"}`;
  return {
    event: "call.completed",
    delivery_id: call.id,
    external_id: lead.external_id,
    segment: lead.segment,
    contacted: status !== null,
    status,
    status_updated_at: status ? sentAt : null,
    previous_status: lead.vps_status ?? null,
    note,
    last_contact_at: call.ended_at,
    outcome: call.outcome,
    attempt: call.attempt,
    duration_sec: call.duration_sec,
    accepts_foreigners: a.accepts_foreigners ?? null,
    owner_agreed_profile: a.owner_agreed_profile ?? null,
    profile_channel: a.profile_channel ?? null,
    line_id: a.line_id ?? lead.line_id ?? null,
    current_lease_until: a.current_lease_until ?? lead.current_lease_until ?? null,
    callback_at: a.callback_at ?? null,
    next_call_at: lead.next_call_at ?? null,
    summary: call.summary,
    recording_url: call.recording_url,
    transcript: call.transcript ?? [],
  };
}

export function sign(secret: string, timestamp: string, body: string) {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** ส่งผลของ 1 สายไปที่ VPS_WEBHOOK_URL พร้อมลายเซ็น แล้วจดผล/ตั้งเวลาส่งซ้ำ */
export async function deliverResult(db: SupabaseClient, callId: string) {
  const url = process.env.VPS_WEBHOOK_URL;
  const secret = process.env.VPS_WEBHOOK_SECRET;
  if (!url || !secret) return; // ยังไม่เชื่อม VPS: เก็บไว้เป็น pending ส่งทีหลังได้

  const { data: call } = await db.from("calls").select("*, leads!calls_lead_id_fkey(*)").eq("id", callId).single();
  if (!call || call.state !== "ended" || call.sync_status !== "pending") return;
  const lead = Array.isArray(call.leads) ? call.leads[0] : call.leads;
  if (!lead?.external_id) {
    await db.from("calls").update({ sync_status: "skipped", sync_error: "ห้องนี้ไม่ได้มาจาก VPS (ไม่มี external_id)" }).eq("id", callId);
    return;
  }

  const sentAt = new Date().toISOString();
  const payload = buildResultPayload(call, lead, sentAt);
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const attempts = (call.sync_attempts ?? 0) + 1;
  let error: string | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AICall-Event": "call.completed",
        "X-AICall-Delivery": call.id,
        "X-AICall-Timestamp": ts,
        "X-AICall-Signature": sign(secret, ts, body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) error = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (!error) {
    await db.from("calls").update({ sync_status: "sent", sync_attempts: attempts, synced_at: sentAt, sync_error: null, next_sync_at: null }).eq("id", callId);
    // สถานะที่ยืนยันแล้วถูกเขียนลง VPS → เก็บสำเนาไว้ฝั่งเราด้วย (ห้องนี้จะไม่นับเป็นทรัพย์เก่าอีก n วัน)
    if (payload.status) await db.from("leads").update({ vps_status: payload.status, vps_updated_at: sentAt }).eq("id", lead.id);
  } else if (attempts > BACKOFF_MIN.length) {
    await db.from("calls").update({ sync_status: "failed", sync_attempts: attempts, sync_error: error, next_sync_at: null }).eq("id", callId);
  } else {
    const next = new Date(Date.now() + BACKOFF_MIN[attempts - 1] * 60_000).toISOString();
    await db.from("calls").update({ sync_attempts: attempts, sync_error: error, next_sync_at: next }).eq("id", callId);
  }
}

/** เรียกทุก tick: ส่งผลที่ค้าง/ถึงรอบส่งซ้ำ ครั้งละไม่เกิน limit สาย */
export async function syncPending(db: SupabaseClient, limit = 20) {
  if (!process.env.VPS_WEBHOOK_URL || !process.env.VPS_WEBHOOK_SECRET) return 0;
  const now = new Date().toISOString();
  const { data } = await db
    .from("calls")
    .select("id")
    .eq("state", "ended")
    .eq("sync_status", "pending")
    .or(`next_sync_at.is.null,next_sync_at.lte."${now}"`)
    .order("ended_at")
    .limit(limit);
  for (const c of data ?? []) await deliverResult(db, c.id);
  return data?.length ?? 0;
}
