/**
 * Yalecom API (https://client.yalecom.co.th/api/document)
 * ทุกคำขอใช้ company_id + key (GET ส่งเป็น query, POST ส่งใน body)
 */
const BASE = "https://client.yalecom.co.th";

function creds() {
  const company_id = process.env.YALECOM_COMPANY_ID;
  const key = process.env.YALECOM_KEY;
  if (!company_id || !key) throw new Error("ยังไม่ได้ตั้ง YALECOM_COMPANY_ID / YALECOM_KEY");
  return { company_id, key };
}

function url(path: string, params: Record<string, string | number | undefined | null>) {
  const u = new URL(path, BASE);
  for (const [k, v] of Object.entries({ ...creds(), ...params })) if (v != null && v !== "") u.searchParams.set(k, String(v));
  return u;
}

/** เบอร์ไทยแบบที่ Yalecom ใช้: 0812345678 */
export const yalecomNumber = (p: string) => p.replace(/[^\d+]/g, "").replace(/^\+66/, "0");

/** สร้าง Robocall 1 สาย: โทรหา destination → รับสาย → โอนไป transfer_to (IVR เล่นเสียง + อัดคำตอบ) */
export async function sendRobocall(o: {
  caller_id_number: string; destination_number: string; transfer_to: string; ref_1: string; ref_2?: string; call_timeout?: number;
}) {
  const res = await fetch(url("/api/robocall/send", { ...o, max_retries: 0, call_timeout: o.call_timeout ?? 30 }), { signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({}));
  const ok = res.ok && !/fail|error|invalid|missing/i.test(String(body?.status ?? ""));
  if (!ok) throw new Error(`Yalecom ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body as { status?: string; message?: string };
}

export type Cdr = {
  xml_cdr_uuid: string; call_result?: string; duration?: string | number; call_duration?: string | number;
  start_stamp?: string; end_stamp?: string; recording?: string; ref_1?: string; ref_2?: string; [k: string]: unknown;
};

/** ดึง CDR ดิบ (ใช้ทั้งค้นหาและหน้าตรวจสอบ) */
export async function fetchCdr(params: Record<string, string | undefined>) {
  const res = await fetch(url("/api/cdr", params), { signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, text: body ? null : text.slice(0, 500) };
}

export function cdrList(body: any): Cdr[] {
  if (Array.isArray(body)) return body;
  for (const k of ["data", "result", "results", "records", "cdr"]) {
    const v = body?.[k];
    if (Array.isArray(v)) return v;
    if (Array.isArray(v?.data)) return v.data;
  }
  return [];
}

/** หา CDR ของสายเราด้วย ref_1 (ต้องตรงเท่านั้น ห้ามเดา) */
export async function findCdrByRef(ref1: string): Promise<Cdr | null> {
  const byRef = await fetchCdr({ ref_1: ref1 });
  const hit = cdrList(byRef.body).find((c) => String(c.ref_1 ?? "") === ref1);
  if (hit) return hit;
  // บางระบบไม่กรองด้วย ref_1 ให้: ไล่ดูรายการล่าสุด 100 รายการ
  const latest = await fetchCdr({});
  return cdrList(latest.body).find((c) => String(c.ref_1 ?? "") === ref1) ?? null;
}

/** ดาวน์โหลดไฟล์บันทึกเสียง (MP3) */
export async function downloadRecording(xmlCdrUuid: string): Promise<ArrayBuffer | null> {
  const res = await fetch(url("/api/cdr/recording", { xml_cdr_uuid: xmlCdrUuid }), { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json") || type.includes("html")) return null; // ยังไม่มีไฟล์ / error
  const buf = await res.arrayBuffer();
  return buf.byteLength > 1000 ? buf : null;
}

/** call_result ของ Yalecom → สถานะสาย */
export function mapCallResult(r?: string | null): "answered" | "noanswer" | "failed" {
  const v = String(r ?? "").toLowerCase();
  if (v.startsWith("answer")) return "answered";
  if (v.startsWith("fail")) return "failed";
  return "noanswer"; // missed, cancelled, ว่าง
}

/** ชื่อไฟล์เสียงคอนโดในระบบ Yalecom: tl_condo_<8 ตัวอักษร> (คงที่ต่อชื่อคอนโด) */
export function condoFileName(condo: string) {
  let h = 2166136261;
  for (const ch of condo.trim().toLowerCase()) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 16777619) >>> 0; }
  return `tl_condo_${h.toString(16).padStart(8, "0")}`;
}

/** เวลาใน CDR ของ Yalecom เป็นเวลาไทยแบบไม่มีเขตเวลา ("2026-11-12 18:27:06") → ms */
export function yalecomTime(v?: unknown): number {
  const t = String(v ?? "").trim();
  if (!t) return NaN;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(t)) return Date.parse(t);
  return Date.parse(t.replace(" ", "T") + "+07:00");
}
