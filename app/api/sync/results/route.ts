import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildResultPayload } from "@/lib/sync";

export const dynamic = "force-dynamic";

/**
 * ดึงผลการโทรย้อนหลัง (กันข้อมูลตกหล่นจาก webhook)
 * GET /api/sync/results?since=2026-11-08T00:00:00Z&limit=200   header: x-ingest-key
 * เรียงตาม ended_at จากเก่าไปใหม่ ใช้ next_since เป็น since ของรอบถัดไป
 */
export async function GET(req: NextRequest) {
  if (!process.env.INGEST_API_KEY || req.headers.get("x-ingest-key") !== process.env.INGEST_API_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  const since = sp.get("since") ?? new Date(Date.now() - 24 * 3600_000).toISOString();
  if (Number.isNaN(Date.parse(since))) return NextResponse.json({ error: "since ต้องเป็นวันที่แบบ ISO 8601" }, { status: 400 });
  const limit = Math.min(500, Math.max(1, Number(sp.get("limit")) || 200));

  const db = createAdminClient();
  const { data, error } = await db
    .from("calls")
    .select("*, leads!calls_lead_id_fkey(*)")
    .eq("state", "ended")
    .gt("ended_at", new Date(since).toISOString())
    .order("ended_at", { ascending: true })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const items = (data ?? [])
    .map((c: any) => ({ c, l: Array.isArray(c.leads) ? c.leads[0] : c.leads }))
    .filter(({ l }) => l?.external_id)
    .map(({ c, l }) => buildResultPayload(c, l, c.synced_at ?? c.ended_at));
  const last = data?.at(-1)?.ended_at ?? null;
  return NextResponse.json({ items, next_since: last ?? since, has_more: (data?.length ?? 0) === limit });
}
