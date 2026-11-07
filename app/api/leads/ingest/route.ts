import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizePhone } from "@/lib/phone";

export const dynamic = "force-dynamic";
const MAX_ITEMS = 500;
const DAY = 24 * 3600_000;
const VPS_STATUSES = ["ว่าง", "ไม่ว่าง", "รอติดต่อ"];
/** ห้องที่อยู่ในสถานะเหล่านี้ ห้ามดึงเข้าคิวซ้ำ */
const NO_REQUEUE = ["queued", "calling", "dnc"];

/**
 * รับทรัพย์จาก VPS
 * POST /api/leads/ingest   header: x-ingest-key: <INGEST_API_KEY>
 * body: object หรือ array (ไม่เกิน 500) — ดูเอกสาร "สเปก API เชื่อมระบบทรัพย์"
 *
 * เข้าคิวโทรอัตโนมัติเมื่อ:
 *  - ทรัพย์ใหม่ (segment new) ที่เพิ่งเข้ามา และเปิด "ส่งห้องใหม่เข้าคิวอัตโนมัติ"
 *  - ทรัพย์ที่ไม่ได้อัปเดตบนเว็บเกิน stale_days วัน (หรือไม่มีวันที่) และเราไม่ได้โทรภายใน 1 วันที่ผ่านมา
 *  - ส่ง queue: true มาเอง
 */
