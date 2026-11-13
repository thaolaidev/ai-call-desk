import { createAdminClient } from "./supabase/admin";
import { applyCallResult } from "./outcome";
import { simulateConversation, simulateProvider } from "./providers/simulate";
import { vapiProvider } from "./providers/vapi";
import { yalecomProvider } from "./providers/yalecom";
import { pollYalecom } from "./ivr";
import { bkkClock, todayRangeBKK, toMinutes } from "./time";
import { syncPending } from "./sync";
import { pullLeadsIfDue } from "./vps";

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

  // 1c) สาย Yalecom ที่ callback ยังไม่มา: ถาม CDR เอง
  report.finished += await pollYalecom(db).catch(() => 0);

  // 1d) ส่งผลการโทรที่ค้างกลับไปที่ VPS
  await syncPending(db, s);
  try {
    const pulled = await pullLeadsIfDue(db, s.last_pull_at, s.pull_time);
    if (pulled?.error) report.errors.push(`ดึงลีดจาก VPS: ${pulled.error}`);
  } catch (e) {
    report.errors.push(`ดึงลีดจาก VPS: ${e instanceof Error ? e.message : e}`);
  }

  // 2) เติมสายทีละห้อง (ทรัพย์ใหม่ / ทรัพย์เดิม)
  const { data: rooms } = await db.from("call_rooms").select("*").order("segment");
  const active = (rooms ?? []).filter((r: any) => r.running && r.concurrency > 0);
  if (!active.length) return { ...report, skipped: "ทุกห้องหยุดอยู่" };
  const clock = bkkClock();
  if (!s.call_days.includes(clock.weekday)) return { ...report, skipped: "วันนี้ไม่ใช่วันโทร" };
  if (clock.minutes < toMinutes(s.call_start) || clock.minutes >= toMinutes(s.call_end)) {
    return { ...report, skipped: "อยู่นอกช่วงเวลาโทร" };
  }

  const { from, to } = todayRangeBKK();
  const provider = s.provider === "vapi" ? vapiProvider : s.provider === "yalecom" ? yalecomProvider : simulateProvider;

  for (const room of active) {
    const [{ count: inflight }, { count: today }] = await Promise.all([
      db.from("calls").select("id", { count: "exact", head: true }).eq("segment", room.segment).in("state", IN_FLIGHT),
      db.from("calls").select("id", { count: "exact", head: true }).eq("segment", room.segment).gte("started_at", from).lt("started_at", to),
    ]);
    const slots = Math.min(room.concurrency - (inflight ?? 0), room.daily_cap - (today ?? 0));
    if (slots <= 0) continue;

    const { data: leads, error: ce } = await db.rpc("claim_leads", { p_limit: slots, p_segment: room.segment });
    if (ce) { report.errors.push(ce.message); continue; }

    for (const lead of leads ?? []) {
      const { data: call, error } = await db
        .from("calls")
        .insert({ lead_id: lead.id, provider: provider.name, attempt: lead.attempts + 1, from_status: lead.prev_status, segment: room.segment })
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
        report.errors.push(`${room.name}: ${msg}`);
        await db.from("calls").update({ state: "failed", ended_at: new Date().toISOString(), summary: msg }).eq("id", call.id);
        await db.from("leads").update({ status: lead.prev_status ?? "queued" }).eq("id", lead.id);
        // ระบบโทรมีปัญหา หยุดห้องนี้ไว้ก่อน ไม่ให้ยิงซ้ำรัวๆ
        await db.from("call_rooms").update({ running: false }).eq("segment", room.segment);
        break;
      }
    }
  }
  return report;
}
