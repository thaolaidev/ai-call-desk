import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { vpsBase } from "./vps";
import { thaiDateToISO } from "./thaidate";
import { botMarkUnsure } from "./chatbot";

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
  // เจ้าของไม่รับเอเจนต์ / ไม่ให้โทรอีก = ไม่ว่าง (ตามที่ทีมกำหนด)
  callback: null, noanswer: null, unclear: null, invalid: null, wrong_number: null, dnc: "ไม่ว่าง",
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
/** หมายเหตุตอนติดต่อไม่ได้ เช่น "ไม่รับสาย (ครั้งที่ 1/3) · AI จะโทรซ้ำ 10:38" — ขึ้นบนการ์ด/ปุ่มในแชท */
/** ลักษณะสายที่ไม่ได้คุย จาก ended_reason "sip:declined cause 17" → declined / noanswer / unreachable / error */
export const callKind = (call: any) => String(call?.analysis?.call_kind ?? /^sip:(\w+)/.exec(String(call?.ended_reason ?? ""))?.[1] ?? "");
const KIND_TEXT: Record<string, string> = { declined: "เจ้าของตัดสาย", unreachable: "โทรไม่ติด (ปิดเครื่อง/ไม่มีสัญญาณ)", error: "ระบบโทรออกไม่สำเร็จ" };

function failNote(call: any, lead: any, willRetry: boolean, max?: number | null) {
  const what = call.outcome === "noanswer" ? KIND_TEXT[callKind(call)] ?? "ไม่รับสาย" : FAIL_NOTE[call.outcome] ?? "โทรแล้วติดต่อไม่ได้";
  const nth = `ครั้งที่ ${call.attempt ?? 1}${max ? `/${max}` : ""}`;
  const at = lead?.next_call_at ? new Date(lead.next_call_at) : null;
  const when = at && !isNaN(+at)
    ? at.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", ...(at.toDateString() !== new Date().toDateString() ? { day: "numeric", month: "short" } : {}) })
    : null;
  const next = willRetry
    ? `AI จะโทรซ้ำ${when ? ` ${when}` : "อัตโนมัติ"}`
    : call.outcome === "dnc" ? "" : call.outcome === "noanswer" || call.outcome === "unclear" ? "ครบจำนวนครั้งแล้ว AI ไม่โทรซ้ำ" : "";
  return [`${what} (${nth})`, next].filter(Boolean).join(" · ");
}

