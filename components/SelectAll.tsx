"use client";

/** ติ๊กเลือก/ยกเลิกทุกช่อง name="ids" ในฟอร์มเดียวกัน */
export function SelectAll() {
  return (
    <input
      type="checkbox"
      aria-label="เลือกทั้งหมด"
      onChange={(e) => {
        e.currentTarget.form
          ?.querySelectorAll<HTMLInputElement>('input[name="ids"]:not(:disabled)')
          .forEach((c) => (c.checked = e.currentTarget.checked));
      }}
    />
  );
}
