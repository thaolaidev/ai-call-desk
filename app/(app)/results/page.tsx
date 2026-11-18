import { Fragment } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { STATUS, OUTCOMES, isHot } from "@/lib/status";
import { prettyPhone } from "@/lib/phone";
import { fmtDateTime, fmtDur, fmtTime } from "@/lib/time";
import { Top } from "@/components/Top";
import { Pill } from "@/components/Pill";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type SP = Promise<{ outcome?: string; id?: string; seg?: string; range?: string; from?: string; to?: string }>;
const SEG_TABS = [["all", "ทั้งหมด"], ["new", "Check ทรัพย์ใหม่"], ["old", "Check สถานะห้อง"]] as const;
const RANGES = [["today", "วันนี้"], ["yesterday", "เมื่อวาน"], ["7d", "7 วัน"], ["30d", "30 วัน"], ["all", "ทั้งหมด"]] as const;
const DAY = 24 * 3600_000;
const ymdBKK = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const startBKK = (ymd: string) => new Date(`${ymd}T00:00:00+07:00`);
/** ช่วงวันที่ตามตัวกรอง → [from, to) เป็น ISO (null = ไม่จำกัด) */
function rangeOf(range: string, from?: string, to?: string): { from: string | null; to: string | null; label: string } {
  const today = startBKK(ymdBKK(new Date()));
  const ok = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (range === "custom" && (ok(from) || ok(to))) {
    const f = ok(from) ? startBKK(from!) : null;
    const t2 = ok(to) ? new Date(startBKK(to!).getTime() + DAY) : null;
    return { from: f?.toISOString() ?? null, to: t2?.toISOString() ?? null, label: `${from ?? "…"} ถึง ${to ?? "…"}` };
  }
  if (range === "yesterday") return { from: new Date(today.getTime() - DAY).toISOString(), to: today.toISOString(), label: "เมื่อวาน" };
  if (range === "7d") return { from: new Date(today.getTime() - 6 * DAY).toISOString(), to: null, label: "7 วันล่าสุด" };
  if (range === "30d") return { from: new Date(today.getTime() - 29 * DAY).toISOString(), to: null, label: "30 วันล่าสุด" };
  if (range === "all") return { from: null, to: null, label: "ทั้งหมด" };
  return { from: today.toISOString(), to: null, label: "วันนี้" };
}
const NOT_REACHED = ["noanswer", "invalid"];
const SYNC_LABEL: Record<string, string> = { sent: "ยิงกลับ VPS แล้ว", pending: "รอยิงกลับ VPS", failed: "ยิงกลับ VPS ไม่สำเร็จ", skipped: "ไม่ต้องยิงกลับ" };

const FIELD_LABEL: Record<string, string> = {
  needs_review: "⚠️ ต้องตรวจ", room_available: "ห้องว่าง", ready_now: "พร้อมเข้าอยู่เลย", available_from: "ว่างตั้งแต่", price_confirmed: "ยืนยันราคาเดิม", owner_price: "ราคาที่เจ้าของบอก (บาท)", accepts_foreigners: "รับต่างชาติ", rules_explained: "อธิบายกฎแล้ว", owner_agreed_profile: "ยอมดูโปรไฟล์", nationality_told: "สัญชาติที่บอกเจ้าของ", foreign_exclude: "ไม่รับสัญชาติ", pet_friendly: "เลี้ยงสัตว์ได้", pet_note: "สัตว์ที่รับ", call_kind: "ลักษณะสาย", accepted_after_rules: "รับต่างชาติหลังฟังกฎ",
  profile_channel: "ส่งโปรไฟล์ทาง", line_id: "LINE ID", nationality_note: "เงื่อนไขสัญชาติ", current_lease_until: "ผู้เช่าเดิมถึง",
  callback_at: "นัดโทรกลับ", owner_questions: "คำถามที่ต้องตอบต่อ", sentiment: "ท่าทีเจ้าของ",
  answer_text: "คำตอบที่ถอดได้", transcript_full: "ข้อความทั้งหมด",
};
const fmtVal = (v: unknown) =>
  v === true ? "ใช่" : v === false ? "ไม่" : Array.isArray(v) ? (v.length ? v.join(", ") : null) : v == null || v === "" ? null : String(v);

