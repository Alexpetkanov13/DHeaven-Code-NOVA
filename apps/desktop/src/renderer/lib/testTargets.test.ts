import { describe, expect, it } from 'vitest';
import type { TestCase, TestNode } from '@nova/ipc-contract';
import { aggregate, covers, minimize, resultsFor, targetsForNodes, toTargets, under } from './testTargets';

const n = (framework: TestNode['framework'], id: string, className: string, method: string | null): TestNode => ({ id, framework, label: method ?? id, className, method, rel: 'f', line: 1 });
const r = (framework: TestCase['framework'], id: string, status: TestCase['status']): TestCase => ({ id, framework, name: id, status, timeMs: null, message: null, stack: null, stdout: '' });

const nodes: TestNode[] = [
  n('gradle', 'a.B', 'a.B', null), n('gradle', 'a.B.m', 'a.B', 'm'),
  n('pytest', 't.py', 't.py', null), n('pytest', 't.py::test_x', 't.py', 'test_x'), n('pytest', 't.py::C', 't.py::C', null), n('pytest', 't.py::C::test_y', 't.py::C', 'test_y'),
  n('cargo', 'src/g.rs#g::tests', 'src/g.rs#g::tests', null), n('cargo', 'g::tests::one', 'src/g.rs#g::tests', 'one'), n('cargo', 'g::tests::two', 'src/g.rs#g::tests', 'two'),
];

describe('test targets', () => {
  it('under() understands Gradle dots, pytest :: and [params]', () => {
    expect(under('a.B.m', 'a.B')).toBe(true);
    expect(under('t.py::C::test_y', 't.py')).toBe(true);
    expect(under('t.py::test_x[1]', 't.py::test_x')).toBe(true);
    expect(under('a.Bc.m', 'a.B')).toBe(false);
  });
  it('group runs use each framework\'s natural filter; cargo groups run their leaves exactly', () => {
    expect(targetsForNodes([nodes[0]!], nodes)).toEqual([{ framework: 'gradle', filters: ['a.B'] }]);
    expect(targetsForNodes([nodes[2]!, nodes[4]!], nodes)).toEqual([{ framework: 'pytest', filters: ['t.py'] }]); // file covers its class
    expect(targetsForNodes([nodes[6]!], nodes)).toEqual([{ framework: 'cargo', filters: ['g::tests::one', 'g::tests::two'] }]);
    expect(targetsForNodes([nodes[1]!, nodes[7]!], nodes)).toEqual([{ framework: 'gradle', filters: ['a.B.m'] }, { framework: 'cargo', filters: ['g::tests::one'] }]);
  });
  it('rerun-failed targets keep parametrized ids and split by framework', () => {
    expect(toTargets([{ framework: 'pytest', filter: 't.py::test_x[1]' }, { framework: 'cargo', filter: 'g::tests::two' }, { framework: 'pytest', filter: 't.py::test_x[2]' }]))
      .toEqual([{ framework: 'pytest', filters: ['t.py::test_x[1]', 't.py::test_x[2]'] }, { framework: 'cargo', filters: ['g::tests::two'] }]);
    expect(minimize(['t.py::C', 't.py', 't.py'])).toEqual(['t.py']);
  });
  it('status aggregates params and groups; running marker follows the targets', () => {
    const res = [r('pytest', 't.py::test_x[1]', 'passed'), r('pytest', 't.py::test_x[2]', 'failed'), r('cargo', 'g::tests::one', 'passed'), r('cargo', 'g::tests::two', 'skipped'), r('gradle', 'a.B.m', 'passed')];
    expect(aggregate(resultsFor(nodes[3]!, nodes, res))).toBe('failed');
    expect(aggregate(resultsFor(nodes[2]!, nodes, res))).toBe('failed');
    expect(aggregate(resultsFor(nodes[6]!, nodes, res))).toBe('passed');
    expect(aggregate(resultsFor(nodes[0]!, nodes, res))).toBe('passed');
    expect(aggregate(resultsFor(nodes[5]!, nodes, res))).toBeNull();
    expect(covers([{ framework: 'cargo', filters: ['g::tests::one'] }], nodes[6]!, nodes)).toBe(true); // group shows running when a leaf runs
    expect(covers([{ framework: 'pytest', filters: ['t.py::C'] }], nodes[3]!, nodes)).toBe(false);
    expect(covers('all', nodes[3]!, nodes)).toBe(true);
  });
});
