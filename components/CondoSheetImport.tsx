"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { importCondoSheet, type SheetRow } from "@/app/(app)/condos/actions";

/** แยก CSV แบบรองรับเครื่องหมายคำพูด (ชื่อคอนโดมี , ได้) */
function csv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}

function toRows(text: string): SheetRow[] {
  const all = csv(text.replace(/^\uFEFF/, ""));
  if (!all.length) return [];
  // หาแถวหัวตารางใน 15 แถวแรก (ไฟล์ export บางแบบมีคำอธิบายนำหน้า)
  const isId = (c: string) => /^(condo_id|project_id|location_id|id|รหัส.*)$/i.test(c.trim());
  const isName = (c: string) => /^(condo_name|name_th|name|ชื่อ.*)$/i.test(c.trim());
  const isText = (c: string) => /(คำอ่าน|reading|tts)/i.test(c);
  let h = all.slice(0, 15).findIndex((r) => r.some(isId) && r.some(isName));
  let iId = 0, iName = 1, iText = 2;
  if (h >= 0) {
    iId = all[h].findIndex(isId);
    iName = all[h].findIndex(isName);
    iText = all[h].findIndex(isText);
  } else h = -1;
  return all.slice(h + 1).map((r) => ({
    condo_id: iId >= 0 ? (r[iId] ?? "").trim() : "",
    condo_name: iName >= 0 ? (r[iName] ?? "").trim() : "",
    tts_text: iText >= 0 ? (r[iText] ?? "").trim() : "",
  })).filter((r) => (r.condo_id && /\d/.test(r.condo_id)) || r.condo_name);
}

export function CondoSheetImport() {
  const ref = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <>
      <button type="button" className="btn" disabled={pending} onClick={() => ref.current?.click()}>{pending ? "กำลังนำเข้า…" : "นำเข้าชีท (CSV)"}</button>
      <input
        ref={ref}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const rows = toRows(await f.text());
          e.target.value = "";
          if (!rows.length) return setMsg("ไม่พบข้อมูล · ต้องมีคอลัมน์ id (หรือ condo_id) และ name_th (หรือ condo_name)");
          start(async () => {
            const sum = { added: 0, updated: 0, skipped: 0 };
            const SIZE = 1000;
            for (let i = 0; i < rows.length; i += SIZE) {
              setMsg(`กำลังนำเข้า ${Math.min(i + SIZE, rows.length).toLocaleString()} / ${rows.length.toLocaleString()} …`);
              const r = await importCondoSheet(rows.slice(i, i + SIZE));
              if (r.error) return setMsg(`นำเข้าไม่สำเร็จ: ${r.error}`);
              sum.added += r.added; sum.updated += r.updated; sum.skipped += r.skipped;
            }
            setMsg(`นำเข้าเสร็จ: เพิ่ม ${sum.added.toLocaleString()} · อัปเดต ${sum.updated.toLocaleString()} · ข้าม ${sum.skipped.toLocaleString()}`);
            router.refresh();
          });
        }}
      />
      {msg && <span className="hint" role="status">{msg}</span>}
    </>
  );
}
