import type { SupabaseClient } from "@supabase/supabase-js";
import { simulateProvider } from "./providers/simulate";
import { vapiProvider } from "./providers/vapi";
import { yalecomProvider } from "./providers/yalecom";
import { sipProvider } from "./providers/sip";
import { bkkClock, toMinutes, todayRangeBKK } from "./time";
import { notifyCalling, checkHandled, clearCalling } from "./sync";
import { findCondoAudio } from "./condolib";
import { ensureCondoAudio, defaultReading } from "./botnoi";
import { findPriceAudio, ensurePriceAudio } from "./priceaudio";
import { matchCondo } from "./condomatch";

/**
 * ก่อนโทร: หาเสียงชื่อคอนโดจากคลัง แล้วสร้างให้ถ้ายังไม่มี (อ่านชื่อไทยในคลังเสมอ)
 *  1) condo_id (location_id จากเว็บ) ตรงกับคลัง → ใช้แถวนั้น
 *  2) ไม่มี/ไม่เจอ → จับคู่ชื่อกับคลัง (matchCondo) แล้วผูก lead กับแถวในคลัง
 *  3) ไม่เจอเลย → สร้างจากชื่อที่มี (ไทยถ้ามี ไม่งั้นตามที่พิมพ์)
 * ราคา: สร้างเสียงราคาถ้ายังไม่มี · ไม่สำเร็จ = โทรต่อโดยข้ามท่อนนั้น
 */
export async function prepareAudio(db: SupabaseClient, lead: any) {
  let row: any = await findCondoAudio(db, { condo: lead.condo, condo_id: lead.condo_id ?? null }).catch(() => null);
  if (row && !row.condo_id && /[A-Za-z]/.test(String(row.tts_text ?? "")) && !/[\u0E00-\u0E7F]/.test(String(row.tts_text ?? ""))) row = null; // แถวที่อ่านอังกฤษ → ลองคลังก่อน
  if (!row) {
    const m = await matchCondo(db, lead.condo).catch(() => null);
    if (m) {
      lead.condo_id = m.condo_id ?? lead.condo_id;
      await db.from("leads").update({ condo_id: lead.condo_id }).eq("id", lead.id);
      row = await findCondoAudio(db, { condo: m.condo, condo_id: m.condo_id }).catch(() => null);
    }
  }
  if (row?.path) return void (await priceAudio(db, lead));
  const name = row?.condo ?? lead.condo;
  await ensureCondoAudio(db, name, { condo_id: row?.condo_id ?? lead.condo_id ?? null, text: defaultReading(name) ?? name }).catch(() => null);
  await priceAudio(db, lead);
}

async function priceAudio(db: SupabaseClient, lead: any) {
  if (lead.rent && !(await findPriceAudio(db, lead.rent).catch(() => null))) await ensurePriceAudio(db, lead.rent).catch(() => null);
}

const IN_FLIGHT = ["dialing", "ringing", "in_progress"];

export const providerOf = (name: string) =>
  name === "vapi" ? vapiProvider : name === "yalecom" ? yalecomProvider : name === "sip" ? sipProvider : simulateProvider;

/** อยู่ในวันและเวลาโทรที่ตั้งไว้ไหม (null = โทรได้, ข้อความ = เหตุผลที่ยังโทรไม่ได้) */
export function outsideHours(s: any): string | null {
  const clock = bkkClock();
  if (!s.call_days.includes(clock.weekday)) return "วันนี้ไม่ใช่วันโทร";
  if (clock.minutes < toMinutes(s.call_start) || clock.minutes >= toMinutes(s.call_end)) {
    return `อยู่นอกช่วงเวลาโทร (${String(s.call_start).slice(0, 5)}–${String(s.call_end).slice(0, 5)})`;
  }
  return null;
}

const HANDLED_LABEL: Record<string, string> = {
  calling: "กำลังโทร", called: "โทรแล้ว", unreachable: "ติดต่อไม่ได้", line: "ทักไลน์", facebook: "ทักเฟส",
  available: "ว่าง", unavailable: "ไม่ว่าง", waiting: "รอตอบ", agent: "Ag",
};

/**
 * ทำงานร่วมกับทีม: ห้องที่คนในทีมกดโทร/กดสถานะในแชทไปแล้ว (หลังส่งมา หรือภายใน "ไม่โทรซ้ำภายใน" ชม.) → เอาออกจากคิว ไม่ให้ AI โทรซ้ำ
 * คืน id ของลีดที่เอาออก
 */
