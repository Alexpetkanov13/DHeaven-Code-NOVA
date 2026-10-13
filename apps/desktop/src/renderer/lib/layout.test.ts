import { describe, expect, it } from 'vitest';
import { closeIn, emptyLayout, fromSaved, moveTab, openIn, reconcile, split, toSaved, MAX_GROUPS } from './layout';

const rels = (l: ReturnType<typeof emptyLayout>) => l.groups.map((g) => `${g.rels.join(',')}|${g.active}`);
describe('editor layout', () => {
  it('opens, splits, moves and closes tabs across groups', () => {
    let l = openIn(openIn(emptyLayout(), 0, 'a'), 0, 'b');
    expect(rels(l)).toEqual(['a,b|b']);
    l = split(l, 0, 'row');
    expect(l.dir).toBe('row'); expect(rels(l)).toEqual(['a,b|b', 'b|b']); expect(l.activeGroup).toBe(1);
    l = moveTab(l, 0, 1, 'a', false, 0);
    expect(rels(l)).toEqual(['b|b', 'a,b|a']); expect(l.activeGroup).toBe(1);
    l = closeIn(l, 0, 'b'); // group 0 emptied -> removed
    expect(rels(l)).toEqual(['a,b|a']); expect(l.activeGroup).toBe(0);
    l = closeIn(l, 0, 'a');
    expect(rels(l)).toEqual(['b|b']);
    l = closeIn(l, 0, 'b'); // last group stays
    expect(rels(l)).toEqual(['|null']);
  });
  it('copy-drag keeps the source; reorder within a group', () => {
    let l = split(openIn(openIn(emptyLayout(), 0, 'a'), 0, 'b'), 0, 'column');
    l = moveTab(l, 0, 1, 'a', true);
    expect(rels(l)).toEqual(['a,b|b', 'b,a|a']);
    l = moveTab(l, 1, 1, 'a', false, 0);
    expect(rels(l)).toEqual(['a,b|b', 'a,b|a']);
  });
  it('limits group count and reconciles closed/renamed files', () => {
    let l = openIn(emptyLayout(), 0, 'x');
    for (let i = 0; i < 6; i++) l = split(l, 0, 'row');
    expect(l.groups.length).toBe(MAX_GROUPS);
    l = openIn(l, 1, 'old/y');
    l = reconcile(l, new Set(['x', 'new/y']), (r) => r.replace(/^old\//, 'new/'));
    expect(rels(l)).toEqual(['x|x', 'x,new/y|new/y', 'x|x', 'x|x']);
    l = reconcile(l, new Set(['new/y']));
    expect(rels(l)).toEqual(['new/y|new/y']);
    expect(reconcile(l, new Set(['new/y']))).toBe(l);
  });
  it('round-trips and validates the saved form', () => {
    const l = split(openIn(openIn(emptyLayout(), 0, 'a'), 0, 'b'), 0, 'column');
    const back = fromSaved(JSON.parse(JSON.stringify(toSaved(l))))!;
    expect(rels(back)).toEqual(rels(l)); expect(back.dir).toBe('column'); expect(back.activeGroup).toBe(1);
    expect(fromSaved({ dir: 'diag', groups: [] })).toBeNull();
    expect(rels(fromSaved({ dir: 'row', groups: [{ rels: ['a', 3], active: 'zzz' }], activeGroup: 9 })!)).toEqual(['a|a']);
  });
});
