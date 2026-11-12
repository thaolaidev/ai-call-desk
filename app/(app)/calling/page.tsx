import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { todayRangeBKK, fmtTime } from "@/lib/time";
import { prettyPhone } from "@/lib/phone";
import { Top } from "@/components/Top";
import { AutoRefresh } from "@/components/AutoRefresh";
import { toggleRoom } from "../actions";

export const dynamic = "force-dynamic";
const STATE_LABEL: Record<string, string> = { dialing: "กำลังต่อสาย", ringing: "กำลังเรียก", in_progress: "กำลังคุย" };
const SEGS = ["new", "old"] as const;
const IN_FLIGHT = ["dialing", "ringing", "in_progress"];

export default async function CallingPage() {
  const sb = await createClient();
  const { from, to } = todayRangeBKK();
  const dueSoon = new Date(Date.now() + 24 * 3600_000).toISOString();

  const [{ data: s, error }, { data: rooms }, { data: live }, ...perSeg] = await Promise.all([
    sb.from("settings").select("provider, call_start, call_end").eq("id", 1).single(),
    sb.from("call_rooms").select("*").order("segment"),
    sb.from("calls").select("id, state, started_at, attempt, segment, leads!calls_lead_id_fkey(condo, unit, owner_name, phone, segment)").in("state", IN_FLIGHT).order("started_at"),
    ...SEGS.flatMap((seg) => [
      sb.from("calls").select("id", { count: "exact", head: true }).eq("segment", seg).gte("started_at", from).lt("started_at", to),
      sb.from("leads").select("id, condo, owner_name, phone, status, attempts, next_call_at", { count: "exact" })
        .eq("segment", seg)
        .or(`status.eq.queued,and(status.in.(noanswer,unclear,callback),next_call_at.lt."${dueSoon}")`)
        .order("next_call_at", { ascending: true, nullsFirst: true }).order("created_at").limit(10),
    ]),
  ]);
  if (error || !s) return <div className="view"><p className="banner err">{error?.message ?? "ไม่พบ settings"}</p></div>;
  if (!rooms?.length) return <div className="view"><p className="banner err">ยังไม่มีห้องโทร · รันไฟล์ update_0006_rooms.sql ใน Supabase ก่อน</p></div>;

  const provider = s.provider === "simulate" ? "โหมดจำลอง" : s.provider === "yalecom" ? "Yalecom (โทรจริง)" : "Vapi (โทรจริง)";
  const anyRunning = rooms.some((r: any) => r.running);
  const liveCalls = (live ?? []) as any[];

  return (
    <>
      <Top title="ห้องโทร" sub={`2 ห้อง แยกสาย แยกคิว แยกเปิด-ปิด · โทรได้ ${String(s.call_start).slice(0, 5)}–${String(s.call_end).slice(0, 5)} น.`}>
        <span className="chip"><span className={`dot ${anyRunning ? "live" : ""}`} />{provider}</span>
        <Link className="btn" href="/settings#campaign">ตั้งค่าการโทร</Link>
      </Top>
      <AutoRefresh ms={8000} ping={anyRunning || liveCalls.length > 0} />
      <div className="view">
        <div className="half">
          {SEGS.map((seg, k) => {
            const room: any = rooms.find((r: any) => r.segment === seg) ?? { name: seg, concurrency: 0, daily_cap: 0, running: false };
            const today = (perSeg[k * 2] as any).count ?? 0;
            const queueRes: any = perSeg[k * 2 + 1];
            const queue: any[] = queueRes.data ?? [];
            const calls = liveCalls.filter((c) => (c.segment ?? (Array.isArray(c.leads) ? c.leads[0] : c.leads)?.segment) === seg);
            const lines = Array.from({ length: room.concurrency }, (_, i) => calls[i]);
            const extra = calls.slice(room.concurrency); // สายที่ยังค้างเกินจำนวนที่ตั้ง (เช่น เพิ่งลดจำนวนสาย)
            return (
              <div key={seg} className="room-col">
                <div className={`card room ${room.running ? "on" : ""}`}>
                  <div className="room-row">
                    <h2>ห้อง{room.name}</h2>
                    <span className="chip"><span className={`dot ${room.running ? "live" : ""}`} />{room.running ? "กำลังโทร" : "หยุดอยู่"}</span>
                  </div>
                  <div className="room-row">
                    <span className="room-stat">{today}<small> / {room.daily_cap} สาย</small></span>
                    <span className="small muted">ใช้ {calls.length}/{room.concurrency} สาย · คิว {queueRes.count ?? 0} ห้อง</span>
                    <form action={toggleRoom}>
                      <input type="hidden" name="segment" value={seg} />
                      <button className={`btn sm ${room.running ? "stop" : "primary"}`}>{room.running ? "หยุด" : "เริ่มโทร"}</button>
                    </form>
                  </div>
                  <div className="bar"><i style={{ width: `${room.daily_cap ? Math.min(100, (today / room.daily_cap) * 100) : 0}%` }} /></div>
                  {seg === "new" && <span className="small muted">บทเสียงห้องนี้ยังไม่ได้ทำ · ตั้งไฟล์เสียงได้ที่หน้าตั้งค่าระบบ</span>}
                </div>

                <div className="card">
                  <div className="card-h"><h3>สายที่กำลังทำงาน</h3><span className="hint">{calls.length} จาก {room.concurrency} สาย</span></div>
                  <div className="card-b lines lines-3">
                    {[...lines, ...extra].map((c, i) => {
                      if (!c) return <div key={i} className="line free"><div className="line-h"><b>สาย {i + 1}</b><span className="pill t-ok">ว่าง</span></div><p className="small muted">{room.running ? "รอลีดถัดไป" : "หยุดชั่วคราว"}</p></div>;
                      const l = Array.isArray(c.leads) ? c.leads[0] : c.leads;
                      return (
                        <div key={c.id} className={`line ${c.state}`}>
                          <div className="line-h"><b>สาย {i + 1}</b><span className="pill t-bad busy-pill">ไม่ว่าง</span></div>
                          <b>{l?.condo}</b>
                          <span className="small muted">คุณ{l?.owner_name} · <span className="mono">{l ? prettyPhone(l.phone) : ""}</span></span>
                          <span className="small muted">{STATE_LABEL[c.state]} · เริ่ม {fmtTime(c.started_at)} · ครั้งที่ {c.attempt}</span>
                        </div>
                      );
                    })}
                    {!room.concurrency && <p className="small muted">ห้องนี้ตั้งไว้ 0 สาย</p>}
                  </div>
                </div>

                <div className="card">
                  <div className="card-h"><h3>คิวถัดไป</h3><span className="hint">รอโทร {queueRes.count ?? 0} ห้อง</span></div>
                  {queue.map((l, i) => (
                    <div className="list-row" key={l.id} style={{ gridTemplateColumns: "24px 1fr auto" }}>
                      <span className="mono muted">{i + 1}</span>
                      <span><b style={{ fontWeight: 500 }}>{l.condo}</b> <span className="muted small">คุณ{l.owner_name} · <span className="mono">{prettyPhone(l.phone)}</span></span></span>
                      <span className="small muted">{l.status === "queued" ? "" : l.next_call_at ? `โทรซ้ำ ${fmtTime(l.next_call_at)}` : ""}</span>
                    </div>
                  ))}
                  {!queue.length && <p className="empty">ไม่มีห้องในคิว</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
