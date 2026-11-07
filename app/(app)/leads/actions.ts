"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { normalizePhone } from "@/lib/phone";
import { QUEUEABLE } from "@/lib/status";

async function autoStatus(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data } = await supabase.from("settings").select("auto_queue").eq("id", 1).single();
  return data?.auto_queue ? "queued" : "new";
}

export async function queueLeads(formData: FormData) {
  const ids = formData.getAll("ids").map(String);
  if (!ids.length) return;
  const supabase = await createClient();
  await supabase.from("leads").update({ status: "queued", next_call_at: null, attempts: 0 }).in("id", ids).in("status", QUEUEABLE);
  revalidatePath("/leads");
}

export async function addLead(formData: FormData) {
  const supabase = await createClient();
  const rent = Number(String(formData.get("rent") ?? "").replace(/\D/g, "")) || null;
  await supabase.from("leads").insert({
    owner_name: String(formData.get("owner_name")).trim().replace(/^คุณ/, ""),
    phone: normalizePhone(String(formData.get("phone"))),
    condo: String(formData.get("condo")).trim(),
    unit: String(formData.get("unit") ?? "").trim() || null,
    rent,
    source: String(formData.get("source") ?? "เพิ่มเอง"),
    customer_nationalities: String(formData.get("customer_nationalities") ?? "").trim() || null,
    status: await autoStatus(supabase),
  });
  revalidatePath("/leads");
}

export type CsvRow = { owner_name: string; phone: string; condo: string; unit?: string; rent?: string; customer_nationalities?: string };

export async function importLeads(rows: CsvRow[]): Promise<{ inserted: number; error?: string }> {
  const supabase = await createClient();
  const status = await autoStatus(supabase);
  const clean = rows
    .filter((r) => r.owner_name && r.phone && r.condo)
    .map((r) => ({
      owner_name: r.owner_name.trim().replace(/^คุณ/, ""),
      phone: normalizePhone(r.phone),
      condo: r.condo.trim(),
      unit: r.unit?.trim() || null,
      rent: Number(String(r.rent ?? "").replace(/\D/g, "")) || null,
      customer_nationalities: r.customer_nationalities?.trim() || null,
      source: "นำเข้า CSV",
      status,
    }));
  const { data, error } = await supabase.from("leads").upsert(clean, { onConflict: "phone,condo", ignoreDuplicates: true }).select("id");
  revalidatePath("/leads");
  return { inserted: data?.length ?? 0, error: error?.message };
}
