export interface Pos { line: number; character: number }
export interface TextEdit { range: { start: Pos; end: Pos }; newText: string }

/** Offset of an LSP (0-based line, UTF-16 character) position in a JS string (JS strings are UTF-16). */
export function offsetAt(text: string, p: Pos): number {
  let line = 0, i = 0;
  while (line < p.line) { const n = text.indexOf('\n', i); if (n < 0) return text.length; i = n + 1; line++; }
  const end = text.indexOf('\n', i);
  const lineEnd = end < 0 ? text.length : (end > i && text[end - 1] === '\r' ? end - 1 : end);
  return Math.min(i + p.character, lineEnd);
}

/** Apply non-overlapping LSP edits (any order) to text. */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const withOff = edits.map((e, idx) => ({ s: offsetAt(text, e.range.start), e: offsetAt(text, e.range.end), t: e.newText, idx }));
  withOff.sort((a, b) => b.s - a.s || b.idx - a.idx);
  let out = text;
  for (const x of withOff) out = out.slice(0, x.s) + x.t + out.slice(x.e);
  return out;
}

export interface WorkspaceEditLike {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: ({ textDocument: { uri: string; version?: number | null }; edits: TextEdit[] } | { kind: string })[];
}
/** Flatten a WorkspaceEdit into per-URI edit lists; reports unsupported resource operations. */
export function flattenWorkspaceEdit(we: WorkspaceEditLike): { byUri: Map<string, TextEdit[]>; unsupported: string[] } {
  const byUri = new Map<string, TextEdit[]>(); const unsupported: string[] = [];
  for (const [u, es] of Object.entries(we.changes ?? {})) byUri.set(u, [...(byUri.get(u) ?? []), ...es]);
  for (const dc of we.documentChanges ?? []) {
    if ('textDocument' in dc) byUri.set(dc.textDocument.uri, [...(byUri.get(dc.textDocument.uri) ?? []), ...dc.edits]);
    else unsupported.push(dc.kind);
  }
  return { byUri, unsupported };
}
