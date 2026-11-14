"use client";
import { useActionState } from "react";
import { testCall } from "@/app/(app)/settings/actions";

const NAME: Record<string, string> = { yalecom: "Yalecom", vapi: "Vapi", sip: "Server เสียง", simulate: "โหมดจำลอง" };

export function TestCallForm({ provider }: { provider: string }) {
  const [msg, action, pending] = useActionState(testCall, null);
  return (
    <form action={action} className="card-b form-grid">
      <div className="field"><label htmlFor="tc-phone">เบอร์ที่จะโทรทดสอบ (เบอร์ของคุณเอง)</label><input id="tc-phone" name="phone" required placeholder="08x-xxx-xxxx" inputMode="tel" /></div>
      <div className="field"><label htmlFor="tc-condo">คอนโดตัวอย่าง (ชื่อเหมือนในคลัง)</label><input id="tc-condo" name="condo" defaultValue="Ashton Asoke / แอชตัน อโศก" /></div>
      <div className="field"><label htmlFor="tc-rent">ราคาห้องตัวอย่าง (บาท)</label><input id="tc-rent" name="rent" defaultValue="12000" inputMode="numeric" /></div>
      <div className="field"><label htmlFor="tc-seg">ห้อง</label><select id="tc-seg" name="segment" defaultValue="new"><option value="new">ทรัพย์ใหม่</option><option value="old">ทรัพย์เดิม · อัปเดต</option></select></div>
      <p className="hint" style={{ gridColumn: "1 / -1" }}>ก่อนโทร ระบบให้ Botnoi อ่านชื่อคอนโด (เฉพาะชื่อไทย: "แอชตัน อโศก") และราคา ("หนึ่งหมื่นสองพัน") แล้วเก็บไว้ใช้ซ้ำ · ถ้ามีเสียงอยู่แล้วใช้ของเดิม</p>
      <div><button className="btn primary" disabled={pending}>{pending ? "กำลังเตรียมเสียงและสั่งโทร…" : `โทรทดสอบ (${NAME[provider] ?? provider})`}</button></div>
      {msg && <p className={`banner ${msg.startsWith("โทรไม่สำเร็จ") ? "err" : ""}`} style={{ gridColumn: "1 / -1" }}>{msg}</p>}
    </form>
  );
}
