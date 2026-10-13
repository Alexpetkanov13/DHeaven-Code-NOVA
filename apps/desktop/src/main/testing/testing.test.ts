import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverPytest, parsePytestXml, pytestArgs, pytestMissing, pythonFor, scanPytestSource } from './pytest';
import { cargoArgs, discoverCargo, modulePathOf, parseCargoOutput, scanRustTests } from './cargo';
import { discoverAllTests, frameworksOf } from '.';

const data = (f: string) => fs.readFile(path.join(__dirname, '__data__', f), 'utf8');
const fixtures = path.resolve(__dirname, '../../../../../fixtures');

describe('pytest', () => {
  it('static scan: module functions, Test* class methods, ignores helpers, nested defs and non-Test classes', () => {
    const r = scanPytestSource([
      'import pytest', '', '@pytest.mark.parametrize("x", [1])', 'def test_a(x):', '    def test_inner(): pass', '', 'def helper(): pass',
      'async def test_async(): pass', '', 'class TestThing:', '    def test_m(self): pass', '    def other(self): pass', '', 'class Helper:', '    def test_not(self): pass',
    ].join('\n'));
    expect(r.functions).toEqual([{ name: 'test_a', line: 4 }, { name: 'test_async', line: 8 }]);
    expect(r.classes).toEqual([{ name: 'TestThing', line: 10, methods: [{ name: 'test_m', line: 11 }] }]);
  });
  it('discovers the fixture with pytest node ids', async () => {
    const ids = (await discoverPytest(path.join(fixtures, 'python'))).map((n) => `${n.method ? 'L' : 'G'} ${n.id}`);
    expect(ids).toEqual([
      'G tests/test_greeter.py', 'L tests/test_greeter.py::test_greets_by_name', 'L tests/test_greeter.py::test_greets_each', 'L tests/test_greeter.py::test_not_yet',
      'G tests/test_greeter.py::TestGreeter', 'L tests/test_greeter.py::TestGreeter::test_prefix', 'L tests/test_greeter.py::TestGreeter::test_deliberate_failure',
    ]);
  });
  it('parses real pytest 8 JUnit XML (xunit1) back to node ids with params, skip reasons, failures and captured output', async () => {
    const r = parsePytestXml(await data('pytest.xml'));
    const by = Object.fromEntries(r.map((t) => [t.id, t]));
    expect(Object.keys(by).sort()).toEqual([
      'tests/test_greeter.py::TestGreeter::test_deliberate_failure', 'tests/test_greeter.py::TestGreeter::test_prefix',
      'tests/test_greeter.py::test_greets_by_name', 'tests/test_greeter.py::test_greets_each[Java]', 'tests/test_greeter.py::test_greets_each[Rust]', 'tests/test_greeter.py::test_not_yet',
    ]);
    expect(by['tests/test_greeter.py::test_greets_by_name']).toMatchObject({ status: 'passed', framework: 'pytest', stdout: 'greeting NOVA' });
    expect(by['tests/test_greeter.py::test_not_yet']).toMatchObject({ status: 'skipped', message: 'not implemented yet' });
    const f = by['tests/test_greeter.py::TestGreeter::test_deliberate_failure']!;
    expect(f.status).toBe('failed');
    expect(f.message).toMatch(/^AssertionError: assert 'Hello, NOVA\?' == 'Hello, NOVA!'/);
    expect(f.stack).toContain('tests/test_greeter.py:29: AssertionError');
  });
  it('args: xunit1 + rootdir, ids after "--" only when filtered; missing pytest is named', () => {
    expect(pytestArgs('/w', [], '/t/x.xml')).not.toContain('--');
    expect(pytestArgs('/w', ['tests/a.py::t[1]'], '/t/x.xml').slice(-2)).toEqual(['--', 'tests/a.py::t[1]']);
    expect(pytestArgs('/w', [], '/t/x.xml')).toEqual(expect.arrayContaining(['junit_family=xunit1', '--junitxml=/t/x.xml', '--rootdir=/w']));
    expect(pytestMissing('/usr/bin/python3: No module named pytest\n', 'python3')).toMatch(/pytest is not installed for python3/);
    expect(pytestMissing('1 passed', 'python3')).toBeNull();
  });
  it('prefers a project virtualenv over PATH python', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-py-'));
    expect((await pythonFor(root)).source).toBe('PATH');
    const exe = process.platform === 'win32' ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
    await fs.mkdir(path.dirname(exe), { recursive: true }); await fs.writeFile(exe, '');
    expect(await pythonFor(root)).toEqual({ command: exe, source: 'virtualenv .venv' });
  });
});

