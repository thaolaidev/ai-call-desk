import type { Outcome } from "../status";
import type { Turn } from "../outcome";
import type { CallProvider } from "./types";

/**
 * โหมดจำลอง: ไม่โทรจริง ใช้ทดสอบระบบทั้งเส้นก่อนใส่ key
 * สายจะ "จบ" เองหลัง 20–75 วินาที แล้วตัวยิงสายจะสร้างบทสนทนา + ผลสรุปตามบทจริง
 */
export const simulateProvider: CallProvider = {
  name: "simulate",
  async start() {
    const sec = 20 + Math.floor(Math.random() * 55);
    return { providerCallId: null, simEndAt: new Date(Date.now() + sec * 1000).toISOString() };
  },
};

const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const ri = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));

function pickOutcome(): Outcome {
  const w: [Outcome, number][] = [
    ["avail_ok", 0.17], ["avail_profile", 0.11], ["avail_no", 0.08], ["not_avail", 0.2], ["callback", 0.06],
    ["dnc", 0.02], ["wrong_number", 0.02], ["noanswer", 0.28], ["invalid", 0.06],
  ];
  let x = Math.random();
  for (const [o, p] of w) { if ((x -= p) < 0) return o; }
  return "noanswer";
}

const RULES1 =
  "ขออนุญาตอธิบายการรับลูกค้าต่างชาติของบริษัทเราสั้นๆ 2 นาทีนะคะ ลูกค้าของเราทุกคนต้องยอมรับกฎให้เข้าตรวจเช็คห้องได้ทุก 60–90 วัน ถ้าลูกค้ายอมรับกฎนี้ แสดงว่าเป็นลูกค้าที่มีระเบียบวินัยค่ะ";
const RULES2 =
  "ข้อแรก ลูกค้าจะไม่เลี้ยงสัตว์ ถ้าผิดกฎ เจ้าของยึดเงินมัดจำและยกเลิกสัญญาได้ ลูกค้าต้องย้ายออกภายใน 24 ชั่วโมงค่ะ ข้อสอง ลูกค้าจะไม่ทำห้องพังหรือสกปรก เพราะเจ้าของเปรียบเทียบปรับและให้ซ่อมแซมได้ทันที ลูกค้าต้องยอมรับกฎนี้เท่านั้น เราถึงจะหาห้องให้ค่ะ";

