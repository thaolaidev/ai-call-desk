"use client";
import { useActionState } from "react";
import { testBotnoi } from "@/app/(app)/settings/actions";

/** ทดสอบ Botnoi: พิมพ์ข้อความ → กดอ่าน → ฟังเสียงทันที */
export function BotnoiTest() {
  const [r, action, pending] = useActionState(testBotnoi, null);
  return (
    <form action={action} className="card-b" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input name="text" defaultValue="แอชตัน อโศก ราคาห้องปัจจุบันคือ หนึ่งหมื่นสองพัน บาท ใช่ไหมคะ" aria-label="ข้อความทดสอบ" style={{ flex: "1 1 320px", padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface)" }} />
        <button className="btn primary" disabled={pending}>{pending ? "Botnoi กำลังอ่าน…" : "ให้ Botnoi อ่าน"}</button>
      </div>
      {r?.url && <audio controls autoPlay src={r.url} style={{ width: "100%", maxWidth: 480 }} />}
      {r?.error && <p className="banner err">{r.error}</p>}
    </form>
  );
}
