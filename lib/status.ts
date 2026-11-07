export type LeadStatus =
  | "new" | "queued" | "calling"
  | "avail_ok" | "avail_profile" | "avail_no" | "not_avail"
  | "callback" | "dnc" | "wrong_number" | "noanswer" | "invalid" | "closed";

export type Outcome =
  | "avail_ok" | "avail_profile" | "avail_no" | "not_avail"
  | "callback" | "dnc" | "wrong_number" | "noanswer" | "invalid";

export const STATUS: Record<string, { label: string; tone: "ok" | "cb" | "ne" | "wa" | "bad" | "ac" | "idle"; fail?: boolean }> = {
  new:           { label: "ใหม่", tone: "ac" },
  queued:        { label: "รอโทร", tone: "idle" },
  calling:       { label: "กำลังโทร", tone: "ac" },
  avail_ok:      { label: "ว่าง · รับต่างชาติ", tone: "ok" },
  avail_profile: { label: "ว่าง · ขอดูโปรไฟล์", tone: "ok" },
  avail_no:      { label: "ว่าง · ไม่รับต่างชาติ", tone: "cb" },
  not_avail:     { label: "ไม่ว่าง", tone: "ne" },
  callback:      { label: "ขอให้โทรกลับ", tone: "ac" },
  dnc:           { label: "ขอไม่ให้โทร", tone: "bad" },
  wrong_number:  { label: "เบอร์ผิด", tone: "bad" },
  noanswer:      { label: "ไม่รับสาย", tone: "wa", fail: true },
  invalid:       { label: "ติดต่อไม่ได้", tone: "idle", fail: true },
  closed:        { label: "ปิด (โทรครบแล้ว)", tone: "idle" },
  pending:       { label: "กำลังโทร", tone: "ac" },
};

export const OUTCOMES: Outcome[] = [
  "avail_ok", "avail_profile", "avail_no", "not_avail", "callback", "dnc", "wrong_number", "noanswer", "invalid",
];

export const isHot = (o?: string | null) => o === "avail_ok" || o === "avail_profile";
export const isFail = (o?: string | null) => o === "noanswer" || o === "invalid";
export const QUEUEABLE: LeadStatus[] = ["new", "noanswer", "callback", "invalid", "not_avail", "closed", "avail_no"];
