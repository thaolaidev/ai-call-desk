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
const ANSWER_SILENCE_SEC = 3; // กำหนดตายตัว ไม่ต้องตั้งในหน้าเว็บ
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
      if (s && !s.started) { s.started = true; s.answered = true; s.answeredAt = Date.now(); runFlow(s).catch((err) => { log(s.callId, "flow error", err.message); hangup(s); }); }
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

async function play(s, sound) {
  if (!sound || s.gone) return;
  const id = randomUUID();
  const done = wait(s, `playback:${id}`, 180_000);
  try { await ari("POST", `/channels/${s.id}/play/${id}`, { media: `sound:${sound}` }); }
  catch (err) { release(`playback:${id}`); if (s.gone) return; throw err; }
  await done;
}

/** อัดคำตอบสั้นๆ ของเจ้าของ (หยุดเมื่อเงียบ) แล้วให้ Gemini ตีความ */
async function listen(s, kind, question, silenceSec) {
  if (s.gone) return { intent: "hangup" };
  const name = `ans-${s.callId}-${++s.turn}`;
  const done = wait(s, `recording:${name}`, (CFG.listenMax + 5) * 1000);
  try {
    await ari("POST", `/channels/${s.id}/record`, {
      name, format: "wav", maxDurationSeconds: Math.max(CFG.listenMax, (silenceSec ?? 0) + 7), maxSilenceSeconds: Math.max(1, Math.round(silenceSec ?? CFG.listenSilence)), ifExists: "overwrite", beep: "false", terminateOn: "none",
    });
  } catch (err) { release(`recording:${name}`); if (s.gone) return { intent: "hangup" }; throw err; }
  const r = await done;
  if (r.hangup || s.gone) return { intent: "hangup" };
  const file = `${CFG.recDir}/${name}.wav`;
  const size = await stat(file).then((x) => x.size).catch(() => 0);
  if (size < 8000) return log(s.callId, kind, "silence"), { intent: "silent", text: "" }; // < ~0.5 วินาที
  // เล่นเสียงรับคำสั้นๆ (เช่น "ค่ะ") ระหว่างรอ AI ตีความ → ไม่เงียบนาน
  const [a] = await Promise.all([understand(kind, question, await readFile(file)), s.on("ack") ? play(s, s.snd.ack) : null]);
  s.answers.push({ step: kind, question, ...a });
  log(s.callId, kind, JSON.stringify(a));
  return a;
}

const KINDS = {
  avail: 'ห้องยังว่างไหม → intent: "yes" (ว่าง/ยังว่าง) | "no" (ไม่ว่าง/มีคนเช่า/ขายแล้ว) | "callback" (ไม่สะดวก ให้โทรใหม่) | "dnc" (ไม่ให้ติดต่อ/ไม่ฝากเอเจนต์) | "wrong" (ไม่ใช่เจ้าของ) | "unclear"\n' +
    'ระวังเป็นพิเศษ: "ไม่ว่าง" กับ "ยังว่าง" ฟังคล้ายกันมากทางโทรศัพท์ ให้ฟังพยางค์แรกให้ชัด ("ไม่" เสียงสั้น สระ ไ / "ยัง" มีตัวสะกด ง) และดูคำอื่นประกอบ เช่น "มีคนเช่าแล้ว" "ไม่ค่ะ" · ถ้าไม่แน่ใจ ให้ตอบ "unclear"',
  ready: 'พร้อมเข้าอยู่เลยไหม → intent: "yes" | "no" | "unclear" · ถ้าบอกวันที่/เดือนที่ว่าง ให้ใส่ available_from',
  date: 'ว่างวันที่เท่าไหร่ → intent: "answered" | "unclear" · available_from = วันที่ตามที่เจ้าของพูด',
  month: 'เดือนไหน → intent: "answered" | "unclear" · available_from = เดือนตามที่เจ้าของพูด',
  price: 'ราคาห้องตามที่บอทพูดถูกไหม → intent: "yes" | "no" | "unclear" · ถ้าเจ้าของบอกราคาใหม่ ใส่ owner_price (ตัวเลขบาท)',
  foreign: 'เจ้าของรับลูกค้าต่างชาติไหม → intent: "yes" | "no" | "unclear" · asks_nationality = true ถ้าเจ้าของถามกลับว่าลูกค้าชาติไหน',
};

