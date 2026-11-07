import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizePhone } from "@/lib/phone";

export const dynamic = "force-dynamic";

/**
 * รับลีดจากระบบภายนอก (n8n / Make / Zapier / สคริปต์ดึงประกาศ)
 * POST /api/leads/ingest   header: x-ingest-key: <INGEST_API_KEY>
 * body: { owner_name, phone, condo, unit?, rent?, source?, customer_nationalities?, viewing_when? }  หรือ array
 */
export async function POST(req: NextRequest) {
  if (!process.env.INGEST_API_KEY || req.headers.get("x-ingest-key") !== process.env.INGEST_API_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const items: any[] = Array.isArray(body) ? body : body ? [body] : [];
  const rows = items
    .filter((x) => x?.owner_name && x?.phone && x?.condo)
    .map((x) => ({
      owner_name: String(x.owner_name).trim(),
      phone: normalizePhone(String(x.phone)),
      condo: String(x.condo).trim(),
      unit: x.unit ? String(x.unit) : null,
      rent: x.rent ? Number(String(x.rent).replace(/\D/g, "")) || null : null,
      source: x.source ? String(x.source) : "API",
      customer_nationalities: x.customer_nationalities ?? null,
      viewing_when: x.viewing_when ?? null,
    }));
  if (!rows.length) return NextResponse.json({ error: "ต้องมี owner_name, phone, condo" }, { status: 400 });

  const db = createAdminClient();
  const { data: s } = await db.from("settings").select("auto_queue").eq("id", 1).single();
  const status = s?.auto_queue ? "queued" : "new";
  const { data, error } = await db
    .from("leads")
    .upsert(rows.map((r) => ({ ...r, status })), { onConflict: "phone,condo", ignoreDuplicates: true })
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ received: rows.length, inserted: data?.length ?? 0 });
}
