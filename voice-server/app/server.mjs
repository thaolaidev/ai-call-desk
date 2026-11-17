// Thaolai voice server: คุมบทโทรผ่าน Asterisk (ARI) — เล่นไฟล์ Botnoi, ฟังคำตอบ, แยกทางทันที
// ไม่ใช้ไลบรารีภายนอก (Node 22: fetch, WebSocket, FormData มีในตัว) · ต้องมี ffmpeg ในเครื่อง
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, unlink, stat, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const env = (k, d) => process.env[k] ?? d;
const CFG = {
  port: Number(env("PORT", 8090)),
  host: env("LISTEN_HOST", "0.0.0.0"),
  secret: env("VOICE_SECRET", ""),
  ari: env("ARI_URL", "http://127.0.0.1:8088").replace(/\/+$/, ""),
  ariUser: env("ARI_USER", "thaolai"),
  ariPass: env("ARI_PASSWORD", ""),
  resultUrl: env("WEB_RESULT_URL", ""),
  geminiKey: env("GEMINI_API_KEY", ""),
  geminiModel: env("GEMINI_MODEL", "gemini-3.5-flash-lite"),
  // คำถามสำคัญ (ห้องว่างไหม) ใช้รุ่นที่ฟังแม่นกว่า เพราะ "ไม่ว่าง" กับ "ยังว่าง" เสียงคล้ายกันมากทางโทรศัพท์
  geminiModelKey: env("GEMINI_MODEL_KEY", "gemini-3.8-flash"),
  geminiUrl: env("GEMINI_URL", "https://generativelanguage.googleapis.com/v1beta/models"),
  endpoint: env("SIP_ENDPOINT", "PJSIP/{number}@yalecom"),
  callerId: env("CALLER_ID", ""),
  sounds: env("SOUNDS_DIR", "/var/lib/asterisk/sounds/thaolai"),
  recDir: env("REC_DIR", "/var/spool/asterisk/recording"),
  maxCalls: Number(env("MAX_CALLS", 6)),
  ringTimeout: Number(env("RING_TIMEOUT", 30)),
  listenMax: Number(env("LISTEN_MAX_SEC", 7)),
  listenSilence: Number(env("LISTEN_SILENCE_SEC", 1)),
};
const APP = "thaolai";
const ANSWER_MAX_SEC = 30; // เจ้าของพูดยาวได้สูงสุดต่อคำตอบ
const TALK_QUIET_MS = 1000; // พูดแล้วเงียบ 1 วินาที = ตอบจบ (ตรวจจับเสียงพูด)
const NO_ANSWER_SEC = 2; // ถามแล้วเจ้าของไม่พูดภายใน 2 วินาที = ไม่ตอบ → ถามซ้ำ
const WAIT_QUIET_MAX_MS = 15_000; // ก่อนบอทพูด รอให้เจ้าของพูดจบ (นานสุด 15 วินาที)
const log = (...a) => console.log(new Date().toISOString(), ...a);
mkdirSync(CFG.sounds, { recursive: true });