const noThinking = new Set(); // รุ่นที่ไม่รับการตั้งระดับคิด
async function understand(kind, question, wav) {
  if (!CFG.geminiKey) return { intent: "unclear", text: "", error: "no GEMINI_API_KEY" };
  const prompt =
    `เสียงนี้คือคำตอบของเจ้าของห้องคอนโด (ภาษาไทย ทางโทรศัพท์) ต่อคำถาม "${question}"\n` +
    `${KINDS[kind]}\nห้ามเดา ถ้าฟังไม่ออกให้ unclear\n` +
    'ตอบ JSON เท่านั้น: {"text": string, "intent": string, "confidence": number (0-1), "available_from": string|null, "owner_price": number|null, "asks_nationality": boolean}';
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
    const intent = Number.isFinite(conf) && conf < 0.7 ? "unclear" : String(j.intent ?? "unclear");
    return { intent, confidence: Number.isFinite(conf) ? conf : null, heard: String(j.intent ?? ""), text: String(j.text ?? ""), available_from: j.available_from ?? null, owner_price: j.owner_price ?? null, asks_nationality: !!j.asks_nationality };
  } catch (err) {
    return { intent: "unclear", text: "", error: err.message };
  }
}

// ---------- บทโทร (แยกทางตามคำตอบ) ----------
async function runFlow(s) {
  const P = (k) => (s.on(k) ? play(s, s.snd[k]) : null);
  const L = (kind, _step, q) => listen(s, kind, q, ANSWER_SILENCE_SEC); // เจ้าของเงียบ 3 วินาที = ตอบจบ
  const Q = (k) => s.title[k] ?? k;
  const live = (s.live = { outcome: "unclear", ready_now: null, available_from: null, price_confirmed: null, owner_price: null, accepts_foreigners: null });

  await P("01");
  await P("02-1");
  if (s.snd.condo) await play(s, s.snd.condo);
  await P("02-2");
  let a = await L("avail", "02-2", "ห้องยังว่างอยู่ไหม");
  if (["silent", "unclear"].includes(a.intent) && !s.gone) { await P("02-2"); a = await L("avail", "02-2", "ห้องยังว่างอยู่ไหม (ถามซ้ำ)"); }
  if (a.intent === "hangup" || s.gone) return;

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
    await P("03");
    const r = await L("ready", "03", Q("03"));
    if (r.intent === "yes") live.ready_now = true;
    if (r.intent === "no") live.ready_now = false;
    if (r.available_from) live.available_from = r.available_from;
    if (r.intent !== "yes" && !live.available_from && !s.gone) {
      if (s.on("03-1")) { await P("03-1"); const d = await L("date", "03-1", Q("03-1")); if (d.available_from) live.available_from = d.available_from; }
      if (s.on("03-2")) { await P("03-2"); const m = await L("month", "03-2", Q("03-2")); if (m.available_from) live.available_from = [live.available_from, m.available_from].filter(Boolean).join(" "); }
    }
  }
  if (s.snd.price && s.on("04-1")) {
    await P("04-1"); await play(s, s.snd.price); await P("04-2");
    const p = await L("price", "04-2", "ราคาห้องปัจจุบันใช่ไหม");
    if (p.intent === "yes") live.price_confirmed = true;
    if (p.intent === "no") live.price_confirmed = false;
    if (p.owner_price) live.owner_price = Number(p.owner_price) || null;
  }

  // ต่างชาติ
  if (s.on("05")) {
    await P("05");
    let f = await L("foreign", "05", Q("05"));
    if (["silent", "unclear"].includes(f.intent) && !s.gone) { await P("05"); f = await L("foreign", "05", `${Q("05")} (ถามซ้ำ)`); }
    if (f.intent === "yes") {
      live.accepts_foreigners = true;
      if (f.asks_nationality && s.snd["06A"]) { await play(s, s.snd["06A"]); }
    } else if (f.intent === "no") {
      live.accepts_foreigners = false;
      for (const k of ["07-1", "07-2", "07-3", "07-4"]) await play(s, s.snd[k]); // อธิบายกฎเสมอเมื่อไม่รับ
    }
  }
  live.outcome = live.accepts_foreigners === true ? "avail_ok" : live.accepts_foreigners === false ? "avail_no" : "avail";

  await P("08");
  await P("09");
  return hangup(s);
}

