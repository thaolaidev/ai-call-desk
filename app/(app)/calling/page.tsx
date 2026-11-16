import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { todayRangeBKK, fmtTime } from "@/lib/time";
import { prettyPhone } from "@/lib/phone";
import { Top } from "@/components/Top";
import { AutoRefresh } from "@/components/AutoRefresh";
import { setChatMode, removeChatQueued } from "./actions";

export const dynamic = "force-dynamic";
const STATE_LABEL: Record<string, string> = { dialing: "กำลังต่อสาย", ringing: "กำลังเรียก", in_progress: "กำลังคุย" };
const SEGS = ["new", "old"] as const;
const IN_FLIGHT = ["dialing", "ringing", "in_progress"];
const ROOM_HINT: Record<string, string> = {
  new: "แอดมินพิมพ์ “เบอร์ + ชื่อคอนโด” ในกลุ่ม → ผลขึ้นที่ปุ่มใต้ข้อความ",
  old: "ทีมค้นห้อง / รหัสห้องในกลุ่ม → ผลขึ้นที่การ์ดห้อง + สถานะบนเว็บ",
};
const MODE_UI = [
  ["auto", "โทรทันที", "ส่งมาแล้ว AI โทรเลย"],
  ["queue", "รับเข้าคิว · รอกดโทร", "เก็บห้องไว้ก่อน กด “โทรทันที” เมื่อพร้อม"],
  ["off", "ปิดรับ", "ค้นในแชทได้ตามปกติ แต่ไม่ส่งมาให้ AI"],
] as const;
const MODE_CHIP: Record<string, string> = { auto: "โทรทันที", queue: "รอกดโทร", off: "ปิดรับ" };

