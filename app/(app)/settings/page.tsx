import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Top } from "@/components/Top";
import { SaveButton } from "@/components/SaveButton";
import { CopyButton } from "@/components/CopyButton";
import { TestCallForm } from "@/components/TestCallForm";
import { FIRST_MESSAGE, SYSTEM_PROMPT, ANALYSIS_SCHEMA, SUMMARY_PROMPT } from "@/lib/prompt";
import { updateSettings } from "./actions";
import { updateCampaign } from "../calling/actions";

const DAYS = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
import { condoFileName } from "@/lib/yalecom";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ err?: string; saved?: string }> }) {
  const sp = await searchParams;
  const sb = await createClient();
  const [{ data: s, error }, { data: roomRows }] = await Promise.all([
    sb.from("settings").select("*").eq("id", 1).single(),
    sb.from("call_rooms").select("*").order("segment"),
  ]);
  const rooms: any[] = roomRows ?? [];
  const room = (seg: string) => rooms.find((r) => r.segment === seg) ?? {};
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
    vps: !!process.env.VPS_API_URL && !!process.env.VPS_API_KEY,
    botnoi: !!process.env.BOTNOI_TOKEN,
    voice: !!process.env.VOICE_SERVER_URL && !!process.env.VOICE_SECRET,
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
  const missing = condos.filter(([c]) => !audioMap.get(c)?.path).length;
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
        <form className="card" action={updateCampaign} id="campaign">
          <div className="card-h"><h2>ตั้งค่าการโทร</h2><SaveButton /></div>
          <div className="card-b form-grid">
            {["new", "old"].map((seg) => (
              <div key={seg} className="field" style={{ gridColumn: "span 1" }}>
                <label>{seg === "new" ? "ห้องทรัพย์ใหม่" : "ห้องทรัพย์เดิม · อัปเดต"}: สายพร้อมกัน / เป้าต่อวัน</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input name={`concurrency_${seg}`} type="number" min={0} max={10} defaultValue={room(seg).concurrency ?? 3} aria-label="สายพร้อมกัน" style={{ width: "50%" }} />
                  <input name={`daily_cap_${seg}`} type="number" min={0} defaultValue={room(seg).daily_cap ?? 100} aria-label="เป้าต่อวัน" style={{ width: "50%" }} />
                </div>
              </div>
            ))}
            <div className="field"><label htmlFor="call_start">เริ่มโทร</label><input id="call_start" name="call_start" type="time" defaultValue={String(s.call_start).slice(0, 5)} /></div>
            <div className="field"><label htmlFor="call_end">หยุดโทร</label><input id="call_end" name="call_end" type="time" defaultValue={String(s.call_end).slice(0, 5)} /></div>
            <div className="field"><label htmlFor="retry_gap_min">ไม่รับสาย: โทรซ้ำทุก (นาที)</label><input id="retry_gap_min" name="retry_gap_min" type="number" min={15} defaultValue={s.retry_gap_min} /></div>
            <div className="field"><label htmlFor="max_attempts">โทรสูงสุด (ครั้ง)</label><input id="max_attempts" name="max_attempts" type="number" min={1} max={10} defaultValue={s.max_attempts} /></div>
            <div className="field"><label htmlFor="pull_time">ดึงลีดจากเว็บทุกวันเวลา</label><input id="pull_time" name="pull_time" type="time" defaultValue={s.pull_time ?? "09:00"} /></div>
            <div className="field"><label htmlFor="sync_every_min">ส่งผลกลับเว็บทุก (นาที)</label><input id="sync_every_min" name="sync_every_min" type="number" min={5} max={1440} defaultValue={s.sync_every_min ?? 30} /></div>
            <div className="field"><label htmlFor="new_days">ทรัพย์ใหม่: ลงประกาศมาไม่เกิน (วัน)</label><input id="new_days" name="new_days" type="number" min={1} max={90} defaultValue={s.new_days ?? 7} /></div>
            <div className="field"><label htmlFor="stale_days">ทรัพย์เก่า: โทรเช็คเมื่อไม่ได้อัปเดตเกิน (วัน)</label><input id="stale_days" name="stale_days" type="number" min={1} max={365} defaultValue={s.stale_days ?? 30} /></div>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="small muted" style={{ fontWeight: 500, marginBottom: 6 }}>วันที่โทร</legend>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {DAYS.map((d, i) => (
                  <label key={d} className="toggle"><input type="checkbox" name="call_days" value={i} defaultChecked={s.call_days.includes(i)} />{d}</label>
                ))}
              </div>
            </fieldset>
            <label className="toggle"><input type="checkbox" name="auto_queue" defaultChecked={s.auto_queue} />ส่งห้องใหม่เข้าคิวอัตโนมัติ</label>
          </div>
        </form>

        <form className="card" action={updateSettings}>
          <div className="card-h"><h2>ระบบโทรและข้อมูลในบท</h2><SaveButton /></div>
          <div className="card-b form-grid">
            <div className="field">
              <label htmlFor="provider">ระบบโทร</label>
              <select id="provider" name="provider" defaultValue={s.provider}>
                <option value="simulate">โหมดจำลอง (ไม่โทรจริง)</option>
                <option value="sip">Server เสียงของเรา (SIP) · แยกทางตามคำตอบ</option>
                <option value="yalecom">Yalecom Robocall (เล่นเสียงอัด + ถอดเสียงคำตอบ)</option>
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
            {["old", "new"].map((seg) => (
              <div key={seg} className="field">
                <label>ไฟล์เสียงห้อง{seg === "new" ? "ทรัพย์ใหม่" : "ทรัพย์เดิม"}: เปิดสาย / คำถาม / เปิดสายไม่มีชื่อคอนโด</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input name={`audio_intro_${seg}`} defaultValue={room(seg).audio_intro ?? ""} aria-label="ไฟล์เปิดสาย" style={{ width: "33%" }} />
                  <input name={`audio_question_${seg}`} defaultValue={room(seg).audio_question ?? ""} aria-label="ไฟล์คำถาม" style={{ width: "33%" }} />
                  <input name={`audio_generic_intro_${seg}`} defaultValue={room(seg).audio_generic_intro ?? ""} aria-label="ไฟล์เปิดสายไม่มีชื่อคอนโด" style={{ width: "33%" }} />
                </div>
              </div>
            ))}
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
              <dt>เว็บเท่าไหร่ (VPS_API_URL / VPS_API_KEY)</dt><dd>{env.vps ? `ตั้งแล้ว · ดึงลีดทุกวัน ${s.pull_time ?? "09:00"} · ส่งผลกลับทุก ${s.sync_every_min ?? 30} นาที${s.last_pull_at ? ` · ล่าสุด ${new Date(s.last_pull_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}` : ""}` : "ยังไม่ตั้ง"}</dd>
              <dt>Server เสียง (VOICE_SERVER_URL / VOICE_SECRET)</dt><dd>{env.voice ? `ตั้งแล้ว · ${process.env.VOICE_SERVER_URL}` : "ยังไม่ตั้ง"}</dd>
              <dt>Botnoi อ่านชื่อคอนโด (BOTNOI_TOKEN)</dt><dd>{env.botnoi ? `ตั้งแล้ว · ${(process.env.BOTNOI_VERSION ?? "v2").toUpperCase()} · ผู้พูด ${process.env.BOTNOI_SPEAKER || "Ava (ค่าเริ่มต้น)"}` : "ยังไม่ตั้ง"}</dd>
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
          <div className="card-h"><h2>เสียงชื่อคอนโด</h2><Link className="btn sm" href="/condos">ไปคลังชื่อคอนโด</Link></div>
          <p className="card-b hint">ยังไม่มีเสียง {missing} จาก {condos.length} โครงการที่อยู่ในคิว · จัดการ ฟัง และอัปโหลดไฟล์ได้ที่หน้า "คลังชื่อคอนโด"</p>
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
