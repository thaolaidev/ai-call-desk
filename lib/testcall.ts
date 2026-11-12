import { createAdminClient } from "./supabase/admin";
import { normalizePhone } from "./phone";
import { simulateProvider } from "./providers/simulate";
import { vapiProvider } from "./providers/vapi";
import { yalecomProvider } from "./providers/yalecom";

/**
 * โทรทดสอบ 1 สายหาเบอร์ที่ระบุ ไม่ผ่านคิว ไม่สนว่าแคมเปญเปิดหรือปิด
 * สร้างลีด source = "ทดสอบ" ไว้ ผลจะขึ้นในหน้าผลการโทรเหมือนสายจริง (แต่ไม่ยิงกลับ VPS เพราะไม่มี external_id)
 */
export async function startTestCall(phoneRaw: string, condo: string) {
  const db = createAdminClient();
  const phone = normalizePhone(phoneRaw);
  if (phone.replace(/\D/g, "").length < 9) throw new Error("เบอร์โทรไม่ถูกต้อง");
  const { data: s } = await db.from("settings").select("*").eq("id", 1).single();
  if (!s) throw new Error("อ่าน settings ไม่ได้");

  const condoName = condo.trim() || "ห้องทดสอบ";
  const { data: existing } = await db.from("leads").select("*").eq("phone", phone).eq("condo", condoName).maybeSingle();
  let lead = existing;
  if (!lead) {
    const { data, error } = await db
      .from("leads")
      .insert({ owner_name: "ทดสอบ", phone, condo: condoName, source: "ทดสอบ", status: "new", segment: "new" })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    lead = data;
  }
  if (lead.status === "calling") throw new Error("เบอร์นี้กำลังโทรอยู่");
  await db.from("leads").update({ prev_status: lead.status, status: "calling" }).eq("id", lead.id);

  const provider = s.provider === "vapi" ? vapiProvider : s.provider === "yalecom" ? yalecomProvider : simulateProvider;
  const { data: call, error } = await db
    .from("calls")
    .insert({ lead_id: lead.id, provider: provider.name, attempt: lead.attempts + 1, from_status: lead.status })
    .select("id")
    .single();
  if (error || !call) throw new Error(error?.message ?? "สร้างสายไม่ได้");

  try {
    const r = await provider.start({ callId: call.id, lead, settings: s });
    await db
      .from("calls")
      .update({ provider_call_id: r.providerCallId ?? null, sim_end_at: r.simEndAt ?? null, state: provider.name === "simulate" ? "in_progress" : "dialing" })
      .eq("id", call.id);
    return { callId: call.id, provider: provider.name };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("calls").update({ state: "failed", ended_at: new Date().toISOString(), summary: msg }).eq("id", call.id);
    await db.from("leads").update({ status: lead.status }).eq("id", lead.id);
    throw new Error(msg);
  }
}
