import fs from 'node:fs/promises';
import { resolveInsideReal } from './pathGuard';
import { atomicWrite } from './atomicWrite';

export function buildRegex(query: string, isRegex: boolean, caseSensitive: boolean) {
  const src = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(src, caseSensitive ? 'g' : 'gi');
}

/** Literal replacement text (no $1 expansion unless regex mode). */
export function replaceAll(text: string, re: RegExp, replacement: string, isRegex: boolean) {
  let n = 0;
  const out = text.replace(re, (...args) => {
    n++;
    if (!isRegex) return replacement;
    const groups = args.slice(1, -2) as string[];
    return replacement.replace(/\$(\d)/g, (_m, d: string) => groups[Number(d) - 1] ?? '');
  });
  return { out, n };
}

export async function applyReplace(root: string, rels: string[], query: string, isRegex: boolean, caseSensitive: boolean, replacement: string) {
  const re = buildRegex(query, isRegex, caseSensitive);
  let files = 0, replacements = 0;
  for (const rel of new Set(rels)) {
    const abs = await resolveInsideReal(root, rel);
    const text = await fs.readFile(abs, 'utf8');
    re.lastIndex = 0;
    const { out, n } = replaceAll(text, re, replacement, isRegex);
    if (n > 0) { await atomicWrite(abs, out); files++; replacements += n; }
  }
  return { files, replacements };
}
