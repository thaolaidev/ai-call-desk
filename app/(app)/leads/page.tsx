import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { STATUS, QUEUEABLE, type LeadStatus } from "@/lib/status";
import { prettyPhone } from "@/lib/phone";
import { fmtDateTime, fmtTime } from "@/lib/time";
import { Top } from "@/components/Top";
import { Pill } from "@/components/Pill";
import { CsvImport } from "@/components/CsvImport";
import { SelectAll } from "@/components/SelectAll";
import { addLead, queueLeads } from "./actions";

export const dynamic = "force-dynamic";
const PER = 50;

type Seg = "new" | "old";
type Tab = "today" | "called" | "all";
const SEG_LABEL: Record<Seg, string> = { new: "ทรัพย์ใหม่", old: "ทรัพย์เก่า" };
const TAB_LABEL: Record<Tab, string> = { today: "จะโทรวันนี้", called: "โทรแล้ว · อัปเดตสถานะแล้ว", all: "ทั้งหมด" };
const RESULT_STATUSES = ["avail_ok", "avail_profile", "avail_no", "not_avail", "callback", "noanswer", "invalid", "wrong_number", "dnc", "closed"];

type SP = Promise<{ seg?: string; tab?: string; status?: string; q?: string; page?: string }>;

export default async function LeadsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const seg: Seg = sp.seg === "old" ? "old" : "new";
  const tab: Tab = sp.tab === "called" || sp.tab === "all" ? sp.tab : "today";
  const status = sp.status && STATUS[sp.status] ? sp.status : "";
  const q = (sp.q ?? "").trim();
  const page = Math.max(1, Number(sp.page) || 1);
  const sb = await createClient();

  // ---- นับจำนวนสำหรับแท็บ ----
  const { data: counts, error: cErr } = await sb.rpc("lead_tab_counts");
  const cnt = { new: { today: 0, called: 0, all: 0 }, old: { today: 0, called: 0, all: 0 } };
  const statusCnt: Record<string, number> = {};
  for (const r of (counts ?? []) as { segment: Seg; status: string; due_today: boolean; called: boolean; n: number }[]) {
    const n = Number(r.n);
    const c = cnt[r.segment];
    if (!c) continue;
    c.all += n;
    if (r.due_today) c.today += n;
    if (r.called) c.called += n;
    if (r.segment === seg && (tab === "all" || (tab === "called" && r.called) || (tab === "today" && r.due_today))) {
      statusCnt[r.status] = (statusCnt[r.status] ?? 0) + n;
    }
  }

  // ---- รายการ ----
  let query = sb.from("leads_v").select("*", { count: "exact" }).eq("segment", seg);
  if (tab === "today") query = query.eq("due_today", true).order("next_call_at", { ascending: true, nullsFirst: true }).order("created_at");
  if (tab === "called") query = query.eq("called", true).order("last_called_at", { ascending: false, nullsFirst: false });
  if (tab === "all") query = query.order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);
  if (q) {
    const safe = q.replace(/[,()%"]/g, " ");
    const digits = safe.replace(/\D/g, "");
    query = query.or(`owner_name.ilike.%${safe}%,condo.ilike.%${safe}%${digits ? `,phone.ilike.%${digits}%` : ""}`);
  }
  const { data: leads, count, error } = await query.range((page - 1) * PER, page * PER - 1);

  const href = (o: Partial<{ seg: Seg; tab: Tab; status: string; q: string; page: number }>) => {
    const m = { seg, tab, status, q, page: 1, ...o };
    const p = new URLSearchParams();
    if (m.seg !== "new") p.set("seg", m.seg);
    if (m.tab !== "today") p.set("tab", m.tab);
    if (m.status) p.set("status", m.status);
    if (m.q) p.set("q", m.q);
    if (m.page > 1) p.set("page", String(m.page));
    return `/leads${p.size ? `?${p}` : ""}`;
  };
  const pages = Math.max(1, Math.ceil((count ?? 0) / PER));
  const chipStatuses = tab === "today" ? ["queued", "calling", "noanswer", "callback"] : tab === "called" ? RESULT_STATUSES : ["new", "queued", ...RESULT_STATUSES];

  return (
    <>
      <Top title="กองลีด" sub="แยกทรัพย์ใหม่ / ทรัพย์เก่า และแยกห้องที่จะโทรวันนี้ กับห้องที่โทรแล้ว" />
      <div className="view">
        {(error || cErr) && (
          <p className="banner err">
            {(error ?? cErr)?.message} · ถ้าขึ้นว่าไม่พบ leads_v หรือ lead_tab_counts ให้รัน supabase/migrations/0002_segments.sql
          </p>
        )}

        <nav className="segtabs" aria-label="ประเภททรัพย์">
          {(["new", "old"] as Seg[]).map((s) => (
            <Link key={s} href={href({ seg: s, tab: "today", status: "" })} className={seg === s ? "on" : ""} aria-current={seg === s ? "page" : undefined}>
              {SEG_LABEL[s]}<b>{cnt[s].all}</b>
            </Link>
          ))}
        </nav>

        <div className="toolbar" style={{ justifyContent: "space-between" }}>
          <nav className="subtabs" aria-label="มุมมอง">
            {(["today", "called", "all"] as Tab[]).map((t) => (
              <Link key={t} href={href({ tab: t, status: "" })} className={tab === t ? "on" : ""}>
                {TAB_LABEL[t]}<b>{cnt[seg][t]}</b>
              </Link>
            ))}
          </nav>
          <div className="toolbar">
            <form style={{ display: "flex" }}>
              {seg !== "new" && <input type="hidden" name="seg" value={seg} />}
              {tab !== "today" && <input type="hidden" name="tab" value={tab} />}
              <input className="search" name="q" defaultValue={q} type="search" placeholder="ค้นหาเจ้าของ คอนโด เบอร์" aria-label="ค้นหา" />
            </form>
            <CsvImport segment={seg} />
          </div>
        </div>

        <div className="chips">
          <Link href={href({ status: "" })} className={`fchip ${!status ? "on" : ""}`}>ทุกสถานะ</Link>
          {chipStatuses.filter((s) => statusCnt[s]).map((s) => (
            <Link key={s} href={href({ status: s })} className={`fchip ${status === s ? "on" : ""}`}>
              {STATUS[s].label}<b>{statusCnt[s]}</b>
            </Link>
          ))}
        </div>

        <form className="card" action={queueLeads}>
          <div className="card-h">
            <span className="hint">
              {SEG_LABEL[seg]} · {TAB_LABEL[tab]} · แสดง {leads?.length ?? 0} จาก {count ?? 0} ห้อง
            </span>
            {tab !== "today" && <button className="btn sm primary">ส่งที่เลือกเข้าคิวโทรวันนี้</button>}
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  {tab !== "today" && <th><SelectAll /></th>}
                  <th>คอนโด / ห้อง</th><th>เจ้าของ</th><th>ค่าเช่า</th><th>เบอร์โทร</th>
                  <th>{tab === "today" ? "โทรเมื่อ" : tab === "called" ? "โทรล่าสุด" : "เข้ามาเมื่อ"}</th>
                  <th>บนเว็บ (VPS)</th><th>สถานะการโทร</th><th>ครั้งที่โทร</th><th>สรุปจาก AI</th><th></th>
                </tr>
              </thead>
              <tbody>
                {(leads ?? []).map((l: any) => (
                  <tr key={l.id}>
                    {tab !== "today" && (
                      <td><input type="checkbox" name="ids" value={l.id} disabled={!QUEUEABLE.includes(l.status as LeadStatus)} aria-label={`เลือก ${l.condo}`} /></td>
                    )}
                    <td><b style={{ fontWeight: 500 }}>{l.condo}</b><br /><span className="muted small">{l.unit ?? "–"}</span></td>
                    <td>คุณ{l.owner_name}<br /><span className="muted small">{l.source}</span></td>
                    <td className="mono">{l.rent ? `฿${l.rent.toLocaleString("th-TH")}` : "–"}</td>
                    <td className="mono">{prettyPhone(l.phone)}</td>
                    <td className="small muted">
                      {tab === "today"
                        ? l.status === "calling" ? "กำลังโทร" : l.next_call_at ? `${fmtTime(l.next_call_at)} น.` : "ตามคิว"
                        : tab === "called" ? fmtDateTime(l.last_called_at) : fmtDateTime(l.created_at)}
                    </td>
                    <td className="small">{l.vps_status ?? "–"}<br /><span className="muted">{l.vps_updated_at ? `อัปเดต ${fmtDateTime(l.vps_updated_at)}` : "ไม่มีวันที่"}</span></td>
                    <td><Pill status={l.status} /></td>
                    <td className="mono">{l.attempts}</td>
                    <td><p className={`clamp ${l.last_summary ? "" : "muted"}`}>{l.last_summary ?? "ยังไม่ได้โทร"}</p></td>
                    <td>{l.last_call_id && <Link className="btn sm" href={`/results?id=${l.last_call_id}`}>ดูบทสนทนา</Link>}</td>
                  </tr>
                ))}
                {!leads?.length && (
                  <tr><td colSpan={11} className="empty">
                    {tab === "today" ? `ยังไม่มี${SEG_LABEL[seg]}ที่จะโทรวันนี้ · ไปที่แท็บ "ทั้งหมด" เพื่อเลือกส่งเข้าคิว` : "ไม่พบห้องที่ตรงกับตัวกรอง"}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="pager">
              {page > 1 && <Link className="btn sm" href={href({ page: page - 1 })}>ก่อนหน้า</Link>}
              <span className="hint">หน้า {page} / {pages}</span>
              {page < pages && <Link className="btn sm" href={href({ page: page + 1 })}>ถัดไป</Link>}
            </div>
          )}
        </form>

        <details className="card add">
          <summary className="card-h"><h2>+ เพิ่ม{SEG_LABEL[seg]}</h2><span className="hint">หรือส่งผ่าน API /api/leads/ingest (ใส่ segment: &quot;new&quot; หรือ &quot;old&quot;)</span></summary>
          <form action={addLead} className="card-b form-grid">
            <input type="hidden" name="segment" value={seg} />
            <div className="field"><label htmlFor="owner_name">ชื่อเจ้าของ</label><input id="owner_name" name="owner_name" required /></div>
            <div className="field"><label htmlFor="phone">เบอร์โทร</label><input id="phone" name="phone" required placeholder="08x-xxx-xxxx" /></div>
            <div className="field"><label htmlFor="condo">คอนโด</label><input id="condo" name="condo" required placeholder="Ideo Mobi Asoke" /></div>
            <div className="field"><label htmlFor="unit">ห้อง</label><input id="unit" name="unit" placeholder="1 ห้องนอน 35 ตร.ม. ชั้น 18" /></div>
            <div className="field"><label htmlFor="rent">ค่าเช่า/เดือน</label><input id="rent" name="rent" inputMode="numeric" /></div>
            <div className="field"><label htmlFor="customer_nationalities">สัญชาติลูกค้าที่สนใจ</label><input id="customer_nationalities" name="customer_nationalities" placeholder="อเมริกัน และ รัสเซีย" /></div>
            <div className="field"><label htmlFor="source">แหล่งที่มา</label><select id="source" name="source"><option>เพิ่มเอง</option><option>Livinginsider</option><option>DDproperty</option><option>Hipflat</option><option>กลุ่ม Facebook</option></select></div>
            <div><button className="btn primary">เพิ่มเข้า{SEG_LABEL[seg]}</button></div>
          </form>
        </details>
        <p className="hint">CSV: <span className="mono">ชื่อเจ้าของ,เบอร์โทร,คอนโด,ห้อง,ค่าเช่า,สัญชาติลูกค้า</span> · นำเข้าตามแท็บที่เปิดอยู่ · เบอร์+คอนโดซ้ำจะถูกข้าม</p>
      </div>
    </>
  );
}
