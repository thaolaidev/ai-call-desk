"use client";
import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { toast } from "./Toast";

/** ปุ่มบันทึก: ระหว่างส่งขึ้น "กำลังบันทึก…" ส่งเสร็จขึ้นป็อปอัพ "บันทึกสำเร็จ" */
export function SaveButton({ label = "บันทึก", done = "บันทึกสำเร็จ", className = "btn sm primary", formAction }: {
  label?: string; done?: string; className?: string; formAction?: (fd: FormData) => void | Promise<void>;
}) {
  const { pending, action } = useFormStatus();
  const mine = useRef(false);
  const was = useRef(false);
  useEffect(() => {
    // แจ้งเฉพาะปุ่มที่ถูกกด (ฟอร์มเดียวกันอาจมีหลายปุ่ม)
    if (was.current && !pending && mine.current) {
      mine.current = false;
      // รอให้ข้อความ error (ถ้ามี) ขึ้นก่อน ถ้ามี error ไม่ต้องแจ้งสำเร็จ
      setTimeout(() => {
        const errAt = (window as any).__toastErrAt ?? 0;
        if (Date.now() - errAt > 2000 && !window.location.search.includes("err=")) toast(done);
      }, 700);
    }
    was.current = pending;
  }, [pending, action, done]);
  return (
    <button className={className} disabled={pending} aria-busy={pending} formAction={formAction} onClick={() => { mine.current = true; }}>
      {pending && mine.current ? "กำลังบันทึก…" : label}
    </button>
  );
}
