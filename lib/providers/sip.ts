import { createAdminClient } from "../supabase/admin";
import { STEPS } from "../script";
import { loadPlaylist } from "../playlist";
import { findCondoAudio } from "../condolib";
import type { CallProvider } from "./types";

/**
 * โทรผ่าน server เสียงของเราเอง (Asterisk + SIP Trunk) — ดูโฟลเดอร์ voice-server/
 * ส่งลิงก์ไฟล์เสียงทุกท่อน + ชื่อคอนโด ให้ server เล่นและแยกทางตามคำตอบเอง
 * ผลกลับมาที่ /api/voice/result
 */
export const sipProvider: CallProvider = {
  name: "sip",
  async start({ callId, lead }) {
    const base = (process.env.VOICE_SERVER_URL ?? "").replace(/\/+$/, "");
    if (!base || !process.env.VOICE_SECRET) throw new Error("ยังไม่ได้ตั้ง VOICE_SERVER_URL / VOICE_SECRET");
    const db = createAdminClient();
    const bucket = db.storage.from("script-audio");
    const [{ data: rows }, playlist, condo] = await Promise.all([
      db.from("script_audio").select("step_key, path"),
      loadPlaylist(db),
      findCondoAudio(db, { condo: lead.condo, condo_id: lead.condo_id ?? null }),
    ]);
    const audio: Record<string, string> = {};
    for (const r of rows ?? []) if (STEPS[r.step_key]) audio[r.step_key] = bucket.getPublicUrl(r.path).data.publicUrl;
    if (!audio["01"] || !audio["02-2"]) throw new Error("ยังไม่มีไฟล์เสียงบทโทร (อย่างน้อยท่อน 01 และ 02-2) ในหน้าบทโทร");

    const res = await fetch(`${base}/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-voice-secret": process.env.VOICE_SECRET },
      body: JSON.stringify({
        call_id: callId,
        phone: lead.phone,
        mode: lead.segment === "old" ? "short" : "full", // ทรัพย์เดิม: ถามแค่ว่าง/ไม่ว่าง
        audio,
        enabled: playlist.filter((p) => p.enabled).map((p) => p.key),
        titles: Object.fromEntries(Object.values(STEPS).map((s) => [s.key, s.text])),
        condo_url: condo?.path ? bucket.getPublicUrl(condo.path).data.publicUrl : null,
        price_url: null,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`server เสียง: ${(await res.text().catch(() => "")).slice(0, 200) || res.status}`);
    return { providerCallId: callId };
  },
};
