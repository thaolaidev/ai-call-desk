"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "แดชบอร์ด" },
  { href: "/leads", label: "กองลีด" },
  { href: "/calling", label: "ห้องโทร" },
  { href: "/results", label: "ผลการโทร" },
  { href: "/settings", label: "ตั้งค่าระบบ" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="เมนูหลัก">
      {ITEMS.map((i) => {
        const on = i.href === "/" ? path === "/" : path.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} className={on ? "on" : ""} aria-current={on ? "page" : undefined}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
