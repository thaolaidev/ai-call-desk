/**
 * แปลงวันที่ที่เจ้าของพูด (ข้อความไทย) เป็น YYYY-MM-DD สำหรับส่งให้เว็บเท่าไหร่
 * เช่น "15 ธันวาคม" "วันที่ 15" "เดือนกรกฎา" "1 ม.ค. 2570" "2026-12-15" "พร้อมเลย"
 * แปลไม่ได้ = null (ส่งเป็นข้อความใน note แทน)
 */
const MONTHS: [RegExp, number][] = [
  [/มกรา|ม\.ค/, 1], [/กุมภา|ก\.พ/, 2], [/มีนา|มี\.ค/, 3], [/เมษา|เม\.ย/, 4], [/พฤษภา|พ\.ค/, 5], [/มิถุนา|มิ\.ย/, 6],
  [/กรกฎา|ก\.ค/, 7], [/สิงหา|ส\.ค/, 8], [/กันยา|ก\.ย/, 9], [/ตุลา|ต\.ค/, 10], [/พฤศจิกา|พ\.ย/, 11], [/ธันวา|ธ\.ค/, 12],
  [/\bjan/i, 1], [/\bfeb/i, 2], [/\bmar/i, 3], [/\bapr/i, 4], [/\bmay/i, 5], [/\bjun/i, 6],
  [/\bjul/i, 7], [/\baug/i, 8], [/\bsep/i, 9], [/\boct/i, 10], [/\bnov/i, 11], [/\bdec/i, 12],
];

const pad = (n: number) => String(n).padStart(2, "0");

/** วันนี้ตามเวลาไทย */
function todayBKK(now = new Date()) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now).split("-").map(Number);
  return { y, m, d };
}

export function thaiDateToISO(text: string | null | undefined, now = new Date()): string | null {
  if (!text) return null;
  const s = String(text).trim();
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const t = todayBKK(now);
  if (/พร้อม|เลย|ทันที|ตอนนี้|วันนี้/.test(s) && !/\d/.test(s)) return `${t.y}-${pad(t.m)}-${pad(t.d)}`;
  if (/พรุ่งนี้/.test(s)) {
    const d = new Date(Date.UTC(t.y, t.m - 1, t.d + 1));
    return d.toISOString().slice(0, 10);
  }

  const month = MONTHS.find(([re]) => re.test(s))?.[1] ?? null;
  // ปี: 2570 (พ.ศ.) หรือ 2027
  const yMatch = s.match(/\b(25\d{2}|20\d{2})\b/);
  let year = yMatch ? Number(yMatch[1]) : null;
  if (year && year > 2400) year -= 543;
  const dayMatch = s.replace(/\b(25\d{2}|20\d{2})\b/, "").match(/(\d{1,2})/);
  const day = dayMatch ? Number(dayMatch[1]) : null;
  if (day !== null && (day < 1 || day > 31)) return null;
  if (!month && !day) return null;

  let m = month ?? t.m;
  let y = year ?? t.y;
  let d = day ?? 1;
  if (!year) {
    // ไม่บอกปี: ถ้าวันนั้นผ่านไปแล้ว ถือเป็นครั้งถัดไป (เดือนหน้า / ปีหน้า)
    const passed = m < t.m || (m === t.m && day !== null && d < t.d);
    if (passed) {
      if (month) y += 1;
      else { m += 1; if (m > 12) { m = 1; y += 1; } }
    }
  }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > last) d = last;
  return `${y}-${pad(m)}-${pad(d)}`;
}
