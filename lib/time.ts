const TZ = "Asia/Bangkok";

/** ช่วงเวลา [เริ่ม, สิ้นสุด) ของ "วันนี้" ตามเวลาไทย เป็น ISO string */
export function todayRangeBKK(now = new Date()) {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const start = new Date(`${ymd}T00:00:00+07:00`);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** นาทีของวันและวันในสัปดาห์ ตามเวลาไทย */
export function bkkClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { minutes: Number(get("hour")) * 60 + Number(get("minute")), weekday: days.indexOf(get("weekday")) };
}

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};

export const fmtTime = (iso?: string | null) =>
  iso ? new Intl.DateTimeFormat("th-TH", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "–";

export const fmtDateTime = (iso?: string | null) =>
  iso ? new Intl.DateTimeFormat("th-TH", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "–";

export const fmtDur = (sec?: number | null) => (sec == null ? "–" : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`);
