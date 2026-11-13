"use client";
import { useFormStatus } from "react-dom";

export function PullButton({ label = "ดึงลีดจากเว็บ", busy = "กำลังดึง…" }: { label?: string; busy?: string }) {
  const { pending } = useFormStatus();
  return <button className="btn" disabled={pending} aria-busy={pending}>{pending ? busy : label}</button>;
}
