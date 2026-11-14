import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { botnoiReady } from "@/lib/botnoi";
import { leadPrices, priceFile } from "@/lib/priceaudio";
import { thaiNumber } from "@/lib/thainum";
import { Top } from "@/components/Top";
import { AudioUpload } from "@/components/AudioUpload";
import { PullButton } from "@/components/PullButton";
import { SaveButton } from "@/components/SaveButton";
import { PriceImport } from "@/components/PriceImport";
import { fillMissingPrices, regenPrice, savePrice, uploadPriceFile } from "./actions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type SP = Promise<{ f?: string; q?: string; page?: string; msg?: string }>;
const PER = 50;
const TABS = [["all", "มีลีด"], ["missing", "ยังไม่มีเสียง"], ["has", "มีเสียงแล้ว"], ["lib", "คลังรวม"]] as const;

export default async function PricesPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const f = TABS.some(([k]) => k === sp.f) ? sp.f! : "all";
  const q = Math.round(Number(String(sp.q ?? "").replace(/[^\d.]/g, ""))) || null;
  const page = Math.max(1, Number(sp.page) || 1);
  const sb = await createClient();

  const counts = await leadPrices(sb);
  const leadList = [...counts.keys()];
  const audio = new Map<number, any>();
  for (let i = 0; i < leadList.length; i += 300) {
    const { data } = await sb.from("price_audio").select("*").in("price", leadList.slice(i, i + 300));
    for (const r of data ?? []) audio.set(Number(r.price), r);
  }
  const { count: libTotal, error } = await sb.from("price_audio").select("price", { count: "exact", head: true });
  const inLeads = leadList.map((p) => ({ price: p, n: counts.get(p) ?? 0, a: audio.get(p) ?? null }));
  const count = { all: inLeads.length, has: inLeads.filter((x) => x.a?.path).length, missing: inLeads.filter((x) => !x.a?.path).length, lib: libTotal ?? 0 };

  let rows: { price: number; n: number; a: any }[];
  let total: number;
  if (f === "lib") {
    let lq = sb.from("price_audio").select("*", { count: "exact" }).order("price").range((page - 1) * PER, page * PER - 1);
    if (q) lq = lq.eq("price", q);
    const { data, count: c } = await lq;
    rows = (data ?? []).map((a) => ({ price: Number(a.price), n: counts.get(Number(a.price)) ?? 0, a }));
    total = c ?? 0;
  } else {
    const list = inLeads
      .filter((x) => (f === "has" ? x.a?.path : f === "missing" ? !x.a?.path : true))
      .filter((x) => !q || x.price === q)
      .sort((a, b) => b.n - a.n || a.price - b.price);
    total = list.length;
    rows = list.slice((page - 1) * PER, page * PER);
  }
  const pages = Math.max(1, Math.ceil(total / PER));
  const href = (o: Record<string, string | number>) => {
    const p = new URLSearchParams({ ...(f !== "all" ? { f } : {}), ...(q ? { q: String(q) } : {}), ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])) });
    for (const [k, v] of [...p.entries()]) if (!v || (k === "f" && v === "all") || (k === "page" && v === "1")) p.delete(k);
    return `/prices${p.size ? `?${p}` : ""}`;
  };
  const urlOf = (path: string) => sb.storage.from("script-audio").getPublicUrl(path).data.publicUrl;

  return (
    <>
      <Top title="คลังราคา" sub={`ราคาที่มีในลีด ${count.all.toLocaleString()} ราคา · มีเสียงแล้ว ${count.has.toLocaleString()} · คลังทั้งหมด ${count.lib.toLocaleString()} ราคา`}>
        <PriceImport />
        {botnoiReady() && count.missing > 0 && <form action={fillMissingPrices}><PullButton label="สร้างเสียงราคาที่ยังขาด (ครั้งละ 15)" busy="กำลังสร้างเสียง…" /></form>}
      </Top>
      <div className="view">
        {error && <p className="banner err">{error.message} · ให้รัน update_0014_price_audio.sql ใน Supabase ก่อน</p>}
        {!botnoiReady() && <p className="banner">ยังไม่ได้ตั้ง BOTNOI_TOKEN ใน Vercel · ตอนนี้อัปโหลดไฟล์เองได้อย่างเดียว</p>}
        {sp.msg && <p className="banner">{sp.msg}</p>}
        <p className="hint">ใช้ในท่อน "ราคาห้องปัจจุบันคือ <b>[ราคา]</b> บาท ใช่ไหมคะ" · ราคาที่ซ้ำกันใช้ไฟล์เสียงเดียวกัน · ระบบอ่านเฉพาะราคาที่มีในลีด แล้วเก็บไฟล์ไว้ใช้ซ้ำ · คำอ่านเริ่มต้นแปลงจากตัวเลขให้อัตโนมัติ (เช่น 12,500 → หนึ่งหมื่นสองพันห้าร้อย) · ลีดที่ไม่มีราคาหรือยังไม่มีเสียง ระบบข้ามท่อนถามราคาให้เอง</p>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <nav className="segtabs" aria-label="กรองราคา">
            {TABS.map(([k, label]) => (
              <Link key={k} href={href({ f: k, page: 1 })} className={f === k ? "on" : ""} aria-current={f === k ? "page" : undefined}>{label}<b>{count[k as keyof typeof count].toLocaleString()}</b></Link>
            ))}
          </nav>
          <form action="/prices" style={{ display: "flex", gap: 8 }}>
            {f !== "all" && <input type="hidden" name="f" value={f} />}
            <input name="q" defaultValue={sp.q ?? ""} placeholder="ค้นหาราคา เช่น 12000" inputMode="numeric" aria-label="ค้นหาราคา" style={{ padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface)" }} />
            <button className="btn sm">ค้นหา</button>
          </form>
        </div>

        <div className="card">
          <div className="tbl-wrap">
            <table className="tbl" style={{ minWidth: 900 }}>
              <thead><tr><th>ราคา (บาท)</th><th>ลีด</th><th>คำอ่าน</th><th>เสียง</th></tr></thead>
              <tbody>
                {rows.map(({ price, n, a }) => (
                  <tr key={price}>
                    <td><b className="mono" style={{ fontWeight: 500 }}>{price.toLocaleString()}</b><div className="hint mono">{priceFile(price)}</div></td>
                    <td className="mono">{n}</td>
                    <td style={{ minWidth: 280 }}>
                      <form action={savePrice} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <input type="hidden" name="price" value={price} />
                        <input name="tts_text" defaultValue={a?.tts_text ?? ""} placeholder={thaiNumber(price)} aria-label={`คำอ่าน ${price}`} style={{ flex: "1 1 200px", padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--surface)" }} />
                        <SaveButton className="btn sm" />
                        {botnoiReady() && <SaveButton className="btn sm" formAction={regenPrice} label={a?.path ? "อ่านใหม่" : "สร้างเสียง"} done="สร้างเสียงแล้ว" />}
                      </form>
                    </td>
                    <td style={{ minWidth: 250 }}>
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
                      <div style={{ marginTop: 6 }}><AudioUpload action={uploadPriceFile} fields={{ price: String(price) }} has={!!a?.path} /></div>
                    </td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={4} className="empty">{f === "lib" ? "คลังยังว่าง · กดนำเข้าราคา (CSV)" : "ยังไม่มีลีดที่มีราคา · ต้องให้ dev ส่งราคาห้อง (price หรือ rent) มาใน API ลีด"}</td></tr>}
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
