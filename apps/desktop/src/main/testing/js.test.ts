import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverJs, jsArgs, jsRunnerOf, parseJestJson, parseVitestJunit, planJs, runnerEntry, scanJsTests } from './js';

const data = (f: string) => fs.readFile(path.join(__dirname, '__data__', f), 'utf8');
const fixtures = path.resolve(__dirname, '../../../../../fixtures');

describe('js tests: static scan', () => {
  it('tracks describe nesting, modifiers, quotes; skips dynamic names, comments and look-alikes', () => {
    const r = scanJsTests([
      "import { describe, it } from 'vitest';",
      "describe('outer', () => {",
      "  it('a', () => { const s = '}'; });",
      '  describe.skip("inner \\"q\\"", () => {',
      '    test.only(`b`, async () => {});',
      '    it(`dyn ${x}`, () => {});',
      '  });',
      "  it.todo('c');",
      "  // it('commented', () => {});",
      "  /* test('block', () => {}) */",
      "  edit('not a test', () => {});",
      "  foo.test('member call', () => {});",
      '});',
      "test('top', () => {});",
    ].join('\n'));
    expect(r.map((t) => `${t.path.join(' > ')}@${t.line}`)).toEqual(['outer > a@3', 'outer > inner "q" > b@5', 'outer > c@8', 'top@14']);
  });
  it('discovers the fixtures with their runner; nothing without vitest/jest in package.json', async () => {
    const v = await discoverJs(path.join(fixtures, 'js-vitest'));
    expect(v.map((n) => n.id)).toEqual([
      'src/greeter.test.ts', 'src/greeter.test.ts::greet > greets by name', 'src/greeter.test.ts::greet > punctuation > uses a custom mark',
      'src/greeter.test.ts::greet > punctuation > deliberate failure', 'src/greeter.test.ts::greet > not implemented yet', 'src/greeter.test.ts::top level & "quoted" name',
    ]);
    expect(new Set(v.map((n) => n.framework))).toEqual(new Set(['vitest']));
    expect(v[2]!.label).toBe('greet › punctuation › uses a custom mark');
    expect((await discoverJs(path.join(fixtures, 'js-jest'))).every((n) => n.framework === 'jest')).toBe(true);
    expect(await discoverJs(path.join(fixtures, 'typescript-node'))).toEqual([]);
    expect(await jsRunnerOf(path.join(fixtures, 'python'))).toBeNull();
  });
});

describe('js tests: runs', () => {
  it('plans whole files and named tests as separate invocations with an exact, escaped -t pattern', () => {
    expect(planJs([])).toEqual({ files: [], tests: null });
    expect(planJs(['a.test.ts', 'b.test.ts::x > y (1+1)', 'b.test.ts::z'])).toEqual({ files: ['a.test.ts'], tests: { files: ['b.test.ts'], pattern: '^(?:x y \\(1\\+1\\)|z)$' } });
    expect(new RegExp(planJs(['f::top level & "quoted" name']).tests!.pattern).test('top level & "quoted" name')).toBe(true);
  });
  it('args: vitest junit reporter + files + -t; jest --json with path regexes that accept either separator', () => {
    expect(jsArgs('/e/vitest.mjs', 'vitest', '/t/r.xml', ['src/a.test.ts'], '^x$')).toEqual(['/e/vitest.mjs', 'run', '--reporter=default', '--reporter=junit', '--outputFile.junit=/t/r.xml', 'src/a.test.ts', '-t', '^x$']);
    const j = jsArgs('/e/jest.js', 'jest', '/t/r.json', ['src/a.test.js'], null);
    expect(j).toEqual(['/e/jest.js', '--json', '--outputFile=/t/r.json', '--testLocationInResults', '--ci', 'src[\\\\/]a\\.test\\.js']);
    expect(new RegExp(j[5]!).test('C:\\w\\src\\a.test.js') && new RegExp(j[5]!).test('/w/src/a.test.js')).toBe(true);
  });
  it('runner entry from node_modules bin; a clear message when not installed', async () => {
    expect(await runnerEntry(path.join(fixtures, 'js-vitest'), 'vitest').catch(() => null)).toSatisfy((p: string | null) => p === null || p.endsWith(path.join('vitest', 'vitest.mjs')));
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-js-'));
    await expect(runnerEntry(empty, 'jest')).rejects.toThrow(/jest is listed in package.json but is not installed/);
  });
  it('parses real vitest 3.2.7 JUnit output', async () => {
    const r = parseVitestJunit(await data('vitest.xml'));
    const by = Object.fromEntries(r.map((t) => [t.id, t]));
    expect(Object.keys(by)).toEqual([
      'src/greeter.test.ts::greet > greets by name', 'src/greeter.test.ts::greet > punctuation > uses a custom mark', 'src/greeter.test.ts::greet > punctuation > deliberate failure',
      'src/greeter.test.ts::greet > not implemented yet', 'src/greeter.test.ts::top level & "quoted" name',
    ]);
    expect(by['src/greeter.test.ts::greet > greets by name']).toMatchObject({ status: 'passed', stdout: 'greeting NOVA', framework: 'vitest' });
    expect(by['src/greeter.test.ts::greet > not implemented yet']!.status).toBe('skipped');
    const f = by['src/greeter.test.ts::greet > punctuation > deliberate failure']!;
    expect(f).toMatchObject({ status: 'failed', message: "expected 'Hello, NOVA?' to be 'Hello, NOVA!' // Object.is equality" });
    expect(f.stack).toContain('src/greeter.test.ts:');
  });
  it('parses real jest 30.5.2 --json output (todo -> skipped; file load errors become one error result)', async () => {
    const r = parseJestJson(await data('jest.json'), '/w');
    expect(r.map((t) => [t.id, t.status])).toEqual([
      ['src/greeter.test.js::greet > greets by name', 'passed'], ['src/greeter.test.js::greet > punctuation > uses a custom mark', 'passed'],
      ['src/greeter.test.js::greet > punctuation > deliberate failure', 'failed'], ['src/greeter.test.js::greet > not implemented yet', 'skipped'],
    ]);
    expect(r[2]!.message).toMatch(/expect\(received\)\.toBe\(expected\)/);
    expect(r[3]!.message).toBe('todo');
    const broken = parseJestJson(JSON.stringify({ testResults: [{ name: '/w/src/x.test.js', status: 'failed', message: 'SyntaxError: Unexpected token', assertionResults: [] }] }), '/w');
    expect(broken).toEqual([{ id: 'src/x.test.js', framework: 'jest', name: 'x.test.js', status: 'error', timeMs: null, message: 'Test file failed to run', stack: 'SyntaxError: Unexpected token', stdout: '' }]);
  });
});
