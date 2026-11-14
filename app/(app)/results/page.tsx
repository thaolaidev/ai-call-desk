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
type SP = Promise<{ outcome?: string; id?: string; seg?: string }>;
const SEG_TABS = [["new", "ทรัพย์ใหม่"], ["old", "ทรัพย์เดิม · อัปเดต"], ["all", "ทั้งหมด"]] as const;
const SYNC_LABEL: Record<string, string> = { sent: "ยิงกลับ VPS แล้ว", pending: "รอยิงกลับ VPS", failed: "ยิงกลับ VPS ไม่สำเร็จ", skipped: "ไม่ต้องยิงกลับ" };

const FIELD_LABEL: Record<string, string> = {
  needs_review: "⚠️ ต้องตรวจ", room_available: "ห้องว่าง", ready_now: "พร้อมเข้าอยู่เลย", available_from: "ว่างตั้งแต่", price_confirmed: "ยืนยันราคาเดิม", owner_price: "ราคาที่เจ้าของบอก (บาท)", accepts_foreigners: "รับต่างชาติ", rules_explained: "อธิบายกฎแล้ว", owner_agreed_profile: "ยอมดูโปรไฟล์",
  profile_channel: "ส่งโปรไฟล์ทาง", line_id: "LINE ID", nationality_note: "เงื่อนไขสัญชาติ", current_lease_until: "ผู้เช่าเดิมถึง",
  callback_at: "นัดโทรกลับ", owner_questions: "คำถามที่ต้องตอบต่อ", sentiment: "ท่าทีเจ้าของ",
  answer_text: "คำตอบที่ถอดได้", transcript_full: "ข้อความทั้งหมด",
};
const fmtVal = (v: unknown) =>
  v === true ? "ใช่" : v === false ? "ไม่" : Array.isArray(v) ? (v.length ? v.join(", ") : null) : v == null || v === "" ? null : String(v);

export default async function ResultsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const outcome = sp.outcome && (OUTCOMES as string[]).includes(sp.outcome) ? sp.outcome : "all";
  const seg = sp.seg === "old" || sp.seg === "all" ? sp.seg : "new";
  const sb = await createClient();

  let q = sb.from("calls").select("id, outcome, started_at, duration_sec, attempt, summary, segment, sync_status, leads!calls_lead_id_fkey(condo, owner_name, segment)").eq("state", "ended").order("started_at", { ascending: false }).limit(150);
  if (outcome !== "all") q = q.eq("outcome", outcome);
  if (seg !== "all") q = q.eq("segment", seg);
  let cq = sb.from("calls").select("outcome, segment").eq("state", "ended").order("started_at", { ascending: false }).limit(5000);
  const [{ data: list, error }, { data: countRows }] = await Promise.all([q, cq]);
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
    const p = new URLSearchParams({ ...(seg !== "new" ? { seg } : {}), ...(outcome !== "all" ? { outcome } : {}), ...o });
    if (p.get("outcome") === "all") p.delete("outcome");
    if (p.get("seg") === "new") p.delete("seg");
    return `/results${p.size ? `?${p}` : ""}`;
  };

  return (
    <>
      <Top title="ผลการโทร" sub="บทสนทนากับเจ้าของห้องที่ถอดเป็นข้อความ และสรุปโดย AI" />
      <div className="view">
        {error && <p className="banner err">{error.message}</p>}
        <nav className="segtabs" aria-label="ประเภททรัพย์">
          {SEG_TABS.map(([k, label]) => (
            <Link key={k} href={link({ seg: k, outcome: "all", id: "" }).replace(/[?&]id=(&|$)/, "$1").replace(/[?&]$/, "")} className={seg === k ? "on" : ""} aria-current={seg === k ? "page" : undefined}>
              {label}<b>{segCount[k]}</b>
            </Link>
          ))}
        </nav>
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
                  <span className="r1 small muted"><span className="mono">{fmtTime(x.started_at)} · {fmtDur(x.duration_sec)}</span><span>{seg === "all" && <span className="seg">{(x.segment ?? l?.segment) === "old" ? "เดิม" : "ใหม่"}</span>} คุณ{l?.owner_name} · ครั้งที่ {x.attempt}</span></span>
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
                      <span>{(c.segment ?? lead.segment) === "old" ? "ทรัพย์เดิม" : "ทรัพย์ใหม่"}</span>
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
