import { STATUS } from "@/lib/status";

export function Pill({ status }: { status: string | null | undefined }) {
  const s = STATUS[status ?? "pending"] ?? { label: status ?? "-", tone: "idle" };
  return <span className={`pill t-${s.tone}`}>{s.label}</span>;
}
