"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function updateCampaign(formData: FormData) {
  const supabase = await createClient();
  const days = formData.getAll("call_days").map(Number);
  await supabase
    .from("settings")
    .update({
      concurrency: Math.min(10, Math.max(1, Number(formData.get("concurrency")) || 8)),
      daily_cap: Math.max(1, Number(formData.get("daily_cap")) || 200),
      call_start: String(formData.get("call_start") || "09:00"),
      call_end: String(formData.get("call_end") || "20:00"),
      call_days: days.length ? days : [1, 2, 3, 4, 5, 6],
      retry_gap_min: Math.max(15, Number(formData.get("retry_gap_min")) || 120),
      max_attempts: Math.min(10, Math.max(1, Number(formData.get("max_attempts")) || 3)),
      auto_queue: formData.get("auto_queue") === "on",
    })
    .eq("id", 1);
  revalidatePath("/calling");
}
