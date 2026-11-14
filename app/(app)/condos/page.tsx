import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { botnoiReady, defaultReading } from "@/lib/botnoi";
import { buildLibrary } from "@/lib/condolib";
import { CondoSheetImport } from "@/components/CondoSheetImport";
import { condoFileName } from "@/lib/yalecom";
import { Top } from "@/components/Top";
import { AudioUpload } from "@/components/AudioUpload";
import { CopyButton } from "@/components/CopyButton";
import { PullButton } from "@/components/PullButton";
import { SaveButton } from "@/components/SaveButton";
import { fillMissing, regenCondo, saveCondo, uploadCondoFile } from "./actions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type SP = Promise<{ f?: string; q?: string; page?: string; msg?: string }>;
const PER = 50;
const TABS = [["all", "มีลีด"], ["missing", "ยังไม่มีเสียง"], ["has", "มีเสียงแล้ว"], ["error", "สร้างไม่สำเร็จ"], ["lib", "คลังรวม"]] as const;

export default async function CondosPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const f = TABS.some(([k]) => k === sp.f) ? sp.f! : "all";
  const q = (sp.q ?? "").trim().toLowerCase();
  const page = Math.max(1, Number(sp.page) || 1);

  const sb = await createClient();
  const { error } = await sb.from("condo_audio").select("condo_id").limit(1);
  const all = await buildLibrary(sb);
  const { count: libTotal } = await sb.from("condo_audio").select("condo", { count: "exact", head: true });
  // ค้นหา: รวมคอนโดในคลังทั้งหมด (จากชีท) ที่ยังไม่มีลีดด้วย
  if (q && f !== "lib") {
    const safe = q.replace(/[,()%*]/g, " ").trim();
    if (safe) {
      const { data: lib } = await sb.from("condo_audio").select("*").or(`condo.ilike.%${safe}%,tts_text.ilike.%${safe}%${/^\d+$/.test(safe) ? `,condo_id.eq.${safe}` : ""}`).limit(50);
      const have = new Set(all.map((x) => x.condo));
      for (const a of lib ?? []) if (!have.has(a.condo)) all.push({ key: `lib:${a.condo}`, condo: a.condo, condo_id: a.condo_id ?? null, n: 0, a });
    }
  }
  const isHas = (x: any) => !!x.a?.path;
  const isErr = (x: any) => !x.a?.path && !!x.a?.tts_error;
  const count = { all: all.length, has: all.filter(isHas).length, error: all.filter(isErr).length, missing: all.filter((x) => !isHas(x)).length, lib: libTotal ?? 0 };

  // แท็บ "คลังรวม": อ่านจากคลังทั้งหมดทีละหน้า (ไม่โหลดทั้งหมื่นแถว)
  let libRows: any[] = [];
  let libCount = 0;
  if (f === "lib") {
    const safe = q.replace(/[,()%*]/g, " ").trim();
    let lq = sb.from("condo_audio").select("*", { count: "exact" }).order("condo_id", { ascending: true, nullsFirst: false }).range((page - 1) * PER, page * PER - 1);
    if (safe) lq = lq.or(`condo.ilike.%${safe}%,tts_text.ilike.%${safe}%${/^\d+$/.test(safe) ? `,condo_id.eq.${safe}` : ""}`);
    const { data, count: c } = await lq;
    libRows = data ?? [];
    libCount = c ?? 0;
  }
  const leadCount = new Map(all.map((x) => [x.a?.condo ?? x.condo, x.n]));
  const list = f === "lib" ? libRows.map((a) => ({ key: `lib:${a.condo}`, condo: a.condo, condo_id: a.condo_id ?? null, n: leadCount.get(a.condo) ?? 0, a })) : all
    .filter((x) => (f === "has" ? isHas(x) : f === "missing" ? !isHas(x) : f === "error" ? isErr(x) : true))
    .filter((x) => !q || x.condo.toLowerCase().includes(q) || (x.condo_id ?? "").toLowerCase() === q || (x.a?.tts_text ?? "").toLowerCase().includes(q))
    .sort((a, b) => b.n - a.n || a.condo.localeCompare(b.condo, "th"));
  const pages = Math.max(1, Math.ceil((f === "lib" ? libCount : list.length) / PER));
  const shown = f === "lib" ? list : list.slice((page - 1) * PER, page * PER);
  const href = (o: Record<string, string | number>) => {
    const p = new URLSearchParams({ ...(f !== "all" ? { f } : {}), ...(q ? { q } : {}), ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])) });
    for (const [k, v] of [...p.entries()]) if (!v || (k === "f" && v === "all") || (k === "page" && v === "1")) p.delete(k);
    return `/condos${p.size ? `?${p}` : ""}`;
  };
  const urlOf = (path: string) => sb.storage.from("script-audio").getPublicUrl(path).data.publicUrl;

  return (
    <>
      <Top title="คลังชื่อคอนโด" sub={`คอนโดที่มีลีด ${count.all.toLocaleString()} โครงการ · มีเสียงแล้ว ${count.has.toLocaleString()} · คลังทั้งหมด ${(libTotal ?? 0).toLocaleString()} โครงการ`}>
        <CondoSheetImport />
        {botnoiReady() && count.missing > 0 && <form action={fillMissing}><PullButton label="สร้างเสียงที่ยังขาด (ครั้งละ 10)" busy="กำลังสร้างเสียง…" /></form>}
      </Top>
      <div className="view">
        {error && <p className="banner err">{error.message} · ให้รัน update_0009_condo_tts.sql และ update_0010_condo_id.sql ใน Supabase ก่อน</p>}
        {!botnoiReady() && <p className="banner">ยังไม่ได้ตั้ง BOTNOI_TOKEN ใน Vercel · ตอนนี้อัปโหลดไฟล์เองได้อย่างเดียว</p>}
        {sp.msg && <p className="banner">{sp.msg}</p>}

        <p className="hint">นำเข้าชีทคลังคอนโดไว้ก่อน (คอลัมน์ id + name_th) · พอดึงลีดมาแล้วตรงกับ id หรือชื่อไหน ระบบจึงให้ Botnoi อ่าน<b>เฉพาะชื่อภาษาไทย</b> แล้วเก็บไฟล์ไว้ใช้ซ้ำ (คอนโดที่ไม่มีลีดจะไม่ถูกอ่าน ไม่เปลืองเครดิต) · ช่องค้นหาค้นได้ทั้งคลัง · อ่านผิด: แก้คำอ่านแล้วกด "อ่านใหม่" หรืออัปโหลดไฟล์เองแทน</p>

        <div className="toolbar" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <nav className="segtabs" aria-label="กรองคอนโด">
            {TABS.map(([k, label]) => (
              <Link key={k} href={href({ f: k, page: 1 })} className={f === k ? "on" : ""} aria-current={f === k ? "page" : undefined}>{label}<b>{count[k as keyof typeof count].toLocaleString()}</b></Link>
            ))}
          </nav>
          <form action="/condos" style={{ display: "flex", gap: 8 }}>
            {f !== "all" && <input type="hidden" name="f" value={f} />}
            <input name="q" defaultValue={sp.q ?? ""} placeholder="ค้นหาชื่อคอนโด" aria-label="ค้นหาชื่อคอนโด" style={{ padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface)" }} />
            <button className="btn sm">ค้นหา</button>
          </form>
        </div>

        <div className="card">
          <div className="tbl-wrap">
            <table className="tbl stack" style={{ minWidth: 980 }}>
              <thead><tr><th>ID</th><th>ชื่อคอนโด</th><th>คำอ่าน</th><th>เสียง</th></tr></thead>
              <tbody>
                {shown.map(({ key, condo, condo_id, n, a }) => {
                  const file = a?.file_name ?? (condo_id ? `tl_condo_${condo_id}` : condoFileName(condo));
                  const fields: Record<string, string> = { condo, ...(condo_id ? { condo_id } : {}) };
                  return (
                    <tr key={key}>
                      <td className="mono" data-label="ID">{condo_id ?? <span className="hint">ยังไม่มี</span>}</td>
                      <td style={{ maxWidth: 240 }} data-label="ชื่อคอนโด">
                        <b style={{ fontWeight: 500 }}>{condo}</b>
                        <div className="hint">{n} ลีด · <span className="mono">{file}</span> <CopyButton text={file} /></div>
                      </td>
                      <td style={{ minWidth: 260 }} data-label="คำอ่าน">
                        <form action={saveCondo} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                          {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                          <input name="tts_text" defaultValue={a?.tts_text ?? ""} placeholder={defaultReading(condo) ?? "ไม่มีชื่อไทย ใส่คำอ่านเอง"} aria-label={`คำอ่าน ${condo}`} style={{ flex: "1 1 200px", padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--surface)" }} />
                          <SaveButton className="btn sm" />
                          {botnoiReady() && <SaveButton className="btn sm" formAction={regenCondo} label={a?.path ? "อ่านใหม่" : "สร้างเสียง"} done="สร้างเสียงแล้ว" />}
                          <label className="toggle small" title="ส่งไฟล์เข้า Yalecom แล้ว"><input type="checkbox" name="ready" defaultChecked={!!a?.ready} />อยู่ใน Yalecom</label>
                        </form>
                      </td>
                      <td style={{ minWidth: 250 }} data-label="เสียง">
                        {a?.path ? (
                          <>
                            <audio controls preload="none" src={urlOf(a.path)} style={{ width: 230, height: 32, display: "block" }} />
                            <div className="hint">{a.audio_source === "upload" ? "อัปโหลดเอง" : "Botnoi"}</div>
                          </>
                        ) : (
                          <>
                            <span className={`pill ${a?.tts_error ? "t-bad" : "t-wa"}`}>{a?.tts_error ? "สร้างไม่สำเร็จ" : "ยังไม่มีเสียง"}</span>
                            {a?.tts_error && <div className="hint" style={{ maxWidth: 240 }}>{a.tts_error}</div>}
                          </>
                        )}
                        <div style={{ marginTop: 6 }}><AudioUpload action={uploadCondoFile} fields={fields} has={!!a?.path} /></div>
                      </td>
                    </tr>
                  );
                })}
                {!shown.length && <tr><td colSpan={4} className="empty">{q ? "ไม่พบคอนโดที่ค้นหา" : "ยังไม่มีคอนโด · ดึงลีดจากเว็บ หรือนำเข้าชีทก่อน"}</td></tr>}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="card-b" style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
              {page > 1 && <Link className="btn sm" href={href({ page: page - 1 })}>ก่อนหน้า</Link>}
              <span className="small muted">หน้า {page} / {pages}</span>
              {page < pages && <Link className="btn sm" href={href({ page: page + 1 })}>ถัดไป</Link>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
