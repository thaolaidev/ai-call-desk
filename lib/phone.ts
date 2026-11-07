/** 081-234-5678 → 0812345678 */
export const normalizePhone = (p: string) => p.replace(/[^\d+]/g, "").replace(/^\+66/, "0");

/** 0812345678 → +66812345678 (รูปแบบ E.164 สำหรับระบบโทร) */
export const toE164 = (p: string) => {
  const d = normalizePhone(p);
  return d.startsWith("0") ? `+66${d.slice(1)}` : d.startsWith("+") ? d : `+${d}`;
};

export const prettyPhone = (p: string) => {
  const d = normalizePhone(p);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d.length === 9 ? `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}` : p;
};