export async function POST(req: NextRequest) {
  if (!process.env.INGEST_API_KEY || req.headers.get("x-ingest-key") !== process.env.INGEST_API_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const items: any[] = Array.isArray(body) ? body : body && typeof body === "object" ? [body] : [];
  if (!items.length) return NextResponse.json({ error: "body ต้องเป็น object หรือ array ของทรัพย์" }, { status: 400 });
  if (items.length > MAX_ITEMS) return NextResponse.json({ error: `ส่งได้ครั้งละไม่เกิน ${MAX_ITEMS} รายการ` }, { status: 400 });

  const db = createAdminClient();
  const { data: s } = await db.from("settings").select("auto_queue, stale_days").eq("id", 1).single();
  const now = Date.now();
  const staleBefore = now - (s?.stale_days ?? 30) * DAY;

  const result = { received: items.length, created: 0, updated: 0, queued: 0, skipped: [] as { external_id: string | null; reason: string }[] };

  type Row = {
    external_id: string | null; owner_name: string; phone: string; condo: string; unit: string | null; rent: number | null;
    source: string; segment: "new" | "old" | null; customer_nationalities: string | null; viewing_when: string | null;
    vps_status: string | null; vps_updated_at: string | null; queue: boolean | null;
  };
  const rows: Row[] = [];
  for (const x of items) {
    const ext = x?.external_id != null && String(x.external_id).trim() ? String(x.external_id).trim() : null;
    const owner = x?.owner_name ?? x?.name;
    const condo = x?.condo ?? x?.property_name;
    const missing = [["owner_name", owner], ["phone", x?.phone], ["condo", condo]].filter(([, v]) => !v || !String(v).trim()).map(([k]) => k);
    if (missing.length) { result.skipped.push({ external_id: ext, reason: `ไม่มี ${missing.join(", ")}` }); continue; }
    const phone = normalizePhone(String(x.phone));
    if (phone.replace(/\D/g, "").length < 9) { result.skipped.push({ external_id: ext, reason: "เบอร์โทรไม่ถูกต้อง" }); continue; }
    const rawUpdated = x.updated_at ?? x.last_updated_at ?? null;
    const updatedMs = rawUpdated ? Date.parse(String(rawUpdated)) : NaN;
    const status = x.status != null ? String(x.status).trim() : null;
    rows.push({
      external_id: ext,
      owner_name: String(owner).trim().replace(/^คุณ/, ""),
      phone,
      condo: String(condo).trim(),
      unit: x.unit ? String(x.unit).trim() : null,
      rent: x.rent != null && x.rent !== "" ? Number(String(x.rent).replace(/[^\d.]/g, "")) || null : null,
      source: x.source ? String(x.source) : "VPS",
      segment: x.segment === "old" ? "old" : x.segment === "new" ? "new" : null,
      customer_nationalities: x.customer_nationalities ? String(x.customer_nationalities) : null,
      viewing_when: x.viewing_when ? String(x.viewing_when) : null,
      vps_status: status && VPS_STATUSES.includes(status) ? status : status || null,
      vps_updated_at: Number.isFinite(updatedMs) ? new Date(updatedMs).toISOString() : null,
      queue: typeof x.queue === "boolean" ? x.queue : null,
    });
  }

  const phones = [...new Set(rows.map((r) => r.phone))];
  const { data: dnc } = phones.length ? await db.from("dnc_numbers").select("phone").in("phone", phones) : { data: [] };
  const dncSet = new Set((dnc ?? []).map((d: any) => d.phone));

  const cols = "id, external_id, phone, condo, status, segment, last_called_at";
  const exts = rows.map((r) => r.external_id).filter(Boolean) as string[];
  const { data: byExt } = exts.length ? await db.from("leads").select(cols).in("external_id", exts) : { data: [] };
  const extMap = new Map((byExt ?? []).map((l: any) => [l.external_id, l]));
  const { data: byPhone } = phones.length ? await db.from("leads").select(cols).in("phone", phones) : { data: [] };
  const pcMap = new Map((byPhone ?? []).map((l: any) => [`${l.phone}|${l.condo.toLowerCase()}`, l]));

  for (const r of rows) {
    const existing: any = (r.external_id && extMap.get(r.external_id)) || pcMap.get(`${r.phone}|${r.condo.toLowerCase()}`);
    const blocked = dncSet.has(r.phone);
    const stale = !r.vps_updated_at || Date.parse(r.vps_updated_at) < staleBefore;
    const segment = r.segment ?? existing?.segment ?? (r.vps_updated_at ? "old" : "new");
    const info = {
      owner_name: r.owner_name, phone: r.phone, condo: r.condo, unit: r.unit, rent: r.rent, source: r.source, segment,
      customer_nationalities: r.customer_nationalities, viewing_when: r.viewing_when, vps_status: r.vps_status, vps_updated_at: r.vps_updated_at,
    };

    if (existing) {
      if (existing.external_id && r.external_id && existing.external_id !== r.external_id) {
        result.skipped.push({ external_id: r.external_id, reason: `เบอร์+คอนโดซ้ำกับทรัพย์ ${existing.external_id}` });
        continue;
      }
      const calledRecently = existing.last_called_at && Date.parse(existing.last_called_at) > now - DAY;
      const autoRequeue = stale && existing.status !== "new" && !calledRecently;
      const phoneChanged = existing.phone !== r.phone;
      const wantQueue = !blocked && !NO_REQUEUE.includes(existing.status) && (existing.status !== "wrong_number" || phoneChanged)
        && (r.queue === true || (r.queue !== false && autoRequeue));
      const patch: Record<string, unknown> = { ...info, external_id: r.external_id ?? existing.external_id };
      if (wantQueue) Object.assign(patch, { status: "queued", attempts: 0, next_call_at: null });
      const { error } = await db.from("leads").update(patch).eq("id", existing.id);
      if (error) { result.skipped.push({ external_id: r.external_id, reason: error.message }); continue; }
      result.updated++;
      if (wantQueue) result.queued++;
      continue;
    }

    const queue = !blocked && (r.queue ?? (segment === "new" ? !!s?.auto_queue : stale));
    const { error } = await db.from("leads").insert({ ...info, external_id: r.external_id, status: blocked ? "dnc" : queue ? "queued" : "new" });
    if (error) { result.skipped.push({ external_id: r.external_id, reason: error.message }); continue; }
    result.created++;
    if (queue) result.queued++;
    if (blocked) result.skipped.push({ external_id: r.external_id, reason: "เบอร์อยู่ในรายการห้ามโทร (บันทึกไว้แต่ไม่โทร)" });
  }

  return NextResponse.json(result);
}
