/** แปลงตัวเลขเป็นคำอ่านภาษาไทย เช่น 12500 → "หนึ่งหมื่นสองพันห้าร้อย", 1111 → "หนึ่งพันหนึ่งร้อยสิบเอ็ด" */
const D = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
const P = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"];

function under1M(n: number): string {
  const s = String(n);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i]);
    const pos = s.length - 1 - i;
    if (d === 0) continue;
    if (pos === 1 && d === 1) out += "สิบ";
    else if (pos === 1 && d === 2) out += "ยี่สิบ";
    else if (pos === 0 && d === 1 && n > 1) out += "เอ็ด";
    else out += D[d] + P[pos];
  }
  return out;
}

export function thaiNumber(input: number): string {
  const n = Math.round(Math.abs(input));
  if (n === 0) return D[0];
  if (n < 1_000_000) return under1M(n);
  const m = Math.floor(n / 1_000_000);
  const rest = n % 1_000_000;
  return `${thaiNumber(m)}ล้าน${rest ? under1M(rest) : ""}`;
}
