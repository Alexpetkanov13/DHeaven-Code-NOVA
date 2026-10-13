import { describe, expect, it } from 'vitest';
import { flatten, fromLsp, fromTsNavTree, symbolPathAt } from './outline';
import { NavHistory } from './navHistory';

const r = (a: number, b: number) => ({ start: { line: a, character: 0 }, end: { line: b, character: 1 } });
describe('outline', () => {
  it('converts hierarchical LSP symbols and finds the breadcrumb path', () => {
    const syms = fromLsp([{ name: 'App', kind: 5, range: r(0, 20), selectionRange: r(0, 0), children: [{ name: 'main', kind: 6, range: r(10, 15), selectionRange: r(10, 10) }, { name: 'greet', kind: 6, range: r(2, 5), selectionRange: r(2, 2) }] }]);
    expect(syms[0]!.children.map((c) => c.name)).toEqual(['greet', 'main']); // sorted by position
    expect(symbolPathAt(syms, 12).map((s) => s.name)).toEqual(['App', 'main']);
    expect(symbolPathAt(syms, 30)).toEqual([]);
    expect(flatten(syms).map((f) => `${f.container}|${f.sym.name}|${f.sym.kind}`)).toEqual(['|App|class', 'App|greet|method', 'App|main|method']);
  });
  it('accepts flat SymbolInformation', () => {
    expect(fromLsp([{ name: 'x', kind: 13, location: { uri: 'file:///a', range: r(3, 3) } }])[0]).toMatchObject({ name: 'x', kind: 'variable', line: 4, endLine: 4 });
    expect(fromLsp(null)).toEqual([]);
  });
  it('converts a TypeScript navigation tree', () => {
    const text = 'function a() {}\nclass B { m() {} }\n';
    const pos = (o: number) => { const pre = text.slice(0, o).split('\n'); return { lineNumber: pre.length, column: pre[pre.length - 1]!.length + 1 }; };
    const s = fromTsNavTree({ text: '<global>', kind: 'script', spans: [], childItems: [
      { text: 'B', kind: 'class', spans: [{ start: 16, length: 18 }], childItems: [{ text: 'm', kind: 'method', spans: [{ start: 26, length: 6 }] }] },
      { text: 'a', kind: 'function', spans: [{ start: 0, length: 15 }] }] }, pos);
    expect(s.map((x) => [x.name, x.line])).toEqual([['a', 1], ['B', 2]]);
    expect(symbolPathAt(s, 2).map((x) => x.name)).toEqual(['B', 'm']);
  });
});

describe('NavHistory', () => {
  it('goes back and forward, collapsing nearby moves and truncating forward on new push', () => {
    const h = new NavHistory(50, 10);
    h.push({ rel: 'a', line: 1, col: 1 });
    expect(h.push({ rel: 'a', line: 5, col: 1 })).toBe(false);
    h.push({ rel: 'a', line: 40, col: 1 });
    h.push({ rel: 'b', line: 1, col: 1 });
    expect(h.back()).toMatchObject({ rel: 'a', line: 40 });
    expect(h.back()).toMatchObject({ rel: 'a', line: 5 });
    expect(h.back()).toBeNull();
    expect(h.forward()).toMatchObject({ line: 40 });
    h.push({ rel: 'c', line: 1, col: 1 });
    expect(h.canForward()).toBe(false);
    h.forget('c');
    expect(h.canForward()).toBe(false);
    expect(h.back()).toMatchObject({ rel: 'a', line: 5 });
  });
  it('caps size', () => {
    const h = new NavHistory(3, 0);
    for (let i = 0; i < 10; i++) h.push({ rel: `f${i}`, line: 1, col: 1 });
    expect(h.back()?.rel).toBe('f8'); expect(h.back()?.rel).toBe('f7'); expect(h.back()).toBeNull();
  });
});
