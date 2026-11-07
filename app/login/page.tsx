"use client";
import { useActionState } from "react";
import { signIn } from "./actions";

export default function LoginPage() {
  const [error, action, pending] = useActionState(signIn, null);
  return (
    <main className="login">
      <form className="card" action={action}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="logo-light" src="/logo.png" alt="Thaolai.com" width={200} height={39} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="logo-dark" src="/logo-yellow.png" alt="Thaolai.com" width={200} height={39} />
        <div>
          <h1>ห้องโทร AI</h1>
          <p className="muted small">เข้าสู่ระบบด้วยบัญชีทีมงาน</p>
        </div>
        <div className="field">
          <label htmlFor="email">อีเมล</label>
          <input id="email" name="email" type="email" required autoComplete="email" />
        </div>
        <div className="field">
          <label htmlFor="password">รหัสผ่าน</label>
          <input id="password" name="password" type="password" required autoComplete="current-password" />
        </div>
        {error && <p className="banner err">{error}</p>}
        <button className="btn primary" disabled={pending}>{pending ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}</button>
        <p className="hint">ผู้ใช้สร้างใน Supabase → Authentication และอีเมลต้องอยู่ในตาราง team_members</p>
      </form>
    </main>
  );
}
