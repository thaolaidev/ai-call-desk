"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/** ตั้งค่าโทรต่อนาที (หน้าค่าใช้จ่ายค่าโทร) */
export async function setCostRate(formData: FormData) {
  const rate = Number(formData.get("cost_per_min"));
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) redirect("/costs?err=" + encodeURIComponent("ค่าโทรต่อนาทีไม่ถูกต้อง"));
  const supabase = await createClient();
  const { error } = await supabase.from("settings").update({ cost_per_min: rate }).eq("id", 1);
  if (error) redirect("/costs?err=" + encodeURIComponent(error.message.includes("cost_per_min") ? "ยังไม่ได้รัน update_0018_cost.sql ใน Supabase" : error.message));
  revalidatePath("/costs");
  redirect("/costs?saved=" + encodeURIComponent(`บันทึกค่าโทร ${rate} บาท/นาที แล้ว`));
}
