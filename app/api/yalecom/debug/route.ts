import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchCdr, cdrList } from "@/lib/yalecom";

export const dynamic = "force-dynamic";

/** หน้าตรวจสอบ: ดูว่า Yalecom ตอบอะไรเกี่ยวกับสายล่าสุด (ต้องล็อกอิน · ไม่แสดง key) */
export async function GET() {
  const sb = await createClient();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });

  const db = createAdminClient();
  const { data: call } = await db.from("calls").select("id, state, outcome, summary, ended_reason, started_at").eq("provider", "yalecom").order("started_at", { ascending: false }).limit(1).maybeSingle();
  const strip = (v: any) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (k === "key" || k === "company_id" ? "***" : x)));

  const byRef = call ? await fetchCdr({ ref_1: call.id }).catch((e) => ({ error: String(e) })) : null;
  const latest = await fetchCdr({}).catch((e) => ({ error: String(e) }));
  const latestList = "body" in latest ? cdrList(latest.body) : [];
  return NextResponse.json({
    our_latest_call: call,
    cdr_search_by_ref_1: strip(byRef && "body" in byRef ? { http: byRef.status, count: cdrList(byRef.body).length, first: cdrList(byRef.body)[0] ?? byRef.body ?? byRef.text } : byRef),
    cdr_latest_3: strip("body" in latest ? { http: latest.status, shape: Array.isArray(latest.body) ? "array" : Object.keys(latest.body ?? {}), items: latestList.slice(0, 3), raw_if_unparsed: latest.text } : latest),
  });
}
