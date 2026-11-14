import type { Outcome } from "./status";

/**
 * ถอดเสียงคำตอบเป็นข้อความ แล้วจัดผลเป็น ว่าง / ไม่ว่าง / ฯลฯ
 * ใช้ OpenAI (gpt-4o-mini-transcribe + gpt-4o-mini) ถ้าไม่มี key จะใช้การจับคำแทน
 */
export async function transcribe(audio: ArrayBuffer, filename = "answer.mp3"): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/mpeg" }), filename);
  form.append("model", process.env.STT_MODEL || "gpt-4o-mini-transcribe");
  form.append("language", "th");
  form.append("prompt", "บทสนทนาโทรศัพท์ภาษาไทยเรื่องห้องเช่าคอนโด คำตอบมักเป็น ว่าง หรือ ไม่ว่าง");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return String(body.text ?? "").trim();
}

export type Classified = { outcome: Outcome; summary: string; current_lease_until: string | null; answer_text: string; details?: CallDetails };
/** รายละเอียดที่ได้จากสคริปต์ห้องทรัพย์ใหม่ (null = ไม่ได้ถาม/ไม่ได้ตอบ) */
export type CallDetails = {
  ready_now: boolean | null;          // พร้อมเข้าอยู่เลยไหม
  available_from: string | null;      // ว่างวันที่/เดือนไหน (ตามที่เจ้าของพูด)
  price_confirmed: boolean | null;    // ยืนยันราคาเดิม
  owner_price: number | null;         // ราคาที่เจ้าของบอก ถ้าไม่ตรงกับเดิม
  accepts_foreigners: boolean | null; // รับลูกค้าต่างชาติไหม
};

/** ตัดส่วนที่เป็นเสียงอัดของเราออก เหลือเฉพาะคำตอบของเจ้าของ (เสียงอัดจบด้วย "ได้เลยค่ะ") */
export function ownerPart(text: string) {
  const markers = ["ได้เลยค่ะ", "ได้เลยคะ", "ได้เลย"];
  for (const m of markers) {
    const i = text.lastIndexOf(m);
    if (i >= 0) return text.slice(i + m.length).trim();
  }
  return text.slice(Math.floor(text.length * 0.6)).trim();
}

/** จัดผลด้วยการจับคำ (ใช้เมื่อไม่มี LLM) */
export function classifyByKeywords(answer: string): Classified {
  const t = answer.replace(/\s+/g, "");
  let outcome: Outcome = "unclear";
  if (/ไม่ต้องโทร|อย่าโทร|ไม่ฝาก/.test(t)) outcome = "dnc";
  else if (/ไม่ใช่เจ้าของ|โทรผิด|ผิดเบอร์/.test(t)) outcome = "wrong_number";
  else if (/ไม่ว่าง|มีคนเช่า|เช่าแล้ว|ขายแล้ว|ไม่ปล่อย/.test(t)) outcome = "not_avail";
  else if (/ว่าง/.test(t)) outcome = "avail";
  else if (/โทรมาใหม่|ไม่สะดวก|ทีหลัง/.test(t)) outcome = "callback";
  const label: Record<string, string> = {
    avail: "เจ้าของตอบว่าห้องว่าง", not_avail: "เจ้าของตอบว่าห้องไม่ว่าง", dnc: "เจ้าของขอไม่ให้ติดต่ออีก",
    wrong_number: "คนรับสายไม่ใช่เจ้าของ", callback: "เจ้าของขอให้โทรมาใหม่", unclear: "รับสายแต่ไม่ได้คำตอบที่ชัดเจน",
  };
  return { outcome, summary: `${label[outcome]}${answer ? ` ("${answer.slice(0, 80)}")` : ""}`, current_lease_until: null, answer_text: answer };
}

