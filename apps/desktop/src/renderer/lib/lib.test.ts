import { describe, expect, it } from 'vitest';
import { flatten, visibleRange } from './tree';
import { fuzzyScore } from './fuzzy';

describe('tree', () => {
  it('flattens only expanded dirs', () => {
    const c = new Map([
      ['', [{ name: 'src', rel: 'src', kind: 'dir' as const }, { name: 'a', rel: 'a', kind: 'file' as const }]],
      ['src', [{ name: 'b', rel: 'src/b', kind: 'file' as const }]],
    ]);
    expect(flatten(c, new Set()).map((r) => r.entry.rel)).toEqual(['src', 'a']);
    expect(flatten(c, new Set(['src'])).map((r) => [r.entry.rel, r.depth])).toEqual([['src', 0], ['src/b', 1], ['a', 0]]);
  });
  it('computes bounded virtual window', () => {
    expect(visibleRange(0, 220, 22, 100000, 0)).toEqual({ start: 0, end: 10 });
    expect(visibleRange(22000, 220, 22, 100000, 5)).toEqual({ start: 995, end: 1015 });
  });
});
describe('fuzzy', () => {
  it('matches subsequences and ranks prefixes higher', () => {
    expect(fuzzyScore('sv', 'File: Save')).toBeGreaterThan(0);
    expect(fuzzyScore('xyz', 'File: Save')).toBe(-1);
    expect(fuzzyScore('save', 'File: Save')).toBeGreaterThan(fuzzyScore('save', 'File: Save As…') - 1);
  });
});
import { uriToRel, joinAbs } from './paths';
describe('paths', () => {
  it('maps fs paths to workspace-relative paths', () => {
    expect(uriToRel('/w/p/src/A.java', '/w/p')).toBe('src/A.java');
    expect(uriToRel('/w/p2/x', '/w/p')).toBeNull();
    expect(uriToRel('c:\\Work\\P\\a.kt', 'C:\\work\\p')).toBe('a.kt');
    expect(joinAbs('/w/p/', 'a/b')).toBe('/w/p/a/b');
  });
});
