import { describe, expect, it } from 'vitest';
import { applyTextEdits, flattenWorkspaceEdit, offsetAt } from './textEdits';

const r = (sl: number, sc: number, el: number, ec: number) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });
describe('textEdits', () => {
  it('maps UTF-16 positions incl. surrogate pairs and CRLF', () => {
    const t = 'a😀b\r\nxyz';
    expect(offsetAt(t, { line: 0, character: 3 })).toBe(3); // after the emoji (2 UTF-16 units)
    expect(offsetAt(t, { line: 0, character: 99 })).toBe(4); // clamps before \r
    expect(offsetAt(t, { line: 1, character: 1 })).toBe(7);
  });
  it('applies multiple edits in any order', () => {
    expect(applyTextEdits('foo bar foo', [{ range: r(0, 0, 0, 3), newText: 'baz' }, { range: r(0, 8, 0, 11), newText: 'baz' }])).toBe('baz bar baz');
    expect(applyTextEdits('x', [{ range: r(0, 1, 0, 1), newText: 'b' }, { range: r(0, 1, 0, 1), newText: 'c' }])).toBe('xbc');
  });
  it('flattens WorkspaceEdit forms', () => {
    const f = flattenWorkspaceEdit({ changes: { a: [{ range: r(0, 0, 0, 0), newText: '1' }] }, documentChanges: [{ textDocument: { uri: 'b', version: 1 }, edits: [] }, { kind: 'rename' }] });
    expect([...f.byUri.keys()]).toEqual(['a', 'b']); expect(f.unsupported).toEqual(['rename']);
  });
});
