import { createAdminClient } from "./supabase/admin";
import { normalizePhone } from "./phone";
import { simulateProvider } from "./providers/simulate";
import { vapiProvider } from "./providers/vapi";
import { yalecomProvider } from "./providers/yalecom";
import { sipProvider } from "./providers/sip";
import { findCdrByRef } from "./yalecom";
import { processYalecomCall } from "./ivr";

/**
 * โทรทดสอบ 1 สายหาเบอร์ที่ระบุ ไม่ผ่านคิว ไม่สนว่าแคมเปญเปิดหรือปิด
 * สร้างลีด source = "ทดสอบ" ไว้ ผลจะขึ้นในหน้าผลการโทรเหมือนสายจริง (แต่ไม่ยิงกลับ VPS เพราะไม่มี external_id)
 */
export const TEST_CONDO = "Ashton Asoke / แอชตัน อโศก";
export const TEST_RENT = 12000;

export async function startTestCall(phoneRaw: string, condo: string, segment: "new" | "old" = "old", rentRaw?: number | null) {
  const db = createAdminClient();
  const phone = normalizePhone(phoneRaw);
  if (phone.replace(/\D/g, "").length < 9) throw new Error("เบอร์โทรไม่ถูกต้อง");
  const { data: s } = await db.from("settings").select("*").eq("id", 1).single();
  if (!s) throw new Error("อ่าน settings ไม่ได้");

  const condoName = condo.trim() || TEST_CONDO;
  const rent = rentRaw && rentRaw > 0 ? Math.round(rentRaw) : null;
  // จับคู่กับคลังชื่อคอนโด (เอา condo_id มาด้วย ถ้ามี)
  const { data: libRow } = await db.from("condo_audio").select("condo, condo_id").eq("condo", condoName).maybeSingle();
  const condoId = libRow?.condo_id ?? null;
  const { data: existing } = await db.from("leads").select("*").eq("phone", phone).eq("condo", condoName).maybeSingle();
  let lead = existing;
  if (lead && (lead.segment !== segment || lead.rent !== rent || (condoId && lead.condo_id !== condoId))) {
    await db.from("leads").update({ segment, rent, ...(condoId ? { condo_id: condoId } : {}) }).eq("id", lead.id);
    Object.assign(lead, { segment, rent, ...(condoId ? { condo_id: condoId } : {}) });
  }
  if (!lead) {
    const { data, error } = await db
      .from("leads")
      .insert({ owner_name: "ทดสอบ", phone, condo: condoName, source: "ทดสอบ", status: "new", segment, rent, ...(condoId ? { condo_id: condoId } : {}) })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    lead = data;
  }
  if (lead.status === "calling") {
    const { data: open } = await db.from("calls").select("id, started_at, provider").eq("lead_id", lead.id).in("state", ["dialing", "ringing", "in_progress"]);
    const stillOpen: any[] = [];
    for (const c of open ?? []) {
      // สาย Yalecom: ถาม CDR ก่อน ถ้าวางสายแล้วจริง ปล่อยให้ระบบประมวลผลต่อ (ถอดเสียง) โดยไม่บล็อกการโทรใหม่
      if (c.provider === "yalecom") {
        const cdr = await findCdrByRef(c.id).catch(() => null);
        if (cdr?.end_stamp || cdr?.call_result) {
          processYalecomCall(db, c.id, cdr).catch(() => null);
          continue;
        }
      }
      if (Date.parse(c.started_at) < Date.now() - 2 * 60_000) {
        await db.from("calls").update({ state: "failed", ended_at: new Date().toISOString(), summary: "ยกเลิกสายทดสอบที่ค้าง" }).eq("id", c.id);
        continue;
      }
      stillOpen.push(c);
    }
    if (stillOpen.length) throw new Error("เบอร์นี้กำลังโทรอยู่ (ระบบโทรยังไม่ยืนยันว่าวางสาย) รอประมาณ 1 นาทีแล้วลองใหม่");
    lead.status = "new";
  }
  await db.from("leads").update({ prev_status: lead.status, status: "calling" }).eq("id", lead.id);

  // เตรียมเสียงชื่อคอนโดและราคาก่อนโทร (ใช้ของเดิมถ้ามี) → ทดสอบการเชื่อม Botnoi ไปในตัว
  const notes: string[] = [];
  const { botnoiReady, ensureCondoAudio } = await import("./botnoi");
  const { ensurePriceAudio } = await import("./priceaudio");
  if (botnoiReady()) {
    try { const r = await ensureCondoAudio(db, condoName, { condo_id: condoId }); notes.push(`ชื่อคอนโด ✓ ${r.reused ? "ใช้เสียงเดิม" : "Botnoi อ่านใหม่"}`); }
    catch (e) { notes.push(`ชื่อคอนโด ✗ ${e instanceof Error ? e.message : e}`); }
    if (rent) {
      try { const r = await ensurePriceAudio(db, rent); notes.push(`ราคา ${rent.toLocaleString()} ✓ ${r.reused ? "ใช้เสียงเดิม" : "Botnoi อ่านใหม่"}`); }
      catch (e) { notes.push(`ราคา ✗ ${e instanceof Error ? e.message : e}`); }
    }
  } else notes.push("ยังไม่ได้ตั้ง BOTNOI_TOKEN · ข้ามชื่อคอนโด/ราคา");

  const provider = s.provider === "vapi" ? vapiProvider : s.provider === "yalecom" ? yalecomProvider : s.provider === "sip" ? sipProvider : simulateProvider;
  const { data: call, error } = await db
    .from("calls")
    .insert({ lead_id: lead.id, provider: provider.name, attempt: lead.attempts + 1, from_status: lead.status, segment: lead.segment })
    .select("id")
    .single();
  if (error || !call) throw new Error(error?.message ?? "สร้างสายไม่ได้");

  try {
    const r = await provider.start({ callId: call.id, lead, settings: s });
    await db
      .from("calls")
      .update({ provider_call_id: r.providerCallId ?? null, sim_end_at: r.simEndAt ?? null, state: provider.name === "simulate" ? "in_progress" : "dialing" })
      .eq("id", call.id);
    return { callId: call.id, provider: provider.name, notes };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("calls").update({ state: "failed", ended_at: new Date().toISOString(), summary: msg }).eq("id", call.id);
    await db.from("leads").update({ status: lead.status }).eq("id", lead.id);
    throw new Error(msg);
  }
}
