import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyLine } from "./line";
import { prettyPhone } from "./phone";
import type { LeadStatus, Outcome } from "./status";

export type Turn = { role: "ai" | "owner" | "system"; text: string };

export type CallResult = {
  callId: string;
  outcome: Outcome;
  analysis?: Record<string, unknown> | null;
  transcript?: Turn[];
  summary?: string | null;
  durationSec?: number | null;
  costThb?: number | null;
  recordingUrl?: string | null;
  endedReason?: string | null;
};

const NEXT_ACTION: Record<Outcome, string> = {
  avail: "close",
  unclear: "retry_later",
  avail_ok: "send_profile",
  avail_profile: "send_profile",
  avail_no: "offer_thai_only",
  not_avail: "remind_before_lease_end",
  callback: "schedule_callback",
  dnc: "add_dnc",
  wrong_number: "verify_number",
  noanswer: "retry_later",
  invalid: "verify_number",
};

/**
 * บันทึกผลการโทร แล้วอัปเดตสถานะลีดตามตาราง "ผลลัพธ์ → สถานะ → งานถัดไป"
 * ใช้ร่วมกันทั้งโหมดจำลองและ webhook ของ Vapi
 */
export async function applyCallResult(db: SupabaseClient, r: CallResult) {
  const { data: call } = await db.from("calls").select("*, leads!calls_lead_id_fkey(*)").eq("id", r.callId).single();
  if (!call || call.state === "ended") return; // ประมวลผลไปแล้ว (webhook ซ้ำ)
  const lead = call.leads;
  const { data: s } = await db.from("settings").select("retry_gap_min,max_attempts").eq("id", 1).single();

  const a = (r.analysis ?? {}) as Record<string, any>;
  const attempts = (lead.attempts ?? 0) + 1;
  const now = Date.now();

  let status: LeadStatus = r.outcome;
  let nextCallAt: string | null = null;

  if (r.outcome === "noanswer" || r.outcome === "unclear") {
    if (attempts >= (s?.max_attempts ?? 3)) status = "closed";
    else nextCallAt = new Date(now + (s?.retry_gap_min ?? 120) * 60_000).toISOString();
  }
  if (r.outcome === "callback") {
    const when = typeof a.callback_at === "string" ? Date.parse(a.callback_at) : NaN;
    nextCallAt = new Date(Number.isFinite(when) && when > now ? when : now + 60 * 60_000).toISOString();
  }

  const summary = r.summary ?? (typeof a.summary_th === "string" ? a.summary_th : null);

  await db
    .from("calls")
    .update({
      state: "ended",
      outcome: r.outcome,
      to_status: status,
      ended_at: new Date().toISOString(),
      duration_sec: r.durationSec ?? null,
      cost_thb: r.costThb ?? null,
      transcript: r.transcript ?? [],
      analysis: r.analysis ?? null,
      summary,
      next_action: (typeof a.next_action === "string" && a.next_action) || NEXT_ACTION[r.outcome],
      recording_url: r.recordingUrl ?? null,
      ended_reason: r.endedReason ?? null,
    })
    .eq("id", r.callId);

  await db
    .from("leads")
    .update({
      status,
      attempts,
      next_call_at: nextCallAt,
      last_summary: summary,
      last_call_id: r.callId,
      last_called_at: call.started_at,
      line_id: typeof a.line_id === "string" ? a.line_id : lead.line_id,
      current_lease_until: typeof a.current_lease_until === "string" ? a.current_lease_until : lead.current_lease_until,
    })
    .eq("id", lead.id);

  if (r.outcome === "dnc") {
    await db.from("dnc_numbers").upsert({ phone: lead.phone, reason: summary ?? "เจ้าของขอไม่ให้ติดต่อ" });
  }

  if (r.outcome === "avail_ok" || r.outcome === "avail_profile") {
    const channel = a.profile_channel === "line_id" && a.line_id ? `LINE ID: ${a.line_id}` : `LINE เบอร์ ${prettyPhone(lead.phone)}`;
    const note = `ส่งโปรไฟล์ลูกค้า${lead.customer_nationalities ?? ""} ทาง ${channel}`;
    await db.from("admin_tasks").insert({ lead_id: lead.id, call_id: r.callId, kind: "send_profile", note });
    await notifyLine(
      `🏠 ${lead.condo} (${lead.unit ?? "-"}) ว่าง\n` +
        `${r.outcome === "avail_ok" ? "รับต่างชาติ" : "ฟังกฎแล้วขอดูโปรไฟล์"}\n` +
        `เจ้าของ: คุณ${lead.owner_name} ${prettyPhone(lead.phone)}\n` +
        `งาน: ${note}\n${summary ?? ""}`,
    );
  }
}
