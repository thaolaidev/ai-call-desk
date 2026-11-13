import type { SupabaseClient } from "@supabase/supabase-js";

/** 1 แถวในคลังชื่อคอนโด: จับคู่ด้วย condo_id ก่อน ถ้าไม่มีค่อยใช้ชื่อ */
export type Entry = { key: string; condo: string; condo_id: string | null; n: number; a: any | null };

/** ลีดทั้งหมด จัดกลุ่มตามโครงการ */
async function leadGroups(db: SupabaseClient) {
  const groups = new Map<string, { condo: string; condo_id: string | null; n: number }>();
  let cols = "condo, condo_id";
  for (let from = 0; from < 50_000; from += 1000) {
    let { data, error } = await db.from("leads").select(cols).order("id").range(from, from + 999);
    if (error && cols.includes("condo_id")) { cols = "condo"; ({ data, error } = await db.from("leads").select(cols).order("id").range(from, from + 999)); }
    for (const r of (data ?? []) as any[]) {
      if (!r.condo) continue;
      const id = r.condo_id ? String(r.condo_id) : null;
      const key = id ? `id:${id}` : `name:${r.condo}`;
      const g = groups.get(key);
      if (g) g.n++;
      else groups.set(key, { condo: r.condo, condo_id: id, n: 1 });
    }
    if ((data?.length ?? 0) < 1000) break;
  }
  return groups;
}

export async function buildLibrary(db: SupabaseClient): Promise<Entry[]> {
  const [groups, { data: rows }] = await Promise.all([leadGroups(db), db.from("condo_audio").select("*")]);
  const byId = new Map<string, any>();
  const byName = new Map<string, any>();
  for (const a of rows ?? []) {
    if (a.condo_id) byId.set(String(a.condo_id), a);
    byName.set(a.condo, a);
  }
  const used = new Set<string>();
  const out: Entry[] = [];
  for (const [key, g] of groups) {
    const a = (g.condo_id && byId.get(g.condo_id)) || byName.get(g.condo) || null;
    if (a) used.add(a.condo);
    out.push({ key, condo: a?.condo ?? g.condo, condo_id: g.condo_id ?? a?.condo_id ?? null, n: g.n, a });
  }
  // คอนโดที่นำเข้าจากชีทแต่ยังไม่มีลีด
  for (const a of rows ?? []) if (!used.has(a.condo)) out.push({ key: a.condo_id ? `id:${a.condo_id}` : `name:${a.condo}`, condo: a.condo, condo_id: a.condo_id ?? null, n: 0, a });
  return out;
}

/** ตอนโทร: หาเสียงชื่อคอนโดของลีด */
export async function findCondoAudio(db: SupabaseClient, lead: { condo: string; condo_id?: string | null }) {
  if (lead.condo_id) {
    const { data } = await db.from("condo_audio").select("*").eq("condo_id", lead.condo_id).maybeSingle();
    if (data) return data;
  }
  const { data } = await db.from("condo_audio").select("*").eq("condo", lead.condo).maybeSingle();
  return data;
}
