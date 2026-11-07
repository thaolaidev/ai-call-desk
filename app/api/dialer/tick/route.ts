import { NextResponse, type NextRequest } from "next/server";
import { tick } from "@/lib/dialer";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** อนุญาต: Vercel Cron (Bearer CRON_SECRET) หรือผู้ใช้ที่ล็อกอินอยู่ (หน้าเว็บ ping ทุก 5 วินาที) */
async function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") === `Bearer ${secret}`) return true;
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return !!data.user;
}

async function handle(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const report = await tick();
  return NextResponse.json(report);
}

export const GET = handle;
export const POST = handle;
