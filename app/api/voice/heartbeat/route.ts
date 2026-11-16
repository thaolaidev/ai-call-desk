import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchChat, pruneWaiting } from "@/lib/chat";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * server เสียงบน VPS เรียกทุก 30 วินาที (x-voice-secret)
 * เช็กห้องที่ทีมโทรเองแล้วในแชท → เอาออกจากคิว · แล้วเติมสายให้ห้องที่เปิดโทรทันที
 */
export async function POST(req: NextRequest) {
  if (!process.env.VOICE_SECRET || req.headers.get("x-voice-secret") !== process.env.VOICE_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = createAdminClient();
  const { data: s } = await db.from("settings").select("*").eq("id", 1).single();
  const pruned = await pruneWaiting(db, s, 25_000).catch(() => 0);
  const d = await dispatchChat(db, s).catch((e) => ({ started: 0, errors: [String(e)] }));
  return NextResponse.json({ pruned, started: d.started, errors: d.errors });
}