export default async function CallingPage() {
  const sb = await createClient();
  const { from, to } = todayRangeBKK();
  const now = new Date().toISOString();

  const [{ data: s, error }, { data: rooms }, { data: live }, ...perSeg] = await Promise.all([
    sb.from("settings").select("*").eq("id", 1).single(),
    sb.from("call_rooms").select("*").order("segment"),
    sb.from("calls").select("id, state, started_at, attempt, segment, leads!calls_lead_id_fkey(condo, unit, owner_name, phone, segment)").in("state", IN_FLIGHT).order("started_at"),
    ...SEGS.flatMap((seg) => [
      sb.from("calls").select("id", { count: "exact", head: true }).eq("segment", seg).gte("started_at", from).lt("started_at", to),
      sb.from("leads").select("id, condo, code, phone, status, next_call_at, chat_requested_by, chat_requested_at", { count: "exact" })
        .eq("segment", seg)
        .not("chat_requested_at", "is", null)
        .or(`status.eq.queued,and(status.in.(noanswer,unclear,callback),next_call_at.lt."${now}")`)
        .order("chat_requested_at").limit(10),
    ]),
  ]);
  if (error || !s) return <div className="view"><p className="banner err">{error?.message ?? "ไม่พบ settings"}</p></div>;
  if (!rooms?.length) return <div className="view"><p className="banner err">ยังไม่มีห้องโทร · รันไฟล์ update_0006_rooms.sql ใน Supabase ก่อน</p></div>;
  const needSql = rooms.some((r: any) => r.chat_mode === undefined);

  const provider = s.provider === "simulate" ? "โหมดจำลอง" : s.provider === "sip" ? "Server เสียง (โทรจริง)" : s.provider === "yalecom" ? "Yalecom (โทรจริง)" : "Vapi (โทรจริง)";
  const liveCalls = (live ?? []) as any[];
  const anyAuto = rooms.some((r: any) => r.chat_mode === "auto");

  return (
    <>
      <Top title="ห้องโทร" sub={`2 ห้องตามกลุ่มแชท แยกสาย แยกคิว แยกเปิด-ปิด · โทรได้ ${String(s.call_start).slice(0, 5)}–${String(s.call_end).slice(0, 5)} น.`}>
        <span className="chip"><span className={`dot ${anyAuto ? "live" : ""}`} />{provider}</span>
        <Link className="btn" href="/settings#campaign">ตั้งค่าการโทร</Link>
      </Top>
      <AutoRefresh ms={8000} ping={anyAuto || liveCalls.length > 0} />
      <div className="view">
        {needSql && <p className="banner err">ยังไม่ได้รัน update_0017_rooms.sql ใน Supabase · ปุ่มโหมดของแต่ละห้องจะยังใช้ไม่ได้</p>}
        <div className="half">
          {SEGS.map((seg, k) => {
            const room: any = rooms.find((r: any) => r.segment === seg) ?? { name: seg, concurrency: 0, daily_cap: 0 };
            const mode: string = room.chat_mode ?? "queue";
            const today = (perSeg[k * 2] as any).count ?? 0;
            const queueRes: any = perSeg[k * 2 + 1];
            const queue: any[] = queueRes.data ?? [];
            const waitN: number = queueRes.count ?? 0;
            const calls = liveCalls.filter((c) => (c.segment ?? (Array.isArray(c.leads) ? c.leads[0] : c.leads)?.segment) === seg);
            const lines = Array.from({ length: room.concurrency }, (_, i) => calls[i]);
            const extra = calls.slice(room.concurrency);
            return (
              <div key={seg} className="room-col">
                <div className={`card room ${mode === "auto" ? "on" : ""}`}>
                  <div className="room-row">
                    <h2>ห้อง {room.name}</h2>
                    <span className="chip"><span className={`dot ${mode === "auto" && calls.length ? "live" : ""}`} />{MODE_CHIP[mode] ?? mode}</span>
                  </div>
                  <span className="small muted">{ROOM_HINT[seg]}</span>
                  <form action={setChatMode} className="mode-btns" role="radiogroup" aria-label={`โหมดห้อง ${room.name}`}>
                    <input type="hidden" name="segment" value={seg} />
                    {MODE_UI.map(([key, label, hint]) => (
                      <button key={key} name="chat_mode" value={key} className={`btn sm ${mode === key ? (key === "off" ? "stop" : "primary") : ""}`} aria-pressed={mode === key} title={hint}>
                        {label}
                      </button>
                    ))}
                  </form>
                  <div className="room-row">
                    <span className="room-stat">{today}<small> / {room.daily_cap} สาย</small></span>
                    <span className="small muted">ใช้ {calls.length}/{room.concurrency} สาย · รอโทร {waitN} ห้อง</span>
                  </div>
                  <div className="bar"><i style={{ width: `${room.daily_cap ? Math.min(100, (today / room.daily_cap) * 100) : 0}%` }} /></div>
                  {mode === "queue" && waitN > 0 && <span className="small muted">กด “โทรทันที” เพื่อเริ่มโทรห้องที่รอ</span>}
                </div>

                <div className="card">
                  <div className="card-h"><h3>สายที่กำลังทำงาน</h3><span className="hint">{calls.length} จาก {room.concurrency} สาย</span></div>
                  <div className="card-b lines lines-3">
                    {[...lines, ...extra].map((c, i) => {
                      if (!c) return <div key={i} className="line free"><div className="line-h"><b>สาย {i + 1}</b><span className="pill t-ok">ว่าง</span></div><p className="small muted">{mode === "auto" ? "รอห้องถัดไป" : "หยุดชั่วคราว"}</p></div>;
                      const l = Array.isArray(c.leads) ? c.leads[0] : c.leads;
                      return (
                        <div key={c.id} className={`line ${c.state}`}>
                          <div className="line-h"><b>สาย {i + 1}</b><span className="pill t-bad busy-pill">กำลังโทร</span></div>
                          <b>{l?.condo}</b>
                          <span className="small muted"><span className="mono">{l ? prettyPhone(l.phone) : ""}</span></span>
                          <span className="small muted">{STATE_LABEL[c.state]} · เริ่ม {fmtTime(c.started_at)} · ครั้งที่ {c.attempt}</span>
                        </div>
                      );
                    })}
                    {!room.concurrency && <p className="small muted">ห้องนี้ตั้งไว้ 0 สาย</p>}
                  </div>
                </div>

                <div className="card">
                  <div className="card-h"><h3>คิวรอโทร</h3><span className="hint">{waitN} ห้อง</span></div>
                  {queue.length > 0 ? queue.map((l) => (
                    <div className="q-row" key={l.id}>
                      <div className="q-main">
                        <b>{l.code ? <span className="mono">{l.code} </span> : null}{l.condo}</b>
                        <span className="small muted">
                          <span className="mono">{prettyPhone(l.phone)}</span> · {l.chat_requested_by ?? "-"} {fmtTime(l.chat_requested_at)} · {l.status === "queued" ? "รอโทร" : `รอโทรซ้ำ${l.next_call_at ? ` ${fmtTime(l.next_call_at)}` : ""}`}
                        </span>
                      </div>
                      <form action={removeChatQueued}>
                        <input type="hidden" name="id" value={l.id} />
                        <button className="btn sm" title="เอาห้องนี้ออกจากคิว AI จะไม่โทร">ลบ</button>
                      </form>
                    </div>
                  )) : <p className="empty">ไม่มีห้องในคิว</p>}
                  {waitN > 0 && (
                    <form action={removeChatQueued} className="card-b" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <input type="hidden" name="all" value="1" />
                      <input type="hidden" name="segment" value={seg} />
                      <button className="btn sm stop">ลบทั้งคิว ({waitN} ห้อง)</button>
                      {waitN > queue.length && <span className="small muted">แสดง {queue.length} ห้องแรก</span>}
                    </form>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
