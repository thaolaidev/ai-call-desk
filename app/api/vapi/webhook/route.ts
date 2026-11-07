import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyCallResult, type Turn } from "@/lib/outcome";
import { OUTCOMES, type Outcome } from "@/lib/status";
import { tick } from "@/lib/dialer";
import { deliverResult } from "@/lib/sync";

export const dynamic = "force-dynamic";

/**
 * Vapi Server URL → https://<โดเมน>/api/vapi/webhook
 * ตั้ง Server URL Secret ใน Vapi ให้ตรงกับ VAPI_WEBHOOK_SECRET
 * รับ 2 แบบ: status-update (อัปเดตสถานะสาย) และ end-of-call-report (ผลหลังวางสาย)
 */
export async function POST(req: NextRequest) {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (secret) {
    const got = req.headers.get("x-vapi-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (got !== secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const msg = body?.message;
  if (!msg?.type) return NextResponse.json({ ok: true });

  const db = createAdminClient();
  const vapiCallId: string | undefined = msg.call?.id;
  const ourId: string | undefined = msg.call?.metadata?.call_id;

  const findCall = async () => {
    if (ourId) return ourId;
    if (!vapiCallId) return null;
    const { data } = await db.from("calls").select("id").eq("provider_call_id", vapiCallId).maybeSingle();
    return data?.id ?? null;
  };

  if (msg.type === "status-update") {
    const id = await findCall();
    const map: Record<string, string> = { queued: "dialing", ringing: "ringing", "in-progress": "in_progress" };
    if (id && map[msg.status]) await db.from("calls").update({ state: map[msg.status] }).eq("id", id).neq("state", "ended");
    return NextResponse.json({ ok: true });
  }

  if (msg.type === "end-of-call-report") {
    const id = await findCall();
    if (!id) return NextResponse.json({ ok: true, note: "unknown call" });

    const analysis = (msg.analysis?.structuredData ?? null) as Record<string, unknown> | null;
    const outcome = resolveOutcome(String(msg.endedReason ?? ""), analysis);

    const transcript: Turn[] = (msg.artifact?.messages ?? msg.messages ?? [])
      .filter((m: any) => m.role === "bot" || m.role === "assistant" || m.role === "user")
      .map((m: any) => ({ role: m.role === "user" ? "owner" : "ai", text: String(m.message ?? m.content ?? "") }))
      .filter((m: Turn) => m.text);

    const rate = Number(process.env.USD_TO_THB ?? 36);
    await applyCallResult(db, {
      callId: id,
      outcome,
      analysis,
      transcript,
      summary: (analysis?.summary_th as string) ?? msg.analysis?.summary ?? null,
      durationSec: msg.durationSeconds != null ? Math.round(Number(msg.durationSeconds)) : null,
      costThb: msg.cost != null ? Math.round(Number(msg.cost) * rate * 100) / 100 : null,
      recordingUrl: msg.artifact?.recordingUrl ?? msg.recordingUrl ?? null,
      endedReason: msg.endedReason ?? null,
    });

    await deliverResult(db, id); // ส่งผลกลับ VPS ทันที (ไม่สำเร็จจะส่งซ้ำตามรอบ)
    await tick(); // ว่างแล้ว 1 สาย เติมสายถัดไปทันที
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}

/** แปลงเหตุผลการวางสายของ Vapi + ผลวิเคราะห์ เป็น outcome ของระบบ */
function resolveOutcome(endedReason: string, analysis: Record<string, unknown> | null): Outcome {
  const r = endedReason.toLowerCase();
  if (r.includes("did-not-answer") || r.includes("busy") || r.includes("voicemail") || r.includes("no-answer")) return "noanswer";
  if (r.includes("failed") || r.includes("invalid") || r.includes("unreachable")) {
    if (!analysis?.call_outcome) return "invalid";
  }
  const o = String(analysis?.call_outcome ?? "");
  if (o === "voicemail") return "noanswer";
  if ((OUTCOMES as string[]).includes(o)) return o as Outcome;
  return "noanswer";
}