export async function pruneHandled(db: SupabaseClient, s: any, leads: any[]): Promise<Set<string>> {
  const removed = new Set<string>();
  const list = leads.filter((l) => l.external_id && l.chat_requested_at);
  if (!list.length) return removed;
  const recallMs = (s?.chat_recall_hours ?? 12) * 3600_000;
  const items = list.map((l) => ({
    id: String(l.external_id),
    since_seconds: Math.ceil((Date.now() - (Date.parse(l.chat_requested_at) - recallMs)) / 1000),
  }));
  const done = await checkHandled(items);
  for (const l of list) {
    const h = done.get(String(l.external_id));
    if (!h) continue;
    removed.add(l.id);
    await db.from("leads").update({
      status: "new", chat_requested_at: null, next_call_at: null,
      last_summary: `ทีมจัดการเองแล้ว (${HANDLED_LABEL[h.status] ?? h.status}${h.by ? ` · ${h.by}` : ""}) — AI ไม่โทร`,
    }).eq("id", l.id);
  }
  return removed;
}

/**
 * กู้ห้องที่ค้าง: (1) สถานะ "กำลังโทร" แต่ไม่มีสายที่ทำงานอยู่จริงเกิน 3 นาที (เช่น ระบบล่มกลางทาง) → กลับเข้าคิว
 * (2) ห้องจากแชทที่สถานะรอโทรแต่หลุดจากคิวแชท → ใส่กลับเข้าคิว
 */
export async function rescueStuck(db: SupabaseClient) {
  const cutoff = new Date(Date.now() - 3 * 60_000).toISOString();
  let fixed = 0;
  const { data: stuck } = await db.from("leads").select("id, attempts, prev_status, chat_requested_at").eq("status", "calling").lt("updated_at", cutoff).limit(50);
  for (const l of stuck ?? []) {
    const { data: busy } = await db.from("calls").select("id").eq("lead_id", l.id)
      .or(`state.in.(${IN_FLIGHT.join(",")}),started_at.gte.${cutoff}`).limit(1);
    if (busy?.length) continue;
    const retry = (l.attempts ?? 0) > 0;
    const status = l.chat_requested_at ? (retry ? "noanswer" : "queued") : (l.prev_status && l.prev_status !== "calling" ? l.prev_status : "queued");
    await db.from("leads").update({ status, next_call_at: retry ? new Date().toISOString() : null }).eq("id", l.id).eq("status", "calling");
    fixed++;
  }
  const { data: lost } = await db.from("leads").select("id").eq("status", "queued").is("chat_requested_at", null).not("chat_group_uuid", "is", null).limit(50);
  if (lost?.length) {
    await db.from("leads").update({ chat_requested_at: new Date().toISOString() }).in("id", lost.map((x: any) => x.id));
    fixed += lost.length;
  }
  return fixed;
}

/** ชื่อคอนโดที่ไม่ใช่ชื่อจริง (หัวข้อในฟอร์ม / ป้ายปุ่ม) */
const BAD_CONDO = /^\s*(?:\d+\s*[.)]\s*)?(?:number\s*owner|owner\s*(?:id\s*)?line|name\s*property|phone\s*\d*|tel|project|link|line|ag|agent|ว่าง|ไม่ว่าง|รอตอบ)(?![a-z])/i;

let lastPrune = 0;
/** ทุก tick และทุก 30 วินาทีจาก server เสียง (ไม่ถี่กว่า 30 วินาที): เช็กห้องที่รอในคิวจากแชท แล้วเอาห้องที่ทีมโทรเองแล้วออก (ทุกโหมด) */
export async function pruneWaiting(db: SupabaseClient, s?: any, minGapMs = 30_000) {
  if (Date.now() - lastPrune < minGapMs) return 0;
  lastPrune = Date.now();
  await rescueStuck(db).catch(() => 0);
  const { data } = await db.from("leads").select("id, external_id, chat_requested_at")
    .not("chat_requested_at", "is", null).in("status", ["queued", "noanswer", "unclear", "callback"]).limit(100);
  return (await pruneHandled(db, s, data ?? [])).size;
}

/**
 * โทรห้องที่ส่งมาจากแชท แยกตามห้องโทร (new = Check ทรัพย์ใหม่ · old = Check สถานะห้อง)
 * แต่ละห้อง: โหมดโทรทันทีเท่านั้น · ไม่เกินจำนวนสายพร้อมกันและเป้าต่อวันของห้องนั้น
 * เรียกตอนแชทส่งห้องมา, ทุก tick และทุกครั้งที่สายจากแชทจบ (ให้คิวถัดไปโทรต่อทันที)
 */
export async function dispatchChat(db: SupabaseClient, s?: any, onlySegment?: string): Promise<{ started: number; waiting?: string; errors: string[] }> {
  if (!s) s = (await db.from("settings").select("*").eq("id", 1).single()).data;
  if (!s) return { started: 0, errors: ["อ่าน settings ไม่ได้"] };
  const { data: rooms } = await db.from("call_rooms").select("*").order("segment");
  let started = 0;
  const errors: string[] = [];
  let waiting: string | undefined;
  for (const room of (rooms ?? []).filter((r: any) => !onlySegment || r.segment === onlySegment)) {
    const r = await dispatchRoom(db, s, room);
    started += r.started;
    errors.push(...r.errors);
    if (r.waiting) waiting = r.waiting;
  }
  return { started, waiting, errors };
}