describe('cargo test', () => {
  it('module paths of source files', () => {
    expect(modulePathOf('main.rs')).toEqual([]);
    expect(modulePathOf('lib.rs')).toEqual([]);
    expect(modulePathOf('greeter.rs')).toEqual(['greeter']);
    expect(modulePathOf('net/mod.rs')).toEqual(['net']);
    expect(modulePathOf('net/http.rs')).toEqual(['net', 'http']);
    expect(modulePathOf('bin/tool.rs')).toEqual([]);
  });
  it('static scan tracks inline mods, attributes, comments and strings', () => {
    const r = scanRustTests([
      'fn not_a_test() { let s = "mod fake {"; }', '// #[test]', '// fn commented() {}', '#[cfg(test)]', 'mod tests {', '    use super::*;',
      '    #[test]', '    #[ignore = "later"]', '    fn a() { assert!(true); }', '    mod deeper {', '        #[tokio::test]', '        async fn b() {}', '    }',
      '    #[test]', '    fn c() {}', '}', '/* #[test]', 'fn hidden() {} */', '#[test]', 'fn top() {}',
    ].join('\n'), ['greeter']);
    expect(r.map((t) => [...t.module, t.name].join('::'))).toEqual(['greeter::tests::a', 'greeter::tests::deeper::b', 'greeter::tests::c', 'greeter::top']);
    expect(r[0]!.line).toBe(9);
  });
  it('discovers the fixture with libtest names', async () => {
    const n = await discoverCargo(path.join(fixtures, 'rust-cargo'));
    expect(n.filter((x) => x.method).map((x) => x.id)).toEqual(['greeter::tests::greets_by_name', 'greeter::tests::greets_all_with_prefix', 'greeter::tests::not_yet', 'greeter::tests::deliberate_failure']);
    expect(n.find((x) => !x.method)).toMatchObject({ id: 'src/greeter.rs#greeter::tests', label: 'greeter::tests', rel: 'src/greeter.rs' });
    expect(await discoverCargo(path.join(fixtures, 'python'))).toEqual([]);
  });
  it('parses real libtest output: statuses, ignore reason, panic message/stack, --show-output stdout; no fake durations', async () => {
    const r = parseCargoOutput(await data('cargo-output.txt'));
    const by = Object.fromEntries(r.map((t) => [t.id, t]));
    expect(Object.keys(by).sort()).toEqual(['greeter::tests::deliberate_failure', 'greeter::tests::greets_all_with_prefix', 'greeter::tests::greets_by_name', 'greeter::tests::not_yet']);
    expect(by['greeter::tests::greets_by_name']).toMatchObject({ status: 'passed', stdout: 'greeting NOVA', timeMs: null, framework: 'cargo' });
    expect(by['greeter::tests::not_yet']).toMatchObject({ status: 'skipped', message: 'not implemented yet' });
    const f = by['greeter::tests::deliberate_failure']!;
    expect(f.status).toBe('failed');
    expect(f.message).toBe('assertion `left == right` failed: set NOVA_DEMO_FAIL=1 to see a failure');
    expect(f.stack).toMatch(/^thread 'greeter::tests::deliberate_failure' .*panicked at src\/greeter\.rs:39:13:/);
    expect(f.stdout).toBe('');
  });
  it('should-panic and doctest lines', () => {
    const r = parseCargoOutput('test m::panics - should panic ... ok\ntest src/lib.rs - add (line 3) ... ok\ntest m::slow ... ignored\n');
    expect(r.map((t) => [t.id, t.status, t.message])).toEqual([['m::panics', 'passed', null], ['src/lib.rs - add (line 3)', 'passed', null], ['m::slow', 'skipped', 'ignored']]);
  });
  it('args: all targets, --exact only when filtered, --workspace for workspace roots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-cargo-'));
    await fs.writeFile(path.join(root, 'Cargo.toml'), '[package]\nname = "x"\n');
    expect(await cargoArgs(root, [])).toEqual(['test', '--no-fail-fast', '--color', 'never', '--', '--show-output', '--color', 'never']);
    expect((await cargoArgs(root, ['a::b'])).slice(-2)).toEqual(['--exact', 'a::b']);
    await fs.writeFile(path.join(root, 'Cargo.toml'), '[workspace]\nmembers = ["a"]\n');
    expect(await cargoArgs(root, [])).toContain('--workspace');
  });
});

describe('discovery across frameworks', () => {
  it('finds each framework in its fixture and nothing runs', async () => {
    expect(frameworksOf(await discoverAllTests(path.join(fixtures, 'java-gradle')))).toEqual(['gradle']);
    expect(frameworksOf(await discoverAllTests(path.join(fixtures, 'python')))).toEqual(['pytest']);
    expect(frameworksOf(await discoverAllTests(path.join(fixtures, 'rust-cargo')))).toEqual(['cargo']);
    expect(frameworksOf(await discoverAllTests(path.join(fixtures, 'typescript-node')))).toEqual([]);
  });
});
