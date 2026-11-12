"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { tick } from "@/lib/dialer";

export async function completeTask(formData: FormData) {
  const supabase = await createClient();
  await supabase.from("admin_tasks").update({ status: "done", done_at: new Date().toISOString() }).eq("id", String(formData.get("id")));
  revalidatePath("/");
}

export async function toggleRunning() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return;
  const { data } = await supabase.from("settings").select("running").eq("id", 1).single();
  const running = !data?.running;
  await supabase.from("settings").update({ running }).eq("id", 1);
  if (running) await tick();
  revalidatePath("/", "layout");
}

/** เริ่ม/หยุดห้องโทรห้องเดียว (ทรัพย์ใหม่ หรือ ทรัพย์เดิม) */
export async function toggleRoom(formData: FormData) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return;
  const segment = formData.get("segment") === "new" ? "new" : "old";
  const { data } = await supabase.from("call_rooms").select("running").eq("segment", segment).single();
  const running = !data?.running;
  await supabase.from("call_rooms").update({ running, updated_at: new Date().toISOString() }).eq("segment", segment);
  if (running) await tick();
  revalidatePath("/", "layout");
}
