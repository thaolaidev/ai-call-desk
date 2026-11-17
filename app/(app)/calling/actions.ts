"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchChat } from "@/lib/chat";

const CHAT_MODES = { auto: "โทรทันที", queue: "รับเข้าคิว รอกดโทร", off: "ปิดรับ" } as const;

/** ปุ่มเลือกโหมดของห้องโทร (หน้าห้องโทร) · เปลี่ยนเป็น "โทรทันที" = เริ่มโทรห้องที่รออยู่เลย */
export async function setChatMode(formData: FormData) {
  const mode = String(formData.get("chat_mode")) as keyof typeof CHAT_MODES;
  const segment = formData.get("segment") === "new" ? "new" : "old";
  if (!(mode in CHAT_MODES)) redirect("/calling?err=" + encodeURIComponent("โหมดไม่ถูกต้อง"));
  const supabase = await createClient();
  const { data: room, error } = await supabase.from("call_rooms").update({ chat_mode: mode, updated_at: new Date().toISOString() }).eq("segment", segment).select("name").single();
  if (error) redirect("/calling?err=" + encodeURIComponent(error.message.includes("chat_mode") ? "ยังไม่ได้รัน update_0017_rooms.sql" : error.message));
  let note = "";
  if (mode === "auto") {
    const d = await dispatchChat(createAdminClient(), undefined, segment).catch((e) => ({ started: 0, waiting: undefined, errors: [String(e)] }));
    note = d.started ? ` · เริ่มโทร ${d.started} สาย` : d.waiting ? ` · ${d.waiting}` : "";
  }
  revalidatePath("/calling");
  redirect("/calling?saved=" + encodeURIComponent(`${room?.name ?? ""}: ${CHAT_MODES[mode]}${note}`));
}
export async function updateCampaign(formData: FormData) {
  const supabase = await createClient();
  const days = formData.getAll("call_days").map(Number);
  await supabase
    .from("settings")
    .update({
      call_start: String(formData.get("call_start") || "09:00"),
      call_end: String(formData.get("call_end") || "20:00"),
      call_days: days.length ? days : [1, 2, 3, 4, 5, 6],
      retry_gap_min: Math.max(15, Number(formData.get("retry_gap_min")) || 120),
      max_attempts: Math.min(10, Math.max(1, Number(formData.get("max_attempts")) || 3)),
      auto_queue: formData.get("auto_queue") === "on",
      stale_days: Math.min(365, Math.max(1, Number(formData.get("stale_days")) || 30)),
      new_days: Math.min(90, Math.max(1, Number(formData.get("new_days")) || 7)),
      sync_every_min: Math.min(1440, Math.max(5, Number(formData.get("sync_every_min")) || 30)),
      ...(formData.has("chat_recall_hours")
        ? { chat_recall_hours: Math.min(720, Math.max(0, Number(formData.get("chat_recall_hours") ?? 12))) }
        : {}),
    })
    .eq("id", 1);
  for (const seg of ["new", "old"]) {
    await supabase
      .from("call_rooms")
      .update({
        concurrency: Math.min(10, Math.max(0, Number(formData.get(`concurrency_${seg}`)) || 0)),
        daily_cap: Math.max(0, Number(formData.get(`daily_cap_${seg}`)) || 0),
        updated_at: new Date().toISOString(),
      })
      .eq("segment", seg);
  }
  revalidatePath("/calling");
  revalidatePath("/settings");
}

const WAITING = ["queued", "noanswer", "unclear", "callback"];

/** เอาห้องจากแชทออกจากคิวโทร (id เดียว หรือ all = ทั้งหมดที่รออยู่) · ห้องที่กำลังโทรอยู่ไม่แตะ */
export async function removeChatQueued(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const all = formData.get("all") === "1";
  const segment = formData.get("segment") === "new" ? "new" : formData.get("segment") === "old" ? "old" : null;
  if (!id && !all) redirect("/calling?err=" + encodeURIComponent("ไม่พบห้องที่จะลบ"));
  const supabase = await createClient();
  let q = supabase
    .from("leads")
    .update({ status: "new", chat_requested_at: null, next_call_at: null })
    .not("chat_requested_at", "is", null)
    .in("status", WAITING);
  if (!all) q = q.eq("id", id);
  else if (segment) q = q.eq("segment", segment);
  const { data, error } = await q.select("id");
  if (error) redirect("/calling?err=" + encodeURIComponent(error.message));
  revalidatePath("/calling");
  redirect("/calling?saved=" + encodeURIComponent(`ลบออกจากคิวแล้ว ${data?.length ?? 0} ห้อง`));
}

/** โทรซ้ำห้องนี้รอบถัดไปเลย (ไม่ต้องรอเวลาโทรซ้ำ) แล้วเติมสายทันทีถ้าห้องเปิดโทรทันที */
export async function callNow(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  const { data, error } = await supabase.from("leads")
    .update({ next_call_at: new Date().toISOString() })
    .eq("id", id).in("status", ["noanswer", "unclear", "callback"]).select("segment").maybeSingle();
  if (error || !data) redirect("/calling?err=" + encodeURIComponent(error?.message ?? "ห้องนี้ไม่ได้รอโทรซ้ำแล้ว"));
  const d = await dispatchChat(createAdminClient(), undefined, data!.segment).catch(() => ({ started: 0, waiting: undefined as string | undefined }));
  revalidatePath("/calling");
  redirect("/calling?saved=" + encodeURIComponent(d.started ? "เริ่มโทรซ้ำแล้ว" : `เลื่อนมาโทรรอบถัดไปแล้ว${d.waiting ? ` · ${d.waiting}` : ""}`));
}
