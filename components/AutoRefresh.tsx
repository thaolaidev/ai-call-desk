"use client";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * รีเฟรชข้อมูลหน้าเป็นระยะ ถ้า ping=true จะสั่งตัวยิงสายทำงานด้วย
 * ไม่ยิงซ้อน: ถ้ารอบก่อนยังไม่เสร็จ รอบใหม่จะข้ามไป · หยุดเมื่อแท็บไม่ได้เปิดอยู่
 */
export function AutoRefresh({ ms = 5000, ping = false }: { ms?: number; ping?: boolean }) {
  const router = useRouter();
  const busy = useRef(false);
  useEffect(() => {
    const id = setInterval(async () => {
      if (document.hidden || busy.current) return;
      busy.current = true;
      try {
        if (ping) await fetch("/api/dialer/tick", { method: "POST" }).catch(() => {});
        router.refresh();
      } finally {
        busy.current = false;
      }
    }, ms);
    return () => clearInterval(id);
  }, [ms, ping, router]);
  return null;
}
