"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * รีเฟรชข้อมูลหน้าเป็นระยะ ถ้า ping=true จะสั่งตัวยิงสายทำงานด้วย
 * (เผื่อยังไม่ได้ตั้ง Cron ทุกนาที แคมเปญก็เดินได้ตราบที่เปิดหน้านี้อยู่)
 */
export function AutoRefresh({ ms = 5000, ping = false }: { ms?: number; ping?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(async () => {
      if (document.hidden) return;
      if (ping) await fetch("/api/dialer/tick", { method: "POST" }).catch(() => {});
      router.refresh();
    }, ms);
    return () => clearInterval(id);
  }, [ms, ping, router]);
  return null;
}
