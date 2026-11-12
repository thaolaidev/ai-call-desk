import { createClient } from "@/lib/supabase/server";
import { todayRangeBKK, fmtTime } from "@/lib/time";
import { prettyPhone } from "@/lib/phone";
import { Top } from "@/components/Top";
import { AutoRefresh } from "@/components/AutoRefresh";
import { RunButton } from "@/components/RunButton";
import { updateCampaign } from "./actions";

export const dynamic = "force-dynamic";
const STATE_LABEL: Record<string, string> = { dialing: "กำลังต่อสาย", ringing: "กำลังเรียก", in_progress: "กำลังคุย" };
const DAYS = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

export default async function CallingPage() {
  const sb = await createClient();
  const { from, to } = todayRangeBKK();
  const [{ data: s, error }, { count: today }, { data: live }, { data: queue, count: qCount }] = await Promise.all([
    sb.from("settings").select("*").eq("id", 1).single(),
    sb.from("calls").select("id", { count: "exact", head: true }).gte("started_at", from).lt("started_at", to),
    sb.from("calls").select("id, state, started_at, attempt, leads!calls_lead_id_fkey(condo, unit, owner_name, phone, segment)").in("state", ["dialing", "ringing", "in_progress"]).order("started_at"),
    sb.from("leads").select("id, condo, owner_name, phone, status, attempts, segment", { count: "exact" }).eq("status", "queued").order("created_at").limit(10),
  ]);
  if (error || !s) return <div className="view"><p className="banner err">{error?.message ?? "ไม่พบ settings"}</p></div>;

  const done = today ?? 0;
  const perHour = Math.round((s.concurrency * 60) / 2.6);
  const hrs = s.daily_cap / perHour;
  const lines = Array.from({ length: 10 }, (_, i) => (live ?? [])[i] as any);

  return (
    <>
      <Top title="แคมเปญโทร" sub="จำนวนสายพร้อมกัน เป้าต่อวัน และสายที่กำลังทำงาน">
        <span className="chip"><span className={`dot ${s.running ? "live" : ""}`} />{s.provider === "simulate" ? "โหมดจำลอง" : s.provider === "yalecom" ? "Yalecom (โทรจริง)" : "Vapi (โทรจริง)"}</span>
        <RunButton running={s.running} />
      </Top>
      <AutoRefresh ms={5000} ping={s.running || (live?.length ?? 0) > 0} />
      <div className="view">
        <div className="card">
          <div className="card-h"><h2>ความคืบหน้าวันนี้</h2><span className="mono">{done} / {s.daily_cap} สาย</span></div>
          <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="bar"><i style={{ width: `${Math.min(100, (done / s.daily_cap) * 100)}%` }} /></div>
            <p className="small muted">{s.concurrency} สายพร้อมกัน ≈ {perHour} สาย/ชม. (เฉลี่ย 2.6 นาทีต่อสาย) · เป้า {s.daily_cap} สายใช้เวลาราว {hrs < 1 ? `${Math.round(hrs * 60)} นาที` : `${hrs.toFixed(1)} ชม.`}</p>
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h2>สายที่กำลังทำงาน</h2><span className="hint">ใช้งาน {live?.length ?? 0} จาก {s.concurrency} สาย</span></div>
          <div className="card-b lines">
            {lines.map((c, i) => {
              if (i >= s.concurrency) return <div key={i} className="line off"><div className="line-h"><b>สาย {i + 1}</b><span className="muted">ปิดอยู่</span></div></div>;
              if (!c) return <div key={i} className="line"><div className="line-h"><b>สาย {i + 1}</b><span className="muted">ว่าง</span></div><p className="small muted">{s.running ? "รอลีดถัดไป" : "หยุดชั่วคราว"}</p></div>;
              const l = Array.isArray(c.leads) ? c.leads[0] : c.leads;
              return (
                <div key={c.id} className={`line ${c.state}`}>
                  <div className="line-h"><b>สาย {i + 1}</b><span>{STATE_LABEL[c.state]}</span></div>
                  <b>{l?.condo} <span className="seg">{l?.segment === "old" ? "เก่า" : "ใหม่"}</span></b>
                  <span className="small muted">คุณ{l?.owner_name} · <span className="mono">{l ? prettyPhone(l.phone) : ""}</span></span>
                  <span className="small muted">เริ่ม {fmtTime(c.started_at)} · ครั้งที่ {c.attempt}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="grid2">
          <form className="card" action={updateCampaign}>
            <div className="card-h"><h2>ตั้งค่าแคมเปญ</h2><button className="btn sm primary">บันทึก</button></div>
            <div className="card-b form-grid">
              <div className="field"><label htmlFor="concurrency">โทรพร้อมกัน (1–10 สาย)</label><input id="concurrency" name="concurrency" type="number" min={1} max={10} defaultValue={s.concurrency} /></div>
              <div className="field"><label htmlFor="daily_cap">เป้าหมายต่อวัน (สาย)</label><input id="daily_cap" name="daily_cap" type="number" min={1} defaultValue={s.daily_cap} /></div>
              <div className="field"><label htmlFor="call_start">เริ่มโทร</label><input id="call_start" name="call_start" type="time" defaultValue={String(s.call_start).slice(0, 5)} /></div>
              <div className="field"><label htmlFor="call_end">หยุดโทร</label><input id="call_end" name="call_end" type="time" defaultValue={String(s.call_end).slice(0, 5)} /></div>
              <div className="field"><label htmlFor="retry_gap_min">ไม่รับสาย: โทรซ้ำทุก (นาที)</label><input id="retry_gap_min" name="retry_gap_min" type="number" min={15} defaultValue={s.retry_gap_min} /></div>
              <div className="field"><label htmlFor="max_attempts">โทรสูงสุด (ครั้ง)</label><input id="max_attempts" name="max_attempts" type="number" min={1} max={10} defaultValue={s.max_attempts} /></div>
              <div className="field"><label htmlFor="stale_days">ทรัพย์เก่า: โทรเช็คเมื่อไม่ได้อัปเดตเกิน (วัน)</label><input id="stale_days" name="stale_days" type="number" min={1} max={365} defaultValue={s.stale_days ?? 30} /></div>
              <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="small muted" style={{ fontWeight: 500, marginBottom: 6 }}>วันที่โทร</legend>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {DAYS.map((d, i) => (
                    <label key={d} className="toggle"><input type="checkbox" name="call_days" value={i} defaultChecked={s.call_days.includes(i)} />{d}</label>
                  ))}
                </div>
              </fieldset>
              <label className="toggle"><input type="checkbox" name="auto_queue" defaultChecked={s.auto_queue} />ส่งห้องใหม่เข้าคิวอัตโนมัติ</label>
            </div>
          </form>

          <div className="card">
            <div className="card-h"><h2>คิวถัดไป</h2><span className="hint">รอโทร {qCount ?? 0} ห้อง</span></div>
            {(queue ?? []).map((l: any, i: number) => (
              <div className="list-row" key={l.id} style={{ gridTemplateColumns: "28px 1fr" }}>
                <span className="mono muted">{i + 1}</span>
                <span><span className="seg">{l.segment === "old" ? "เก่า" : "ใหม่"}</span> <b style={{ fontWeight: 500 }}>{l.condo}</b> <span className="muted small">คุณ{l.owner_name} · <span className="mono">{prettyPhone(l.phone)}</span></span></span>
              </div>
            ))}
            {!queue?.length && <p className="empty">ไม่มีห้องในคิว ไปที่กองลีดเพื่อส่งเข้าคิว</p>}
          </div>
        </div>
      </div>
    </>
  );
}
