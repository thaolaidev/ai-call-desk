import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processYalecomCall } from "@/lib/ivr";
import { tick } from "@/lib/dialer";
import type { Cdr } from "@/lib/yalecom";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Yalecom ส่งข้อมูลสายหลังจบสาย (Call data callback)
 * URL ที่ให้ Yalecom: https://<โดเมน>/api/yalecom/callback?token=<YALECOM_CALLBACK_TOKEN>
 * body: { company_id, key, created_at, data: {...} }  (data อาจมาเป็น string ตามตัวอย่างในเอกสาร)
 */
export async function POST(req: NextRequest) {
  const token = process.env.YALECOM_CALLBACK_TOKEN;
  if (token && req.nextUrl.searchParams.get("token") !== token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const raw = await req.text();
  const body = parseLoose(raw) ?? {};
  if (process.env.YALECOM_COMPANY_ID && body.company_id && String(body.company_id) !== process.env.YALECOM_COMPANY_ID) {
    return NextResponse.json({ error: "unknown company" }, { status: 401 });
  }
  if (process.env.YALECOM_KEY && body.key && String(body.key) !== process.env.YALECOM_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const data: Cdr | null = typeof body.data === "string" ? parseLoose(body.data) : body.data ?? (body.xml_cdr_uuid ? body : null);
  const callId = data?.ref_1 ? String(data.ref_1) : null;
  if (!data || !callId) return NextResponse.json({ ok: true, note: "ไม่มี ref_1 (ไม่ใช่สายจากห้องโทร AI)" });

  const db = createAdminClient();
  const { data: call } = await db.from("calls").select("id").eq("id", callId).maybeSingle();
  if (!call) return NextResponse.json({ ok: true, note: "ไม่พบสายนี้" });

  const status = await processYalecomCall(db, callId, data);
  if (status === "done") await tick(); // ว่าง 1 สาย เติมสายถัดไป
  return NextResponse.json({ ok: true, status });
}

/** อ่าน JSON แบบยืดหยุ่น: รองรับ JSON ปกติ และแบบ single quote ตามตัวอย่างในเอกสาร Yalecom */
function parseLoose(text: string): any {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  try { return JSON.parse(text.replace(/'/g, '"')); } catch {}
  try { return Object.fromEntries(new URLSearchParams(text)); } catch {}
  return null;
}
