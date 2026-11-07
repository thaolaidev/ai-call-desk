"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function signIn(_: string | null, formData: FormData): Promise<string | null> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  });
  if (error) return "อีเมลหรือรหัสผ่านไม่ถูกต้อง";
  redirect("/");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
