"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Nav } from "./Nav";

/** แถบเมนูซ้าย · บนมือถือย่อเป็นแถบบน + ปุ่มเมนู (กดแล้วกางรายการ) */
export function SideShell({ email, signOut }: { email: string | null; signOut: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]); // เปลี่ยนหน้าแล้วหุบเมนู
  return (
    <aside className={`side ${open ? "open" : ""}`}>
      <div className="side-top">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="logo-light" src="/logo.png" alt="Thaolai.com" width={156} height={30} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="logo-dark" src="/logo-yellow.png" alt="Thaolai.com" width={156} height={30} />
          <b>ห้องโทร AI</b>
        </div>
        <button type="button" className="burger" aria-expanded={open} aria-controls="side-menu" aria-label={open ? "ปิดเมนู" : "เปิดเมนู"} onClick={() => setOpen(!open)}>
          <span aria-hidden="true">{open ? "✕" : "☰"}</span>
        </button>
      </div>
      <div id="side-menu" className="side-menu">
        <Nav />
        <div className="side-foot">
          <span>{email}</span>
          <form action={signOut}>
            <button type="submit">ออกจากระบบ</button>
          </form>
        </div>
      </div>
    </aside>
  );
}
