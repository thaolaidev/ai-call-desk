import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestLeads, type IngestResult } from "./ingest";

/** API ฝั่งเว็บเท่าไหร่ เช่น https://thaolai.com/service/api/v1/ai-call */
export const vpsBase = () => (process.env.VPS_API_URL ?? "").replace(/\/+$/, "");
export const vpsReady = () => !!(vpsBase() && process.env.VPS_API_KEY);

/** ดึงลีดจาก GET {VPS_API_URL}/leads แล้วบันทึกเข้ากองลีด */
export async function pullLeads(db: SupabaseClient): Promise<IngestResult & { error?: string }> {
  const empty = { received: 0, created: 0, updated: 0, queued: 0, skipped: [] };
  if (!vpsReady()) return { ...empty, error: "ยังไม่ได้ตั้ง VPS_API_URL / VPS_API_KEY" };
  // จดเวลาไว้ก่อน แม้ดึงไม่สำเร็จ จะได้ไม่ยิงซ้ำทุก tick
  await db.from("settings").update({ last_pull_at: new Date().toISOString() }).eq("id", 1);
  let items: any[] = [];
  try {
    const res = await fetch(`${vpsBase()}/leads`, {
      headers: { "X-API-Key": process.env.VPS_API_KEY!, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) return { ...empty, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    const json = JSON.parse(text);
    items = json?.data?.items ?? json?.items ?? (Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ...empty, error: /abort|timeout/i.test(m) ? "เว็บเท่าไหร่ไม่ตอบภายใน 15 วินาที (อาจถูกไฟร์วอลล์บล็อก IP ของ Vercel)" : `เรียก API ไม่ได้: ${m}` };
  }
  return ingestLeads(db, items);
}

/** เวลาดึงประจำวันของวันนี้ (เวลาไทย) เช่น "09:00" → Date */
function todayAt(hhmm: string) {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [h, m] = (/^\d{1,2}:\d{2}$/.test(hhmm) ? hhmm : "09:00").split(":");
  return Date.parse(`${d}T${h.padStart(2, "0")}:${m}:00+07:00`);
}

/** เรียกจาก tick: ดึงลีดวันละครั้ง เมื่อถึงเวลา pull_time (ค่าเริ่มต้น 09:00) */
export async function pullLeadsIfDue(db: SupabaseClient, lastPullAt: string | null | undefined, pullTime?: string | null) {
  if (!vpsReady()) return null;
  const due = todayAt(pullTime ?? "09:00");
  if (Date.now() < due) return null;
  if (lastPullAt && Date.parse(lastPullAt) >= due) return null;
  return pullLeads(db);
}
