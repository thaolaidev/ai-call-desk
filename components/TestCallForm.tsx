"use client";
import { useActionState } from "react";
import { testCall } from "@/app/(app)/settings/actions";

export function TestCallForm({ provider }: { provider: string }) {
  const [msg, action, pending] = useActionState(testCall, null);
  return (
    <form action={action} className="card-b form-grid">
      <div className="field"><label htmlFor="tc-phone">เบอร์ที่จะโทรทดสอบ (เบอร์ของคุณเอง)</label><input id="tc-phone" name="phone" required placeholder="08x-xxx-xxxx" inputMode="tel" /></div>
      <div className="field"><label htmlFor="tc-condo">ชื่อคอนโดที่ใช้ทดสอบ</label><input id="tc-condo" name="condo" placeholder="Ideo Mobi Asoke" /></div>
      <div><button className="btn primary" disabled={pending}>{pending ? "กำลังสั่งโทร…" : `โทรทดสอบ (${provider === "yalecom" ? "Yalecom" : provider === "vapi" ? "Vapi" : "โหมดจำลอง"})`}</button></div>
      {msg && <p className={`banner ${msg.startsWith("โทรไม่สำเร็จ") ? "err" : ""}`} style={{ gridColumn: "1 / -1" }}>{msg}</p>}
    </form>
  );
}
