"use client";
import { useState } from "react";

export function CopyButton({ text, label = "คัดลอก" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {}
      }}
    >
      {done ? "คัดลอกแล้ว" : label}
    </button>
  );
}
