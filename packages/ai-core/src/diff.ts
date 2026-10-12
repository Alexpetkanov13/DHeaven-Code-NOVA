/** Line diff → hunks with per-hunk accept/reject. Pure; used by main tests and the renderer. */
export interface Hunk { id: number; oldStart: number; oldLines: string[]; newLines: string[]; contextBefore: string[]; contextAfter: string[] }

const split = (s: string) => (s === '' ? [] : s.replace(/\r\n/g, '\n').split('\n'));

/** Myers-free LCS diff (O(n·m), inputs are capped by the caller). */
export function diffHunks(oldText: string, newText: string, context = 2): Hunk[] {
  const a = split(oldText), b = split(newText);
  if (a.length * b.length > 4_000_000) throw new Error('Edit too large to diff');
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const hunks: Hunk[] = [];
  let i = 0, j = 0, cur: Hunk | null = null;
  const flush = () => { if (cur) { cur.contextAfter = a.slice(i, i + context); hunks.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; continue; }
    if (!cur) cur = { id: hunks.length, oldStart: i, oldLines: [], newLines: [], contextBefore: a.slice(Math.max(0, i - context), i), contextAfter: [] };
    if (j < m && (i >= n || L[i]![j + 1]! >= L[i + 1]![j]!)) cur.newLines.push(b[j++]!);
    else cur.oldLines.push(a[i++]!);
  }
  flush();
  return hunks;
}

/** Applies only the accepted hunks to the old text. */
export function applyHunks(oldText: string, hunks: Hunk[], accepted: ReadonlySet<number>): string {
  const a = split(oldText);
  const out: string[] = [];
  let pos = 0;
  for (const h of [...hunks].sort((x, y) => x.oldStart - y.oldStart)) {
    out.push(...a.slice(pos, h.oldStart));
    out.push(...(accepted.has(h.id) ? h.newLines : h.oldLines));
    pos = h.oldStart + h.oldLines.length;
  }
  out.push(...a.slice(pos));
  return out.join('\n');
}
