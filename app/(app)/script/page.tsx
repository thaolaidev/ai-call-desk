import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { STEPS, STEP_KEYS, yalecomName } from "@/lib/script";
import { Top } from "@/components/Top";
import { StepUpload } from "@/components/StepUpload";
import { deleteStepAudio, savePlaylist } from "./actions";
import { buildPlaybackList, loadPlaylist, WAIT_FILE } from "@/lib/playlist";

export const dynamic = "force-dynamic";

type Row = { step_key: string; path: string; file_name: string | null; size_bytes: number | null; uploaded_at: string };

export default async function ScriptPage() {
  const sb = await createClient();
  const [{ data, error }, { count: condoReady }] = await Promise.all([
    sb.from("script_audio").select("*"),
    sb.from("condo_audio").select("condo", { count: "exact", head: true }).not("path", "is", null),
  ]);
  const rows = new Map<string, Row>(((data ?? []) as Row[]).map((r) => [r.step_key, r]));
  const playlist = await loadPlaylist(sb);
  const preview = buildPlaybackList(playlist, "[ชื่อคอนโด]");
  const waitTotal = preview.filter((f) => f === WAIT_FILE).length;
  const missingOn = playlist.filter((p) => p.enabled && !rows.has(p.key)).map((p) => p.key);
  const done = STEP_KEYS.filter((k) => rows.has(k)).length;

  const bucket = sb.storage.from("script-audio");
  const urlOf = (r: Row) => bucket.getPublicUrl(r.path).data.publicUrl;
  const dlOf = (k: string, r: Row) => bucket.getPublicUrl(r.path, { download: `${yalecomName(k)}.${r.path.split(".").pop()}` }).data.publicUrl;

  const Card = ({ k }: { k: string }) => {
    const s = STEPS[k];
    const r = rows.get(k);
    return (
      <div className={`step ${r ? "has" : ""}`}>
        <div className="step-h">
          <span className="step-no">{s.key}</span>
          <b>{s.title}</b>
          <span className={`pill ${r ? "t-ok" : "t-wa"}`}>{r ? "มีไฟล์แล้ว" : "ยังไม่มีไฟล์"}</span>
        </div>
        <p className="step-txt">“{s.text}”</p>
        {r && <audio controls preload="none" src={urlOf(r)} />}
        <div className="step-f">
          <StepUpload step={k} has={!!r} />
          {r && (
            <>
              <a className="small" href={dlOf(k, r)}>ดาวน์โหลด ({yalecomName(k)})</a>
              <form action={deleteStepAudio}><input type="hidden" name="step" value={k} /><button className="linkbtn small">ลบ</button></form>
            </>
          )}
        </div>
      </div>
    );
  };
  const Fork = ({ label }: { label: string }) => <div className="fork">{label}</div>;
  const Down = () => <div className="down" aria-hidden="true">↓</div>;

  return (
    <>
      <Top title="บทโทร" sub={`ใช้ทั้งห้องทรัพย์ใหม่และทรัพย์เดิม · อัปโหลดไฟล์เสียงแล้ว ${done} / ${STEP_KEYS.length} ท่อน`}>
        {done > 0 && <a className="btn" href="/api/script/zip">ดาวน์โหลดทั้งหมด (zip) ส่ง Yalecom</a>}
      </Top>
      <div className="view">
        {error && <p className="banner err">{error.message} · ให้รัน update_0008_script_audio.sql ใน Supabase ก่อน</p>}

        <form className="card" action={savePlaylist} style={{ marginBottom: 18 }}>
          <div className="card-h">
            <h2>ลำดับที่เล่นในสาย</h2>
            <span className="hint">เล่นต่อกันทั้งชุด เว้นช่วงเงียบให้เจ้าของตอบ แล้ว AI ฟังเสียงอัดทีหลัง · เว้นตอบรวม ~{waitTotal} วินาที</span>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>ท่อน</th><th>เล่นในสาย</th><th>รอให้ตอบ (วินาที)</th><th>ไฟล์</th></tr></thead>
              <tbody>
                {playlist.map((p) => (
                  <tr key={p.key}>
                    <td><span className="step-no">{p.key}</span> {STEPS[p.key].title}</td>
                    <td><label className="toggle"><input type="checkbox" name={`on_${p.key}`} defaultChecked={p.enabled} aria-label={`เล่นท่อน ${p.key}`} />เล่น</label></td>
                    <td><input type="number" name={`wait_${p.key}`} min={0} max={15} defaultValue={p.wait} aria-label={`รอหลังท่อน ${p.key}`} style={{ width: 70, padding: "5px 8px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--surface)" }} /></td>
                    <td>{rows.has(p.key) ? <span className="pill t-ok">มีแล้ว</span> : <span className="pill t-wa">ยังไม่มี</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {missingOn.length > 0 && <p className="banner">ท่อนที่เปิดเล่นแต่ยังไม่มีไฟล์: {missingOn.join(", ")}</p>}
            <p className="hint">ลำดับที่จะส่งให้ Yalecom: <span className="mono">{preview.join(" → ").replaceAll(`${WAIT_FILE} → `, "·").replaceAll(WAIT_FILE, "·")}</span> (· = เงียบ 1 วินาที)</p>
            <p className="hint">ท่อน 04-1 / 04-2 (ราคา) ปิดไว้ก่อน จนกว่าจะมีเสียงราคาห้อง · ท่อน 06A และกฎ 07 เปิดได้ แต่จะเล่นทุกสาย เพราะระบบแยกทางตามคำตอบไม่ได้</p>
            <div><button className="btn primary">บันทึกลำดับ</button></div>
          </div>
        </form>

        <div className="flow">
          <Card k="01" />
          <Down />
          <Card k="02-1" />
          <Down />
          <div className="step condo">
            <div className="step-h"><span className="step-no">ชื่อ</span><b>ชื่อคอนโด (จากคลัง)</b></div>
            <p className="step-txt">Botnoi อ่านให้อัตโนมัติ เก็บไว้ใช้ซ้ำ · มีเสียงแล้ว {condoReady ?? 0} โครงการ · ดู/แก้ที่ <Link href="/condos">คลังชื่อคอนโด</Link></p>
          </div>
          <Down />
          <Card k="02-2" />

          <div className="branches">
            <section className="branch bad" aria-label="ทางห้องไม่ว่าง">
              <Fork label="ห้องไม่ว่าง" />
              <div className="end">วางสาย · ผล: ไม่ว่าง</div>
            </section>

            <section className="branch good" aria-label="ทางห้องว่าง">
              <Fork label="ห้องว่าง · สอบถามรายละเอียด" />
              <Card k="03" />
              <div className="or">ถ้าตอบว่าพร้อมเข้าอยู่เลย ข้าม 03-1 และ 03-2</div>
              <Card k="03-1" /><Down /><Card k="03-2" />
              <Down />
              <Card k="04-1" />
              <Down />
              <div className="step condo">
                <div className="step-h"><span className="step-no">ราคา</span><b>ราคาห้อง (ต่อห้อง)</b></div>
                <p className="step-txt">เช่น “หนึ่งหมื่นห้าพัน” · ต้องให้ dev ส่งราคาห้องมาใน API ก่อน แล้วระบบจะให้ Botnoi อ่านตัวเลขและเก็บไว้ใช้ซ้ำ</p>
              </div>
              <Down />
              <Card k="04-2" />
              <Down />
              <Card k="05" />
              <div className="branches inner">
                <section className="branch">
                  <Fork label="รับต่างชาติ" />
                  <div className="or">ตอบเฉพาะเมื่อเจ้าของถามว่า “ผู้เช่าชาติไหน”</div>
                  <Card k="06A" />
                </section>
                <section className="branch">
                  <Fork label="ไม่รับต่างชาติ · อธิบายกฎ 2 ข้อ" />
                  <Card k="07-1" /><Down /><Card k="07-2" /><Down /><Card k="07-3" /><Down /><Card k="07-4" />
                </section>
              </div>
              <Down />
              <Card k="08" />
              <Down />
              <Card k="09" />
              <div className="end">จบสาย · ผล: ว่าง</div>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
