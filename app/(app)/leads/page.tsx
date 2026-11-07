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
const FILTERS = ["all", "new", "queued", "avail_ok", "avail_profile", "avail_no", "not_avail", "callback", "noanswer", "invalid", "wrong_number", "dnc", "closed"];

type SP = Promise<{ status?: string; q?: string; page?: string }>;

export default async function LeadsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const status = sp.status && FILTERS.includes(sp.status) ? sp.status : "all";
  const q = (sp.q ?? "").trim();
  const page = Math.max(1, Number(sp.page) || 1);
  const sb = await createClient();

  let query = sb.from("leads").select("*", { count: "exact" }).order("created_at", { ascending: false }).range((page - 1) * PER, page * PER - 1);
  if (status !== "all") query = query.eq("status", status);
  if (q) {
    const safe = q.replace(/[,()%]/g, " ");
    query = query.or(`owner_name.ilike.%${safe}%,condo.ilike.%${safe}%,phone.ilike.%${safe.replace(/\D/g, "") || safe}%`);
  }
  const [{ data: leads, count, error }, { data: counts }] = await Promise.all([query, sb.rpc("lead_counts")]);
  const lc: Record<string, number> = {};
  let total = 0;
  for (const r of counts ?? []) { lc[r.status] = Number(r.n); total += Number(r.n); }
  const href = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const m = { status, q, page: 1, ...o };
    if (m.status && m.status !== "all") p.set("status", String(m.status));
    if (m.q) p.set("q", String(m.q));
    if (Number(m.page) > 1) p.set("page", String(m.page));
    return `/leads${p.size ? `?${p}` : ""}`;
  };
  const pages = Math.max(1, Math.ceil((count ?? 0) / PER));

  return (
    <>
      <Top title="กองลีด" sub="ห้องเช่าและเจ้าของ พร้อมสถานะล่าสุดหลังโทร" />
      <div className="view">
        {error && <p className="banner err">{error.message}</p>}
        <div className="toolbar">
          <form className="search" style={{ padding: 0, border: 0, background: "none", display: "flex" }}>
            {status !== "all" && <input type="hidden" name="status" value={status} />}
            <input className="search" name="q" defaultValue={q} type="search" placeholder="ค้นหาชื่อเจ้าของ คอนโด หรือเบอร์โทร" aria-label="ค้นหา" />
          </form>
          <CsvImport />
        </div>

        <details className="card add">
          <summary className="card-h"><h2>+ เพิ่มห้อง / เจ้าของ</h2><span className="hint">หรือส่งผ่าน API /api/leads/ingest จาก n8n, Make, Zapier</span></summary>
          <form action={addLead} className="card-b form-grid">
            <div className="field"><label htmlFor="owner_name">ชื่อเจ้าของ</label><input id="owner_name" name="owner_name" required /></div>
            <div className="field"><label htmlFor="phone">เบอร์โทร</label><input id="phone" name="phone" required placeholder="08x-xxx-xxxx" /></div>
            <div className="field"><label htmlFor="condo">คอนโด</label><input id="condo" name="condo" required placeholder="Ideo Mobi Asoke" /></div>
            <div className="field"><label htmlFor="unit">ห้อง</label><input id="unit" name="unit" placeholder="1 ห้องนอน 35 ตร.ม. ชั้น 18" /></div>
            <div className="field"><label htmlFor="rent">ค่าเช่า/เดือน</label><input id="rent" name="rent" inputMode="numeric" /></div>
            <div className="field"><label htmlFor="customer_nationalities">สัญชาติลูกค้าที่สนใจ</label><input id="customer_nationalities" name="customer_nationalities" placeholder="อเมริกัน และ รัสเซีย" /></div>
            <div className="field"><label htmlFor="source">แหล่งที่มา</label><select id="source" name="source"><option>เพิ่มเอง</option><option>Livinginsider</option><option>DDproperty</option><option>Hipflat</option><option>กลุ่ม Facebook</option></select></div>
            <div><button className="btn primary">เพิ่มเข้ากองลีด</button></div>
          </form>
        </details>

        <div className="chips">
          {FILTERS.map((f) => (
            <Link key={f} href={href({ status: f })} className={`fchip ${status === f ? "on" : ""}`}>
              {f === "all" ? "ทั้งหมด" : STATUS[f].label}<b>{f === "all" ? total : lc[f] ?? 0}</b>
            </Link>
          ))}
        </div>

        <form className="card" action={queueLeads}>
          <div className="card-h">
            <span className="hint">แสดง {leads?.length ?? 0} จาก {count ?? 0} ห้อง</span>
            <button className="btn sm primary">ส่งที่เลือกเข้าคิวโทร</button>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th><SelectAll /></th><th>คอนโด / ห้อง</th><th>เจ้าของ</th><th>ค่าเช่า</th><th>เบอร์โทร</th><th>แหล่งที่มา</th><th>เข้ามาเมื่อ</th><th>สถานะ</th><th>โทรแล้ว</th><th>สรุปจาก AI</th><th></th></tr></thead>
              <tbody>
                {(leads ?? []).map((l: any) => (
                  <tr key={l.id}>
                    <td><input type="checkbox" name="ids" value={l.id} disabled={!QUEUEABLE.includes(l.status as LeadStatus)} aria-label={`เลือก ${l.condo}`} /></td>
                    <td><b style={{ fontWeight: 500 }}>{l.condo}</b><br /><span className="muted small">{l.unit ?? "–"}</span></td>
                    <td>คุณ{l.owner_name}</td>
                    <td className="mono">{l.rent ? `฿${l.rent.toLocaleString("th-TH")}` : "–"}</td>
                    <td className="mono">{prettyPhone(l.phone)}</td>
                    <td className="small">{l.source}</td>
                    <td className="small muted">{fmtDateTime(l.created_at)}</td>
                    <td><Pill status={l.status} />{l.next_call_at && ["noanswer", "callback"].includes(l.status) && <><br /><span className="small muted">โทรอีกครั้ง {fmtTime(l.next_call_at)}</span></>}</td>
                    <td className="mono">{l.attempts}</td>
                    <td><p className={`clamp ${l.last_summary ? "" : "muted"}`}>{l.last_summary ?? "ยังไม่ได้โทร"}</p></td>
                    <td>{l.last_call_id && <Link className="btn sm" href={`/results?id=${l.last_call_id}`}>ดูบทสนทนา</Link>}</td>
                  </tr>
                ))}
                {!leads?.length && <tr><td colSpan={11} className="empty">ไม่พบห้องที่ตรงกับตัวกรอง</td></tr>}
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
        <p className="hint">CSV: <span className="mono">ชื่อเจ้าของ,เบอร์โทร,คอนโด,ห้อง,ค่าเช่า,สัญชาติลูกค้า</span> · เบอร์+คอนโดซ้ำจะถูกข้าม</p>
      </div>
    </>
  );
}
