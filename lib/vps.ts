import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestLeads, type IngestResult } from "./ingest";
import { fillMissingCondoAudio } from "./botnoi";
import { fillMissingPriceAudio } from "./priceaudio";

/** API ฝั่งเว็บเท่าไหร่ เช่น https://thaolai.com/service/api/v1/ai-call */
export const vpsBase = () => (process.env.VPS_API_URL ?? "").replace(/\/+$/, "");
export const vpsReady = () => !!(vpsBase() && process.env.VPS_API_KEY);

const PER_PAGE = 100;
const MAX_PAGES = 20;
const DAY = 24 * 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** เรียก GET {VPS_API_URL}/leads หนึ่งหน้า */
async function fetchPage(params: Record<string, string>) {
  const qs = new URLSearchParams({ ...params, per_page: String(PER_PAGE) });
  const res = await fetch(`${vpsBase()}/leads?${qs}`, {
    headers: { "X-API-Key": process.env.VPS_API_KEY!, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  const items: any[] = json?.data?.items ?? json?.items ?? (Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []);
  return items;
}

/** ดึงทุกหน้าของชุดหนึ่ง (หยุดเมื่อหน้าไม่เต็ม หรือ API ไม่รองรับ page แล้วส่งหน้าเดิมซ้ำ) */
async function fetchAll(params: Record<string, string>) {
  const all: any[] = [];
  let firstId: string | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await fetchPage({ ...params, page: String(page) });
    if (!items.length) break;
    const id = String(items[0]?.id ?? "");
    if (page > 1 && id === firstId) break;
    if (page === 1) firstId = id;
    all.push(...items);
    if (items.length < PER_PAGE) break;
  }
  return all;
}

/**
 * ดึงลีด 2 ชุดจาก GET {VPS_API_URL}/leads แล้วบันทึกเข้ากองลีด
 *  - ทรัพย์ใหม่: ?listed_after=<วันนี้ - new_days>
 *  - ทรัพย์เดิม: ?listed_before=<วันนี้ - new_days>&updated_before=<วันนี้ - stale_days>
 */
export async function pullLeads(db: SupabaseClient): Promise<IngestResult & { error?: string }> {
  const empty = { received: 0, created: 0, updated: 0, queued: 0, skipped: [] };
  if (!vpsReady()) return { ...empty, error: "ยังไม่ได้ตั้ง VPS_API_URL / VPS_API_KEY" };
  // จดเวลาไว้ก่อน แม้ดึงไม่สำเร็จ จะได้ไม่ยิงซ้ำทุก tick
  await db.from("settings").update({ last_pull_at: new Date().toISOString() }).eq("id", 1);
  const { data: s } = await db.from("settings").select("new_days, stale_days").eq("id", 1).single();
  const now = Date.now();
  const newCut = iso(now - (s?.new_days ?? 7) * DAY);
  const staleCut = iso(now - (s?.stale_days ?? 30) * DAY);

  let items: any[];
  try {
    const [fresh, old] = await Promise.all([
      fetchAll({ listed_after: newCut }),
      fetchAll({ listed_before: newCut, updated_before: staleCut }),
    ]);
    const seen = new Set<string>();
    items = [...fresh, ...old].filter((x) => {
      const k = String(x?.id ?? "");
      if (!k || seen.has(k)) return !k;
      seen.add(k);
      return true;
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ...empty, error: /abort|timeout/i.test(m) ? "เว็บเท่าไหร่ไม่ตอบภายใน 15 วินาที (อาจถูกไฟร์วอลล์บล็อก IP ของ Vercel)" : `เรียก API ไม่ได้: ${m}` };
  }
  const result = await ingestLeads(db, items);
  // คอนโดใหม่ที่ยังไม่มีเสียงชื่อ → ให้ Botnoi อ่านแล้วเก็บไว้ใช้ซ้ำ
  await fillMissingCondoAudio(db, 5).catch(() => null);
  await fillMissingPriceAudio(db, 5).catch(() => null);
  return result;
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
