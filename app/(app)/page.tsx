import { createClient } from "@/lib/supabase/server";
import { todayRangeBKK, bkkClock, fmtDur, fmtTime } from "@/lib/time";
import { STATUS, OUTCOMES } from "@/lib/status";
import { prettyPhone } from "@/lib/phone";
import { Top } from "@/components/Top";
import { HourlyChart } from "@/components/HourlyChart";
import { AutoRefresh } from "@/components/AutoRefresh";
import { RunButton } from "@/components/RunButton";
import { completeTask } from "./actions";
import Link from "next/link";

export const dynamic = "force-dynamic";

const TONE_COLOR: Record<string, string> = {
  ok: "var(--ok)", cb: "var(--cb)", ne: "var(--ink)", wa: "var(--warn)", bad: "var(--bad)", ac: "var(--accent)", idle: "var(--idle)",
};

export default async function Dashboard() {
  const sb = await createClient();
  const { from, to } = todayRangeBKK();
  const [stats, hours, settings, inflight, tasks, counts] = await Promise.all([
    sb.rpc("call_stats", { p_from: from, p_to: to }),
    sb.rpc("calls_by_hour", { p_from: from, p_to: to }),
    sb.from("settings").select("*").eq("id", 1).single(),
    sb.from("calls").select("id", { count: "exact", head: true }).in("state", ["dialing", "ringing", "in_progress"]),
    sb.from("admin_tasks").select("id, note, created_at, leads(condo, unit, rent, owner_name, phone)").eq("status", "open").order("created_at", { ascending: false }).limit(8),
    sb.rpc("lead_counts"),
  ]);

  if (settings.error) {
    return (
      <>
        <Top title="แดชบอร์ด" />
        <div className="view">
          <p className="banner err">อ่านข้อมูลไม่ได้: {settings.error.message} · ตรวจว่ารัน migration แล้ว และอีเมลของคุณอยู่ในตาราง team_members</p>
        </div>
      </>
    );
  }

  const s = settings.data;
  const by: Record<string, number> = {};
  let n = 0, talk = 0, cost = 0;
  for (const r of stats.data ?? []) {
    by[r.outcome] = Number(r.n);
    n += Number(r.n);
    if (!["noanswer", "invalid", "unclear", "pending", "failed"].includes(r.outcome)) talk += Number(r.talk_sec);
    cost += Number(r.cost);
  }
  const g = (k: string) => by[k] ?? 0;
  const ended = n - g("pending") - g("failed");
  const fail = g("noanswer") + g("invalid") + g("unclear");
  const conn = ended - fail;
  const avail = g("avail_ok") + g("avail_profile") + g("avail_no");
  const hand = g("avail_ok") + g("avail_profile");
  const pct = (x: number) => (ended ? Math.round((x / ended) * 100) : 0);

  const lc: Record<string, number> = {};
  for (const r of counts.data ?? []) lc[r.status] = Number(r.n);
  const queued = lc.queued ?? 0;

  return (
    <>
      <Top title="แดชบอร์ด" sub="ภาพรวมการโทรวันนี้">
        <span className="chip"><span className={`dot ${s.running ? "live" : ""}`} />{s.running ? "กำลังโทร" : "หยุดอยู่"} · {s.provider === "simulate" ? "โหมดจำลอง" : s.provider === "yalecom" ? "Yalecom" : "Vapi"}</span>
        <RunButton running={s.running} />
      </Top>
      <AutoRefresh ms={15000} ping={s.running || (inflight.count ?? 0) > 0} />
      <div className="view">
        <div className="kpis">
          <div className="card kpi ac"><span className="lbl">โทรแล้ววันนี้</span><span className="val">{n}<small> / {s.daily_cap}</small></span><div className="bar"><i style={{ width: `${Math.min(100, (n / s.daily_cap) * 100)}%` }} /></div></div>
          <div className="card kpi ok"><span className="lbl">โทรสำเร็จ (คุยกับเจ้าของได้)</span><span className="val">{conn}</span><span className="sub">{pct(conn)}% ของสายที่จบแล้ว</span></div>
          <div className="card kpi wa"><span className="lbl">ไม่สำเร็จ</span><span className="val">{fail}</span><span className="sub">ไม่รับสาย {g("noanswer")} · ฟังไม่ชัด {g("unclear")} · ติดต่อไม่ได้ {g("invalid")}{g("failed") ? ` · ระบบโทรผิดพลาด ${g("failed")}` : ""}</span></div>
          <div className="card kpi ok"><span className="lbl">ห้องว่าง</span><span className="val">{avail}</span><span className="sub">ไม่ว่าง {g("not_avail")} ห้อง</span></div>
          <div className="card kpi ok"><span className="lbl">ส่งต่อแอดมิน</span><span className="val">{hand}</span><span className="sub">รับต่างชาติ {g("avail_ok")} · ขอดูโปรไฟล์ {g("avail_profile")}</span></div>
          <div className="card kpi cb"><span className="lbl">ว่าง แต่ไม่รับต่างชาติ</span><span className="val">{g("avail_no")}</span><span className="sub">ฟังกฎแล้วยังไม่รับ</span></div>
        </div>

        <div className="card livebar">
          <span>กำลังโทร <b className="mono">{inflight.count ?? 0}</b> / {s.concurrency} สาย</span><span className="sep" />
          <span>รอในคิว <b className="mono">{queued}</b> ห้อง</span><span className="sep" />
          <span className="muted small">คุยเฉลี่ย <span className="mono">{fmtDur(conn ? Math.round(talk / conn) : 0)}</span> · ค่าโทรวันนี้ ~฿{Math.round(cost).toLocaleString("th-TH")}</span>
          <span style={{ marginLeft: "auto" }}><Link className="btn sm" href="/calling">ดูสายที่กำลังโทร</Link></span>
        </div>

        <div className="grid2">
          <div className="card">
            <div className="card-h"><h2>จำนวนสายรายชั่วโมง วันนี้</h2><div className="legend"><span><i style={{ background: "var(--ok)" }} />ติดต่อได้</span><span><i style={{ background: "var(--idle)" }} />ไม่รับสาย / ติดต่อไม่ได้</span></div></div>
            <div className="card-b"><HourlyChart rows={(hours.data ?? []) as any} currentHour={Math.floor(bkkClock().minutes / 60)} /></div>
          </div>
          <div className="card">
            <div className="card-h"><h2>ผลการโทรวันนี้</h2></div>
            <div className="card-b">
              {OUTCOMES.map((o) => (
                <div className="orow" key={o}>
                  <span style={{ display: "flex", gap: 8, alignItems: "center" }}><i style={{ width: 10, height: 10, borderRadius: 3, background: TONE_COLOR[STATUS[o].tone] }} />{STATUS[o].label}</span>
                  <b className="mono" style={{ fontWeight: 500 }}>{g(o)}</b>
                  <span className="mono muted small" style={{ textAlign: "right" }}>{pct(g(o))}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h2>งานแอดมิน: ส่งโปรไฟล์ลูกค้าให้เจ้าของ</h2><span className="hint">{tasks.data?.length ?? 0} งานค้าง</span></div>
          {(tasks.data ?? []).length === 0 && <p className="empty">ยังไม่มีงานค้าง</p>}
          {(tasks.data ?? []).map((t: any) => {
            const l = Array.isArray(t.leads) ? t.leads[0] : t.leads;
            return (
              <div className="list-row" key={t.id}>
                <span className="mono muted small">{fmtTime(t.created_at)}</span>
                <span>
                  <b>{l?.condo}</b> <span className="muted small">· {l?.unit} {l?.rent ? `· ฿${l.rent.toLocaleString("th-TH")}` : ""}</span><br />
                  <span className="small">คุณ{l?.owner_name} <span className="mono">{l ? prettyPhone(l.phone) : ""}</span> · {t.note}</span>
                </span>
                <form action={completeTask}><input type="hidden" name="id" value={t.id} /><button className="btn sm">ส่งแล้ว</button></form>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
