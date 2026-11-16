import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ingestLeads } from "@/lib/ingest";
import { dispatchChat } from "@/lib/chat";
import { normalizePhone } from "@/lib/phone";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const MAX_ROOMS = 30;

/**
 * แชททีมส่งห้องมาให้ AI โทรทันที
 * POST /api/chat/push   header: X-API-Key: <CHAT_API_KEY>
 * body: { group_uuid, requested_by?, rooms: [{ id, asset_uuid, phone, condo_name, condo_id?, price?, code?, owner_name?, listed_at?, status?, updated_at? }] }
 * ผลการโทรส่งกลับทาง POST {VPS_API_URL}/results ทันทีที่สายจบ (มี chat_group_uuid + asset_uuid ให้ไปอัปเดตการ์ดห้อง)
 */
export async function POST(req: NextRequest) {
  if (!process.env.CHAT_API_KEY || req.headers.get("x-api-key") !== process.env.CHAT_API_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const rooms: any[] = Array.isArray(body?.rooms) ? body.rooms : [];
  const group = body?.group_uuid ? String(body.group_uuid) : null;
  if (!rooms.length) return NextResponse.json({ error: "ต้องมี rooms อย่างน้อย 1 ห้อง" }, { status: 400 });
  if (rooms.length > MAX_ROOMS) return NextResponse.json({ error: `ส่งได้ครั้งละไม่เกิน ${MAX_ROOMS} ห้อง` }, { status: 400 });

  const db = createAdminClient();
  const { data: s } = await db.from("settings").select("*").eq("id", 1).single();
  const mode = s?.chat_mode ?? (s?.chat_enabled === false ? "off" : "auto");
  if (!s || mode === "off") return NextResponse.json({ error: "ปิดรับห้องจากแชทไว้ที่หน้าห้องโทร" }, { status: 503 });
  const recallMs = (s.chat_recall_hours ?? 12) * 3600_000;

  const result: { asset_uuid: string | null; id: string | null; state: "queued" | "skipped"; reason?: string; last_result?: string | null }[] = [];
  const accept: any[] = [];

  // ห้องที่ AI เพิ่งโทรไป หรือกำลังโทรอยู่ ไม่โทรซ้ำ
  const ids = rooms.map((r) => (r?.id != null ? String(r.id) : null)).filter(Boolean) as string[];
  const { data: existing } = ids.length
    ? await db.from("leads").select("external_id, status, last_called_at, last_summary").in("external_id", ids)
    : { data: [] as any[] };
  const byId = new Map((existing ?? []).map((l: any) => [l.external_id, l]));

  for (const r of rooms) {
    const id = r?.id != null ? String(r.id) : null;
    const asset = r?.asset_uuid ? String(r.asset_uuid) : null;
    const l: any = id ? byId.get(id) : null;
    if (!r?.phone || normalizePhone(String(r.phone)).replace(/\D/g, "").length < 9) { result.push({ asset_uuid: asset, id, state: "skipped", reason: "ไม่มีเบอร์โทรหรือเบอร์ไม่ถูกต้อง" }); continue; }
    if (l && ["calling", "queued"].includes(l.status)) { result.push({ asset_uuid: asset, id, state: "skipped", reason: l.status === "calling" ? "AI กำลังโทรห้องนี้อยู่" : "อยู่ในคิวโทรแล้ว" }); continue; }
    if (l?.status === "dnc") { result.push({ asset_uuid: asset, id, state: "skipped", reason: "เจ้าของขอไม่ให้ติดต่อ" }); continue; }
    if (l?.last_called_at && Date.now() - Date.parse(l.last_called_at) < recallMs) {
      result.push({ asset_uuid: asset, id, state: "skipped", reason: `AI โทรไปแล้วเมื่อ ${new Date(l.last_called_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}`, last_result: l.last_summary ?? null });
      continue;
    }
    accept.push({ ...r, queue: true, source: "chat" });
    result.push({ asset_uuid: asset, id, state: "queued" });
  }

  if (accept.length) {
    const ing = await ingestLeads(db, accept);
    for (const sk of ing.skipped) {
      const row = result.find((x) => x.id === sk.external_id && x.state === "queued");
      if (row) Object.assign(row, { state: "skipped", reason: sk.reason });
    }
    // ผูกห้องกับการ์ดในแชท + ทำให้ห้องโทรจากแชทหยิบไปโทร
    const now = new Date().toISOString();
    for (const r of accept) {
      const row = result.find((x) => x.id === (r.id != null ? String(r.id) : null));
      if (row?.state !== "queued") continue;
      const patch = { chat_group_uuid: group, chat_asset_uuid: r.asset_uuid ? String(r.asset_uuid) : null, chat_requested_by: body?.requested_by ? String(body.requested_by) : null, chat_requested_at: now };
      const q = r.id != null
        ? db.from("leads").update(patch).eq("external_id", String(r.id))
        : db.from("leads").update(patch).eq("phone", normalizePhone(String(r.phone))).ilike("condo", String(r.condo_name ?? r.condo ?? ""));
      const { error } = await q;
      if (error) Object.assign(row, { state: "skipped", reason: error.message });
    }
    // ห้องที่ระบบไม่ยอมเข้าคิว (เช่น เคยโทรแล้วเบอร์ผิด) แจ้งกลับให้รู้
    const qIds = result.filter((x) => x.state === "queued" && x.id).map((x) => x.id as string);
    const { data: after } = qIds.length ? await db.from("leads").select("external_id, status").in("external_id", qIds) : { data: [] as any[] };
    for (const l of after ?? []) {
      if (l.status === "queued") continue;
      const row = result.find((x) => x.id === l.external_id);
      if (row) Object.assign(row, { state: "skipped", reason: l.status === "wrong_number" ? "เคยโทรแล้วคนรับไม่ใช่เจ้าของ ต้องแก้เบอร์ก่อน" : `ไม่เข้าคิว (สถานะ ${l.status})` });
    }
  }

  const d = await dispatchChat(db, s);
  return NextResponse.json({
    queued: result.filter((x) => x.state === "queued").length,
    started: d.started,
    waiting: d.waiting ?? null, // เหตุผลที่ยังไม่โทรทันที เช่น นอกเวลาโทร (ห้องยังอยู่ในคิว จะโทรเมื่อถึงเวลา)
    errors: d.errors,
    rooms: result,
  }, { status: 202 });
}