export default async function ResultsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const outcome = sp.outcome && (OUTCOMES as string[]).includes(sp.outcome) ? sp.outcome : "all";
  const seg = sp.seg === "old" || sp.seg === "new" ? sp.seg : "all";
  const range = RANGES.some(([k]) => k === sp.range) || sp.range === "custom" ? sp.range! : "today";
  const rg = rangeOf(range, sp.from, sp.to);
  const sb = await createClient();

  let q = sb.from("calls").select("id, outcome, started_at, duration_sec, attempt, summary, segment, sync_status, via_chat, leads!calls_lead_id_fkey(condo, owner_name, segment)").eq("state", "ended").order("started_at", { ascending: false }).limit(150);
  if (outcome !== "all") q = q.eq("outcome", outcome);
  if (seg !== "all") q = q.eq("segment", seg);
  if (rg.from) q = q.gte("started_at", rg.from);
  if (rg.to) q = q.lt("started_at", rg.to);
  // ตัวเลขสรุป: Supabase ส่งได้ครั้งละไม่เกิน 1,000 แถว → ดึงทีละหน้าจนครบ
  const countAll = async () => {
    const out: any[] = [];
    for (let off = 0; off < 200_000; off += 1000) {
      let cq = sb.from("calls").select("id, outcome, segment, started_at, duration_sec, needs_review:analysis->needs_review").eq("state", "ended")
        .order("started_at", { ascending: false }).order("id").range(off, off + 999);
      if (rg.from) cq = cq.gte("started_at", rg.from);
      if (rg.to) cq = cq.lt("started_at", rg.to);
      const { data } = await cq;
      out.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    return out;
  };
  const [{ data: list, error }, countRows] = await Promise.all([q, countAll()]);

  // mini dashboard: ตัวเลขของห้องที่เลือก + ช่วงวันที่
  const rowsSeg = (countRows ?? []).filter((r: any) => seg === "all" || r.segment === seg);
  const total = rowsSeg.length;
  const reached = rowsSeg.filter((r: any) => !NOT_REACHED.includes(r.outcome));
  const avail = rowsSeg.filter((r: any) => String(r.outcome).startsWith("avail")).length;
  const notAvail = rowsSeg.filter((r: any) => r.outcome === "not_avail").length;
  const foreign = rowsSeg.filter((r: any) => r.outcome === "avail_ok").length;
  const review = rowsSeg.filter((r: any) => r.needs_review).length;
  const talk = reached.map((r: any) => r.duration_sec ?? 0).filter((n: number) => n > 0);
  const avgTalk = talk.length ? Math.round(talk.reduce((a: number, b: number) => a + b, 0) / talk.length) : 0;
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
  // กราฟรายวัน (ไม่เกิน 31 วันล่าสุดในช่วงที่เลือก)
  const byDay = new Map<string, { total: number; reached: number; avail: number }>();
  for (const r of rowsSeg as any[]) {
    const d = ymdBKK(new Date(r.started_at));
    const v = byDay.get(d) ?? { total: 0, reached: 0, avail: 0 };
    v.total++;
    if (!NOT_REACHED.includes(r.outcome)) v.reached++;
    if (String(r.outcome).startsWith("avail")) v.avail++;
    byDay.set(d, v);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-31);
  const maxDay = Math.max(1, ...days.map(([, v]) => v.total));
  const segCount: Record<string, number> = { new: 0, old: 0, all: 0 };
  const outCount: Record<string, number> = {};
  for (const r of countRows ?? []) {
    segCount.all++;
    if (r.segment === "new" || r.segment === "old") segCount[r.segment]++;
    if (seg === "all" || r.segment === seg) outCount[r.outcome] = (outCount[r.outcome] ?? 0) + 1;
  }
  const shownTotal = seg === "all" ? segCount.all : segCount[seg];

  const selId = sp.id ?? list?.find((c: any) => isHot(c.outcome))?.id ?? list?.[0]?.id;
  const { data: c } = selId
    ? await sb.from("calls").select("*, leads!calls_lead_id_fkey(*)").eq("id", selId).maybeSingle()
    : { data: null };
  const lead = c ? (Array.isArray(c.leads) ? c.leads[0] : c.leads) : null;
  let audioUrl: string | null = c?.recording_url ?? null;
  if (c?.recording_path) {
    const { data: signed } = await createAdminClient().storage.from("recordings").createSignedUrl(c.recording_path, 3600);
    audioUrl = signed?.signedUrl ?? null;
  }
  const link = (o: Record<string, string>) => {
    const p = new URLSearchParams({
      ...(seg !== "all" ? { seg } : {}), ...(outcome !== "all" ? { outcome } : {}),
      ...(range !== "today" ? { range } : {}), ...(range === "custom" && sp.from ? { from: sp.from } : {}), ...(range === "custom" && sp.to ? { to: sp.to } : {}),
      ...o,
    });
    if (p.get("outcome") === "all") p.delete("outcome");
    if (p.get("seg") === "all") p.delete("seg");
    if (p.get("range") === "today") p.delete("range");
    if (p.get("range") !== "custom") { p.delete("from"); p.delete("to"); }
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    return `/results${p.size ? `?${p}` : ""}`;
  };

  return (
    <>
      <Top title="ผลการโทร" sub={`${rg.label} · บทสนทนากับเจ้าของห้องที่ถอดเป็นข้อความ และสรุปโดย AI`} />
      <div className="view">
        {error && <p className="banner err">{error.message}</p>}
        <nav className="segtabs" aria-label="ประเภททรัพย์">
          {SEG_TABS.map(([k, label]) => (
            <Link key={k} href={link({ seg: k, outcome: "all", id: "" }).replace(/[?&]id=(&|$)/, "$1").replace(/[?&]$/, "")} className={seg === k ? "on" : ""} aria-current={seg === k ? "page" : undefined}>
              {label}<b>{segCount[k]}</b>
            </Link>
          ))}
        </nav>
        <div className="date-filter">
          <div className="chips">
            {RANGES.map(([k, label]) => (
              <Link key={k} href={link({ range: k, id: "", from: "", to: "" })} className={`fchip ${range === k ? "on" : ""}`}>{label}</Link>
            ))}
          </div>
          <form action="/results" className="date-custom">
            {seg !== "all" && <input type="hidden" name="seg" value={seg} />}
            <input type="hidden" name="range" value="custom" />
            <label>จาก <input type="date" name="from" defaultValue={range === "custom" ? sp.from ?? "" : ""} /></label>
            <label>ถึง <input type="date" name="to" defaultValue={range === "custom" ? sp.to ?? "" : ""} /></label>
            <button className={`btn sm ${range === "custom" ? "primary" : ""}`}>ดู</button>
          </form>
        </div>

        <div className="kpis">
          <div className="card kpi ac"><span className="lbl">โทรทั้งหมด</span><span className="val">{total}<small> สาย</small></span><span className="sub">{rg.label}</span></div>
          <div className="card kpi ok"><span className="lbl">รับสาย / คุยได้</span><span className="val">{reached.length}<small> · {pct(reached.length, total)}%</small></span><span className="sub">ไม่รับ / ติดต่อไม่ได้ {total - reached.length}</span></div>
          <div className="card kpi ok"><span className="lbl">ห้องว่าง</span><span className="val">{avail}<small> · {pct(avail, reached.length)}%</small></span><span className="sub">รับต่างชาติ {foreign} · ไม่ว่าง {notAvail}</span></div>
          <div className="card kpi cb"><span className="lbl">คุยเฉลี่ย</span><span className="val">{fmtDur(avgTalk)}</span><span className="sub">เฉพาะสายที่คุยได้</span></div>
          <div className="card kpi wa"><span className="lbl">⚠️ ควรฟังซ้ำ</span><span className="val">{review}<small> สาย</small></span><span className="sub">AI ระหว่างสายกับหลังวางสายตีความไม่ตรงกัน</span></div>
        </div>

        {days.length > 1 && (
          <div className="card day-chart" aria-label="จำนวนสายรายวัน">
            <div className="card-h"><h3>รายวัน</h3><span className="hint"><i className="dc-key dc-avail" /> ว่าง <i className="dc-key dc-reached" /> คุยได้ <i className="dc-key dc-total" /> โทรทั้งหมด</span></div>
            <div className="dc-bars">
              {days.map(([d, v]) => (
                <div key={d} className="dc-col" title={`${d}: โทร ${v.total} · คุยได้ ${v.reached} · ว่าง ${v.avail}`}>
                  <span className="dc-n">{v.total}</span>
                  <div className="dc-stack" style={{ height: `${(v.total / maxDay) * 100}%` }}>
                    <i className="dc-total" style={{ height: `${100 - (v.reached / v.total) * 100}%` }} />
                    <i className="dc-reached" style={{ height: `${((v.reached - v.avail) / v.total) * 100}%` }} />
                    <i className="dc-avail" style={{ height: `${(v.avail / v.total) * 100}%` }} />
                  </div>
                  <span className="dc-d">{Number(d.slice(8))}/{Number(d.slice(5, 7))}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="chips">
          <Link href={link({ outcome: "all", id: "" }).replace(/[?&]id=(&|$)/, "$1").replace(/[?&]$/, "")} className={`fchip ${outcome === "all" ? "on" : ""}`}>ทุกผล<b>{shownTotal}</b></Link>
          {OUTCOMES.filter((o) => outCount[o]).map((o) => (
            <Link key={o} href={link({ outcome: o, id: "" }).replace(/[?&]id=(&|$)/, "$1").replace(/[?&]$/, "")} className={`fchip ${outcome === o ? "on" : ""}`}>{STATUS[o].label}<b>{outCount[o]}</b></Link>
          ))}
        </div>
        <div className="res">
          <div className="card rlist">
            {(list ?? []).map((x: any) => {
              const l = Array.isArray(x.leads) ? x.leads[0] : x.leads;
              return (
                <Link key={x.id} href={`${link({ id: x.id })}#detail`} className={`ritem ${x.id === selId ? "on" : ""}`}>
                  <span className="r1"><b>{l?.condo}</b><Pill status={x.outcome} /></span>
                  <span className="r1 small muted"><span className="mono">{fmtTime(x.started_at)} · {fmtDur(x.duration_sec)}</span><span>{x.via_chat && <span className="seg">แชท</span>}{seg === "all" && <span className="seg">{(x.segment ?? l?.segment) === "old" ? "สถานะห้อง" : "ทรัพย์ใหม่"}</span>} คุณ{l?.owner_name} · ครั้งที่ {x.attempt}</span></span>
                  <span className="r2">{x.summary}</span>
                </Link>
              );
            })}
            {!list?.length && <p className="empty">ยังไม่มีสายที่จบในหมวดนี้</p>}
          </div>

          <div className="card" id="detail" style={{ scrollMarginTop: 72 }}>
            {!c || !lead ? (
              <p className="empty">เลือกสายทางซ้ายเพื่อดูบทสนทนา</p>
            ) : (
              <>
                <div className="card-h">
                  <div>
                    <h2>{lead.condo}</h2>
                    <div className="meta">
                      <span>{lead.unit}</span>{lead.rent && <span>฿{lead.rent.toLocaleString("th-TH")}/เดือน</span>}
                      <span>คุณ{lead.owner_name}</span><span className="mono">{prettyPhone(lead.phone)}</span>
                      <span>{fmtDateTime(c.started_at)}</span><span>ยาว {fmtDur(c.duration_sec)}</span><span>ครั้งที่ {c.attempt}</span>
                      {c.cost_thb != null && <span>~฿{c.cost_thb}</span>}
                      <span>{(c.segment ?? lead.segment) === "old" ? "Check สถานะห้อง" : "Check ทรัพย์ใหม่"}</span>
                      {c.sync_status && <span>{SYNC_LABEL[c.sync_status] ?? c.sync_status}{c.sync_status === "failed" && c.sync_error ? ` (${c.sync_error})` : ""}</span>}
                    </div>
                  </div>
                  <Pill status={c.outcome} />
                </div>
                <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div className="aibox">
                    <span className="small" style={{ color: "var(--accent)", fontWeight: 600 }}>สรุปโดย AI</span>
                    <p style={{ fontWeight: 500 }}>{c.summary ?? "–"}</p>
                    <dl className="kv">
                      {Object.entries(c.analysis ?? {})
                        .filter(([k]) => FIELD_LABEL[k])
                        .map(([k, v]) => [k, fmtVal(v)] as const)
                        .filter(([, v]) => v)
                        .map(([k, v]) => (<Fragment key={k}><dt>{FIELD_LABEL[k]}</dt><dd>{v}</dd></Fragment>))}
                      <dt>ขั้นต่อไป</dt><dd>{c.next_action ?? "–"}</dd>
                    </dl>
                    <div className="small" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span className="muted">อัปเดตสถานะห้อง:</span><Pill status={c.from_status ?? "queued"} /><span aria-hidden="true">→</span><Pill status={c.to_status} />
                    </div>
                  </div>
                  {audioUrl && <audio controls preload="none" src={audioUrl} style={{ width: "100%" }} />}
                  <div>
                    <h3 style={{ marginBottom: 10 }}>บทสนทนา (ถอดจากเสียง)</h3>
                    <div className="chat">
                      {(c.transcript ?? []).map((m: any, i: number) => (
                        <div key={i} className={`msg ${m.role}`}>
                          {m.role !== "system" && <span className="w">{m.role === "ai" ? "AI เอเจนต์" : "เจ้าของห้อง"}</span>}
                          <span className="t">{m.text}</span>
                        </div>
                      ))}
                      {!c.transcript?.length && <p className="muted small">ไม่มีบทสนทนา</p>}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
