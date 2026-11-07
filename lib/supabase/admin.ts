import { createClient } from "@supabase/supabase-js";

/** Service-role client สำหรับงานเบื้องหลัง (ตัวยิงสาย, webhook) ข้าม RLS — ห้ามใช้ฝั่ง browser */
export function createAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
