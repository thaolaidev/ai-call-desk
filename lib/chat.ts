import type { SupabaseClient } from "@supabase/supabase-js";
import { simulateProvider } from "./providers/simulate";
import { vapiProvider } from "./providers/vapi";
import { yalecomProvider } from "./providers/yalecom";
import { sipProvider } from "./providers/sip";
import { bkkClock, toMinutes } from "./time";
import { notifyCalling } from "./sync";
import { findCondoAudio } from "./condolib";
import { ensureCondoAudio } from "./botnoi";
import { findPriceAudio, ensurePriceAudio } from "./priceaudio";

/** ห้องจากแชทมาแบบไม่ได้เตรียมไว้ก่อน: สร้างเสียงชื่อคอนโด/ราคาด้วย Botnoi ก่อนโทร (ไม่สำเร็จ = โทรต่อโดยข้ามท่อนนั้น) */
async function prepareAudio(db: SupabaseClient, lead: any) {
  const condo = await findCondoAudio(db, { condo: lead.condo, condo_id: lead.condo_id ?? null }).catch(() => null);
  if (!condo?.path) await ensureCondoAudio(db, lead.condo, { condo_id: lead.condo_id ?? null }).catch(() => null);
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
 * โทรห้องที่ส่งมาจากแชททันที (ไม่ต้องกดเริ่มห้องโทร) · ไม่เกิน chat_concurrency สายพร้อมกัน
 * เรียกตอนแชทส่งห้องมา, ทุก tick และทุกครั้งที่สายจากแชทจบ (ให้คิวถัดไปโทรต่อทันที)
 */
export async function dispatchChat(db: SupabaseClient, s?: any): Promise<{ started: number; waiting?: string; errors: string[] }> {
  const errors: string[] = [];
  if (!s) s = (await db.from("settings").select("*").eq("id", 1).single()).data;
  if (!s) return { started: 0, errors: ["อ่าน settings ไม่ได้"] };
  const mode = s.chat_mode ?? (s.chat_enabled === false ? "off" : "auto");
  if (mode === "off") return { started: 0, waiting: "ปิดรับห้องจากแชทอยู่", errors };
  if (mode === "queue") return { started: 0, waiting: "ตั้งให้รอกดโทรเอง (เปิดโหมดโทรทันทีที่หน้าห้องโทร)", errors };
  const off = outsideHours(s);
  if (off) return { started: 0, waiting: off, errors };

  const { count: inflight } = await db.from("calls").select("id", { count: "exact", head: true }).eq("via_chat", true).in("state", IN_FLIGHT);
  const slots = (s.chat_concurrency ?? 3) - (inflight ?? 0);
  if (slots <= 0) return { started: 0, waiting: "สายเต็ม รอสายก่อนหน้าจบ", errors };

  const { data: leads, error: ce } = await db.rpc("claim_chat_leads", { p_limit: slots });
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