async function hangup(s) {
  if (s.gone) return;
  await ari("DELETE", `/channels/${s.id}`).catch(() => {});
}

// ---------- จบสาย: ส่งผล + ไฟล์เสียงกลับเว็บ ----------
const PRE_ANSWER = { 17: "noanswer", 18: "noanswer", 19: "noanswer", 21: "noanswer", 1: "invalid", 3: "invalid", 22: "invalid", 28: "invalid", 34: "noanswer", 38: "noanswer" };

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
  for (let i = 0; i < 4; i++) {
    try {
      const fd = new FormData();
      fd.append("json", JSON.stringify(payload));
      if (mp3) fd.append("recording", new Blob([mp3], { type: "audio/mpeg" }), `${s.callId}.mp3`);
      const res = await fetch(CFG.resultUrl, { method: "POST", headers: { "x-voice-secret": CFG.secret }, body: fd, signal: AbortSignal.timeout(60_000) });
      if (res.ok) { log(s.callId, "result sent"); break; }
      log(s.callId, "result HTTP", res.status, (await res.text()).slice(0, 200));
    } catch (err) { log(s.callId, "result error", err.message); }
    await new Promise((r) => setTimeout(r, [2000, 10_000, 30_000][i] ?? 60_000));
  }
  // ลบไฟล์ชั่วคราว (เก็บไฟล์เต็มไว้ที่เว็บแล้ว)
  for (let n = 1; n <= s.turn; n++) await unlink(`${CFG.recDir}/ans-${s.callId}-${n}.wav`).catch(() => {});
  if (mp3) await unlink(`${CFG.recDir}/full-${s.callId}.wav`).catch(() => {});
}

// ---------- รับคำสั่งโทรจากเว็บ ----------
async function startCall(body) {
  const callId = String(body.call_id ?? "").replace(/[^\w-]/g, "");
  const number = String(body.phone ?? "").replace(/\D/g, "");
  if (!callId || number.length < 9) throw Object.assign(new Error("ต้องมี call_id และ phone"), { code: 400 });
  if (sessions.size >= CFG.maxCalls) throw Object.assign(new Error(`สายเต็ม (${CFG.maxCalls})`), { code: 429 });
  if (!wsUp) throw Object.assign(new Error("ยังเชื่อม Asterisk ไม่ได้"), { code: 503 });

  // เตรียมไฟล์เสียงก่อนโทร
  const snd = {};
  for (const [k, url] of Object.entries(body.audio ?? {})) snd[k] = await prepare(url);
  if (body.condo_url) snd.condo = await prepare(body.condo_url).catch(() => null);
  if (body.price_url) snd.price = await prepare(body.price_url).catch(() => null);
  const enabled = new Set(body.enabled ?? Object.keys(snd));

  const id = `tl-${callId}`;
  const s = { id, callId, mode: body.mode === "short" ? "short" : "full", turn: 0, answers: [], pending: new Set(), snd, title: body.titles ?? {}, on: (k) => enabled.has(k) && !!snd[k], started: false, answered: false, gone: false };
  sessions.set(id, s);
  // กันค้าง: ไม่มีใครรับเกินเวลา → ปิดเป็นไม่รับสาย · คุยเกิน 6 นาที → วางสาย
  s.timer = setTimeout(() => { if (!s.answered && !s.finished) { s.cause = s.cause ?? 19; hangup(s); finish(s); } }, (CFG.ringTimeout + 20) * 1000);
  s.maxTimer = setTimeout(() => hangup(s), 6 * 60_000);
  try {
    await ari("POST", "/channels", {
      endpoint: CFG.endpoint.replace("{number}", number),
      extension: "s", context: "thaolai-out", priority: 1,
      channelId: id, timeout: CFG.ringTimeout, callerId: CFG.callerId || undefined,
    }, { variables: { CALL_ID: callId } });
  } catch (err) {
    clearTimeout(s.timer); clearTimeout(s.maxTimer);
    sessions.delete(id);
    throw err;
  }
  log(callId, "dialing", number);
  return { ok: true, channel: id };
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
