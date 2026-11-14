"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { finishStepUpload, prepareStepUpload } from "@/app/(app)/script/actions";

/** อัปโหลดไฟล์เสียงบทโทรตรงไป Storage (ไฟล์ใหญ่ได้ ไม่ทำให้หน้าขาว) */
export function StepUpload({ step, has }: { step: string; has: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const upload = (file: File) =>
    start(async () => {
      setMsg(null);
      try {
        const p = await prepareStepUpload(step, file.name, file.size);
        if (p.error || !p.url || !p.path) return setMsg({ ok: false, text: p.error ?? "อัปโหลดไม่สำเร็จ" });
        const res = await fetch(p.url, { method: "PUT", headers: { "Content-Type": file.type || "audio/mpeg", "x-upsert": "true" }, body: file });
        if (!res.ok) return setMsg({ ok: false, text: `อัปโหลดไม่สำเร็จ (${res.status}) ${(await res.text().catch(() => "")).slice(0, 120)}` });
        const done = await finishStepUpload(step, p.path, file.name, file.size);
        setMsg({ ok: done === "อัปโหลดแล้ว", text: done });
        router.refresh();
      } catch (e) {
        setMsg({ ok: false, text: `อัปโหลดไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}` });
      }
    });

  return (
    <span className="upl">
      <button type="button" className={`btn sm ${!pending && !has ? "primary" : ""}`} disabled={pending} aria-busy={pending} onClick={() => ref.current?.click()}>
        {pending ? "กำลังอัปโหลด…" : has ? "อัปโหลดไฟล์แทน" : "อัปโหลดเสียง"}
      </button>
      <input
        ref={ref}
        type="file"
        hidden
        accept="audio/*,.mp3,.wav,.m4a,.ogg,.aac,.flac"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) upload(f);
        }}
      />
      {msg && <span className={`small ${msg.ok ? "ok-txt" : "err-txt"}`} role="status">{msg.text}</span>}
    </span>
  );
}
