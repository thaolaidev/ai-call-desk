"use client";
import { useRef, useState, useTransition } from "react";
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
  const all = csv(text.replace(/^﻿/, ""));
  if (!all.length) return [];
  const h = all[0].map((c) => c.toLowerCase());
  const find = (re: RegExp) => h.findIndex((c) => re.test(c));
  let iId = find(/condo_id|project_id|^id$|รหัส/), iName = find(/condo_name|^name$|ชื่อ/), iText = find(/คำอ่าน|reading|tts/);
  const hasHeader = iId >= 0 || iName >= 0 || iText >= 0;
  if (!hasHeader) [iId, iName, iText] = [0, 1, 2];
  return all.slice(hasHeader ? 1 : 0).map((r) => ({
    condo_id: iId >= 0 ? r[iId] ?? "" : "",
    condo_name: iName >= 0 ? r[iName] ?? "" : "",
    tts_text: iText >= 0 ? r[iText] ?? "" : "",
  })).filter((r) => r.condo_id || r.condo_name);
}

export function CondoSheetImport() {
  const ref = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
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
          if (!rows.length) return setMsg("ไม่พบข้อมูล · คอลัมน์ที่ต้องมี: condo_id, condo_name, คำอ่าน");
          start(async () => setMsg(await importCondoSheet(rows)));
        }}
      />
      {msg && <span className="hint" role="status">{msg}</span>}
    </>
  );
}
