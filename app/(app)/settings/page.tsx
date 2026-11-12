import { createClient } from "@/lib/supabase/server";
import { Top } from "@/components/Top";
import { CopyButton } from "@/components/CopyButton";
import { TestCallForm } from "@/components/TestCallForm";
import { FIRST_MESSAGE, SYSTEM_PROMPT, ANALYSIS_SCHEMA, SUMMARY_PROMPT } from "@/lib/prompt";
import { updateSettings, saveCondoAudio } from "./actions";
import { condoFileName } from "@/lib/yalecom";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const sb = await createClient();
  const { data: s, error } = await sb.from("settings").select("*").eq("id", 1).single();
  if (error || !s) return <div className="view"><p className="banner err">{error?.message ?? "ไม่พบ settings"}</p></div>;

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "https://your-app.vercel.app";
  const env = {
    vapiKey: !!process.env.VAPI_API_KEY,
    vapiSecret: !!process.env.VAPI_WEBHOOK_SECRET,
    line: !!process.env.LINE_CHANNEL_ACCESS_TOKEN && !!process.env.LINE_TARGET_ID,
    cron: !!process.env.CRON_SECRET,
    ingest: !!process.env.INGEST_API_KEY,
    yalecom: !!process.env.YALECOM_COMPANY_ID && !!process.env.YALECOM_KEY,
    openai: !!process.env.OPENAI_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
  };
  const callbackUrl = `${site}/api/yalecom/callback${process.env.YALECOM_CALLBACK_TOKEN ? "?token=<YALECOM_CALLBACK_TOKEN>" : ""}`;

  // คอนโดที่มีในกองลีด + สถานะไฟล์เสียง
  const [{ data: condoRows }, { data: audioRows }] = await Promise.all([
    sb.from("leads").select("condo").in("status", ["new", "queued", "calling", "noanswer", "unclear", "callback"]).limit(5000),
    sb.from("condo_audio").select("*"),
  ]);
  const audioMap = new Map<string, any>((audioRows ?? []).map((a: any) => [a.condo, a] as [string, any]));
  const counts = new Map<string, number>();
  for (const r of condoRows ?? []) counts.set(r.condo, (counts.get(r.condo) ?? 0) + 1);
  const condos = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200);
  const missing = condos.filter(([c]) => !audioMap.get(c)?.ready).length;
  const schemaText = JSON.stringify(ANALYSIS_SCHEMA, null, 2);
  const block = (title: string, text: string) => (
    <div className="card">
      <div className="card-h"><h3>{title}</h3><CopyButton text={text} /></div>
      <div className="card-b"><pre className="code">{text}</pre></div>
    </div>
  );

  return (
    <>
      <Top title="ตั้งค่าระบบ" sub="ระบบโทร บทของเอเจนต์ และการเชื่อมต่อ" />
      <div className="view">
        <form className="card" action={updateSettings}>
          <div className="card-h"><h2>ระบบโทรและข้อมูลในบท</h2><button className="btn sm primary">บันทึก</button></div>
          <div className="card-b form-grid">
            <div className="field">
              <label htmlFor="provider">ระบบโทร</label>
              <select id="provider" name="provider" defaultValue={s.provider}>
                <option value="simulate">โหมดจำลอง (ไม่โทรจริง)</option>
                <option value="yalecom">Yalecom (เล่นเสียงอัด + ถอดเสียงคำตอบ)</option>
                <option value="vapi">Vapi (AI คุยสด)</option>
              </select>
            </div>
            <div className="field"><label htmlFor="company">ชื่อบริษัท {"{{company}}"}</label><input id="company" name="company" defaultValue={s.company} /></div>
            <div className="field"><label htmlFor="default_nationalities">สัญชาติลูกค้าตั้งต้น</label><input id="default_nationalities" name="default_nationalities" defaultValue={s.default_nationalities} /></div>
            <div className="field"><label htmlFor="viewing_when">ลูกค้าอยากนัดชม</label><input id="viewing_when" name="viewing_when" defaultValue={s.viewing_when} /></div>
            <div className="field"><label htmlFor="vapi_assistant_id">Vapi Assistant ID</label><input id="vapi_assistant_id" name="vapi_assistant_id" defaultValue={s.vapi_assistant_id ?? ""} placeholder="ใส่ทีหลังได้" /></div>
            <div className="field"><label htmlFor="vapi_phone_number_id">Vapi Phone Number ID (เบอร์จาก SIP Trunk)</label><input id="vapi_phone_number_id" name="vapi_phone_number_id" defaultValue={s.vapi_phone_number_id ?? ""} placeholder="ใส่ทีหลังได้" /></div>
          </div>
          <div className="card-b form-grid" style={{ borderTop: "1px solid var(--line)" }}>
            <div className="field"><label htmlFor="yalecom_caller_id">Yalecom: เบอร์โทรออก</label><input id="yalecom_caller_id" name="yalecom_caller_id" defaultValue={s.yalecom_caller_id ?? ""} placeholder="02xxxxxxx" /></div>
            <div className="field"><label htmlFor="yalecom_transfer_to">Yalecom: เบอร์ภายใน IVR (transfer_to)</label><input id="yalecom_transfer_to" name="yalecom_transfer_to" defaultValue={s.yalecom_transfer_to ?? ""} placeholder="ได้จาก Yalecom" /></div>
            <div className="field"><label htmlFor="audio_intro">ไฟล์เปิดสาย (ก่อนชื่อคอนโด)</label><input id="audio_intro" name="audio_intro" defaultValue={s.audio_intro ?? "tl_intro"} /></div>
            <div className="field"><label htmlFor="audio_question">ไฟล์คำถาม + เสียงสัญญาณ</label><input id="audio_question" name="audio_question" defaultValue={s.audio_question ?? "tl_question"} /></div>
            <div className="field"><label htmlFor="audio_generic_intro">ไฟล์เปิดสายแบบไม่มีชื่อคอนโด</label><input id="audio_generic_intro" name="audio_generic_intro" defaultValue={s.audio_generic_intro ?? "tl_intro_generic"} /></div>
          </div>
        </form>

        <div className="card">
          <div className="card-h"><h2>โทรทดสอบ 1 สาย</h2><span className="hint">โทรหาเบอร์ที่ใส่เท่านั้น ไม่แตะคิว · ใช้ระบบโทรที่เลือกไว้ด้านบน</span></div>
          <TestCallForm provider={s.provider} />
        </div>

        <div className="card">
          <div className="card-h"><h2>สถานะการเชื่อมต่อ</h2><span className="hint">ค่าเหล่านี้ตั้งใน Environment Variables</span></div>
          <div className="card-b">
            <dl className="kv">
              <dt>Yalecom (YALECOM_COMPANY_ID / KEY)</dt><dd>{env.yalecom ? "ตั้งแล้ว" : "ยังไม่ตั้ง"}</dd>
              <dt>ถอดเสียง + จัดผล</dt><dd>{env.gemini ? "Gemini (ตั้งแล้ว)" : env.openai ? "OpenAI (ตั้งแล้ว)" : "ยังไม่ตั้ง GEMINI_API_KEY หรือ OPENAI_API_KEY"}</dd>
              <dt>VAPI_API_KEY</dt><dd>{env.vapiKey ? "ตั้งแล้ว" : "ยังไม่ตั้ง (ใช้ได้แค่โหมดจำลอง)"}</dd>
              <dt>VAPI_WEBHOOK_SECRET</dt><dd>{env.vapiSecret ? "ตั้งแล้ว" : "ยังไม่ตั้ง"}</dd>
              <dt>LINE แจ้งแอดมิน</dt><dd>{env.line ? "ตั้งแล้ว" : "ยังไม่ตั้ง (ไม่บังคับ)"}</dd>
              <dt>CRON_SECRET</dt><dd>{env.cron ? "ตั้งแล้ว" : "ยังไม่ตั้ง"}</dd>
              <dt>INGEST_API_KEY</dt><dd>{env.ingest ? "ตั้งแล้ว" : "ยังไม่ตั้ง"}</dd>
            </dl>
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h2>URL ที่ต้องเอาไปใส่ในระบบอื่น</h2></div>
          <div className="card-b">
            <dl className="kv">
              <dt>Yalecom: Call data callback</dt><dd className="mono">{callbackUrl} <CopyButton text={callbackUrl} /></dd>
              <dt>Yalecom: Sequential playback</dt><dd className="mono">{site}/api/yalecom/playback <CopyButton text={`${site}/api/yalecom/playback`} /></dd>
              <dt>Vapi Server URL</dt><dd className="mono">{site}/api/vapi/webhook <CopyButton text={`${site}/api/vapi/webhook`} /></dd>
              <dt>รับลีดจาก n8n / Make</dt><dd className="mono">POST {site}/api/leads/ingest (header x-ingest-key) <CopyButton text={`${site}/api/leads/ingest`} /></dd>
              <dt>Cron ตัวยิงสาย</dt><dd className="mono">{site}/api/dialer/tick ทุก 1 นาที</dd>
            </dl>
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h2>ไฟล์เสียงชื่อคอนโด (Yalecom)</h2>
            <span className="hint">ยังไม่มีไฟล์ {missing} จาก {condos.length} โครงการที่อยู่ในคิว · ยังไม่มีไฟล์ = เล่นแบบไม่มีชื่อคอนโด</span>
          </div>
          <div className="tbl-wrap">
            <table className="tbl" style={{ minWidth: 820 }}>
              <thead><tr><th>คอนโด</th><th>ห้องในคิว</th><th>คำอ่าน (ส่งให้ Botnoi)</th><th>ชื่อไฟล์ใน Yalecom</th><th>อัปโหลดแล้ว</th><th></th></tr></thead>
              <tbody>
                {condos.map(([condo, n]) => {
                  const a: any = audioMap.get(condo);
                  const file = a?.file_name ?? condoFileName(condo);
                  return (
                    <tr key={condo}>
                      <td><b style={{ fontWeight: 500 }}>{condo}</b></td>
                      <td className="mono">{n}</td>
                      <td colSpan={4}>
                        <form action={saveCondoAudio} style={{ display: "grid", gridTemplateColumns: "minmax(180px,1fr) 170px 90px auto", gap: 10, alignItems: "center" }}>
                          <input type="hidden" name="condo" value={condo} />
                          <input type="hidden" name="file_name" value={file} />
                          <input name="tts_text" defaultValue={a?.tts_text ?? ""} placeholder="เช่น ไอดีโอ โมบิ อโศก" aria-label={`คำอ่าน ${condo}`} style={{ padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--surface)" }} />
                          <span className="mono small">{file} <CopyButton text={file} /></span>
                          <label className="toggle"><input type="checkbox" name="ready" defaultChecked={!!a?.ready} />พร้อม</label>
                          <button className="btn sm">บันทึก</button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
                {!condos.length && <tr><td colSpan={6} className="empty">ยังไม่มีห้องในคิว</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="card-b hint">ขั้นตอน: ใส่คำอ่าน → สร้างเสียงใน Botnoi → ตั้งชื่อไฟล์ตามคอลัมน์ "ชื่อไฟล์" → ส่ง/อัปโหลดเข้า Yalecom → ติ๊ก "พร้อม"</p>
        </div>

        <h2>บทของเอเจนต์ (วางใน Vapi Assistant)</h2>
        {block("First Message", FIRST_MESSAGE)}
        {block("System Prompt", SYSTEM_PROMPT)}
        {block("Analysis → Structured Data (JSON Schema)", schemaText)}
        {block("Prompt สรุปผล (ถ้าใช้ LLM แยก)", SUMMARY_PROMPT)}
      </div>
    </>
  );
}
