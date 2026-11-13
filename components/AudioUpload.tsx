"use client";
import { useActionState, useRef } from "react";
import { useFormStatus } from "react-dom";

type Action = (prev: string | null, formData: FormData) => Promise<string>;

function Label({ has }: { has: boolean }) {
  const { pending } = useFormStatus();
  return <span className={`btn sm ${!pending && !has ? "primary" : ""}`} aria-busy={pending}>{pending ? "กำลังอัปโหลด…" : has ? "อัปโหลดไฟล์แทน" : "อัปโหลดเสียง"}</span>;
}

/** ปุ่มอัปโหลดไฟล์เสียง: เลือกไฟล์แล้วส่งทันที */
export function AudioUpload({ action, fields, has }: { action: Action; fields: Record<string, string>; has: boolean }) {
  const [msg, run] = useActionState(action, null);
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={run} className="upl">
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <label className="upl-btn">
        <input type="file" name="file" accept="audio/*,.mp3,.wav,.m4a,.ogg" onChange={() => form.current?.requestSubmit()} />
        <Label has={has} />
      </label>
      {msg && <span className={`small ${msg === "อัปโหลดแล้ว" ? "ok-txt" : "err-txt"}`} role="status">{msg}</span>}
    </form>
  );
}