export function buildResultPayload(call: any, lead: any, sentAt = new Date().toISOString(), maxAttempts?: number | null) {
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
  // หมายเหตุสั้นๆ (ขึ้นบนการ์ดห้อง และใต้ข้อความในแชท) เช่น
  // "ว่าง · รับต่างชาติ · พร้อมเข้าอยู่ · ยืนยันราคา 13,000 · เลี้ยงสัตว์ได้"
  const fmt = (n: unknown) => Number(n).toLocaleString("en-US");
  const foreign = a.foreign_exclude ? `รับต่างชาติ ยกเว้น ${a.foreign_exclude}`
    : a.accepts_foreigners === true || call.outcome === "avail_ok" || call.outcome === "avail_profile" ? "รับต่างชาติ"
    : a.accepts_foreigners === false || call.outcome === "avail_no" ? "ไม่รับต่างชาติ" : "";
  const short = [
    call.outcome === "dnc" ? "ไม่ว่าง · เจ้าของไม่รับเอเจนต์ / ขอไม่ให้โทรอีก" : status ?? "",
    status === "ว่าง" ? foreign : "",
    status === "ว่าง" && a.ready_now === true ? "พร้อมเข้าอยู่" : "",
    availText ? `${status === "ไม่ว่าง" ? "จะว่าง" : "เข้าได้"} ${availText}` : "",
    a.owner_price ? `เจ้าของแจ้งราคา ${fmt(a.owner_price)}` : a.price_confirmed === true && lead?.rent ? `ยืนยันราคา ${fmt(lead.rent)}` : "",
    a.pet_friendly === true ? "เลี้ยงสัตว์ได้" : a.pet_friendly === false ? "เลี้ยงสัตว์ไม่ได้" : "",
    call.outcome === "avail" && willRetry ? "ยังไม่ได้ถามเรื่องต่างชาติ · AI จะโทรถามอีกครั้ง" : "",
    a.needs_review ? "⚠️ ควรฟังเสียงซ้ำ" : "",
  ].filter(Boolean).join(" · ");
  // หมายเหตุ = สรุป 1 ประโยคของ AI (แบบ "ห้องยังว่างและพร้อมเข้าอยู่ สายตัดไปก่อนยืนยันราคา") + สิ่งที่ทีมต้องรู้เพิ่ม
  // ไม่มีสรุปจาก AI (ฟังทั้งสายไม่สำเร็จ) = ใช้สรุปแบบรายการแทน
  const addOn = [
    call.outcome === "avail" && willRetry ? "AI จะโทรถามเรื่องต่างชาติอีกครั้ง" : "",
    a.foreign_exclude && !String(call.summary ?? "").includes(String(a.foreign_exclude).split(",")[0]) ? `ไม่รับ ${a.foreign_exclude}` : "",
    a.pet_friendly === true && !/สัตว์/.test(String(call.summary ?? "")) ? "เลี้ยงสัตว์ได้" : "",
  ].filter(Boolean).join(" · ");
  const note = status
    ? (call.summary ? [call.summary, addOn].filter(Boolean).join(" · ") : short || null)
    : failNote(call, lead, willRetry, maxAttempts);
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
    // API เว็บเท่าไหร่รับ ว่าง / ไม่ว่าง / ยังไม่แน่นอน / ติดต่อไม่ได้ (ห้ามว่าง)
    // ไม่รับสาย / ฟังไม่ชัด / ขอให้โทรกลับ = "ยังไม่แน่นอน" (ห้องยังไม่แน่นอน + ประวัติโทรแล้ว · AI โทรซ้ำตามรอบ)
    // เบอร์ผิด / เบอร์ปิด / ไม่ให้ติดต่อ = "ติดต่อไม่ได้" (คงสถานะห้องเดิม)
    // ฟังไม่ชัด = รับสายแต่ได้คำตอบไม่ชัด (ปุ่ม "ฟังไม่ชัด")
    status: status ?? (call.outcome === "unclear" ? "ฟังไม่ชัด" : UNSURE_OUTCOMES.includes(call.outcome) ? "ยังไม่แน่นอน" : "ติดต่อไม่ได้"),
    // ยังไม่ได้คำตอบและ AI จะโทรอีก → ผลโทร "รอโทรซ้ำ" แทน "โทรแล้ว"
    // ห้องว่างที่ยังไม่รู้เรื่องต่างชาติ ก็ "รอโทรซ้ำ" ด้วย (AI จะโทรถามอีกครั้ง)
    retry: willRetry && (!status || call.outcome === "avail"),
    call_kind: callKind(call) || null,
    // จากสาย หรือจากฟอร์มห้องชมพู (Pet : Yes/No) — ส่งทุกครั้งแม้ไม่รับสาย ให้ปุ่ม Pet friendly อัปเดต
    pet_friendly: typeof a.pet_friendly === "boolean" ? a.pet_friendly : typeof lead.pet_friendly === "boolean" ? lead.pet_friendly : null,
    status_updated_at: status ? sentAt : null,
    previous_status: lead.vps_status ?? null,
    note,
    last_contact_at: call.ended_at,
    outcome: call.outcome,
    attempt: call.attempt,
    duration_sec: call.duration_sec,
    // ว่างรับตช / ว่างไม่รับตช
    accepts_foreigners: a.accepts_foreigners ?? (call.outcome === "avail_ok" || call.outcome === "avail_profile" ? true : call.outcome === "avail_no" ? false : null),
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

/** โทรออกไม่สำเร็จหลังตั้งป้ายกำลังโทรแล้ว → ส่ง "ติดต่อไม่ได้" ให้หลังบ้านเอาป้ายกำลังโทรออก (สถานะห้องไม่เปลี่ยน) */
export async function clearCalling(lead: any) {
  const t = target();
  if (!t?.key || !lead?.external_id) return;
  await fetch(t.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": t.key },
    body: JSON.stringify({ id: lead.external_id, code: lead.code ?? null, status: "ติดต่อไม่ได้", updated_by: "AI Call", note: "โทรออกไม่สำเร็จ (ระบบโทร) จะลองใหม่", outcome: "error" }),
    signal: AbortSignal.timeout(8_000),
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

/** ผลที่ยังไม่ได้คำตอบเรื่องห้อง และจะโทรซ้ำ → ส่งสถานะ "ยังไม่แน่นอน" */
export const UNSURE_OUTCOMES = ["noanswer", "unclear", "callback", "wrong_number"];

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
  const { data: st } = await db.from("settings").select("max_attempts").eq("id", 1).maybeSingle();
  const payload: Record<string, any> = buildResultPayload(call, lead, sentAt, st?.max_attempts ?? null);
  let body = JSON.stringify(payload);
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
    const send = () => fetch(t.url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    let res = await send();
    // หลังบ้านยังไม่รองรับ "ยังไม่แน่นอน" (ยังไม่ได้ลง patch) →
    // 1) ตั้งผ่านบัญชี AI Call เหมือนคนในทีมกดปุ่มเอง (ยังไม่แน่นอน + โทรแล้ว / โทรแล้ว + รอตอบ)
    // 2) ยังไม่ได้ตั้งบัญชี หรือทำไม่สำเร็จ → ส่ง "ติดต่อไม่ได้" (ลบป้ายกำลังโทรออก ไม่ค้าง)
    if (res.status === 400 && (payload.status === "ยังไม่แน่นอน" || payload.status === "ฟังไม่ชัด")) {
      const txt = await res.text().catch(() => "");
      if (/unsupported status/i.test(txt)) {
        const viaBot = await botMarkUnsure(lead, call, `AI Call: ${payload.note ?? "ไม่รับสาย"}`).catch((e) => { console.error("botMarkUnsure", e?.message); return false; });
        if (viaBot) {
          await db.from("calls").update({ sync_status: "sent", sync_attempts: attempts, synced_at: sentAt, sync_error: "ตั้ง ยังไม่แน่นอน ผ่านบัญชี AI Call (หลังบ้านยังไม่รองรับ)", next_sync_at: null }).eq("id", callId);
          return;
        }
        payload.status = "ติดต่อไม่ได้";
        body = JSON.stringify(payload);
        if (t.secret) headers["X-AICall-Signature"] = sign(t.secret, ts, body);
        res = await send();
      } else res = new Response(txt, { status: 400 });
    }
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
 * เรียกทุก 30 วินาที (ชีพจรจาก server เสียง): ส่งผลของห้องจากแชทที่ยังค้าง/ถึงเวลาส่งซ้ำ ให้การ์ด/ปุ่มในแชทอัปเดตภายใน 1 นาที
 * (ไม่รอรอบใหญ่ — cron ของ Vercel รันวันละครั้ง) · ข้ามสายที่เพิ่งจบไม่ถึง 20 วินาที (กำลังส่งอยู่แล้ว)
 */
export async function resendDueChat(db: SupabaseClient, limit = 10) {
  if (!target()) return 0;
  const now = new Date();
  const { data } = await db.from("calls").select("id")
    .eq("sync_status", "pending").eq("state", "ended").eq("via_chat", true)
    .lt("ended_at", new Date(now.getTime() - 20_000).toISOString())
    .or(`next_sync_at.is.null,next_sync_at.lte.${now.toISOString()}`)
    .order("ended_at").limit(limit);
  for (const c of data ?? []) await deliverResult(db, c.id).catch(() => null);
  return data?.length ?? 0;
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
