import type { TestCase, TestFramework, TestNode } from '@nova/ipc-contract';

export interface Target { framework: TestFramework; filters: string[] }

/** `id` is `f` or inside it: Gradle `pkg.Class.method`, pytest `file::Class::test[param]`. */
export const under = (id: string, f: string) => id === f || id.startsWith(f + '.') || id.startsWith(f + '::') || id.startsWith(f + '[');

/** Leaves of a group node (cargo groups are files×modules whose id is not a libtest name, so they run by leaf names). */
export const leavesOf = (g: TestNode, all: TestNode[]) => all.filter((n) => n.method && n.framework === g.framework && n.className === g.className);

/** Filters that run exactly this node, in the framework's own syntax. */
export function filtersFor(n: TestNode, all: TestNode[]): string[] {
  if (n.method) return [n.id];
  if (n.framework === 'gradle') return [n.className];
  if (n.framework === 'pytest') return [n.id];
  return leavesOf(n, all).map((l) => l.id);
}

/** Drops filters already covered by a broader one (pytest `file` covers `file::Class`), keeps order, de-duplicates. */
export function minimize(filters: string[]): string[] {
  const uniq = [...new Set(filters)];
  return uniq.filter((f) => !uniq.some((g) => g !== f && under(f, g)));
}

/** Groups (framework, filter) pairs into one target per framework. */
export function toTargets(pairs: { framework: TestFramework; filter: string }[]): Target[] {
  const by = new Map<TestFramework, string[]>();
  for (const p of pairs) by.set(p.framework, [...(by.get(p.framework) ?? []), p.filter]);
  return [...by].map(([framework, fs]) => ({ framework, filters: framework === 'cargo' ? [...new Set(fs)] : minimize(fs) }));
}

export function targetsForNodes(nodes: TestNode[], all: TestNode[]): Target[] {
  return toTargets(nodes.flatMap((n) => filtersFor(n, all).map((filter) => ({ framework: n.framework, filter }))));
}

/** Results that belong to a node: its own, parametrized variants (`test[x]`), and for groups every test inside. */
export function resultsFor(n: TestNode, all: TestNode[], results: TestCase[]): TestCase[] {
  const own = results.filter((t) => t.framework === n.framework);
  if (n.method) return own.filter((t) => t.id === n.id || t.id.startsWith(n.id + '['));
  if (n.framework === 'cargo') { const ids = new Set(leavesOf(n, all).map((l) => l.id)); return own.filter((t) => ids.has(t.id)); }
  return own.filter((t) => under(t.id, n.framework === 'gradle' ? n.className : n.id));
}

export function aggregate(rs: TestCase[]): TestCase['status'] | null {
  if (!rs.length) return null;
  return rs.some((t) => t.status === 'failed') ? 'failed' : rs.some((t) => t.status === 'error') ? 'error' : rs.every((t) => t.status === 'skipped') ? 'skipped' : 'passed';
}

/** Whether a running target set includes this node (for the "running" marker). */
export function covers(targets: Target[] | 'all', n: TestNode, all: TestNode[]): boolean {
  if (targets === 'all') return true;
  return targets.some((t) => t.framework === n.framework && (!t.filters.length || filtersFor(n, all).some((f) => t.filters.some((x) => under(f, x) || under(x, f)))));
}