// ---------- ARI ----------
const auth = "Basic " + Buffer.from(`${CFG.ariUser}:${CFG.ariPass}`).toString("base64");
async function ari(method, path, query = {}, body) {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${CFG.ari}/ari${path}${qs.size ? `?${qs}` : ""}`, {
    method,
    headers: { Authorization: auth, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ARI ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const waiters = new Map(); // key → resolve (playback:<id>, recording:<name>)
const sessions = new Map(); // channelId → session
let wsUp = false;

let ws = null;
let lastUp = Date.now();
function connectEvents() {
  // subscribeAll: ได้ event ของสายตั้งแต่เริ่มโทร (รวมสายที่ไม่รับ/เบอร์ผิด) ไม่พลาดแม้สายตัดเร็ว
  const url = `${CFG.ari.replace(/^http/, "ws")}/ari/events?app=${APP}&subscribeAll=true&api_key=${encodeURIComponent(`${CFG.ariUser}:${CFG.ariPass}`)}`;
  try { ws?.close(); } catch {}
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => { if (ws !== sock) return; wsUp = true; lastUp = Date.now(); log("ARI connected"); };
  sock.onclose = () => { if (ws !== sock) return; if (wsUp) log("ARI disconnected"); wsUp = false; };
  sock.onerror = () => {};
  sock.onmessage = (m) => {
    let e;
    try { e = JSON.parse(typeof m.data === "string" ? m.data : Buffer.from(m.data).toString()); } catch { return; }
    onEvent(e).catch((err) => log("event error", err.message));
  };
}

// เฝ้าการเชื่อมต่อ: หลุดเมื่อไหร่ต่อใหม่ทุก 5 วินาที · หลุดนานเกิน 2 นาที → ปิดตัวเองให้ Docker เปิดใหม่
setInterval(async () => {
  if (wsUp) {
    lastUp = Date.now();
    // เช็กว่า Asterisk ยังตอบจริง (กรณีโดนรีสตาร์ทแต่ socket ไม่รู้ตัว)
    try { await ari("GET", "/asterisk/ping"); } catch { log("ARI ping failed, reconnect"); wsUp = false; connectEvents(); }
    return;
  }
  if (Date.now() - lastUp > 120_000 && sessions.size === 0) { log("ARI down > 2 min, exiting for restart"); process.exit(1); }
  connectEvents();
}, 5000);

function wait(s, key, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { waiters.delete(key); s.pending.delete(key); resolve({ timeout: true }); }, ms);
    s.pending.add(key);
    waiters.set(key, (v) => { clearTimeout(t); waiters.delete(key); s.pending.delete(key); resolve(v ?? {}); });
  });
}
function release(key, v) { waiters.get(key)?.(v); }

async function onEvent(e) {
  const chId = e.channel?.id;
  const s = chId ? sessions.get(chId) : null;
  switch (e.type) {
    case "StasisStart":
      if (s && !s.started) {
        s.started = true;
        s.mixAt = Date.now(); // MixMonitor เริ่มอัดไฟล์ rx ก่อนเข้า Stasis เล็กน้อย
        // เปิดตรวจจับเสียงพูดของเจ้าของ → บอทจะไม่พูดแทรกระหว่างที่เจ้าของยังพูดอยู่
        await ari("POST", `/channels/${s.id}/variable`, { variable: "TALK_DETECT(set)", value: `${TALK_QUIET_MS},256` }).then(() => { s.talkDetect = true; log(s.callId, "talk detect on"); }).catch((err) => log(s.callId, "talk detect off", err.message));
        s.answered = true; s.answeredAt = Date.now(); runFlow(s).catch((err) => { log(s.callId, "flow error", err.message); hangup(s); }); }
      break;
    case "ChannelTalkingStarted":
      if (s) { s.talking = true; s.talkStarts.push(Date.now()); if (s.rec) s.rec.talked = true; }
      break;
    case "ChannelTalkingFinished":
      if (s) {
        s.talking = false;
        release(`quiet:${s.id}`);
        // เจ้าของพูดจบแล้ว (เงียบ 1 วินาที) → หยุดอัดเลย ไม่ต้องรอ Asterisk นับเงียบ
        if (s.rec?.talked) ari("POST", `/recordings/live/${s.rec.name}/stop`).catch(() => {});
      }
      break;
    case "ChannelStateChange":
      if (s && e.channel.state === "Up" && !s.answered) { s.answered = true; s.answeredAt = Date.now(); }
      break;
    case "ChannelDestroyed":
      if (s) { s.cause = e.cause; s.gone = true; for (const k of [...s.pending]) release(k, { hangup: true }); finish(s); }
      break;
    case "PlaybackFinished":
      if (e.playback?.state === "failed") {
        log("playback failed", e.playback.media_uri);
        // ลบไฟล์ใน cache ทิ้ง สายถัดไปจะดาวน์โหลดและแปลงใหม่
        const f = String(e.playback.media_uri ?? "").replace(/^sound:/, "");
        if (f.startsWith(CFG.sounds)) unlink(`${f}.wav`).catch(() => {});
      }
      release(`playback:${e.playback.id}`, {});
      break;
    case "RecordingFinished":
    case "RecordingFailed":
      release(`recording:${e.recording.name}`, { failed: e.type === "RecordingFailed" });
      break;
  }
}

// ---------- เสียง ----------
/** ดาวน์โหลดไฟล์เสียงแล้วแปลงเป็น wav 8kHz mono ที่ Asterisk เล่นได้ (เก็บ cache ตาม URL) */
async function prepare(url) {
  if (!url) return null;
  const name = createHash("sha1").update(`v2:${url}`).digest("hex").slice(0, 20);
  const out = `${CFG.sounds}/${name}.wav`;
  if (!existsSync(out)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`โหลดไฟล์เสียงไม่ได้ ${res.status}: ${url}`);
    const tmp = `/tmp/${name}-${Date.now()}`;
    const part = `${CFG.sounds}/${name}.part.wav`;
    await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
    try {
      // แปลงลงไฟล์ชั่วคราวก่อน แล้วค่อยเปลี่ยนชื่อ → ไม่มีไฟล์ครึ่งๆ กลางๆ ค้างใน cache
      // ตัดช่วงเงียบหัว-ท้ายไฟล์ (ไฟล์จาก Botnoi มักมีเงียบติดมา ทำให้สายเว้นจังหวะนาน)
      const trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse";
      await run("ffmpeg", ["-loglevel", "error", "-y", "-i", tmp, "-af", trim, "-ar", "8000", "-ac", "1", "-acodec", "pcm_s16le", part]);
      if ((await stat(part)).size < 1000) throw new Error(`ไฟล์เสียงว่างหรือเสีย: ${url}`);
      await rename(part, out);
    } finally {
      await unlink(tmp).catch(() => {});
      await unlink(part).catch(() => {});
    }
  }
  return `${CFG.sounds}/${name}`; // path เต็ม (Asterisk รับ sound:/path/file โดยไม่ต้องใส่นามสกุล)
}

/** ถ้าเจ้าของยังพูดอยู่ รอจนพูดจบก่อน (กันบอทพูดแทรก) */
async function waitQuiet(s, maxMs = WAIT_QUIET_MAX_MS) {
  if (!s.talking || s.gone) return;
  log(s.callId, "owner still talking, waiting");
  await wait(s, `quiet:${s.id}`, maxMs);
}

async function play(s, sound) {
  if (!sound || s.gone) return;
  await waitQuiet(s);
  if (s.gone) return;
  const id = randomUUID();
  const done = wait(s, `playback:${id}`, 180_000);
  try { await ari("POST", `/channels/${s.id}/play/${id}`, { media: `sound:${sound}` }); }
  catch (err) { release(`playback:${id}`); if (s.gone) return; throw err; }
  await done;
}

/** อัดคำตอบสั้นๆ ของเจ้าของ (หยุดเมื่อเงียบ) แล้วให้ Gemini ตีความ */
/** ตัดเสียงฝั่งเจ้าของจากไฟล์ rx (MixMonitor) ช่วงเวลา fromMs–toMs → wav ใหม่ · null = ทำไม่ได้ */
async function cutRx(s, fromMs, toMs, out) {
  if (!s.mixAt) return null;
  await new Promise((r) => setTimeout(r, 300)); // รอ Asterisk เขียนเสียงล่าสุดลงไฟล์
  const buf = await readFile(`${CFG.recDir}/rx-${s.callId}.wav`).catch(() => null);
  if (!buf || buf.length < 1000) return null;
  const at = (ms) => 44 + Math.max(0, Math.round(((ms - s.mixAt) / 1000) * 8000)) * 2; // wav 8kHz 16-bit mono
  const a = Math.min(at(fromMs), buf.length), b = Math.min(at(toMs), buf.length);
  if (b - a < 8000) return null; // สั้นกว่า 0.5 วินาที
  const data = buf.subarray(a, b);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  await writeFile(out, Buffer.concat([h, data]));
  return out;
}

/** อัดเสียง 1 ช่วง หยุดเมื่อเจ้าของเงียบตามที่กำหนด */
async function recordOnce(s, name) {
  const done = wait(s, `recording:${name}`, (ANSWER_MAX_SEC + 5) * 1000);
  // Asterisk หยุดอัดเมื่อเงียบ NO_ANSWER_SEC (ทั้งตอนยังไม่เริ่มพูด = ไม่ตอบ และตอนพูดจบ = สำรอง)
  // ถ้าตรวจจับเสียงพูดได้ → หยุดเร็วขึ้นทันทีที่เจ้าของพูดจบ (เงียบ 1 วินาที) ดูที่ ChannelTalkingFinished
  s.rec = { name, talked: !!s.talking }; // เริ่มพูดมาก่อนแล้ว (พูดสวนตอนบอทถาม) ก็นับว่าพูดแล้ว
  try {
    await ari("POST", `/channels/${s.id}/record`, {
      name, format: "wav", maxDurationSeconds: ANSWER_MAX_SEC, maxSilenceSeconds: NO_ANSWER_SEC, ifExists: "overwrite", beep: "false", terminateOn: "none",
    });
  } catch (err) { s.rec = null; release(`recording:${name}`); if (s.gone) return null; throw err; }
  const r = await done;
  s.rec = null;
  if (r.hangup || s.gone) return null;
  return `${CFG.recDir}/${name}.wav`;
}

async function listen(s, kind, question) {
  if (s.gone) return { intent: "hangup" };
  const name = `ans-${s.callId}-${++s.turn}`;
  const recStart = Date.now();
  // เจ้าของเริ่มพูดตั้งแต่บอทยังถามไม่จบ (พูดสวน) → คำตอบบางส่วน/ทั้งหมดอยู่ก่อนเริ่มอัด
  const overlapAt = s.talkStarts.find((t) => t >= s.qStart && t < recStart - 150);
  const first = await recordOnce(s, name);
  if (!first) return { intent: "hangup" };
  // เจ้าของเว้นจังหวะแล้วพูดต่อ → อัดต่ออีกช่วง แล้วรวมเป็นคำตอบเดียว (สูงสุด 3 ช่วง)
  const parts = [first];
  for (let i = 1; i <= 2 && s.talking && !s.gone; i++) {
    log(s.callId, kind, "owner continued, recording more");
    const more = await recordOnce(s, `${name}-c${i}`);
    if (!more) return { intent: "hangup" };
    parts.push(more);
  }
  // ส่วนที่เจ้าของพูดสวนก่อนเริ่มอัด → ดึงจากไฟล์ rx มาต่อหน้าคำตอบ
  if (overlapAt) {
    const pre = await cutRx(s, overlapAt - 400, recStart, `${CFG.recDir}/${name}-ov.wav`);
    if (pre) { log(s.callId, kind, `owner spoke over the question (${recStart - overlapAt}ms early)`); parts.unshift(pre); }
  }
  const sizes = await Promise.all(parts.map((f) => stat(f).then((x) => x.size).catch(() => 0)));
  const usable = parts.filter((_, i) => sizes[i] > 1000);
  parts.length = 0; parts.push(...(usable.length ? usable : [first]));
  let file = parts[0];
  if (parts.length > 1) {
    file = `${CFG.recDir}/${name}-all.wav`;
    await run("ffmpeg", ["-loglevel", "error", "-y", ...parts.flatMap((f) => ["-i", f]), "-filter_complex", `concat=n=${parts.length}:v=0:a=1`, "-ar", "8000", "-ac", "1", file]).catch(() => { file = first; });
  }
  const size = await stat(file).then((x) => x.size).catch(() => 0);
  if (size < 8000) return log(s.callId, kind, "no answer"), { intent: "silent", text: "" }; // < ~0.5 วินาที = ไม่ได้พูด
  const [a] = await Promise.all([understand(kind, question, await readFile(file)), s.on("ack") ? play(s, s.snd.ack) : null]);
  s.answers.push({ step: kind, question, ...a });
  log(s.callId, kind, JSON.stringify(a));
  return a;
}

const KINDS = {
  avail: 'ห้องยังว่างไหม → intent: "yes" (ว่าง/ยังว่าง) | "no" (ไม่ว่าง/มีคนเช่า/ขายแล้ว) | "callback" (ไม่สะดวก ให้โทรใหม่) | "dnc" (ไม่ให้ติดต่อ/ไม่ฝากเอเจนต์) | "wrong" (ไม่ใช่เจ้าของ) | "ask_price" (ยังไม่ตอบว่าว่างไหม แต่ถามกลับเรื่องราคา เช่น "ราคาเท่าไหร่" "ลูกค้าดูไว้ราคาเท่าไหร่") | "ask_condo" (ยังไม่ตอบ แต่ถามกลับว่าห้องไหน/คอนโดไหน/อะไรนะ ฟังชื่อไม่ทัน) | "unclear" · asks_price = true ถ้าเจ้าของถามราคา · asks_condo = true ถ้าถามว่าคอนโดไหน/ห้องไหน\n' +
    'ระวังเป็นพิเศษ: "ไม่ว่าง" กับ "ยังว่าง" ฟังคล้ายกันมากทางโทรศัพท์ ให้ฟังพยางค์แรกให้ชัด ("ไม่" เสียงสั้น สระ ไ / "ยัง" มีตัวสะกด ง) และดูคำอื่นประกอบ เช่น "มีคนเช่าแล้ว" "ไม่ค่ะ" · ถ้าไม่แน่ใจ ให้ตอบ "unclear"',
  ready: 'พร้อมเข้าอยู่เลยไหม → intent: "yes" | "no" | "unclear" · ถ้าบอกวันที่/เดือนที่ว่าง ให้ใส่ available_from',
  date: 'ว่างวันที่เท่าไหร่ → intent: "answered" | "unclear" · available_from = วันที่ตามที่เจ้าของพูด',
  month: 'เดือนไหน → intent: "answered" | "unclear" · available_from = เดือนตามที่เจ้าของพูด',
  price: 'ราคาห้องตามที่บอทพูดถูกไหม → intent: "yes" | "no" | "unclear" · ถ้าเจ้าของบอกราคาใหม่ ใส่ owner_price (ตัวเลขบาท)',
  foreign: 'เจ้าของรับลูกค้าต่างชาติไหม → intent: "yes" (รับ · รวมถึงไม่รับแค่บางสัญชาติ เช่น "ไม่รับจีนกับอินเดีย" = รับชาติอื่น ให้ใส่ excluded_nationalities) | "no" (ไม่รับต่างชาติเลย/รับแต่คนไทย) | "ask" (ยังไม่ตอบว่ารับไหม แต่ถามกลับว่าลูกค้าชาติไหน เช่น "ชาติไหน" "คนที่ไหน") | "unclear" · asks_nationality = true ถ้าเจ้าของถามว่าผู้เช่า/ลูกค้าชาติไหน (ทั้งกรณี ask และ yes)',
  rules: 'บอทเพิ่งอธิบายกฎตรวจห้องของบริษัท เจ้าของเปลี่ยนใจรับลูกค้าต่างชาติไหม → intent: "yes" (โอเค/รับได้/ถ้าแบบนี้รับ) | "no" (ยังไม่รับ/รับแต่คนไทย) | "unclear" (แค่รับฟัง เช่น ค่ะ ครับ อืม)',
  profile: 'ให้แอดมินส่งโปรไฟล์ลูกค้าให้พิจารณาก่อนดีไหม → intent: "yes" (ได้/ส่งมาได้/ลองดู) | "no" (ไม่ต้อง/ไม่รับ/ไม่สนใจ) | "unclear"',
};

/** ตรวจ intent กับข้อความที่ถอดได้ ถ้าข้อความมีคำปฏิเสธชัดเจนแต่ intent เป็น yes → แก้เป็น no */
const NEG = {
  avail: /ไม่ว่าง|ไม่ได้ว่าง|ไม่ค่อยว่าง|มีคน(เช่า|อยู่|จอง)|เช่า(ไป)?แล้ว|ขาย(ไป)?แล้ว|ปล่อย(ไป)?แล้ว|ไม่มีห้อง|ไม่เหลือ|ติดผู้เช่า|ไม่ปล่อย/,
  foreign: /ไม่รับ|ไม่เอา(ต่างชาติ|ฝรั่ง)?|เฉพาะคนไทย|คนไทยเท่านั้น|รับแต่คนไทย/,
  profile: /ไม่ต้อง|ไม่สะดวก|ไม่สนใจ|ไม่เอา/,
};
function checkText(kind, text, intent) {
  // ต่างชาติ: "ไม่รับจีนกับอินเดีย" = รับชาติอื่น → yes (ไม่ใช่ no)
  if (kind === "foreign" && partialForeign(text).length) return "yes";
  const re = NEG[kind];
  if (!re || intent !== "yes") return intent;
  return re.test(text.replace(/\s+/g, "")) ? "no" : intent;
}

// สัญชาติที่เจ้าของอาจไม่รับเป็นบางชาติ
const NATS = ["จีน", "อินเดีย", "แขก", "ญี่ปุ่น", "เกาหลี", "เวียดนาม", "พม่า", "เมียนมา", "ลาว", "กัมพูชา", "เขมร", "ฟิลิปปินส์", "อินโดนีเซีย", "มาเลเซีย", "รัสเซีย", "อเมริกัน", "ฝรั่ง", "อาหรับ", "ตะวันออกกลาง", "แอฟริกา", "ไนจีเรีย", "ผิวสี", "ผิวดำ", "ปากีสถาน", "บังคลาเทศ", "เนปาล", "ไต้หวัน", "ฮ่องกง", "อิหร่าน", "อิสราเอล", "ยุโรป"];
const NAT_RE = new RegExp(`(${NATS.join("|")})`, "g");
/** "ไม่รับคนจีนกับอินเดีย" → ["จีน","อินเดีย"] · "ไม่รับต่างชาติ" / ไม่มีคำว่าไม่รับ → [] */
function partialForeign(text) {
  NAT_RE.lastIndex = 0;
  const s = String(text ?? "").replace(/\s+/g, "");
  const m = s.match(/(?:ไม่รับ|ยกเว้น|ไม่เอา|ไม่ให้)(.{0,40})/);
  if (!m) return [];
  if (/^(?:คน|ลูกค้า|ผู้เช่า)?ต่างชาติ/.test(m[1]) && !NAT_RE.test(m[1].replace(/^(?:คน|ลูกค้า|ผู้เช่า)?ต่างชาติ/, ""))) return [];
  NAT_RE.lastIndex = 0;
  return [...new Set(m[1].match(NAT_RE) ?? [])];
}
function excludedFrom(kind, text, fromModel) {
  if (kind !== "foreign") return null;
  const list = [...new Set([...(Array.isArray(fromModel) ? fromModel.map(String) : []), ...partialForeign(text)])].filter(Boolean);
  return list.length ? list : null;
}

/** เจ้าของถามกลับเรื่องราคา เช่น "ราคาเท่าไหร่" "ราคาที่ดูไว้" "กี่บาท" (ไม่นับคำว่า เท่าไหร่ดอทคอม) */
function askedPriceText(text) {
  const s = String(text ?? "").replace(/\s+/g, "").replace(/เท่าไหร่ดอทคอม|เท่าไรดอทคอม/g, "");
  return /ราคา.{0,8}(เท่าไ|กี่|ไหร่|อะไร|ที่ดู|ที่ลูกค้า)|กี่บาท|ให้ราคา(เท่า|ได้)|ราคาลูกค้า|ลูกค้า.{0,10}ราคา/.test(s);
}

/** เจ้าของถามกลับว่าห้อง/คอนโดไหน เช่น "คอนโดไหนคะ" "ห้องไหน" "ที่ไหนนะ" "อะไรนะคะ" */
function askedCondoText(text) {
  const s = String(text ?? "").replace(/\s+/g, "");
  return /(คอนโด|ห้อง|โครงการ|ตึก)(ไหน|อะไร|ที่ไหน)|ที่ไหนนะ|ชื่ออะไร|อะไรนะ|ว่าไงนะ|ห้องเลขที่|ห้องที่เท่าไ/.test(s);
}

const noThinking = new Set(); // รุ่นที่ไม่รับการตั้งระดับคิด
async function understand(kind, question, wav) {
  if (!CFG.geminiKey) return { intent: "unclear", text: "", error: "no GEMINI_API_KEY" };
  const prompt =
    `เสียงนี้คือคำตอบของเจ้าของห้องคอนโด (ภาษาไทย ทางโทรศัพท์) ต่อคำถาม "${question}"\n` +
    `${KINDS[kind]}\nขั้นตอน: ถอดคำพูดของเจ้าของเป็นข้อความ (text) ให้ตรงทุกคำก่อน แล้วตัดสิน intent จาก text นั้น intent ต้องไม่ขัดกับ text · ห้ามเดา ถ้าฟังไม่ออกให้ unclear\n` +
    'ตอบ JSON เท่านั้น: {"text": string, "intent": string, "confidence": number (0-1), "available_from": string|null, "owner_price": number|null, "asks_nationality": boolean, "asks_price": boolean, "asks_condo": boolean, "excluded_nationalities": string[]|null}';
  try {
    const model = kind === "avail" ? CFG.geminiModelKey : CFG.geminiModel;
    // คิดน้อยที่สุดเพื่อให้ตอบเร็ว (3.8 Flash รับต่ำสุดแค่ "low", รุ่น Lite รับ "minimal")
    const level = /lite/.test(model) ? "minimal" : "low";
    const call = (withThinking) => fetch(`${CFG.geminiUrl}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": CFG.geminiKey },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: "audio/wav", data: wav.toString("base64") } }, { text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", ...(withThinking ? { thinkingConfig: { thinkingLevel: level } } : {}) },
      }),
    });
    let res = await call(!noThinking.has(model));
    if (res.status === 400 && !noThinking.has(model)) {
      const t = await res.text().catch(() => "");
      if (/think/i.test(t)) { noThinking.add(model); res = await call(false); }
      else res = new Response(t, { status: 400 });
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160)}`);
    const body = await res.json();
    const t = body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "{}";
    const j = JSON.parse(t.replace(/^```json\s*|\s*```$/g, ""));
    // ไม่มั่นใจ → ถือว่าฟังไม่ชัด ให้ถามซ้ำ
    const conf = Number(j.confidence);
    let intent = Number.isFinite(conf) && conf < 0.7 ? "unclear" : String(j.intent ?? "unclear");
    // กันผลขัดกันเอง: ข้อความที่ถอดได้บอกว่า "ไม่ว่าง/ไม่รับ" แต่ intent ออกมาเป็น yes → เชื่อข้อความ
    const fixed = checkText(kind, String(j.text ?? ""), intent);
    if (fixed !== intent) { log("intent fixed by text", kind, intent, "→", fixed, JSON.stringify(j.text)); intent = fixed; }
    return { intent, confidence: Number.isFinite(conf) ? conf : null, heard: String(j.intent ?? ""), text: String(j.text ?? ""), available_from: j.available_from ?? null, owner_price: j.owner_price ?? null, asks_nationality: !!j.asks_nationality, asks_price: !!j.asks_price || askedPriceText(String(j.text ?? "")), asks_condo: !!j.asks_condo || askedCondoText(String(j.text ?? "")), excluded: excludedFrom(kind, String(j.text ?? ""), j.excluded_nationalities) };
  } catch (err) {
    return { intent: "unclear", text: "", error: err.message };
  }
}

// ---------- บทโทร (แยกทางตามคำตอบ) ----------
async function runFlow(s) {
  const P = (k) => (s.on(k) ? play(s, s.snd[k]) : null);
  const L = (kind, _step, q) => listen(s, kind, q); // ไม่พูด 2 วินาที = ไม่ตอบ · พูดแล้วเงียบ 1 วินาที = ตอบจบ
  const Q = (k) => s.title[k] ?? k;
  /** ถามแล้วรอคำตอบ · เจ้าของไม่ตอบ (เงียบ 2 วินาที) → ถามซ้ำ 1 ครั้ง · retryUnclear = ฟังไม่ออกก็ถามซ้ำ */
  const ask = async (kind, q, say, retryUnclear = false) => {
    s.qStart = Date.now(); await say();
    let a = await L(kind, null, q);
    const again = typeof retryUnclear === "function" ? retryUnclear(a) : retryUnclear && a.intent === "unclear";
    if (!s.gone && (a.intent === "silent" || again)) { s.qStart = Date.now(); await say(); a = await L(kind, null, `${q} (ถามซ้ำ)`); }
    return a;
  };
  const live = (s.live = { outcome: "unclear", ready_now: null, available_from: null, price_confirmed: null, owner_price: null, accepts_foreigners: null, owner_agreed_profile: null, nationality_told: null, accepted_after_rules: null });

  // ทักทาย 3 ท่อน เว้นท่อนละ 1 วินาที (ให้เจ้าของตั้งตัว) · ยังไม่มีไฟล์ท่อนใหม่ = ใช้ไฟล์ 01 เดิม
  const gap = (ms) => new Promise((r) => setTimeout(r, ms));
  if (s.snd["01-1"]) {
    await P("01-1"); if (s.gone) return; await gap(1000);
    await P("01-2"); if (s.gone) return; await gap(1000);
    await P("01-3");
  } else await play(s, s.snd["01"]);
  if (s.gone) return;
  await P("02-1");
  if (s.snd.condo) await play(s, s.snd.condo);
  // ถามราคากลับ → บอกราคา "ราคาห้องปัจจุบันคือ X บาท ใช่ไหมคะ" ฟังคำตอบ (ยืนยัน/ราคาใหม่) แล้วถามห้องว่างอีกครั้ง
  const askedPrice = (x) => x.intent === "ask_price" || !!x.asks_price;
  let priceDone = false;
  const confirmPrice = async () => {
    priceDone = true;
    const p = await ask("price", "ราคาห้องปัจจุบันใช่ไหม", async () => { await P("04-1"); await play(s, s.snd.price); await P("04-2"); });
    if (p.intent === "yes") live.price_confirmed = true;
    if (p.intent === "no") live.price_confirmed = false;
    if (p.owner_price) live.owner_price = Number(p.owner_price) || null;
    return p;
  };
  // ถามว่าคอนโดไหน → พูดชื่อคอนโดอีกครั้ง "ไม่ทราบว่าห้อง [คอนโด] ยังว่างอยู่ไหมคะ"
  const askedCondo = (x) => x.intent === "ask_condo" || !!x.asks_condo;
  const askCondoAgain = async () => { await P("02-1"); if (s.snd.condo) await play(s, s.snd.condo); await P("02-2"); };
  const clarify = (x) => x.intent !== "yes" && x.intent !== "no" && (askedPrice(x) || askedCondo(x));
  let a = await ask("avail", "ห้องยังว่างอยู่ไหม", () => P("02-2"), (x) => x.intent === "unclear" && !clarify(x));
  for (let i = 0; i < 3 && !s.gone && clarify(a); i++) {
    if (askedCondo(a) && !askedPrice(a)) {
      a = await ask("avail", "ห้องยังว่างอยู่ไหม (บอกชื่อคอนโดอีกครั้ง)", askCondoAgain, (x) => x.intent === "unclear" && !clarify(x));
      continue;
    }
    if (s.snd.price && s.on("04-1") && !priceDone) {
      const p = await confirmPrice();
      if (s.gone || p.intent === "hangup") return;
    }
    // ถามห้องว่างอีกครั้ง (ไม่มีไฟล์ราคา = ถามซ้ำเฉยๆ)
    a = await ask("avail", "ห้องยังว่างอยู่ไหม (หลังบอกราคา)", () => P("02-2"), (x) => x.intent === "unclear" && !clarify(x));
  }
  if (a.intent === "hangup" || s.gone) return;
  if (a.intent === "ask_price" || a.intent === "ask_condo") a.intent = "unclear";

  const map = { no: "not_avail", callback: "callback", dnc: "dnc", wrong: "wrong_number" };
  if (a.intent !== "yes") {
    live.outcome = map[a.intent] ?? "unclear";
    await P("02B"); // "ขอบคุณค่ะ" แล้ววางสายเลย (ไม่พูดเรื่องส่งโปรไฟล์)
    return hangup(s);
  }
  live.outcome = "avail";
  if (s.mode === "short") { await P("09"); return hangup(s); } // ทรัพย์เดิม: อัปเดตแค่ว่าง/ไม่ว่าง

  // สอบถามรายละเอียด
  if (s.on("03")) {
    const r = await ask("ready", Q("03"), () => P("03"));
    if (r.intent === "yes") live.ready_now = true;
    if (r.intent === "no") live.ready_now = false;
    if (r.available_from) live.available_from = r.available_from;
    if (r.intent !== "yes" && !live.available_from && !s.gone) {
      if (s.on("03-1")) { const d = await ask("date", Q("03-1"), () => P("03-1")); if (d.available_from) live.available_from = d.available_from; }
      if (s.on("03-2")) { const m = await ask("month", Q("03-2"), () => P("03-2")); if (m.available_from) live.available_from = [live.available_from, m.available_from].filter(Boolean).join(" "); }
    }
  }
  // ยืนยันราคา (ข้ามถ้ายืนยันไปแล้วตอนเจ้าของถามราคากลับ)
  if (s.snd.price && s.on("04-1") && !priceDone) await confirmPrice();
  if (s.gone) return;

  // ต่างชาติ
  const snd = (k) => s.snd[k] ?? null; // ท่อนสัญชาติ/อธิบายกฎ: เล่นเมื่อมีไฟล์เสียง
  const bye = () => (s.on("09") ? P("09") : P("02B")); // "ขอบคุณค่ะ" (ไม่มีไฟล์ 09 → ใช้ 02B)
  const askedNat = (a) => a.intent === "ask" || !!a.asks_nationality || /ชาติ(ไหน|อะไร)|สัญชาติ|ประเทศไหน|คนที่ไหน|คนชาติ/.test(String(a.text ?? "").replace(/\s+/g, ""));
  let f = { intent: "unclear" };
  if (s.on("05")) {
    // ฟังไม่ออก → ถามซ้ำ · แต่ถ้าเจ้าของถามกลับว่าชาติไหน ไม่ต้องถามซ้ำ ให้บอกสัญชาติเลย
    f = await ask("foreign", Q("05"), () => P("05"), (a) => a.intent === "unclear" && !askedNat(a));
  }
  if (f.intent === "hangup" || s.gone) return;
  // "ชาติไหนคะ" เฉยๆ (ยังไม่ได้บอกว่ารับ) แต่ AI ตีเป็น yes → ถือว่าถามกลับ ให้บอกสัญชาติแล้วฟังคำตอบก่อน
  const saidAccept = (x) => /รับ(ได้|ค่ะ|ครับ|คะ|หมด|ทุก)|ได้(ค่ะ|ครับ|หมด)|โอเค|ok/i.test(String(x.text ?? "").replace(/\s+/g, "").replace(/ไม่รับ\S*/g, ""));
  if (f.intent === "yes" && askedNat(f) && !saidAccept(f) && (snd("06A") || snd("06B"))) {
    log(s.callId, "foreign: ถามชาติไหน ยังไม่ได้บอกว่ารับ → บอกสัญชาติก่อน");
    f = { ...f, intent: "ask" };
  }
  // เจ้าของถามว่าผู้เช่าชาติไหน → บอกสัญชาติ (มีชุด A และ B สุ่มเลือก 1 ชุด)
  let natTold = false;
  const tellNationality = async () => {
    if (natTold) return;
    natTold = true;
    // ไม่บอกชุดสัญชาติที่เจ้าของไม่รับ (เช่น ไม่รับเกาหลี → ไม่ใช้ชุด B)
    const bad = live.foreign_exclude ?? [];
    let opts = ["06A", "06B"].filter((k) => snd(k));
    const clean = opts.filter((k) => !bad.some((n) => String(Q(k)).includes(n)));
    if (clean.length) opts = clean;
    const pick = opts[Math.floor(Math.random() * opts.length)];
    if (pick) { live.nationality_told = Q(pick); log(s.callId, "nationality", pick); await play(s, s.snd[pick]); }
  };
  // ถามกลับว่าชาติไหน แต่ยังไม่บอกว่ารับไหม → บอกสัญชาติ แล้วรอฟังว่ารับไหม (เงียบ → ถาม 05 ซ้ำ)
  if (f.intent !== "yes" && f.intent !== "no" && askedNat(f)) {
    s.qStart = Date.now();
    await tellNationality();
    if (s.gone) return;
    let g = await L("foreign", null, "หลังบอกสัญชาติลูกค้า เจ้าของรับไหม");
    if (!s.gone && ["silent", "unclear", "ask"].includes(g.intent)) g = await ask("foreign", Q("05"), () => P("05"));
    if (g.intent === "hangup" || s.gone) return;
    f = g;
  }
  if (f.excluded?.length) live.foreign_exclude = f.excluded;
  if (f.intent === "yes") {
    live.accepts_foreigners = true;
    live.outcome = "avail_ok";
    if (askedNat(f)) await tellNationality();
    // "ขอบคุณค่ะ เดี๋ยวแอดมินจะส่งโปรไฟล์ลูกค้าให้พิจารณาค่ะ"
    if (s.on("09A")) await P("09A");
    else { await P("08"); await bye(); }
    live.owner_agreed_profile = true;
    return hangup(s);
  }

  if (f.intent === "no") {
    live.accepts_foreigners = false;
    live.outcome = "avail_no";
    for (const k of ["07-1", "07-2", "07-3", "07-4"]) if (snd(k)) await play(s, s.snd[k]); // อธิบายกฎเมื่อไม่รับ
    if (s.gone) return;
    // "ยังไงให้ทางแอดมินเราส่งโปรไฟล์ลูกค้าให้พิจารณาดูก่อนดีไหมคะ"
    if (s.on("07-5")) {
      const g = await ask("profile", Q("07-5"), () => P("07-5")); // ฟังคำตอบ แล้วตอบรับ "รับทราบค่ะ"
      if (g.intent === "hangup" || s.gone) return;
      if (g.intent === "yes") live.owner_agreed_profile = true;
      if (g.intent === "no") live.owner_agreed_profile = false;
    }
    await P("08"); // "เดี๋ยวแอดมินจะส่งโปรไฟล์ลูกค้าให้พิจารณานะคะ"
    await bye(); // "ขอบคุณค่ะ"
    return hangup(s);
  }

  // ไม่ได้ถาม/ฟังไม่ออกเรื่องต่างชาติ → ปิดสายแบบรับต่างชาติ
  live.outcome = "avail";
  if (s.on("09A")) await P("09A");
  else { await P("08"); await bye(); }
  return hangup(s);
}

async function hangup(s) {
  if (s.gone) return;
  // รอเสียงท่อนสุดท้ายออกไปถึงปลายสายให้หมดก่อน ไม่งั้นคำท้าย ("สวัสดีค่ะ") จะถูกตัด
  await new Promise((r) => setTimeout(r, 1200));
  if (s.gone) return;
  await ari("DELETE", `/channels/${s.id}`).catch(() => {});
}

// ---------- จบสาย: ส่งผล + ไฟล์เสียงกลับเว็บ ----------
const PRE_ANSWER = { 17: "noanswer", 18: "noanswer", 19: "noanswer", 21: "noanswer", 1: "invalid", 3: "invalid", 22: "invalid", 28: "invalid", 34: "noanswer", 38: "noanswer" };

/** ส่งผลโทรไปเว็บ (ลองซ้ำ 4 ครั้ง) */
async function postResult(payload, mp3) {
  for (let i = 0; i < 4; i++) {
    try {
      const fd = new FormData();
      fd.append("json", JSON.stringify(payload));
      if (mp3) fd.append("recording", new Blob([mp3], { type: "audio/mpeg" }), `${payload.call_id}.mp3`);
      const res = await fetch(CFG.resultUrl, { method: "POST", headers: { "x-voice-secret": CFG.secret }, body: fd, signal: AbortSignal.timeout(60_000) });
      if (res.ok) { log(payload.call_id, "result sent"); break; }
      log(payload.call_id, "result HTTP", res.status, (await res.text()).slice(0, 200));
    } catch (err) { log(payload.call_id, "result error", err.message); }
    await new Promise((r) => setTimeout(r, [2000, 10_000, 30_000][i] ?? 60_000));
  }
}

async function finish(s) {
  if (s.finished) return;
  s.finished = true;
  clearTimeout(s.timer);
  clearTimeout(s.maxTimer);
  sessions.delete(s.id);
  const status = s.answered ? "answered" : PRE_ANSWER[s.cause] ?? "noanswer";
  const duration = s.answeredAt ? Math.round((Date.now() - s.answeredAt) / 1000) : 0;
  log(s.callId, "ended", status, "cause", s.cause, `${duration}s`);

  let mp3 = null;
  if (s.answered) {
    const wav = `${CFG.recDir}/full-${s.callId}.wav`;
    await new Promise((r) => setTimeout(r, 1500)); // ให้ MixMonitor ปิดไฟล์
    if (existsSync(wav)) {
      const out = `/tmp/full-${s.callId}.mp3`;
      try { await run("ffmpeg", ["-loglevel", "error", "-y", "-i", wav, "-ac", "1", "-ar", "16000", "-b:a", "32k", out]); mp3 = await readFile(out); }
      catch (err) { log(s.callId, "mp3 error", err.message); }
      await unlink(out).catch(() => {});
    }
  }
  const payload = { call_id: s.callId, status, cause: s.cause ?? null, duration_sec: duration, answers: s.answers, live: s.live ?? null };
  await postResult(payload, mp3);
  // ลบไฟล์ชั่วคราว (เก็บไฟล์เต็มไว้ที่เว็บแล้ว)
  for (let n = 1; n <= s.turn; n++) for (const x of ["", "-c1", "-c2", "-all", "-ov"]) await unlink(`${CFG.recDir}/ans-${s.callId}-${n}${x}.wav`).catch(() => {});
  if (mp3) await unlink(`${CFG.recDir}/full-${s.callId}.wav`).catch(() => {});
  await unlink(`${CFG.recDir}/rx-${s.callId}.wav`).catch(() => {});
}

// ---------- ชีพจรถึงเว็บทุก 30 วินาที ----------
// ให้เว็บเช็กห้องที่ทีมโทรเองแล้วในแชท (เอาออกจากคิว) และเติมสายห้องที่เปิดโทรทันที — ไม่ต้องรอ cron ทุกนาที
if (CFG.resultUrl && CFG.secret) {
  const beatUrl = new URL("/api/voice/heartbeat", CFG.resultUrl).toString();
  setInterval(() => {
    fetch(beatUrl, { method: "POST", headers: { "x-voice-secret": CFG.secret }, signal: AbortSignal.timeout(25_000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j && (j.pruned || j.started)) log("heartbeat", `pruned ${j.pruned} · started ${j.started}`); })
      .catch(() => {});
  }, 30_000);
}

// ---------- อ่านคำบรรยายใต้รูปในกลุ่มแชท (แทน patch ฝั่ง dev ชั่วคราว) ----------
// โพสต์รูป + "เบอร์ ชื่อคอนโด ราคา" ในกลุ่มที่ตั้งไว้ → ส่งเข้าห้องโทรเหมือนข้อความปกติ (id msg-<ข้อความ>-<ลำดับ> ให้หลังบ้านตั้งป้ายใต้โพสต์รูป)
// เปิดเมื่อมี CAPTION_DB_URL (ผู้ใช้ฐานข้อมูลแบบอ่านอย่างเดียว) + CAPTION_GROUPS + CHAT_API_KEY · อ่านแค่ตัวอักษร ไม่อ่านรูป
const CAP = {
  db: env("CAPTION_DB_URL", ""),
  groups: env("CAPTION_GROUPS", "").split(",").map((x) => x.trim()).filter(Boolean),
  key: env("CHAT_API_KEY", ""),
  push: env("DESK_PUSH_URL", CFG.resultUrl ? new URL("/api/chat/push", CFG.resultUrl).toString() : ""),
  stateFile: `${CFG.recDir}/.caption-last-id`,
};
const TXT_PHONE = /(?:\+?66|0)[\s-]?[689]\d[\s-]?\d{3}[\s-]?\d{4}|0[2-7][\s-]?\d{3}[\s-]?\d{4}/g;
const TXT_PRICE = /(?:ราคา|เช่า|price)?\s*(\d{1,3}(?:,\d{3})+|\d{4,6})\s*(?:บาท|฿|thb|\/เดือน|ต่อเดือน)?|(\d{1,3}(?:\.\d)?)\s*[kK]\b/i;
const TXT_SKIP = /^\s*(?:✅|❌|ว่าง|ไม่ว่าง|move\s*in|รับ|ไม่รับ|ส่งโปรไฟล์|สถานะ|link|map|https?:)/i;
const TXT_NOISE = /\b(?:tel|price|thb|condo|baht)\b|โทร|เบอร์|ราคา|ค่าเช่า|บาท|฿|ต่อเดือน|\/เดือน|คอนโด|ชื่อ|[:：•\-–|,/()]+/gi;
const normPhone = (raw) => {
  let d = String(raw).replace(/\D/g, "");
  if (d.startsWith("66") && d.length === 11) d = "0" + d.slice(2);
  return d.length >= 9 && d.length <= 10 && d[0] === "0" ? d : "";
};
/** เหมือน ParseAICallText ฝั่งหลังบ้าน: เบอร์บรรทัดเดียว = 1 ห้อง (ชื่อ = บรรทัดแรกที่ไม่ใช่เบอร์/ราคา) · หลายบรรทัดมีเบอร์ = แยกห้อง */
export function parseRoomsText(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n").map((line) => {
    const phones = line.match(TXT_PHONE) ?? [];
    let rest = line.replace(TXT_PHONE, " ");
    let price = null;
    const m = rest.match(TXT_PRICE);
    if (m) {
      if (m[1]) { const v = Number(m[1].replace(/,/g, "")); if (v >= 1000) price = v; }
      else if (m[2]) { const v = Number(m[2]); if (v > 0) price = v * 1000; }
      if (price != null) rest = rest.replace(m[0], " ");
    }
    const name = TXT_SKIP.test(line) ? "" : rest.replace(TXT_NOISE, " ").split(/\s+/).filter(Boolean).join(" ");
    return { phones, name, price };
  });
  const phoneLines = lines.filter((l) => l.phones.length).length;
  if (!phoneLines) return [];
  const firstName = lines.find((l) => l.name)?.name ?? "";
  const firstPrice = lines.find((l) => l.price != null)?.price ?? null;
  const near = (i) => {
    for (let j = i - 1; j >= 0; j--) if (!lines[j].phones.length && lines[j].name) return lines[j].name;
    for (let j = i + 1; j < lines.length; j++) { if (lines[j].phones.length) break; if (lines[j].name) return lines[j].name; }
    return "";
  };
  const out = []; const seen = new Set();
  lines.forEach((l, i) => {
    if (!l.phones.length) return;
    let { name, price } = l;
    if (phoneLines === 1) { name ||= firstName; price ??= firstPrice; } else if (!name) name = near(i);
    if (!name) return;
    for (const raw of l.phones) {
      const phone = normPhone(raw);
      if (!phone || seen.has(`${phone}|${name}`)) continue;
      seen.add(`${phone}|${name}`);
      out.push({ phone, condo: name, price });
    }
  });
  return out;
}

/** รูปสุดท้ายของอัลบั้มเดียวกัน (กติกาเดียวกับหน้าแชท: รหัสชุดเดียวกัน หรือรูปถัดไปของคนเดิมที่ไม่มีคำบรรยาย ห่างกันไม่เกิน 2 นาที) */
async function albumLast(pool, m) {
  const { rows } = await pool.query(
    `SELECT id, sender_user_id, kind, created_at, body->>'batch' AS batch, COALESCE(BTRIM(body->>'text'), '') AS text,
            body->>'reply_to' AS reply_to, body->'deleted' IS NOT NULL AS deleted
       FROM chat_message WHERE group_id = $1 AND id > $2 ORDER BY id LIMIT 30`, [m.group_id, m.id]);
  let last = { id: Number(m.id), at: new Date(m.created_at).getTime(), batch: m.batch };
  for (const r of rows) {
    const at = new Date(r.created_at).getTime();
    const same = r.kind === "attachment" && !r.deleted && !r.reply_to && String(r.sender_user_id) === String(m.sender_user_id) && at - last.at <= 120_000
      && (last.batch && r.batch ? r.batch === last.batch : !r.text);
    if (!same) break;
    last = { id: Number(r.id), at, batch: r.batch };
  }
  return last.id;
}

if (CAP.db && CAP.groups.length && CAP.key && CAP.push) {
  (async () => {
    let pg;
    try { pg = (await import("pg")).default; } catch { return log("caption: ไม่มีไลบรารี pg (build ใหม่ด้วย Dockerfile.app ล่าสุด)"); }
    const pool = new pg.Pool({ connectionString: CAP.db, max: 1, idleTimeoutMillis: 30_000 });
    pool.on("error", (e) => log("caption db", e.message));
    let last = Number(await readFile(CAP.stateFile, "utf8").catch(() => "0")) || 0;
    if (!last) {
      const r = await pool.query("SELECT COALESCE(MAX(id), 0)::bigint AS id FROM chat_message").catch((e) => (log("caption db", e.message), null));
      last = Number(r?.rows?.[0]?.id ?? 0); // เริ่มจากข้อความล่าสุด ไม่ย้อนไปโทรโพสต์เก่า
      await writeFile(CAP.stateFile, String(last)).catch(() => {});
    }
    log("caption: เปิดอ่านคำบรรยายใต้รูป", CAP.groups.join(","), "จากข้อความ", last);
    let busy = false;
    setInterval(async () => {
      if (busy) return; busy = true;
      try {
        // รอให้ข้อความเก่ากว่า 15 วินาทีก่อน (รูปในอัลบั้มเดียวกันอัปโหลดทีละรูป ต้องครบทั้งชุดก่อน)
        const top = await pool.query("SELECT COALESCE(MAX(id), 0)::bigint AS id FROM chat_message WHERE created_at < NOW() - INTERVAL '15 seconds'");
        const maxId = Number(top.rows?.[0]?.id ?? last);
        let failed = false;
        const { rows } = await pool.query(
          `SELECT m.id, m.group_id, m.sender_user_id, m.created_at, m.body->>'batch' AS batch, g.uuid::text AS group_uuid, m.body->>'text' AS text,
                  COALESCE(NULLIF(BTRIM(u.first_name_th), ''), u.username) AS by_name
             FROM chat_message m
             JOIN chat_group g ON g.id = m.group_id
             LEFT JOIN "user" u ON u.id = m.sender_user_id
            WHERE m.id > $1 AND m.id <= $3 AND g.uuid::text = ANY($2) AND m.kind = 'attachment'
              AND COALESCE(BTRIM(m.body->>'text'), '') <> '' AND m.body->'deleted' IS NULL
            ORDER BY m.id LIMIT 50`, [last, CAP.groups, maxId]);
        for (const m of rows) {
          const rooms = parseRoomsText(m.text);
          if (rooms.length) {
            // อัลบั้มหลายรูป: ปุ่มสถานะในแชทอยู่ใต้ "รูปสุดท้าย" ของอัลบั้ม (คำบรรยายอยู่รูปแรก) → ผูกกับรูปสุดท้าย
            const target = await albumLast(pool, m).catch(() => Number(m.id));
            const payload = rooms.map((r, i) => ({ id: `msg-${target}-${i + 1}`, condo_name: r.condo, phone: r.phone, message_id: target, ...(r.price != null ? { price: r.price } : {}) }));
            const res = await fetch(CAP.push, {
              method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": CAP.key },
              body: JSON.stringify({ group_uuid: m.group_uuid, requested_by: m.by_name ?? "ผู้ใช้", rooms: payload }),
              signal: AbortSignal.timeout(45_000),
            }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
            const j = res.ok ? await res.json().catch(() => ({})) : null;
            log("caption push", m.id, rooms.map((r) => `${r.phone} ${r.condo}`).join(" | "), res.ok ? `queued ${j?.queued ?? 0} started ${j?.started ?? 0}` : `ERR ${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`);
            if (!res.ok && res.status !== 400) { failed = true; break; } // เว็บล่ม → ลองใหม่รอบหน้า (ไม่ขยับ last)
          }
          last = Number(m.id);
        }
        if (!failed && rows.length < 50) last = Math.max(last, maxId);
        await writeFile(CAP.stateFile, String(last)).catch(() => {});
      } catch (e) { log("caption", e.message); }
      finally { busy = false; }
    }, 10_000);
  })();
}

// ---------- รับคำสั่งโทรจากเว็บ ----------
async function startCall(body) {
  const callId = String(body.call_id ?? "").replace(/[^\w-]/g, "");
  const number = String(body.phone ?? "").replace(/\D/g, "");
  if (!callId || number.length < 9) throw Object.assign(new Error("ต้องมี call_id และ phone"), { code: 400 });
  if (sessions.size >= CFG.maxCalls) throw Object.assign(new Error(`สายเต็ม (${CFG.maxCalls})`), { code: 429 });
  if (!wsUp) throw Object.assign(new Error("ยังเชื่อม Asterisk ไม่ได้"), { code: 503 });

  // ตอบเว็บทันที (ไม่ให้เว็บรอจนหมดเวลาแล้วนับเป็นโทรไม่สำเร็จ ทั้งที่สายออกไปแล้ว)
  // แล้วค่อยเตรียมไฟล์เสียง + โทรออกเบื้องหลัง · ล้มเหลว = แจ้งเว็บเป็นผลโทร "error"
  const id = `tl-${callId}`;
  const enabled = new Set(body.enabled ?? []);
  const s = { id, callId, mode: body.mode === "short" ? "short" : "full", turn: 0, answers: [], pending: new Set(), snd: {}, title: body.titles ?? {}, on: (k) => (body.enabled ? enabled.has(k) : true) && !!s.snd[k], started: false, answered: false, gone: false, talkStarts: [], qStart: 0 };
  sessions.set(id, s); // จองที่ไว้ก่อน (นับจำนวนสายพร้อมกัน)
  dial(s, body, number).catch(async (err) => {
    log(callId, "start failed", err.message);
    clearTimeout(s.timer); clearTimeout(s.maxTimer);
    sessions.delete(id);
    s.finished = true;
    await postResult({ call_id: callId, status: "error", error: String(err.message).slice(0, 300), answers: [], live: null }, null).catch(() => {});
  });
  return { ok: true, channel: id };
}

/** เตรียมไฟล์เสียง (ทำพร้อมกัน) แล้วโทรออก */
async function dial(s, body, number) {
  const entries = Object.entries(body.audio ?? {});
  const files = await Promise.all(entries.map(([, url]) => prepare(url)));
  entries.forEach(([k], i) => { s.snd[k] = files[i]; });
  const [condo, price] = await Promise.all([
    body.condo_url ? prepare(body.condo_url).catch(() => null) : null,
    body.price_url ? prepare(body.price_url).catch(() => null) : null,
  ]);
  if (condo) s.snd.condo = condo;
  if (price) s.snd.price = price;
  // กันค้าง: ไม่มีใครรับเกินเวลา → ปิดเป็นไม่รับสาย · คุยเกิน 6 นาที → วางสาย
  s.timer = setTimeout(() => { if (!s.answered && !s.finished) { s.cause = s.cause ?? 19; hangup(s); finish(s); } }, (CFG.ringTimeout + 20) * 1000);
  s.maxTimer = setTimeout(() => hangup(s), 6 * 60_000);
  await ari("POST", "/channels", {
    endpoint: CFG.endpoint.replace("{number}", number),
    extension: "s", context: "thaolai-out", priority: 1,
    channelId: s.id, timeout: CFG.ringTimeout, callerId: CFG.callerId || undefined,
  }, { variables: { CALL_ID: s.callId } });
  log(s.callId, "dialing", number);
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, ari: wsUp, active: sessions.size, max: CFG.maxCalls });
  if (!CFG.secret || req.headers["x-voice-secret"] !== CFG.secret) return send(401, { error: "unauthorized" });
  if (req.method === "POST" && req.url === "/call") {
    let raw = "";
    for await (const c of req) raw += c;
    try { send(202, await startCall(JSON.parse(raw || "{}"))); }
    catch (err) { send(err.code ?? 500, { error: err.message }); }
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/hangup/")) {
    const s = sessions.get(`tl-${req.url.split("/").pop()}`);
    if (s) await hangup(s);
    return send(200, { ok: !!s });
  }
  send(404, { error: "not found" });
});

connectEvents();
server.listen(CFG.port, CFG.host, () => log(`voice server ${CFG.host}:${CFG.port} · max ${CFG.maxCalls} calls`));
