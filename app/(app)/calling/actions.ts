"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

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
      pull_time: /^\d{2}:\d{2}$/.test(String(formData.get("pull_time"))) ? String(formData.get("pull_time")) : "09:00",
      sync_every_min: Math.min(1440, Math.max(5, Number(formData.get("sync_every_min")) || 30)),
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
