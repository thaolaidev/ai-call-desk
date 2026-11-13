"use client";
import { useFormStatus } from "react-dom";

export function PullButton() {
  const { pending } = useFormStatus();
  return <button className="btn" disabled={pending} aria-busy={pending}>{pending ? "กำลังดึง…" : "ดึงลีดจากเว็บ"}</button>;
}
