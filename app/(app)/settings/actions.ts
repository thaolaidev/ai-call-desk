"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function updateSettings(formData: FormData) {
  const supabase = await createClient();
  const provider = formData.get("provider") === "vapi" ? "vapi" : "simulate";
  await supabase
    .from("settings")
    .update({
      provider,
      company: String(formData.get("company") || "เท่าไหร่ดอทคอม"),
      default_nationalities: String(formData.get("default_nationalities") || ""),
      viewing_when: String(formData.get("viewing_when") || "วันนี้"),
      vapi_assistant_id: String(formData.get("vapi_assistant_id") || "") || null,
      vapi_phone_number_id: String(formData.get("vapi_phone_number_id") || "") || null,
    })
    .eq("id", 1);
  revalidatePath("/settings");
}
