"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { importPrices } from "@/app/(app)/prices/actions";

/** นำเข้า CSV ราคา: อ่านตัวเลขจากคอลัมน์แรก (หรือคอลัมน์ price) แล้วตัดซ้ำ */
export function PriceImport() {
  const ref = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <>
      <button type="button" className="btn" disabled={pending} onClick={() => ref.current?.click()}>{pending ? "กำลังนำเข้า…" : "นำเข้าราคา (CSV)"}</button>
      <input
        ref={ref}
        type="file"
        accept=".csv,text/csv,.txt"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const lines = (await f.text()).replace(/^﻿/, "").split(/\r?\n/).map((l) => l.split(","));
          const col = Math.max(0, lines[0]?.findIndex((c) => /price|ราคา/i.test(c)) ?? 0);
          const nums: number[] = [...new Set<number>(lines.map((r) => Math.round(Number(String(r[col] ?? "").replace(/[^\d.]/g, "")))).filter((n) => n > 0))];
          if (!nums.length) return setMsg("ไม่พบตัวเลขราคาในไฟล์");
          start(async () => {
            const r = await importPrices(nums);
            setMsg(r.error ? `นำเข้าไม่สำเร็จ: ${r.error}` : `ราคาไม่ซ้ำ ${nums.length.toLocaleString()} ราคา · เพิ่มใหม่ ${r.added.toLocaleString()}`);
            router.refresh();
          });
        }}
      />
      {msg && <span className="hint" role="status">{msg}</span>}
    </>
  );
}
