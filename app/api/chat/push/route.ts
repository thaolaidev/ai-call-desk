import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ingestLeads } from "@/lib/ingest";
import { dispatchChat } from "@/lib/chat";
import { normalizePhone } from "@/lib/phone";
import { matchCondo } from "@/lib/condomatch";

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
  if (!s) return NextResponse.json({ error: "อ่าน settings ไม่ได้" }, { status: 500 });
  // ห้องโทรตามกลุ่มแชท: Check ทรัพย์ใหม่ = new · Check สถานะห้อง = old (ไม่รู้กลุ่ม: ห้องจากข้อความ msg-… = new)
  const { data: callRooms } = await db.from("call_rooms").select("segment, name, chat_mode, chat_group_uuid");
  const isMsg = rooms.some((r) => String(r?.id ?? "").startsWith("msg-"));
  const room: any = (callRooms ?? []).find((r: any) => r.chat_group_uuid && r.chat_group_uuid === group)
    ?? (callRooms ?? []).find((r: any) => r.segment === (isMsg ? "new" : "old"));
  const segment: "new" | "old" = room?.segment === "new" ? "new" : "old";
  if ((room?.chat_mode ?? "queue") === "off") return NextResponse.json({ error: `ห้อง ${room?.name ?? segment} ปิดรับอยู่ (หน้าห้องโทร)` }, { status: 503 });
  const recallMs = (s.chat_recall_hours ?? 12) * 3600_000;

  // ชื่อคอนโดที่ไม่มี condo_id (เช่นแอดมินพิมพ์ "Ideo mobi Asoke") → จับคู่กับคลังชื่อคอนโด ใช้ชื่อเต็ม + id ในคลัง
  // จะได้อ่านชื่อไทยที่ถูกต้อง · จับคู่ไม่ได้ = ใช้ชื่อตามที่พิมพ์
  for (const r of rooms) {
    const typed = String(r?.condo_name ?? r?.condo ?? "").trim();
    if (!typed || r?.condo_id || r?.location_id) continue;
    const m = await matchCondo(db, typed).catch(() => null);
    if (m) Object.assign(r, { condo_name: m.condo, condo: undefined, condo_id: m.condo_id, typed_condo: typed });
  }

  const result: { asset_uuid: string | null; id: string | null; state: "queued" | "skipped"; reason?: string; last_result?: string | null }[] = [];
  const accept: any[] = [];

  // ห้องที่ AI เพิ่งโทรไป หรือกำลังโทรอยู่ ไม่โทรซ้ำ
  const ids = rooms.map((r) => (r?.id != null ? String(r.id) : null)).filter(Boolean) as string[];
  const { data: existing } = ids.length
    ? await db.from("leads").select("external_id, status, last_called_at, last_summary").in("external_id", ids)
    : { data: [] as any[] };
  const byId = new Map((existing ?? []).map((l: any) => [l.external_id, l]));

  // ห้องจากข้อความในแชท (id = msg-…) ยังไม่มีในหลังบ้าน: ถ้าเบอร์+คอนโดเดียวกันเคยส่งมาแล้ว ใช้ลีดเดิม (ย้าย id ไปข้อความล่าสุด)
  const msgRooms = rooms.filter((r) => String(r?.id ?? "").startsWith("msg-") && r?.phone && (r?.condo_name ?? r?.condo));
  if (msgRooms.length) {
    const phones = [...new Set(msgRooms.map((r) => normalizePhone(String(r.phone))))];
    const { data: same } = await db.from("leads").select("id, external_id, phone, condo, status, last_called_at, last_summary").in("phone", phones);
    for (const r of msgRooms) {
      const name = String(r.condo_name ?? r.condo).trim().toLowerCase();
      const l: any = (same ?? []).find((x: any) => x.phone === normalizePhone(String(r.phone)) && String(x.condo).trim().toLowerCase() === name);
      if (!l || l.external_id === String(r.id)) continue;
      byId.set(String(r.id), l); // ใช้กฎกันโทรซ้ำของลีดเดิม
      if (!["calling", "queued"].includes(l.status) && !(l.last_called_at && Date.now() - Date.parse(l.last_called_at) < recallMs)) {
        await db.from("leads").update({ external_id: String(r.id) }).eq("id", l.id);
      }
    }
  }

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
    accept.push({ ...r, queue: true, source: "chat", segment });
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

  const d = await dispatchChat(db, s, segment);
  return NextResponse.json({
    queued: result.filter((x) => x.state === "queued").length,
    started: d.started,
    waiting: d.waiting ?? null, // เหตุผลที่ยังไม่โทรทันที เช่น นอกเวลาโทร (ห้องยังอยู่ในคิว จะโทรเมื่อถึงเวลา)
    errors: d.errors,
    rooms: result,
  }, { status: 202 });
}
