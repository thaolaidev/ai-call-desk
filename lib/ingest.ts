import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";

const DAY = 24 * 3600_000;
const VPS_STATUSES = ["ว่าง", "ไม่ว่าง", "รอติดต่อ"];
/** ห้องที่อยู่ในสถานะเหล่านี้ ห้ามดึงเข้าคิวซ้ำ */
const NO_REQUEUE = ["queued", "calling", "dnc"];

export type IngestResult = { received: number; created: number; updated: number; queued: number; skipped: { external_id: string | null; reason: string }[] };

/**
 * บันทึกทรัพย์จาก VPS ลงกองลีด (ใช้ทั้งตอน VPS ส่งมา และตอนเราดึงจาก GET /leads)
 * รับชื่อฟิลด์ได้ทั้งแบบ API ของเท่าไหร่ (id, code, condo_name, listed_at, updated_by) และแบบเดิม (external_id, condo)
 *
 * แยกประเภท: ลงทรัพย์ภายใน new_days วัน = ทรัพย์ใหม่, เก่ากว่านั้น = ทรัพย์เดิม
 * เข้าคิวโทรอัตโนมัติเมื่อ:
 *  - ทรัพย์ใหม่ที่เพิ่งเข้ามา และเปิด "ส่งห้องใหม่เข้าคิวอัตโนมัติ"
 *  - ทรัพย์ที่ไม่ได้อัปเดตบนเว็บเกิน stale_days วัน และเราไม่ได้โทรภายใน 1 วันที่ผ่านมา
 *  - ส่ง queue: true มาเอง
 */
export async function ingestLeads(db: SupabaseClient, items: any[]): Promise<IngestResult> {
  const { data: s } = await db.from("settings").select("auto_queue, stale_days, new_days").eq("id", 1).single();
  const now = Date.now();
  const staleBefore = now - (s?.stale_days ?? 30) * DAY;

  const result = { received: items.length, created: 0, updated: 0, queued: 0, skipped: [] as { external_id: string | null; reason: string }[] };

  type Row = {
    external_id: string | null; owner_name: string; phone: string; condo: string; unit: string | null; rent: number | null;
    source: string; segment: "new" | "old" | null; customer_nationalities: string | null; viewing_when: string | null;
    vps_status: string | null; vps_updated_at: string | null; queue: boolean | null;
    code: string | null; listed_at: string | null; vps_updated_by: string | null; condo_id: string | null;
  };
  const newBefore = now - (s?.new_days ?? 7) * DAY;
  const rows: Row[] = [];
  for (const x of items) {
    const rawId = x?.external_id ?? x?.id;
    const ext = rawId != null && String(rawId).trim() ? String(rawId).trim() : null;
    const owner = x?.owner_name ?? x?.name ?? "";
    const condo = x?.condo ?? x?.condo_name ?? x?.property_name;
    const missing = [["phone", x?.phone], ["condo", condo]].filter(([, v]) => !v || !String(v).trim()).map(([k]) => k);
    if (missing.length) { result.skipped.push({ external_id: ext, reason: `ไม่มี ${missing.join(", ")}` }); continue; }
    const phone = normalizePhone(String(x.phone));
    if (phone.replace(/\D/g, "").length < 9) { result.skipped.push({ external_id: ext, reason: "เบอร์โทรไม่ถูกต้อง" }); continue; }
    const rawUpdated = x.updated_at ?? x.last_updated_at ?? null;
    const updatedMs = rawUpdated ? Date.parse(String(rawUpdated)) : NaN;
    const status = x.status != null && String(x.status).trim() ? String(x.status).trim() : null;
    const listedMs = x.listed_at ? Date.parse(String(x.listed_at)) : NaN;
    const listed_at = Number.isFinite(listedMs) ? new Date(listedMs).toISOString() : null;
    rows.push({
      external_id: ext,
      owner_name: String(owner).trim().replace(/^คุณ/, ""),
      phone,
      condo: String(condo).trim(),
      unit: x.unit ? String(x.unit).trim() : null,
      rent: (x.rent ?? x.price) != null && (x.rent ?? x.price) !== "" ? Number(String(x.rent ?? x.price).replace(/[^\d.]/g, "")) || null : null,
      source: x.source ? String(x.source) : "VPS",
      segment: x.segment === "old" ? "old" : x.segment === "new" ? "new" : listed_at ? (Date.parse(listed_at) >= newBefore ? "new" : "old") : null,
      customer_nationalities: x.customer_nationalities ? String(x.customer_nationalities) : null,
      viewing_when: x.viewing_when ? String(x.viewing_when) : null,
      vps_status: status && VPS_STATUSES.includes(status) ? status : status || null,
      vps_updated_at: Number.isFinite(updatedMs) ? new Date(updatedMs).toISOString() : null,
      queue: typeof x.queue === "boolean" ? x.queue : null,
      code: x.code ? String(x.code).trim() : null,
      listed_at,
      vps_updated_by: x.updated_by ? String(x.updated_by).trim() : null,
      condo_id: (() => { const v = x.condo_id ?? x.location_id ?? x.project_id; return v != null && String(v).trim() ? String(v).trim() : null; })(),
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
      code: r.code, listed_at: r.listed_at, vps_updated_by: r.vps_updated_by,
      ...(r.condo_id ? { condo_id: r.condo_id } : {}),
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

  return result;
}
