"use client";
import { useActionState, useRef } from "react";
import { useFormStatus } from "react-dom";

type Action = (prev: string | null, formData: FormData) => Promise<string>;

function Label({ has }: { has: boolean }) {
  const { pending } = useFormStatus();
  return <span className={`btn sm ${!pending && !has ? "primary" : ""}`} aria-busy={pending}>{pending ? "กำลังอัปโหลด…" : has ? "อัปโหลดไฟล์แทน" : "อัปโหลดเสียง"}</span>;
}

function alertBig(size: number) {
  window.alert(`ไฟล์ใหญ่ ${(size / 1024 / 1024).toFixed(1)} MB เกินขีดจำกัด 4 MB · ส่งออกจาก Botnoi เป็น mp3 แทน`);
}

/** ปุ่มอัปโหลดไฟล์เสียง: เลือกไฟล์แล้วส่งทันที */
export function AudioUpload({ action, fields, has }: { action: Action; fields: Record<string, string>; has: boolean }) {
  const [msg, run] = useActionState(action, null);
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={run} className="upl">
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <label className="upl-btn">
        <input
          type="file"
          name="file"
          accept="audio/*,.mp3,.wav,.m4a,.ogg"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f && f.size > 4 * 1024 * 1024) { alertBig(f.size); e.target.value = ""; return; }
            form.current?.requestSubmit();
          }}
        />
        <Label has={has} />
      </label>
      {msg && <span className={`small ${msg === "อัปโหลดแล้ว" ? "ok-txt" : "err-txt"}`} role="status">{msg}</span>}
    </form>
  );
}
