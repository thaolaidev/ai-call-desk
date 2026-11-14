"use client";

/** แสดงข้อความแทนหน้าขาว เมื่อหน้าใดหน้าหนึ่งเกิดข้อผิดพลาด */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="view">
      <div className="card">
        <div className="card-h"><h2>หน้านี้เกิดข้อผิดพลาด</h2></div>
        <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p className="banner err">{error.message || "ไม่ทราบสาเหตุ"}{error.digest ? ` (รหัส ${error.digest})` : ""}</p>
          <p className="hint">ลองกดโหลดใหม่ ถ้ายังเป็นอยู่ ก๊อปข้อความด้านบนส่งให้ทีมดู</p>
          <div><button className="btn primary" onClick={() => reset()}>ลองใหม่</button></div>
        </div>
      </div>
    </div>
  );
}