/** จัดผลด้วย LLM (แม่นกว่า และดึงวันหมดสัญญาได้) */
export async function classify(fullText: string): Promise<Classified> {
  const answer = ownerPart(fullText);
  const key = process.env.OPENAI_API_KEY;
  if (!key || !fullText) return classifyByKeywords(answer);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: process.env.CLASSIFY_MODEL || "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "คุณอ่านข้อความที่ถอดจากเสียงโทรศัพท์ ช่วงแรกเป็นเสียงอัดของบริษัทถามว่าห้องคอนโดยังว่างไหม ให้ไม่สนใจคำในเสียงอัด แล้วดูเฉพาะคำตอบของเจ้าของห้อง\n" +
              'ตอบเป็น JSON: {"outcome": "avail|not_avail|callback|dnc|wrong_number|unclear", "current_lease_until": string|null, "summary_th": string}\n' +
              "avail = ห้องยังว่าง · not_avail = ไม่ว่าง/มีคนเช่า/ขายแล้ว · callback = ขอให้โทรมาใหม่ · dnc = ขอไม่ให้ติดต่อ/ไม่ฝากเอเจนต์ · wrong_number = ไม่ใช่เจ้าของ · unclear = ไม่ตอบหรือฟังไม่ออก\n" +
              "current_lease_until = ถ้าบอกว่าผู้เช่าอยู่ถึงเมื่อไหร่ ไม่มีให้ null · summary_th = สรุป 1 ประโยค ห้ามเดา",
          },
          { role: "user", content: `ข้อความทั้งหมด:\n${fullText}\n\nส่วนที่น่าจะเป็นคำตอบของเจ้าของ:\n${answer}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const j = JSON.parse((await res.json()).choices?.[0]?.message?.content ?? "{}");
    const allowed: Outcome[] = ["avail", "not_avail", "callback", "dnc", "wrong_number", "unclear"];
    const outcome = allowed.includes(j.outcome) ? (j.outcome as Outcome) : "unclear";
    return { outcome, summary: String(j.summary_th ?? ""), current_lease_until: j.current_lease_until ?? null, answer_text: answer };
  } catch {
    return classifyByKeywords(answer);
  }
}

/**
 * Gemini: ฟังไฟล์เสียงทั้งสาย → ถอดเสียง + แยกคำตอบเจ้าของ + จัดผล ในคำขอเดียว
 * ใช้เมื่อมี GEMINI_API_KEY (ถ้าไม่มี ใช้ OpenAI / จับคำ ตามเดิม)
 */
export async function analyzeWithGemini(audio: ArrayBuffer): Promise<(Classified & { transcript: string }) | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const prompt =
    "นี่คือไฟล์เสียงโทรศัพท์ภาษาไทย ระหว่างเสียงอัด (บอท) ของบริษัทเท่าไหร่ดอทคอม กับเจ้าของห้องคอนโด\n" +
    "บอทเล่นคำถามต่อกันทั้งชุด เว้นช่วงสั้นๆ ให้เจ้าของตอบ: ห้องยังว่างไหม → พร้อมเข้าอยู่เลยไหม → ว่างวันที่/เดือนไหน → (ราคาห้องใช่ไหม) → รับลูกค้าต่างชาติไหม → แจ้งว่าแอดมินจะส่งโปรไฟล์ลูกค้า\n" +
    "บอทถามต่อจนจบแม้เจ้าของตอบว่าไม่ว่างแล้ว ให้ยึดคำตอบของเจ้าของเป็นหลัก เจ้าของอาจตอบช้า ตอบข้ามข้อ หรือพูดแทรกเสียงบอท ให้จับคู่คำตอบกับคำถามตามความหมาย\n" +
    "1) ถอดเสียงทั้งไฟล์เป็นข้อความ\n2) แยกเฉพาะคำพูดของเจ้าของห้อง (ไม่รวมเสียงบอท)\n" +
    "3) จัดผล outcome: avail = ห้องยังว่าง · not_avail = ไม่ว่าง/มีคนเช่า/ขายแล้ว · callback = ขอให้โทรมาใหม่ · dnc = ขอไม่ให้ติดต่อ/ไม่ฝากเอเจนต์ · wrong_number = ไม่ใช่เจ้าของ · unclear = ไม่ตอบหรือฟังไม่ออก\n" +
    "4) รายละเอียด (ไม่ได้ตอบให้ null): ready_now = พร้อมเข้าอยู่เลยไหม · available_from = วันที่/เดือนที่ว่างตามที่เจ้าของพูด · price_confirmed = ยืนยันราคาที่บอทพูด · owner_price = ราคาที่เจ้าของบอกถ้าไม่ตรง (ตัวเลขบาท) · accepts_foreigners = รับต่างชาติไหม · current_lease_until = ผู้เช่าปัจจุบันอยู่ถึงเมื่อไหร่\n" +
    "ห้ามนับคำในเสียงบอท ห้ามเดา\n" +
    'ตอบเป็น JSON เท่านั้น: {"transcript": string, "owner_answer": string, "outcome": "avail|not_avail|callback|dnc|wrong_number|unclear", "ready_now": boolean|null, "available_from": string|null, "price_confirmed": boolean|null, "owner_price": number|null, "accepts_foreigners": boolean|null, "current_lease_until": string|null, "summary_th": string}';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: "audio/mp3", data: Buffer.from(audio).toString("base64") } }, { text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "{}";
  const j = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
  const allowed: Outcome[] = ["avail", "not_avail", "callback", "dnc", "wrong_number", "unclear"];
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  const details: CallDetails = {
    ready_now: bool(j.ready_now),
    available_from: j.available_from ? String(j.available_from) : null,
    price_confirmed: bool(j.price_confirmed),
    owner_price: Number.isFinite(Number(j.owner_price)) && j.owner_price != null ? Number(j.owner_price) : null,
    accepts_foreigners: bool(j.accepts_foreigners),
  };
  let outcome: Outcome = allowed.includes(j.outcome) ? (j.outcome as Outcome) : "unclear";
  // ว่าง + รู้ว่ารับต่างชาติหรือไม่ → แยกผลให้ละเอียดขึ้น
  if (outcome === "avail" && details.accepts_foreigners === true) outcome = "avail_ok" as Outcome;
  if (outcome === "avail" && details.accepts_foreigners === false) outcome = "avail_no" as Outcome;
  return {
    outcome,
    details,
    summary: String(j.summary_th ?? ""),
    current_lease_until: j.current_lease_until ?? null,
    answer_text: String(j.owner_answer ?? ""),
    transcript: String(j.transcript ?? ""),
  };
}

/** เลือกตัววิเคราะห์ตามคีย์ที่มี: Gemini → OpenAI → จับคำ */
export async function analyzeAnswer(audio: ArrayBuffer | null): Promise<Classified & { transcript: string; error: string | null }> {
  if (!audio) return { ...classifyByKeywords(""), transcript: "", error: null };
  try {
    const g = await analyzeWithGemini(audio);
    if (g) return { ...g, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (!process.env.OPENAI_API_KEY) return { ...classifyByKeywords(""), transcript: "", error };
  }
  try {
    const full = (await transcribe(audio)) ?? "";
    return { ...(await classify(full)), transcript: full, error: null };
  } catch (e) {
    return { ...classifyByKeywords(""), transcript: "", error: e instanceof Error ? e.message : String(e) };
  }
}
