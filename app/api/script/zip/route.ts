import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { STEPS, STEP_KEYS, yalecomName } from "@/lib/script";
import { makeZip } from "@/lib/zip";
import { SILENCE_MP3_B64, WAIT_FILE } from "@/lib/playlist";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** ดาวน์โหลดไฟล์เสียงบทโทรทั้งหมดเป็น zip (ชื่อไฟล์ตามที่ใช้ใน Yalecom) — เฉพาะคนในทีม */
export async function GET() {
  const sb = await createClient();
  const { data: team } = await sb.from("settings").select("id").eq("id", 1).maybeSingle();
  if (!team) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: rows } = await sb.from("script_audio").select("step_key, path");
  const admin = createAdminClient();
  const files: { name: string; data: Uint8Array }[] = [];
  const order = new Map(STEP_KEYS.map((k, i) => [k, i]));
  for (const r of (rows ?? []).filter((r: any) => STEPS[r.step_key]).sort((a: any, b: any) => (order.get(a.step_key) ?? 0) - (order.get(b.step_key) ?? 0))) {
    const { data } = await admin.storage.from("script-audio").download(r.path);
    if (data) files.push({ name: `${yalecomName(r.step_key)}.${r.path.split(".").pop()}`, data: new Uint8Array(await data.arrayBuffer()) });
  }
  if (!files.length) return NextResponse.json({ error: "ยังไม่มีไฟล์เสียง" }, { status: 404 });
  files.push({ name: `${WAIT_FILE}.mp3`, data: Uint8Array.from(Buffer.from(SILENCE_MP3_B64, "base64")) });
  const list = STEP_KEYS.map((k) => `${yalecomName(k)}\t${STEPS[k].title}\t${STEPS[k].text}`).join("\n");
  files.push({ name: "รายการไฟล์.txt", data: new TextEncoder().encode(`ชื่อไฟล์\tท่อน\tข้อความ\n${list}\n${WAIT_FILE}\tช่วงเงียบ 1 วินาที\t(ใช้เว้นให้เจ้าของตอบ)\n`) });
  const zip = makeZip(files);
  return new NextResponse(zip as unknown as BodyInit, {
    headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="thaolai-script-audio.zip"` },
  });
}
