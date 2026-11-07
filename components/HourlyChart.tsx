type Row = { h: number; ok: number; fail: number };

/** แท่งซ้อน: ติดต่อได้ / ไม่สำเร็จ ต่อชั่วโมง (09:00–19:00) */
export function HourlyChart({ rows, currentHour }: { rows: Row[]; currentHour: number }) {
  const hrs = Array.from({ length: 11 }, (_, i) => {
    const r = rows.find((x) => Number(x.h) === 9 + i);
    return { h: 9 + i, ok: Number(r?.ok ?? 0), fail: Number(r?.fail ?? 0) };
  });
  const mx = Math.max(10, ...hrs.map((b) => b.ok + b.fail));
  const top = Math.ceil(mx / 20) * 20;
  const W = 640, H = 230, L = 34, B = 28, T = 16, R = 6, bw = (W - L - R) / hrs.length;
  const y = (v: number) => H - B - (v / top) * (H - B - T);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="จำนวนสายรายชั่วโมงวันนี้">
      {[0, 1, 2, 3, 4].map((k) => {
        const v = (top * k) / 4;
        return (
          <g key={k}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} style={{ stroke: "var(--line)" }} strokeDasharray={k ? "3 4" : undefined} />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" style={{ fill: "var(--muted)", font: "11px var(--f-mono)" }}>{v}</text>
          </g>
        );
      })}
      {hrs.map((b, i) => {
        const x = L + i * bw + bw * 0.2, w = bw * 0.6, tot = b.ok + b.fail, cur = b.h === currentHour;
        return (
          <g key={b.h}>
            {tot > 0 && (
              <>
                <rect x={x} y={y(b.ok)} width={w} height={y(0) - y(b.ok)} rx={2} style={{ fill: "var(--ok)" }} />
                <rect x={x} y={y(tot)} width={w} height={y(b.ok) - y(tot)} rx={2} style={{ fill: "var(--idle)", opacity: 0.55 }} />
                <text x={x + w / 2} y={y(tot) - 5} textAnchor="middle" style={{ fill: "var(--ink)", font: "500 11px var(--f-mono)" }}>{tot}</text>
              </>
            )}
            <text x={x + w / 2} y={H - 9} textAnchor="middle" style={{ fill: cur ? "var(--accent)" : "var(--muted)", font: `${cur ? "600 " : ""}11px var(--f-mono)` }}>
              {String(b.h).padStart(2, "0")}:00
            </text>
          </g>
        );
      })}
    </svg>
  );
}
