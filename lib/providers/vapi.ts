import { callVariables } from "../prompt";
import { toE164 } from "../phone";
import type { CallProvider } from "./types";

/**
 * โทรออกผ่าน Vapi
 * - ตั้ง System prompt / First message / Structured Data ใน Assistant ที่ Vapi dashboard (ดูหน้า "ตั้งค่า")
 * - ผลหลังวางสายจะเข้ามาที่ /api/vapi/webhook
 */
export const vapiProvider: CallProvider = {
  name: "vapi",
  async start({ callId, lead, settings }) {
    const key = process.env.VAPI_API_KEY;
    if (!key) throw new Error("ยังไม่ได้ตั้ง VAPI_API_KEY");
    if (!settings.vapi_assistant_id || !settings.vapi_phone_number_id) {
      throw new Error("ยังไม่ได้ใส่ Vapi Assistant ID / Phone Number ID ในหน้าตั้งค่า");
    }
    const res = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        assistantId: settings.vapi_assistant_id,
        phoneNumberId: settings.vapi_phone_number_id,
        customer: { number: toE164(lead.phone), name: lead.owner_name },
        assistantOverrides: { variableValues: callVariables(lead, settings) },
        metadata: { call_id: callId, lead_id: lead.id },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Vapi ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    return { providerCallId: body.id ?? null };
  },
};
