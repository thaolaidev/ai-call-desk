"use client";
import { useRef, useState, useTransition } from "react";
import { importLeads, type CsvRow } from "@/app/(app)/leads/actions";

/** CSV: ชื่อเจ้าของ,เบอร์โทร,คอนโด,ห้อง,ค่าเช่า,สัญชาติลูกค้า (แถวหัวตารางจะถูกข้าม) */
function parse(text: string): CsvRow[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(",").map((c) => c.trim().replace(/^"|"$/g, "")))
    .filter((c) => c.length >= 3 && c[0] && !/ชื่อ|owner|name/i.test(c[0]))
    .map(([owner_name, phone, condo, unit, rent, customer_nationalities]) => ({ owner_name, phone, condo, unit, rent, customer_nationalities }));
}

export function CsvImport() {
  const ref = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <button type="button" className="btn" disabled={pending} onClick={() => ref.current?.click()}>
        {pending ? "กำลังนำเข้า…" : "นำเข้า CSV"}
      </button>
      <input
        ref={ref}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const rows = parse(await f.text());
          e.target.value = "";
          if (!rows.length) return setMsg("ไม่พบข้อมูล ตรวจรูปแบบ: ชื่อเจ้าของ,เบอร์โทร,คอนโด,ห้อง,ค่าเช่า,สัญชาติลูกค้า");
          start(async () => {
            const r = await importLeads(rows);
            setMsg(r.error ? `นำเข้าไม่สำเร็จ: ${r.error}` : `นำเข้า ${r.inserted} ห้อง (ข้ามที่ซ้ำ ${rows.length - r.inserted})`);
          });
        }}
      />
      {msg && <span className="hint">{msg}</span>}
    </>
  );
}
