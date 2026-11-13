import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ingestLeads } from "@/lib/ingest";

export const dynamic = "force-dynamic";
const MAX_ITEMS = 500;

/** รับทรัพย์ที่ VPS ส่งมาเอง: POST /api/leads/ingest   header: x-ingest-key: <INGEST_API_KEY> */
export async function POST(req: NextRequest) {
  if (!process.env.INGEST_API_KEY || req.headers.get("x-ingest-key") !== process.env.INGEST_API_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const items: any[] = Array.isArray(body) ? body : body && typeof body === "object" ? [body] : [];
  if (!items.length) return NextResponse.json({ error: "body ต้องเป็น object หรือ array ของทรัพย์" }, { status: 400 });
  if (items.length > MAX_ITEMS) return NextResponse.json({ error: `ส่งได้ครั้งละไม่เกิน ${MAX_ITEMS} รายการ` }, { status: 400 });
  return NextResponse.json(await ingestLeads(createAdminClient(), items));
}