async function dispatchRoom(db: SupabaseClient, s: any, room: any): Promise<{ started: number; waiting?: string; errors: string[] }> {
  const errors: string[] = [];
  const mode = room.chat_mode ?? "queue";
  if (mode === "off") return { started: 0, waiting: `ห้อง ${room.name} ปิดรับอยู่`, errors };
  if (mode === "queue") return { started: 0, waiting: `ห้อง ${room.name} ตั้งให้รอกดโทรเอง`, errors };
  const off = outsideHours(s);
  if (off) return { started: 0, waiting: off, errors };

  const { from, to } = todayRangeBKK();
  const [{ count: inflight }, { count: today }] = await Promise.all([
    db.from("calls").select("id", { count: "exact", head: true }).eq("via_chat", true).eq("segment", room.segment).in("state", IN_FLIGHT),
    db.from("calls").select("id", { count: "exact", head: true }).eq("segment", room.segment).gte("started_at", from).lt("started_at", to),
  ]);
  // เป้าต่อวัน 0 (หรือไม่ตั้ง) = ไม่จำกัด
  const cap = (room.daily_cap ?? 0) > 0 ? room.daily_cap : Infinity;
  const slots = Math.min((room.concurrency ?? 3) - (inflight ?? 0), cap - (today ?? 0));
  if (slots <= 0) return { started: 0, waiting: (today ?? 0) >= cap ? `ห้อง ${room.name} ครบเป้าต่อวันแล้ว` : "สายเต็ม รอสายก่อนหน้าจบ", errors };

  const { data: leads, error: ce } = await db.rpc("claim_chat_leads", { p_limit: slots, p_segment: room.segment });
  if (ce) return { started: 0, errors: [ce.message] };
  // ห้องที่ทีมโทรเองแล้ว → เอาออก ไม่โทร
  const handled = await pruneHandled(db, s, leads ?? []);
  // ชื่อคอนโดที่เป็นหัวข้อฟอร์ม/ป้ายปุ่ม (Number Owner 1, Phone, Ag …) ที่ค้างในคิวจากก่อนมีตัวกรอง → ไม่โทร เอาออกจากคิว
  for (const l of leads ?? []) {
    if (handled.has(l.id) || !BAD_CONDO.test(String(l.condo ?? "")) && String(l.condo ?? "").trim().length >= 3) continue;
    handled.add(l.id);
    await db.from("leads").update({ status: "new", chat_requested_at: null, next_call_at: null, last_summary: "ไม่โทร: ชื่อคอนโดไม่ถูกต้อง (มาจากหัวข้อฟอร์ม/ป้ายปุ่ม)" }).eq("id", l.id);
  }

  const provider = providerOf(s.provider);
  let started = 0;
  for (const lead of (leads ?? []).filter((l: any) => !handled.has(l.id))) {
    const { data: call, error } = await db
      .from("calls")
      .insert({
        lead_id: lead.id, provider: provider.name, attempt: lead.attempts + 1, from_status: lead.prev_status, segment: lead.segment,
        via_chat: true, chat_group_uuid: lead.chat_group_uuid, chat_asset_uuid: lead.chat_asset_uuid,
      })
      .select("id")
      .single();
    if (error || !call) {
      errors.push(error?.message ?? "insert call failed");
      await db.from("leads").update({ status: lead.prev_status ?? "queued" }).eq("id", lead.id);
      continue;
    }
    let notified = false;
    try {
      await prepareAudio(db, lead);
      // แจ้ง "กำลังโทร" ก่อนโทรออก (ไม่ใช่หลัง) — สายที่ไม่รับเร็ว ผลจะมาถึงก่อนป้ายกำลังโทร แล้วป้ายค้าง
      await notifyCalling(lead);
      notified = true;
      const r = await provider.start({ callId: call.id, lead, settings: s });
      await db
        .from("calls")
        .update({ provider_call_id: r.providerCallId ?? null, sim_end_at: r.simEndAt ?? null, state: provider.name === "simulate" ? "in_progress" : "dialing" })
        .eq("id", call.id);
      started++;
    } catch (e) {
      // โทรออกไม่ได้ → เอาป้ายกำลังโทรที่เพิ่งตั้งออก
      if (notified) await clearCalling(lead).catch(() => null);
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${lead.condo}: ${msg}`);
      await db.from("calls").update({ state: "failed", ended_at: new Date().toISOString(), summary: msg }).eq("id", call.id);
      // คืนเข้าคิว แต่เลื่อนไป 5 นาที ไม่ให้ยิงซ้ำรัวๆ ตอนระบบโทรมีปัญหา
      await db.from("leads").update({ status: "noanswer", next_call_at: new Date(Date.now() + 5 * 60_000).toISOString() }).eq("id", lead.id);
      break;
    }
  }
  return { started, errors };
}
