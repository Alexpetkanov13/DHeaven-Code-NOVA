/** Editor groups layout (pure; the App holds it in state). Groups are laid out in one direction. */
export interface Group { id: number; rels: string[]; active: string | null }
export interface Layout { dir: 'row' | 'column'; groups: Group[]; activeGroup: number }
export const MAX_GROUPS = 4;

let nextId = 1;
const gid = () => nextId++;
export const emptyLayout = (): Layout => ({ dir: 'row', groups: [{ id: gid(), rels: [], active: null }], activeGroup: 0 });

const upd = (l: Layout, gi: number, f: (g: Group) => Group): Layout => ({ ...l, groups: l.groups.map((g, i) => (i === gi ? f(g) : g)) });

/** Show rel in group gi (adds a tab if needed) and focus that group. */
export function openIn(l: Layout, gi: number, rel: string): Layout {
  const i = Math.min(Math.max(0, gi), l.groups.length - 1);
  return { ...upd(l, i, (g) => ({ ...g, rels: g.rels.includes(rel) ? g.rels : [...g.rels, rel], active: rel })), activeGroup: i };
}

/** Remove rel from group gi; an emptied group (other than the last remaining) is removed. */
export function closeIn(l: Layout, gi: number, rel: string): Layout {
  const g = l.groups[gi]; if (!g || !g.rels.includes(rel)) return l;
  const idx = g.rels.indexOf(rel);
  const rels = g.rels.filter((r) => r !== rel);
  const active = g.active === rel ? (rels[Math.min(idx, rels.length - 1)] ?? null) : g.active;
  if (!rels.length && l.groups.length > 1) {
    const groups = l.groups.filter((_, i) => i !== gi);
    return { ...l, groups, activeGroup: Math.min(l.activeGroup > gi ? l.activeGroup - 1 : l.activeGroup, groups.length - 1) };
  }
  return upd(l, gi, (x) => ({ ...x, rels, active }));
}

/** Split group gi in a direction, showing its active file in the new group (to the right / below). */
export function split(l: Layout, gi: number, dir: 'row' | 'column'): Layout {
  const g = l.groups[gi]; if (!g || l.groups.length >= MAX_GROUPS) return { ...l, dir: l.groups.length === 1 ? dir : l.dir };
  const n: Group = { id: gid(), rels: g.active ? [g.active] : [], active: g.active };
  const groups = [...l.groups.slice(0, gi + 1), n, ...l.groups.slice(gi + 1)];
  return { dir: l.groups.length === 1 ? dir : l.dir, groups, activeGroup: gi + 1 };
}

/** Drag a tab: move (or copy) rel from group `from` to group `to` at position `at` (default end). */
export function moveTab(l: Layout, from: number, to: number, rel: string, copy = false, at?: number): Layout {
  if (!l.groups[from]?.rels.includes(rel) || !l.groups[to]) return l;
  if (from === to) {
    const rels = l.groups[to].rels.filter((r) => r !== rel);
    const pos = Math.min(at ?? rels.length, rels.length);
    return { ...upd(l, to, (g) => ({ ...g, rels: [...rels.slice(0, pos), rel, ...rels.slice(pos)], active: rel })), activeGroup: to };
  }
  const toId = l.groups[to].id;
  let r: Layout = upd(l, to, (g) => {
    const rels = g.rels.filter((x) => x !== rel); const pos = Math.min(at ?? rels.length, rels.length);
    return { ...g, rels: [...rels.slice(0, pos), rel, ...rels.slice(pos)], active: rel };
  });
  if (!copy) r = closeIn(r, from, rel);
  return { ...r, activeGroup: Math.max(0, r.groups.findIndex((g) => g.id === toId)) };
}

/** Drop rels that are no longer open, rename moved files, remove empty extra groups. */
export function reconcile(l: Layout, open: Set<string>, rename?: (rel: string) => string): Layout {
  let groups = l.groups.map((g) => {
    const rels = [...new Set(g.rels.map((r) => (rename ? rename(r) : r)))].filter((r) => open.has(r));
    const a = g.active && rename ? rename(g.active) : g.active;
    return { ...g, rels, active: a && rels.includes(a) ? a : (rels.at(-1) ?? null) };
  });
  const focusedId = l.groups[l.activeGroup]?.id;
  if (groups.length > 1) groups = groups.filter((g) => g.rels.length > 0);
  if (!groups.length) groups = [{ ...l.groups[0]!, rels: [], active: null }];
  const changed = groups.length !== l.groups.length || groups.some((g, i) => g.active !== l.groups[i]!.active || g.rels.join('\0') !== l.groups[i]!.rels.join('\0'));
  if (!changed) return l;
  const ag = groups.findIndex((g) => g.id === focusedId);
  return { ...l, groups, activeGroup: ag >= 0 ? ag : Math.min(l.activeGroup, groups.length - 1) };
}

export interface SavedLayout { dir: 'row' | 'column'; groups: { rels: string[]; active: string | null }[]; activeGroup: number }
export const toSaved = (l: Layout): SavedLayout => ({ dir: l.dir, activeGroup: l.activeGroup, groups: l.groups.map((g) => ({ rels: g.rels, active: g.active })) });
export function fromSaved(v: unknown): Layout | null {
  const s = v as SavedLayout | null;
  if (!s || (s.dir !== 'row' && s.dir !== 'column') || !Array.isArray(s.groups) || !s.groups.length) return null;
  const groups = s.groups.slice(0, MAX_GROUPS).map((g) => {
    const rels = Array.isArray(g?.rels) ? g.rels.filter((r): r is string => typeof r === 'string') : [];
    return { id: gid(), rels, active: typeof g?.active === 'string' && rels.includes(g.active) ? g.active : (rels[0] ?? null) };
  });
  return { dir: s.dir, groups, activeGroup: Math.min(Math.max(0, Number(s.activeGroup) || 0), groups.length - 1) };
}
