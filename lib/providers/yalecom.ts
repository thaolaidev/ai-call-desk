import { sendRobocall, yalecomNumber } from "../yalecom";
import type { CallProvider } from "./types";

/**
 * โทรผ่าน Robocall ของ Yalecom
 * Yalecom โทรหาเจ้าของ → รับสาย → โอนไป transfer_to (IVR ที่ Yalecom ตั้งให้: เล่นเสียงตาม playback_list → อัดคำตอบ)
 * ref_1 = รหัสสายของเรา ใช้จับคู่ตอน callback / ดึง CDR
 */
export const yalecomProvider: CallProvider = {
  name: "yalecom",
  async start({ callId, lead, settings }) {
    if (!settings.yalecom_caller_id || !settings.yalecom_transfer_to) {
      throw new Error("ยังไม่ได้ใส่เบอร์โทรออก / เบอร์ IVR ของ Yalecom ในหน้าตั้งค่า");
    }
    await sendRobocall({
      caller_id_number: settings.yalecom_caller_id,
      destination_number: yalecomNumber(lead.phone),
      transfer_to: settings.yalecom_transfer_to,
      ref_1: callId,
      ref_2: lead.external_id ?? lead.id,
    });
    return { providerCallId: null };
  },
};
