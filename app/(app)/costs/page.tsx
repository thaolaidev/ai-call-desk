import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fmtDur } from "@/lib/time";
import { Top } from "@/components/Top";
import { setCostRate } from "./actions";

export const dynamic = "force-dynamic";
type SP = Promise<{ seg?: string; range?: string; from?: string; to?: string; saved?: string; err?: string }>;
const SEG_TABS = [["all", "ทั้งหมด"], ["new", "Check ทรัพย์ใหม่"], ["old", "Check สถานะห้อง"]] as const;
const RANGES = [["today", "วันนี้"], ["7d", "7 วัน"], ["30d", "30 วัน"], ["month", "เดือนนี้"], ["lastmonth", "เดือนก่อน"], ["all", "ทั้งหมด"]] as const;
const DAY = 24 * 3600_000;
const DEFAULT_RATE = 0.8;
const ymdBKK = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const startBKK = (ymd: string) => new Date(`${ymd}T00:00:00+07:00`);
const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const thDay = (ymd: string) => new Date(`${ymd}T12:00:00+07:00`).toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short", year: "2-digit", timeZone: "Asia/Bangkok" });

function rangeOf(range: string, from?: string, to?: string): { from: string | null; to: string | null; label: string } {
  const todayYmd = ymdBKK(new Date());
  const today = startBKK(todayYmd);
  const ok = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (range === "custom" && (ok(from) || ok(to))) {
    return { from: ok(from) ? startBKK(from!).toISOString() : null, to: ok(to) ? new Date(startBKK(to!).getTime() + DAY).toISOString() : null, label: `${from ?? "…"} ถึง ${to ?? "…"}` };
  }
  if (range === "today") return { from: today.toISOString(), to: null, label: "วันนี้" };
  if (range === "7d") return { from: new Date(today.getTime() - 6 * DAY).toISOString(), to: null, label: "7 วันล่าสุด" };
  if (range === "month") return { from: startBKK(`${todayYmd.slice(0, 7)}-01`).toISOString(), to: null, label: "เดือนนี้" };
  if (range === "lastmonth") {
    const [y, m] = todayYmd.split("-").map(Number);
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    return { from: startBKK(`${py}-${String(pm).padStart(2, "0")}-01`).toISOString(), to: startBKK(`${todayYmd.slice(0, 7)}-01`).toISOString(), label: "เดือนก่อน" };
  }
  if (range === "all") return { from: null, to: null, label: "ทั้งหมด" };
  return { from: new Date(today.getTime() - 29 * DAY).toISOString(), to: null, label: "30 วันล่าสุด" };
}

type Day = { calls: number; answered: number; sec: number; billMin: number };
const empty = (): Day => ({ calls: 0, answered: 0, sec: 0, billMin: 0 });

