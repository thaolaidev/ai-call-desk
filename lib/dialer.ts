import { createAdminClient } from "./supabase/admin";
import { applyCallResult } from "./outcome";
import { simulateConversation, simulateProvider } from "./providers/simulate";
import { vapiProvider } from "./providers/vapi";
import { bkkClock, todayRangeBKK, toMinutes } from "./time";

const IN_FLIGHT = ["dialing", "ringing", "in_progress"];
const STALE_MIN = 15; // สายที่ค้างนานเกินนี้ถือว่าล้มเหลว (เช่น webhook ไม่มา)

export type TickReport = { finished: number; started: number; skipped?: string; errors: string[] };

/**
 * หัวใจของระบบ: เรียกทุกนาทีจาก Cron และทุก 5 วินาทีจากหน้าเว็บที่เปิดอยู่
 * 1) ปิดสายจำลองที่ครบเวลา และสายที่ค้าง
 * 2) ถ้าแคมเปญเปิดอยู่และอยู่ในเวลาโทร → หยิบลีดจากคิวเติมให้เต็มจำนวนสายพร้อมกัน
 */
export async function tick(): Promise<TickReport> {
  const db = createAdminClient();
  const report: TickReport = { finished: 0, started: 0, errors: [] };

  const { data: s, error: se } = await db.from("settings").select("*").eq("id", 1).single();
  if (se || !s) return { ...report, skipped: "อ่าน settings ไม่ได้", errors: [se?.message ?? ""] };

  // 1a) ปิดสายจำลองที่ครบเวลา
  const { data: due } = await db
    .from("calls")
    .select("id, leads!calls_lead_id_fkey(condo, customer_nationalities, viewing_when)")
    .eq("provider", "simulate")
    .in("state", IN_FLIGHT)
    .lte("sim_end_at", new Date().toISOString());
  for (const c of due ?? []) {
    const lead = Array.isArray(c.leads) ? c.leads[0] : c.leads;
    const sim = simulateConversation(lead, s);
    await applyCallResult(db, { callId: c.id, ...sim });
    report.finished++;
  }

  // 1b) สายที่ค้างเกินเวลา → ถือว่าไม่รับสาย
  const staleBefore = new Date(Date.now() - STALE_MIN * 60_000).toISOString();
  const { data: stale } = await db.from("calls").select("id").in("state", IN_FLIGHT).lt("started_at", staleBefore);
  for (const c of stale ?? []) {
    await applyCallResult(db, { callId: c.id, outcome: "noanswer", summary: "ไม่ได้รับผลจากระบบโทรภายใน 15 นาที", endedReason: "stale" });
    report.finished++;
  }

  // 2) เติมสาย
  if (!s.running) return { ...report, skipped: "แคมเปญหยุดอยู่" };
  const clock = bkkClock();
  if (!s.call_days.includes(clock.weekday)) return { ...report, skipped: "วันนี้ไม่ใช่วันโทร" };
  if (clock.minutes < toMinutes(s.call_start) || clock.minutes >= toMinutes(s.call_end)) {
    return { ...report, skipped: "อยู่นอกช่วงเวลาโทร" };
  }

  const { from, to } = todayRangeBKK();
  const [{ count: inflight }, { count: today }] = await Promise.all([
    db.from("calls").select("id", { count: "exact", head: true }).in("state", IN_FLIGHT),
    db.from("calls").select("id", { count: "exact", head: true }).gte("started_at", from).lt("started_at", to),
  ]);
  const slots = Math.min(s.concurrency - (inflight ?? 0), s.daily_cap - (today ?? 0));
  if (slots <= 0) return { ...report, skipped: (today ?? 0) >= s.daily_cap ? "ครบเป้าวันนี้แล้ว" : "สายเต็ม" };

  const { data: leads, error: ce } = await db.rpc("claim_leads", { p_limit: slots });
  if (ce) return { ...report, errors: [ce.message] };

  const provider = s.provider === "vapi" ? vapiProvider : simulateProvider;
  for (const lead of leads ?? []) {
    const { data: call, error } = await db
      .from("calls")
      .insert({ lead_id: lead.id, provider: provider.name, attempt: lead.attempts + 1, from_status: lead.prev_status })
      .select("id")
      .single();
    if (error || !call) {
      report.errors.push(error?.message ?? "insert call failed");
      await db.from("leads").update({ status: lead.prev_status ?? "queued" }).eq("id", lead.id);
      continue;
    }
    try {
      const r = await provider.start({ callId: call.id, lead, settings: s });
      await db
        .from("calls")
        .update({ provider_call_id: r.providerCallId ?? null, sim_end_at: r.simEndAt ?? null, state: provider.name === "simulate" ? "in_progress" : "dialing" })
        .eq("id", call.id);
      report.started++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      report.errors.push(msg);
      await db.from("calls").update({ state: "failed", ended_at: new Date().toISOString(), summary: msg }).eq("id", call.id);
      await db.from("leads").update({ status: lead.prev_status ?? "queued" }).eq("id", lead.id);
      // ถ้าเรียกระบบโทรไม่สำเร็จ หยุดแคมเปญไว้ก่อน ไม่ให้ยิงซ้ำรัวๆ
      await db.from("settings").update({ running: false }).eq("id", 1);
      break;
    }
  }
  return report;
}
