"use client";
import { useActionState, useRef } from "react";
import { useFormStatus } from "react-dom";
import { uploadStepAudio } from "@/app/(app)/script/actions";

function Label({ has }: { has: boolean }) {
  const { pending } = useFormStatus();
  return <span className={`btn sm ${pending ? "" : has ? "" : "primary"}`} aria-busy={pending}>{pending ? "กำลังอัปโหลด…" : has ? "เปลี่ยนไฟล์" : "อัปโหลดเสียง"}</span>;
}

export function AudioUpload({ step, has }: { step: string; has: boolean }) {
  const [msg, action] = useActionState(uploadStepAudio, null);
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={action} className="upl">
      <input type="hidden" name="step" value={step} />
      <label className="upl-btn">
        <input type="file" name="file" accept="audio/*,.mp3,.wav,.m4a,.ogg" onChange={() => form.current?.requestSubmit()} />
        <Label has={has} />
      </label>
      {msg && <span className={`small ${msg === "อัปโหลดแล้ว" ? "ok-txt" : "err-txt"}`} role="status">{msg}</span>}
    </form>
  );
}