export default async function CostsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const seg = sp.seg === "old" || sp.seg === "new" ? sp.seg : "all";
  const range = RANGES.some(([k]) => k === sp.range) || sp.range === "custom" ? sp.range! : "30d";
  const rg = rangeOf(range, sp.from, sp.to);
  const sb = await createClient();

  const { data: s } = await sb.from("settings").select("*").eq("id", 1).single();
  const rate = Number((s as any)?.cost_per_min ?? DEFAULT_RATE) || DEFAULT_RATE;
  const hasRateCol = s ? "cost_per_min" in (s as any) : false;

  // สายที่โทรออกจริง (ไม่นับที่โทรออกไม่สำเร็จจากระบบ) · ค่าโทรคิดจากเวลาตั้งแต่เจ้าของรับสายจนวาง ปัดขึ้นเป็นนาทีทีละสาย
  // Supabase ส่งกลับได้ครั้งละไม่เกิน 1,000 แถว → ดึงทีละหน้าจนครบ (เดิมตัดที่ 1,000 สาย วันเก่าเลยหาย)
  const PAGE = 1000;
  const rows: any[] = [];
  let error: { message: string } | null = null;
  for (let off = 0; off < 200_000; off += PAGE) {
    let q = sb.from("calls").select("id, segment, started_at, duration_sec, state").eq("state", "ended")
      .order("started_at", { ascending: false }).order("id").range(off, off + PAGE - 1);
    if (seg !== "all") q = q.eq("segment", seg);
    if (rg.from) q = q.gte("started_at", rg.from);
    if (rg.to) q = q.lt("started_at", rg.to);
    const { data, error: e } = await q;
    if (e) { error = e; break; }
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }

  const byDay = new Map<string, Day>();
  const total = empty();
  for (const r of rows ?? []) {
    const d = ymdBKK(new Date(r.started_at));
    const v = byDay.get(d) ?? empty();
    const sec = Math.max(0, Number(r.duration_sec) || 0);
    const bill = sec > 0 ? Math.ceil(sec / 60) : 0;
    for (const x of [v, total]) { x.calls++; if (sec > 0) x.answered++; x.sec += sec; x.billMin += bill; }
    byDay.set(d, v);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => b.localeCompare(a));
  const nDays = Math.max(1, days.length);
  const maxCost = Math.max(1, ...days.map(([, v]) => v.billMin));

  const link = (o: Record<string, string>) => {
    const p = new URLSearchParams({ ...(seg !== "all" ? { seg } : {}), ...(range !== "30d" ? { range } : {}), ...(range === "custom" && sp.from ? { from: sp.from } : {}), ...(range === "custom" && sp.to ? { to: sp.to } : {}), ...o });
    if (p.get("seg") === "all") p.delete("seg");
    if (p.get("range") === "30d") p.delete("range");
    if (p.get("range") !== "custom") { p.delete("from"); p.delete("to"); }
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    return `/costs${p.size ? `?${p}` : ""}`;
  };

  return (
    <>
      <Top title="ค่าใช้จ่ายค่าโทร" sub={`${rg.label} · นาทีละ ${rate} บาท · คิดตั้งแต่เจ้าของรับสายจนวาง ปัดขึ้นเป็นนาทีทีละสาย`} />
      <div className="view">
        {error && <p className="banner err">{error.message}</p>}
        <nav className="segtabs" aria-label="ห้องโทร">
          {SEG_TABS.map(([k, label]) => (
            <Link key={k} href={link({ seg: k })} className={seg === k ? "on" : ""} aria-current={seg === k ? "page" : undefined}>{label}</Link>
          ))}
        </nav>
        <div className="date-filter">
          <div className="chips">
            {RANGES.map(([k, label]) => (
              <Link key={k} href={link({ range: k, from: "", to: "" })} className={`fchip ${range === k ? "on" : ""}`}>{label}</Link>
            ))}
          </div>
          <form action="/costs" className="date-custom">
            {seg !== "all" && <input type="hidden" name="seg" value={seg} />}
            <input type="hidden" name="range" value="custom" />
            <label>จาก <input type="date" name="from" defaultValue={range === "custom" ? sp.from ?? "" : ""} /></label>
            <label>ถึง <input type="date" name="to" defaultValue={range === "custom" ? sp.to ?? "" : ""} /></label>
            <button className={`btn sm ${range === "custom" ? "primary" : ""}`}>ดู</button>
          </form>
        </div>

        <div className="kpis">
          <div className="card kpi ac"><span className="lbl">ค่าโทรรวม</span><span className="val">฿{baht(total.billMin * rate)}</span><span className="sub">เฉลี่ยวันละ ฿{baht((total.billMin * rate) / nDays)}</span></div>
          <div className="card kpi cb"><span className="lbl">นาทีที่คิดเงิน</span><span className="val">{total.billMin.toLocaleString("th-TH")}<small> นาที</small></span><span className="sub">คุยจริงรวม {(total.sec / 60).toFixed(1)} นาที</span></div>
          <div className="card kpi ok"><span className="lbl">โทรออก</span><span className="val">{total.calls.toLocaleString("th-TH")}<small> สาย</small></span><span className="sub">รับสาย {total.answered} · ไม่รับ {total.calls - total.answered} (ไม่เสียเงิน)</span></div>
          <div className="card kpi wa"><span className="lbl">เฉลี่ยต่อสายที่รับ</span><span className="val">฿{baht(total.answered ? (total.billMin * rate) / total.answered : 0)}</span><span className="sub">คุยเฉลี่ย {fmtDur(total.answered ? Math.round(total.sec / total.answered) : 0)} นาที</span></div>
        </div>

        <div className="card">
          <div className="card-h"><h3>สรุปรายวัน</h3><span className="hint">{days.length} วัน</span></div>
          <div className="tbl-wrap">
            <table className="tbl stack" style={{ minWidth: 640 }}>
              <thead>
                <tr><th>วันที่</th><th style={{ textAlign: "right" }}>โทรออก (สาย)</th><th style={{ textAlign: "right" }}>รับสาย</th><th style={{ textAlign: "right" }}>คุยจริง</th><th style={{ textAlign: "right" }}>นาทีคิดเงิน</th><th style={{ textAlign: "right" }}>ค่าโทร (บาท)</th><th style={{ width: "22%" }}></th></tr>
              </thead>
              <tbody>
                {days.map(([d, v]) => (
                  <tr key={d}>
                    <td data-label="วันที่">{thDay(d)}</td>
                    <td data-label="โทรออก" className="mono" style={{ textAlign: "right" }}>{v.calls}</td>
                    <td data-label="รับสาย" className="mono" style={{ textAlign: "right" }}>{v.answered}</td>
                    <td data-label="คุยจริง (นาที:วินาที)" className="mono" style={{ textAlign: "right" }}>{fmtDur(v.sec)}</td>
                    <td data-label="นาทีคิดเงิน" className="mono" style={{ textAlign: "right" }}>{v.billMin}</td>
                    <td data-label="ค่าโทร" className="mono" style={{ textAlign: "right" }}><b>{baht(v.billMin * rate)}</b></td>
                    <td aria-hidden="true"><div className="bar" style={{ margin: 0 }}><i style={{ width: `${(v.billMin / maxCost) * 100}%` }} /></div></td>
                  </tr>
                ))}
                {!days.length && <tr><td colSpan={7} className="empty">ยังไม่มีสายในช่วงนี้</td></tr>}
              </tbody>
              {days.length > 1 && (
                <tfoot>
                  <tr>
                    <td><b>รวม</b></td>
                    <td className="mono" style={{ textAlign: "right" }}><b>{total.calls}</b></td>
                    <td className="mono" style={{ textAlign: "right" }}><b>{total.answered}</b></td>
                    <td className="mono" style={{ textAlign: "right" }}><b>{fmtDur(total.sec)}</b></td>
                    <td className="mono" style={{ textAlign: "right" }}><b>{total.billMin}</b></td>
                    <td className="mono" style={{ textAlign: "right" }}><b>{baht(total.billMin * rate)}</b></td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>

        <form action={setCostRate} className="card card-b" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label htmlFor="cost_per_min">ค่าโทรต่อนาที (บาท)</label>
          <input id="cost_per_min" name="cost_per_min" type="number" step="0.01" min="0" defaultValue={rate} style={{ width: 110 }} />
          <button className="btn sm primary">บันทึก</button>
          <span className="small muted">
            {hasRateCol ? "ใช้คำนวณทุกวันย้อนหลังด้วย" : "ยังไม่ได้รัน update_0018_cost.sql — ตอนนี้ใช้ 0.8 บาท"} · สายที่ไม่รับ / โทรไม่ติดไม่คิดเงิน · ตัวเลขเป็นค่าประมาณ เทียบบิลจริงจากผู้ให้บริการอีกครั้ง
          </span>
        </form>
      </div>
    </>
  );
}
