import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { todayRangeBKK, fmtTime } from "@/lib/time";
import { prettyPhone } from "@/lib/phone";
import { Top } from "@/components/Top";
import { AutoRefresh } from "@/components/AutoRefresh";
import { setChatMode, removeChatQueued, callNow, addCallNow } from "./actions";

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
const RETRY_WHY: Record<string, string> = { noanswer: "ไม่รับสาย", unclear: "ฟังไม่ชัด", callback: "ขอให้โทรกลับ" };
/** สถานะในคิว: รอโทร / ไม่รับสาย · โทรซ้ำ 10:38 (ครั้งที่ 2/3) */
function waitLabel(l: any, max: number) {
  if (l.status === "queued") return "รอโทร";
  const when = l.next_call_at ? (Date.parse(l.next_call_at) <= Date.now() ? "โทรซ้ำรอบนี้" : `โทรซ้ำ ${fmtTime(l.next_call_at)}`) : "โทรซ้ำ";
  return `${RETRY_WHY[l.status] ?? l.status} · ${when} (ครั้งที่ ${(l.attempts ?? 0) + 1}/${max})`;
}

const QPAGE = 20; // คิวรอโทร: หน้าละกี่ห้อง

export default async function CallingPage({ searchParams }: { searchParams: Promise<{ qn?: string; qo?: string }> }) {
  const sp = await searchParams;
  // หน้าของคิวแต่ละห้อง (qn = Check ทรัพย์ใหม่, qo = Check สถานะห้อง)
  const qpage: Record<string, number> = { new: Math.max(1, Number(sp.qn) || 1), old: Math.max(1, Number(sp.qo) || 1) };
  const qhref = (seg: string, n: number) => {
    const p = new URLSearchParams({ ...(sp.qn ? { qn: sp.qn } : {}), ...(sp.qo ? { qo: sp.qo } : {}), [seg === "new" ? "qn" : "qo"]: String(n) });
    for (const [k, v] of [...p.entries()]) if (v === "1") p.delete(k);
    return `/calling${p.size ? `?${p}` : ""}#queue-${seg}`;
  };
  const sb = await createClient();
  const { from, to } = todayRangeBKK();
  const now = new Date().toISOString();

  const [{ data: s, error }, { data: rooms }, { data: live }, ...perSeg] = await Promise.all([
    sb.from("settings").select("*").eq("id", 1).single(),
    sb.from("call_rooms").select("*").order("segment"),
    sb.from("calls").select("id, state, started_at, attempt, segment, leads!calls_lead_id_fkey(condo, unit, owner_name, phone, segment)").in("state", IN_FLIGHT).order("started_at"),
    ...SEGS.flatMap((seg) => [
      sb.from("calls").select("id", { count: "exact", head: true }).eq("segment", seg).gte("started_at", from).lt("started_at", to),
      // รอโทร + รอโทรซ้ำ (ไม่รับสาย / ฟังไม่ชัด / ขอให้โทรกลับ) ทั้งที่ถึงเวลาแล้วและยังไม่ถึง
      sb.from("leads").select("id, condo, code, phone, status, attempts, next_call_at, chat_requested_by, chat_requested_at", { count: "exact" })
        .eq("segment", seg)
        .not("chat_requested_at", "is", null)
        .in("status", ["queued", "noanswer", "unclear", "callback"])
        .order("next_call_at", { ascending: true, nullsFirst: true }).order("chat_requested_at")
        .range((qpage[seg] - 1) * QPAGE, qpage[seg] * QPAGE - 1),
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
                    <span className="room-stat">{today}<small>{room.daily_cap > 0 ? ` / ${room.daily_cap} สาย` : " สาย · ไม่จำกัด"}</small></span>
                    <span className="small muted">ใช้ {calls.length}/{room.concurrency} สาย · รอโทร {waitN} ห้อง</span>
                  </div>
                  {room.daily_cap > 0 && <div className="bar"><i style={{ width: `${Math.min(100, (today / room.daily_cap) * 100)}%` }} /></div>}
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

                <details className="card add-call">
                  <summary className="card-h"><h3>+ เพิ่มห้องโทรเอง</h3><span className="hint">ไม่ต้องพิมพ์ในแชท</span></summary>
                  <form action={addCallNow} className="card-b add-call-form">
                    <input type="hidden" name="segment" value={seg} />
                    <input name="phone" required placeholder="เบอร์ 08x-xxx-xxxx" inputMode="tel" aria-label="เบอร์โทร" />
                    <input name="condo" required placeholder="ชื่อคอนโด" aria-label="ชื่อคอนโด" />
                    <input name="rent" placeholder="ราคา" inputMode="numeric" aria-label="ราคา" />
                    <button className="btn primary sm">เข้าคิวโทร</button>
                  </form>
                  <p className="small muted" style={{ padding: "0 16px 12px", margin: 0 }}>ผลดูได้ที่หน้าผลการโทร · ห้องที่เพิ่มเองไม่ขึ้นป้ายในแชท</p>
                </details>

                <div className="card">
                  <div className="card-h" id={`queue-${seg}`}><h3>คิวรอโทร</h3><span className="hint">{waitN} ห้อง</span></div>
                  {queue.length > 0 ? queue.map((l, i) => (
                    <div className="q-row" key={l.id}>
                      <div className="q-main">
                        <b><span className="q-no">{(qpage[seg] - 1) * QPAGE + i + 1}.</span> {l.code ? <span className="mono">{l.code} </span> : null}{l.condo}</b>
                        <span className="small muted">
                          <span className="mono">{prettyPhone(l.phone)}</span> · {l.chat_requested_by ?? "-"} {fmtTime(l.chat_requested_at)} · {waitLabel(l, s.max_attempts ?? 3)}
                        </span>
                      </div>
                      <div className="q-acts">
                        {l.status !== "queued" && l.next_call_at && l.next_call_at > now && (
                          <form action={callNow}>
                            <input type="hidden" name="id" value={l.id} />
                            <button className="btn sm" title="โทรซ้ำรอบถัดไปเลย ไม่ต้องรอเวลา">โทรเลย</button>
                          </form>
                        )}
                        <form action={removeChatQueued}>
                          <input type="hidden" name="id" value={l.id} />
                          <button className="btn sm" title="เอาห้องนี้ออกจากคิว AI จะไม่โทร">ลบ</button>
                        </form>
                      </div>
                    </div>
                  )) : <p className="empty">ไม่มีห้องในคิว</p>}
                  {waitN > 0 && (
                    <form action={removeChatQueued} className="card-b" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <input type="hidden" name="all" value="1" />
                      <input type="hidden" name="segment" value={seg} />
                      <button className="btn sm stop">ลบทั้งคิว ({waitN} ห้อง)</button>
                      {waitN > QPAGE && (
                        <span className="q-pager">
                          {qpage[seg] > 1 ? <Link className="btn sm" href={qhref(seg, qpage[seg] - 1)}>‹ ก่อนหน้า</Link> : <span className="btn sm" aria-disabled="true">‹ ก่อนหน้า</span>}
                          <span className="small muted">หน้า {qpage[seg]} / {Math.max(1, Math.ceil(waitN / QPAGE))} · ห้องที่ {(qpage[seg] - 1) * QPAGE + 1}–{Math.min(waitN, qpage[seg] * QPAGE)}</span>
                          {qpage[seg] * QPAGE < waitN ? <Link className="btn sm" href={qhref(seg, qpage[seg] + 1)}>ถัดไป ›</Link> : <span className="btn sm" aria-disabled="true">ถัดไป ›</span>}
                        </span>
                      )}
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
