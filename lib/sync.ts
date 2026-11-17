import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { vpsBase } from "./vps";
import { thaiDateToISO } from "./thaidate";

/** ปลายทางส่งผล: POST {VPS_API_URL}/results (X-API-Key) หรือ VPS_WEBHOOK_URL แบบเดิม (ลายเซ็น HMAC) */
function target() {
  if (vpsBase() && process.env.VPS_API_KEY) return { url: `${vpsBase()}/results`, key: process.env.VPS_API_KEY, secret: process.env.VPS_WEBHOOK_SECRET };
  if (process.env.VPS_WEBHOOK_URL && process.env.VPS_WEBHOOK_SECRET) return { url: process.env.VPS_WEBHOOK_URL, key: undefined, secret: process.env.VPS_WEBHOOK_SECRET };
  return null;
}

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
 * - ติดต่อไม่ได้: status = "ติดต่อไม่ได้", status_updated_at = null → VPS คงสถานะเดิม บันทึกแค่ประวัติโทร + note
 */
export function buildResultPayload(call: any, lead: any, sentAt = new Date().toISOString()) {
  const a = (call.analysis ?? {}) as Record<string, any>;
  const status = VPS_STATUS[call.outcome] ?? null;
  const willRetry = call.to_status === "noanswer" || call.to_status === "unclear" || call.to_status === "callback";
  // วันที่ว่างตามที่เจ้าของพูด → YYYY-MM-DD (API รับแค่รูปแบบนี้) แปลไม่ได้ = ใส่เป็นข้อความใน note
  const availText: string | null = a.available_from ? String(a.available_from) : null;
  // ว่าง: วันที่ที่เจ้าของบอก หรือ "พร้อมเข้าอยู่เลย" = วันนี้ · ไม่ว่าง: วันที่คาดว่าจะว่าง (ถ้าบอก)
  // ไม่ได้บอกเลย = ไม่ส่ง → เว็บคงวันที่เดิมของห้องไว้ (ห้องยังไม่มีวันที่ = เว็บใส่วันนี้ให้)
  const availDate = status
    ? thaiDateToISO(availText) ?? (status === "ว่าง" && a.ready_now === true ? thaiDateToISO("วันนี้") : null)
    : null;
  const extra = [
    status === "ว่าง" && availText && !availDate ? `ว่าง: ${availText}` : "",
    a.owner_price ? `เจ้าของแจ้งราคา ${Number(a.owner_price).toLocaleString("en-US")} บาท` : "",
    a.foreign_exclude ? `รับต่างชาติ ยกเว้น ${a.foreign_exclude}` : "",
  ].filter(Boolean).join(" · ");
  const note = status
    ? [call.summary, extra].filter(Boolean).join(" · ") || null
    : `${FAIL_NOTE[call.outcome] ?? "โทรแล้วติดต่อไม่ได้"} (ครั้งที่ ${call.attempt})${willRetry ? " ระบบจะโทรใหม่อัตโนมัติ" : call.outcome === "dnc" ? "" : " รอดึงมาโทรใหม่รอบหน้า"}`;
  return {
    event: "call.completed",
    delivery_id: call.id,
    id: lead.external_id,
    external_id: lead.external_id,
    code: lead.code ?? null,
    updated_by: "AI Call",
    updated_at: status ? sentAt : null,
    segment: lead.segment,
    // มาจากแชท: ใช้ 2 ค่านี้อัปเดตการ์ดห้อง (สถานะ + ประวัติโทร) ในกลุ่มที่ส่งมา
    via_chat: !!call.via_chat,
    chat_group_uuid: call.chat_group_uuid ?? null,
    asset_uuid: call.chat_asset_uuid ?? null,
    ...(availDate ? { available_date: availDate } : {}),
    available_text: availText,
    owner_price: a.owner_price ?? null,
    contacted: status !== null,
    // API เว็บเท่าไหร่รับ ว่าง / ไม่ว่าง / ติดต่อไม่ได้ (ห้ามว่าง) — ติดต่อไม่ได้ = คงสถานะห้องเดิม บันทึกแค่ประวัติโทร
    status: status ?? "ติดต่อไม่ได้",
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

/**
 * แจ้งเว็บเท่าไหร่ว่า AI เริ่มโทรห้องนี้แล้ว → การ์ดห้องในแชทขึ้น "กำลังโทร" (ห้องจากแชท: โพสต์ในกลุ่มด้วย)
 * POST {VPS_API_URL}/calling · ไม่สำเร็จก็ไม่เป็นไร (ผลโทรจะส่งตามไปทีหลังอยู่ดี)
 */
export async function notifyCalling(lead: any, call?: { chat_group_uuid?: string | null; chat_asset_uuid?: string | null }) {
  const t = target();
  if (!t?.key || !lead?.external_id) return;
  await fetch(`${vpsBase()}/calling`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": t.key },
    body: JSON.stringify({
      id: lead.external_id,
      code: lead.code ?? null,
      chat_group_uuid: call?.chat_group_uuid ?? lead.chat_group_uuid ?? null,
      asset_uuid: call?.chat_asset_uuid ?? lead.chat_asset_uuid ?? null,
    }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
}

/**
 * ถามเว็บเท่าไหร่ว่าคนในทีมโทร/กดสถานะห้องเหล่านี้ไปแล้วหรือยัง (POST {VPS_API_URL}/check)
 * คืน Map id → { status, by } เฉพาะห้องที่ทีมจัดการแล้ว · เรียกไม่ได้ = Map ว่าง (โทรต่อตามปกติ)
 */
export async function checkHandled(items: { id: string; since_seconds: number }[]) {
  const done = new Map<string, { status: string; by: string }>();
  const t = target();
  if (!t?.key || !items.length) return done;
  try {
    const res = await fetch(`${vpsBase()}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": t.key },
      body: JSON.stringify({ items }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return done;
    const json = await res.json();
    for (const r of json?.data?.items ?? json?.items ?? []) if (r?.handled) done.set(String(r.id), { status: String(r.status ?? ""), by: String(r.by ?? "") });
  } catch { /* เว็บไม่ตอบ = ไม่ตัดห้องออก */ }
  return done;
}

export function sign(secret: string, timestamp: string, body: string) {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** ส่งผลของ 1 สายไปที่ VPS_WEBHOOK_URL พร้อมลายเซ็น แล้วจดผล/ตั้งเวลาส่งซ้ำ */
export async function deliverResult(db: SupabaseClient, callId: string) {
  const t = target();
  if (!t) return; // ยังไม่เชื่อม VPS: เก็บไว้เป็น pending ส่งทีหลังได้

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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-AICall-Event": "call.completed",
      "X-AICall-Delivery": call.id,
      "X-AICall-Timestamp": ts,
    };
    if (t.key) headers["X-API-Key"] = t.key;
    if (t.secret) headers["X-AICall-Signature"] = sign(t.secret, ts, body);
    const res = await fetch(t.url, {
      method: "POST",
      headers,
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
    if (payload.contacted) await db.from("leads").update({ vps_status: payload.status, vps_updated_at: sentAt }).eq("id", lead.id);
  } else if (attempts > BACKOFF_MIN.length) {
    await db.from("calls").update({ sync_status: "failed", sync_attempts: attempts, sync_error: error, next_sync_at: null }).eq("id", callId);
  } else {
    const next = new Date(Date.now() + BACKOFF_MIN[attempts - 1] * 60_000).toISOString();
    await db.from("calls").update({ sync_attempts: attempts, sync_error: error, next_sync_at: next }).eq("id", callId);
  }
}

/**
 * เรียกทุก tick: ส่งผลที่ค้างกลับ VPS เป็นรอบ ทุก sync_every_min นาที (ค่าเริ่มต้น 30)
 * ส่งครั้งละไม่เกิน limit สาย ถ้ายังเหลือ tick ถัดไปจะส่งต่อทันที
 */
export async function syncPending(db: SupabaseClient, s?: { last_sync_at?: string | null; sync_every_min?: number | null }, limit = 50) {
  if (!target()) return 0;
  const every = s?.sync_every_min ?? 30;
  if (s?.last_sync_at && Date.now() - Date.parse(s.last_sync_at) < every * 60_000) return 0;
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
  // ส่งหมดแล้วค่อยนับรอบใหม่ (ถ้ายังเหลือ ปล่อยให้ tick ถัดไปส่งต่อ)
  if ((data?.length ?? 0) < limit) await db.from("settings").update({ last_sync_at: now }).eq("id", 1);
  return data?.length ?? 0;
}