export function simulateConversation(
  lead: { condo: string; customer_nationalities: string | null; viewing_when: string | null },
  s: { company: string; default_nationalities: string; viewing_when: string },
) {
  const outcome = pickOutcome();
  const p = Math.random() < 0.5 ? "ค่ะ" : "ครับ";
  const q = p === "ครับ" ? "ครับ" : "คะ";
  const nat = lead.customer_nationalities || s.default_nationalities;
  const when = lead.viewing_when || s.viewing_when;
  const t: Turn[] = [];
  const ai = (x: string) => t.push({ role: "ai", text: x });
  const ow = (x: string) => t.push({ role: "owner", text: x });
  const sys = (x: string) => t.push({ role: "system", text: x });
  const open = () => {
    ow(`ฮัลโหล${p}`);
    ai(`สวัสดีค่ะ เอเจนต์จากบริษัท${s.company}นะคะ มีลูกค้าสนใจขอนัดชมห้อง${when}ค่ะ ไม่ทราบว่าห้องที่ ${lead.condo} ยังว่างอยู่ไหมคะ`);
  };
  const offerAndClose = () => {
    ai("ยังไงให้ทางแอดมินส่งโปรไฟล์ลูกค้าให้พิจารณาก่อนดีไหมคะ");
    ow(`ได้${p}`);
    ai("สะดวกให้ส่งทาง LINE เบอร์นี้ไหมคะ");
    ow(`ได้${p} เบอร์นี้เลย`);
    ai("ขอบคุณค่ะ เดี๋ยวแอดมินจะส่งโปรไฟล์ลูกค้าให้พิจารณาค่ะ");
  };

  const base = {
    room_available: null as boolean | null, accepts_foreigners: "unknown", rules_explained: false,
    owner_agreed_profile: false, profile_channel: null as string | null, line_id: null, nationality_note: null as string | null,
    current_lease_until: null as string | null, callback_at: null as string | null, owner_questions: [] as string[],
    sentiment: "neutral", summary_th: "",
  };
  let a = { ...base };
  let dur = 0;

  switch (outcome) {
    case "noanswer":
      sys("โทรออกแล้ว ดังครบ 30 วินาที ไม่มีผู้รับสาย");
      a.summary_th = "ไม่รับสาย";
      dur = 30;
      break;
    case "invalid":
      sys("เครือข่ายปลายทาง: หมายเลขที่ท่านเรียกไม่สามารถติดต่อได้ในขณะนี้");
      a.summary_th = "เบอร์ปิดเครื่องหรือไม่มีในระบบ";
      dur = 8;
      break;
    case "avail_ok":
      open(); ow(`ว่าง${p}`); ai("คุณพี่เจ้าของรับลูกค้าต่างชาติไหมคะ"); ow(`รับ${p} ผู้เช่าชาติไหน${q}`);
      ai(`ตอนนี้มีลูกค้า${nat} ที่สนใจจะนัดชมห้องค่ะ`); offerAndClose();
      a = { ...a, room_available: true, accepts_foreigners: "yes", owner_agreed_profile: true, profile_channel: "line_this_number", sentiment: "positive",
        summary_th: `ห้องว่าง รับต่างชาติ สนใจลูกค้า${nat} ให้ส่งโปรไฟล์ทาง LINE เบอร์นี้` };
      dur = ri(80, 140);
      break;
    case "avail_profile":
    case "avail_no":
      open(); ow(`ว่าง${p}`); ai("คุณพี่เจ้าของรับลูกค้าต่างชาติไหมคะ"); ow(`ไม่รับ${p}`);
      ai(RULES1); ow(`อืม${p}`); ai(RULES2);
      if (outcome === "avail_profile") {
        ow(`ถ้ามีกฎแบบนี้ก็น่าสนใจ${p}`); offerAndClose();
        a = { ...a, room_available: true, accepts_foreigners: "after_rules", rules_explained: true, owner_agreed_profile: true, profile_channel: "line_this_number",
          summary_th: `ห้องว่าง เดิมไม่รับต่างชาติ ฟังกฎตรวจห้องแล้วยอมดูโปรไฟล์ลูกค้า${nat}` };
        dur = ri(190, 290);
      } else {
        ow(`เข้าใจ${p} แต่ขอรับเฉพาะคนไทยดีกว่า${p}`);
        ai("รับทราบค่ะ ถ้ามีลูกค้าคนไทยที่สนใจ ขออนุญาตติดต่อกลับนะคะ ขอบคุณค่ะ");
        a = { ...a, room_available: true, accepts_foreigners: "no", rules_explained: true, nationality_note: "รับเฉพาะคนไทย",
          summary_th: "ห้องว่าง แต่ไม่รับต่างชาติ (ฟังกฎตรวจห้องแล้ว) รับเฉพาะคนไทย" };
        dur = ri(160, 240);
      }
      break;
    case "not_avail": {
      const u = pick(["มี.ค. ปีหน้า", "มิ.ย. ปีหน้า", "ม.ค. ปีหน้า"]);
      open(); ow(`ไม่ว่าง${p} มีคนเช่าแล้ว`); ai("ไม่ทราบว่าผู้เช่าเดิมเช่าถึงประมาณเมื่อไหร่คะ"); ow(`ถึง${u}${p}`);
      ai("ขอบคุณค่ะ ใกล้หมดสัญญาแล้วขออนุญาตติดต่อกลับนะคะ");
      a = { ...a, room_available: false, current_lease_until: u, sentiment: "positive", summary_th: `ห้องไม่ว่าง มีผู้เช่าถึง${u}` };
      dur = ri(30, 55);
      break;
    }
    case "callback":
      open(); ow(`ตอนนี้ติดประชุมอยู่${p} โทรมาใหม่อีกชั่วโมงได้ไหม${q}`); ai("ได้ค่ะ จะโทรกลับอีก 1 ชั่วโมงนะคะ ขอบคุณค่ะ");
      a = { ...a, callback_at: new Date(Date.now() + 3600_000).toISOString(), summary_th: "เจ้าของไม่สะดวกคุย ขอให้โทรกลับอีก 1 ชั่วโมง" };
      dur = ri(25, 45);
      break;
    case "wrong_number":
      ow(`ฮัลโหล${p}`); ai(`สวัสดีค่ะ เอเจนต์จากบริษัท${s.company}นะคะ ขอสอบถามเรื่องห้องที่ ${lead.condo} ค่ะ`);
      ow(`ไม่ใช่เจ้าของห้อง${p} โทรผิดแล้ว`); ai("ขออภัยที่รบกวนค่ะ ขอบคุณค่ะ");
      a = { ...a, summary_th: "คนรับสายไม่ใช่เจ้าของห้อง เบอร์ในประกาศอาจผิด" };
      dur = ri(15, 25);
      break;
    case "dnc":
      open(); ow(`ไม่ฝากเอเจนต์${p} ไม่ต้องโทรมาอีกนะ${p}`); ai("ขออภัยที่รบกวนค่ะ จะนำเบอร์ออกจากรายการติดต่อทันทีค่ะ");
      a = { ...a, sentiment: "negative", summary_th: "เจ้าของไม่ต้องการเอเจนต์ ขอไม่ให้ติดต่ออีก" };
      dur = ri(15, 30);
      break;
  }

  const billedMin = outcome === "noanswer" || outcome === "invalid" ? 0 : Math.ceil(dur / 60);
  return {
    outcome,
    transcript: t,
    analysis: { call_outcome: outcome, ...a },
    summary: a.summary_th,
    durationSec: dur,
    costThb: billedMin * 4.5,
  };
}
