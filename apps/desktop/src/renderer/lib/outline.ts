/** Editor-agnostic document outline used by Go to Symbol and breadcrumbs. Lines/columns are 1-based. */
export interface Sym { name: string; kind: string; line: number; col: number; endLine: number; children: Sym[] }

const LSP_KIND: Record<number, string> = { 2: 'module', 3: 'namespace', 4: 'package', 5: 'class', 6: 'method', 7: 'property', 8: 'field', 9: 'constructor', 10: 'enum', 11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 22: 'enumMember', 23: 'struct' };
type LspRange = { start: { line: number; character: number }; end: { line: number; character: number } };
type LspSym = { name: string; kind: number; range?: LspRange; selectionRange?: LspRange; location?: { range: LspRange }; children?: LspSym[] };

/** Accepts both DocumentSymbol[] (hierarchical) and SymbolInformation[] (flat) results. */
export function fromLsp(r: unknown): Sym[] {
  if (!Array.isArray(r)) return [];
  const conv = (s: LspSym): Sym => {
    const range = s.range ?? s.location?.range;
    const sel = s.selectionRange ?? range;
    return { name: s.name, kind: LSP_KIND[s.kind] ?? 'symbol', line: (sel?.start.line ?? 0) + 1, col: (sel?.start.character ?? 0) + 1, endLine: (range?.end.line ?? sel?.start.line ?? 0) + 1, children: (s.children ?? []).map(conv) };
  };
  return sortSyms((r as LspSym[]).map(conv));
}

type NavTree = { text: string; kind: string; spans: { start: number; length: number }[]; childItems?: NavTree[] };
/** TypeScript worker navigation tree → Sym[] (root "<global>" node is unwrapped). */
export function fromTsNavTree(tree: NavTree | undefined, offsetToPos: (o: number) => { lineNumber: number; column: number }): Sym[] {
  if (!tree) return [];
  const conv = (n: NavTree): Sym => {
    const sp = n.spans[0] ?? { start: 0, length: 0 };
    const a = offsetToPos(sp.start), b = offsetToPos(sp.start + sp.length);
    return { name: n.text, kind: n.kind, line: a.lineNumber, col: a.column, endLine: b.lineNumber, children: (n.childItems ?? []).filter((c) => c.kind !== 'alias').map(conv) };
  };
  return sortSyms((tree.childItems ?? []).filter((c) => c.kind !== 'alias').map(conv));
}

function sortSyms(s: Sym[]): Sym[] { for (const x of s) sortSyms(x.children); return s.sort((a, b) => a.line - b.line || a.col - b.col); }

/** Depth-first flat list with the container path, for the Go to Symbol picker. */
export function flatten(syms: Sym[], parent = ''): { sym: Sym; container: string }[] {
  return syms.flatMap((s) => [{ sym: s, container: parent }, ...flatten(s.children, parent ? `${parent}.${s.name}` : s.name)]);
}

/** Innermost chain of symbols whose range contains the line (breadcrumbs). */
export function symbolPathAt(syms: Sym[], line: number): Sym[] {
  const hit = syms.find((s) => s.line <= line && line <= s.endLine);
  return hit ? [hit, ...symbolPathAt(hit.children, line)] : [];
}
