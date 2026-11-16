import type { SupabaseClient } from "@supabase/supabase-js";
import { simulateProvider } from "./providers/simulate";
import { vapiProvider } from "./providers/vapi";
import { yalecomProvider } from "./providers/yalecom";
import { sipProvider } from "./providers/sip";
import { bkkClock, toMinutes, todayRangeBKK } from "./time";
import { notifyCalling } from "./sync";
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
  const slots = Math.min((room.concurrency ?? 3) - (inflight ?? 0), (room.daily_cap ?? 100) - (today ?? 0));
  if (slots <= 0) return { started: 0, waiting: (today ?? 0) >= (room.daily_cap ?? 100) ? `ห้อง ${room.name} ครบเป้าต่อวันแล้ว` : "สายเต็ม รอสายก่อนหน้าจบ", errors };

  const { data: leads, error: ce } = await db.rpc("claim_chat_leads", { p_limit: slots, p_segment: room.segment });
  if (ce) return { started: 0, errors: [ce.message] };

  const provider = providerOf(s.provider);
  let started = 0;
  for (const lead of leads ?? []) {
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
    try {
      await prepareAudio(db, lead);
      const r = await provider.start({ callId: call.id, lead, settings: s });
      await db
        .from("calls")
        .update({ provider_call_id: r.providerCallId ?? null, sim_end_at: r.simEndAt ?? null, state: provider.name === "simulate" ? "in_progress" : "dialing" })
        .eq("id", call.id);
      started++;
      await notifyCalling(lead);
    } catch (e) {
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
