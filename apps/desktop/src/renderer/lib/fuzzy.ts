/** Subsequence fuzzy score; higher is better, -1 means no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (!q) return 0;
  let score = 0, ti = 0, streak = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return -1;
    streak = idx === ti ? streak + 1 : 0;
    score += 1 + streak * 2 + (idx === 0 || t[idx - 1] === ' ' || t[idx - 1] === ':' ? 3 : 0);
    ti = idx + 1;
  }
  return score - t.length * 0.01;
}
