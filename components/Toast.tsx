"use client";
import { useEffect, useState } from "react";

type T = { id: number; ok: boolean; text: string };

/** แสดงป็อปอัพแจ้งผล: เรียก toast("ข้อความ") หรือแนบ ?saved=1 / ?err=... มากับ URL */
export function toast(text: string, ok = true) {
  window.dispatchEvent(new CustomEvent("app-toast", { detail: { text, ok } }));
}

export function Toaster() {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    const push = (text: string, ok: boolean) => {
      if (!ok) (window as any).__toastErrAt = Date.now();
      const id = Date.now() + Math.random();
      setItems((x) => [...x, { id, ok, text }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), ok ? 2500 : 6000);
    };
    const onEvent = (e: Event) => { const d = (e as CustomEvent).detail; push(d.text, d.ok !== false); };
    window.addEventListener("app-toast", onEvent);
    // ผลจากการบันทึกที่ส่งกลับมาทาง URL
    const check = () => {
      const u = new URL(window.location.href);
      const err = u.searchParams.get("err");
      const saved = u.searchParams.get("saved");
      if (!err && !saved) return;
      push(err ?? "บันทึกสำเร็จ", !err);
      u.searchParams.delete("err");
      u.searchParams.delete("saved");
      window.history.replaceState(null, "", u.pathname + (u.search ? u.search : "") + u.hash);
    };
    check();
    const t = setInterval(check, 500);
    return () => { window.removeEventListener("app-toast", onEvent); clearInterval(t); };
  }, []);
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.ok ? "ok" : "bad"}`} role="status">
          <span aria-hidden="true">{t.ok ? "✓" : "!"}</span>
          {t.text}
        </div>
      ))}
    </div>
  );
}
