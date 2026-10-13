import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attrs, text, type TestCase, type TestNode } from '../junit';

export type JsRunner = 'vitest' | 'jest';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target']);
const isTestFile = (rel: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || (/(^|\/)__tests__\//.test(rel) && /\.[cm]?[jt]sx?$/.test(rel));

/** Which runner the workspace's package.json declares (root package only); vitest wins if both are listed. */
export async function jsRunnerOf(root: string): Promise<JsRunner | null> {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try { pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); } catch { return null; }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return deps.vitest ? 'vitest' : deps.jest ? 'jest' : null;
}

async function walk(root: string, dir: string, out: string[], depth = 0) {
  if (depth > 10 || out.length > 5000) return;
  let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(root, p, out, depth + 1); }
    else if (e.isFile()) { const rel = path.relative(root, p).split(path.sep).join('/'); if (isTestFile(rel)) out.push(rel); }
  }
}

/**
 * Static scan for `describe`/`suite` blocks and `it`/`test` calls with string-literal names (also `.skip`, `.only`,
 * `.todo`, `.concurrent`…), nesting tracked by braces with strings/comments removed. Dynamic names (template literals
 * with `${}`, variables) and `.each` tables aren't listed; the runner still runs them and they appear in the counts.
 */
export function scanJsTests(src: string): { path: string[]; line: number }[] {
  const out: { path: string[]; line: number }[] = [];
  const stack: { name: string; depth: number }[] = [];
  let depth = 0; let block = false;
  const NAME = String.raw`\s*\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|\x60([^\x60$]*)\x60)`;
  const DESCRIBE = new RegExp(String.raw`(?:^|[^\w.$])(?:describe|suite)(?:\.(?:only|skip|concurrent|sequential|shuffle))*` + NAME);
  const TEST = new RegExp(String.raw`(?:^|[^\w.$])(?:it|test)(?:\.(?:only|skip|todo|concurrent|sequential|fails|failing))*` + NAME);
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i]!;
    if (block) { const e = l.indexOf('*/'); if (e < 0) continue; l = l.slice(e + 2); block = false; }
    l = l.replace(/\/\*.*?\*\//g, '');
    const bs = l.indexOf('/*'); if (bs >= 0) { l = l.slice(0, bs); block = true; }
    l = l.replace(/(^|[^:'"`])\/\/.*$/, '$1');
    const unq = (m: RegExpExecArray) => (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
    const d = DESCRIBE.exec(l); const t = d ? null : TEST.exec(l);
    if (d) stack.push({ name: unq(d), depth });
    else if (t) out.push({ path: [...stack.map((s) => s.name), unq(t)], line: i + 1 });
    for (const ch of l.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""')) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; while (stack.length && depth <= stack[stack.length - 1]!.depth) stack.pop(); }
    }
  }
  return out;
}

/** Node ids: `file::describe > test` (vitest's own `>`-joined names; jest ancestorTitles + title). */
export const jsId = (rel: string, names: string[]) => `${rel}::${names.join(' > ')}`;

export async function discoverJs(root: string): Promise<TestNode[]> {
  const runner = await jsRunnerOf(root);
  if (!runner) return [];
  const files: string[] = []; await walk(root, root, files);
  const nodes: TestNode[] = [];
  for (const rel of files.sort()) {
    let src: string; try { src = await fs.readFile(path.join(root, rel), 'utf8'); } catch { continue; }
    const tests = scanJsTests(src);
    if (!tests.length) continue;
    nodes.push({ id: rel, framework: runner, label: path.basename(rel), className: rel, method: null, rel, line: 1 });
    for (const t of tests) nodes.push({ id: jsId(rel, t.path), framework: runner, label: t.path.join(' › '), className: rel, method: t.path[t.path.length - 1]!, rel, line: t.line });
  }
  return nodes;
}

/** The runner's JS entry from node_modules (run as `node <entry>`: no .cmd shim, no shell, on every OS). */
export async function runnerEntry(root: string, runner: JsRunner): Promise<string> {
  const dir = path.join(root, 'node_modules', runner);
  let pkg: { bin?: string | Record<string, string> };
  try { pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')); }
  catch { throw new Error(`${runner} is listed in package.json but is not installed. Run your package manager's install (e.g. npm install) first.`); }
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[runner];
  if (!bin) throw new Error(`node_modules/${runner}/package.json has no "${runner}" bin entry`);
  return path.join(dir, bin);
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Splits filters (`file` or `file::a > b`) into whole-file runs and named-test runs (one invocation each). */
export function planJs(filters: string[]): { files: string[]; tests: { files: string[]; pattern: string } | null } {
  const whole = filters.filter((f) => !f.includes('::'));
  const named = filters.filter((f) => f.includes('::'));
  const tests = named.length ? {
    files: [...new Set(named.map((f) => f.slice(0, f.indexOf('::'))))],
    // Both runners match -t against the full name joined with single spaces.
    pattern: `^(?:${[...new Set(named.map((f) => f.slice(f.indexOf('::') + 2).split(' > ').join(' ')))].map(escRe).join('|')})$`,
  } : null;
  return { files: whole, tests };
}

export function reportPath(runId: number, part: number, runner: JsRunner) { return path.join(os.tmpdir(), `nova-${runner}-${process.pid}-${runId}-${part}.${runner === 'vitest' ? 'xml' : 'json'}`); }

export function jsArgs(entry: string, runner: JsRunner, report: string, files: string[], pattern: string | null): string[] {
  if (runner === 'vitest') return [entry, 'run', '--reporter=default', '--reporter=junit', `--outputFile.junit=${report}`, ...files, ...(pattern ? ['-t', pattern] : [])];
  // jest positional args are regexes over absolute paths: escape them and accept either separator.
  return [entry, '--json', `--outputFile=${report}`, '--testLocationInResults', '--ci', ...files.map((f) => escRe(f).split('/').join('[\\\\/]')), ...(pattern ? ['-t', pattern] : [])];
}

/** Vitest JUnit: classname = file (relative to the project root), name = `describe > test`. */
export function parseVitestJunit(xml: string): TestCase[] {
  const out: TestCase[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attrs(m[1]!); const body = m[3] ?? '';
    const file = (a.classname ?? '').split('\\').join('/');
    const fail = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const skip = /<skipped\b([^>]*?)\/?>/.exec(body);
    const sysout = [...body.matchAll(/<system-(out|err)>([\s\S]*?)<\/system-\1>/g)].map((x) => text(x[2]!).trim()).filter(Boolean).join('\n');
    out.push({
      id: `${file}::${a.name ?? ''}`, framework: 'vitest', name: (a.name ?? '').split(' > ').pop()!, timeMs: Math.round(Number(a.time ?? 0) * 1000),
      status: fail ? (fail[1] === 'error' ? 'error' : 'failed') : skip ? 'skipped' : 'passed',
      message: fail ? attrs(fail[2]!).message ?? null : skip ? attrs(skip[1]!).message ?? null : null,
      stack: fail?.[3] ? text(fail[3]).trim() : null, stdout: sysout,
    });
  }
  return out;
}

interface JestJson { testResults: { name: string; status: string; message: string; assertionResults: { ancestorTitles: string[]; title: string; status: string; duration: number | null; failureMessages: string[] }[] }[] }
/** Jest `--json`: per-file assertionResults; a file that failed to load becomes one `error` result for the file. */
export function parseJestJson(json: string, root: string): TestCase[] {
  const d = JSON.parse(json) as JestJson;
  const out: TestCase[] = [];
  for (const f of d.testResults ?? []) {
    const rel = path.relative(root, f.name).split(path.sep).join('/');
    if (!f.assertionResults.length && f.status === 'failed') {
      out.push({ id: rel, framework: 'jest', name: path.basename(rel), status: 'error', timeMs: null, message: 'Test file failed to run', stack: f.message || null, stdout: '' });
      continue;
    }
    for (const a of f.assertionResults) {
      const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped';
      const fm = a.failureMessages.join('\n\n');
      out.push({
        id: jsId(rel, [...a.ancestorTitles, a.title]), framework: 'jest', name: a.title, status, timeMs: a.duration ?? null,
        message: status === 'failed' ? fm.split('\n').find((l) => l.trim())?.trim() ?? 'failed' : status === 'skipped' ? a.status : null,
        stack: status === 'failed' ? fm : null, stdout: '',
      });
    }
  }
  return out;
}
