import { createClient } from "@/lib/supabase/server";
import { Top } from "@/components/Top";
import { CopyButton } from "@/components/CopyButton";
import { FIRST_MESSAGE, SYSTEM_PROMPT, ANALYSIS_SCHEMA, SUMMARY_PROMPT } from "@/lib/prompt";
import { updateSettings } from "./actions";

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
  };
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
                <option value="vapi">Vapi (โทรจริง)</option>
              </select>
            </div>
            <div className="field"><label htmlFor="company">ชื่อบริษัท {"{{company}}"}</label><input id="company" name="company" defaultValue={s.company} /></div>
            <div className="field"><label htmlFor="default_nationalities">สัญชาติลูกค้าตั้งต้น</label><input id="default_nationalities" name="default_nationalities" defaultValue={s.default_nationalities} /></div>
            <div className="field"><label htmlFor="viewing_when">ลูกค้าอยากนัดชม</label><input id="viewing_when" name="viewing_when" defaultValue={s.viewing_when} /></div>
            <div className="field"><label htmlFor="vapi_assistant_id">Vapi Assistant ID</label><input id="vapi_assistant_id" name="vapi_assistant_id" defaultValue={s.vapi_assistant_id ?? ""} placeholder="ใส่ทีหลังได้" /></div>
            <div className="field"><label htmlFor="vapi_phone_number_id">Vapi Phone Number ID (เบอร์จาก SIP Trunk)</label><input id="vapi_phone_number_id" name="vapi_phone_number_id" defaultValue={s.vapi_phone_number_id ?? ""} placeholder="ใส่ทีหลังได้" /></div>
          </div>
        </form>

        <div className="card">
          <div className="card-h"><h2>สถานะการเชื่อมต่อ</h2><span className="hint">ค่าเหล่านี้ตั้งใน Environment Variables</span></div>
          <div className="card-b">
            <dl className="kv">
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
              <dt>Vapi Server URL</dt><dd className="mono">{site}/api/vapi/webhook <CopyButton text={`${site}/api/vapi/webhook`} /></dd>
              <dt>รับลีดจาก n8n / Make</dt><dd className="mono">POST {site}/api/leads/ingest (header x-ingest-key) <CopyButton text={`${site}/api/leads/ingest`} /></dd>
              <dt>Cron ตัวยิงสาย</dt><dd className="mono">{site}/api/dialer/tick ทุก 1 นาที</dd>
            </dl>
          </div>
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
