import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { STEPS, STEP_KEYS, yalecomName } from "@/lib/script";
import { Top } from "@/components/Top";
import { AudioUpload } from "@/components/AudioUpload";
import { deleteStepAudio } from "./actions";

export const dynamic = "force-dynamic";

type Row = { step_key: string; path: string; file_name: string | null; size_bytes: number | null; uploaded_at: string };

export default async function ScriptPage() {
  const sb = await createClient();
  const { data, error } = await sb.from("script_audio").select("*");
  const rows = new Map<string, Row>(((data ?? []) as Row[]).map((r) => [r.step_key, r]));
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
          <AudioUpload step={k} has={!!r} />
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
      <Top title="บทโทร" sub={`ห้องทรัพย์ใหม่ · อัปโหลดไฟล์เสียงแล้ว ${done} / ${STEP_KEYS.length} ท่อน`} />
      <div className="view">
        {error && <p className="banner err">{error.message} · ให้รัน update_0008_script_audio.sql ใน Supabase ก่อน</p>}

        <div className="flow">
          <Card k="01" />
          <Down />
          <Card k="02-1" />
          <Down />
          <div className="step condo">
            <div className="step-h"><span className="step-no">ชื่อ</span><b>ชื่อคอนโด (แยกไฟล์ต่อคอนโด)</b></div>
            <p className="step-txt">เช่น “ไอดีโอ โมบิ อโศก” · จัดการได้ที่ <Link href="/settings">ตั้งค่าระบบ → ไฟล์เสียงชื่อคอนโด</Link></p>
          </div>
          <Down />
          <Card k="02-2" />

          <div className="branches">
            <section className="branch bad" aria-label="ทางห้องไม่ว่าง">
              <Fork label="ห้องไม่ว่าง" />
              <Card k="02B" />
              <div className="end">จบสาย · ผล: ไม่ว่าง</div>
            </section>

            <section className="branch good" aria-label="ทางห้องว่าง">
              <Fork label="ห้องว่าง" />
              <Card k="03" />
              <div className="branches inner">
                <section className="branch">
                  <Fork label="รับต่างชาติ" />
                  <Card k="04A" />
                  <div className="or">หรือ (สลับชุด)</div>
                  <Card k="04B" />
                </section>
                <section className="branch">
                  <Fork label="ไม่รับต่างชาติ" />
                  <Card k="05-1" /><Down /><Card k="05-2" /><Down /><Card k="05-3" /><Down /><Card k="05-4" />
                </section>
              </div>
              <Down />
              <Card k="06" />
              <div className="branches inner">
                <section className="branch">
                  <Fork label="ตกลง" />
                  <Card k="07" />
                  <div className="end">จบสาย · ผล: ว่าง · ส่งโปรไฟล์</div>
                </section>
                <section className="branch">
                  <Fork label="ปฏิเสธ" />
                  <Card k="07B" />
                  <div className="end">จบสาย · ผล: ว่าง · ไม่รับโปรไฟล์</div>
                </section>
              </div>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
