import fs from 'node:fs/promises';
import path from 'node:path';

export interface TestNode { id: string; className: string; method: string | null; rel: string; line: number }
export interface TestCase { id: string; name: string; status: 'passed' | 'failed' | 'skipped' | 'error'; timeMs: number; message: string | null; stack: string | null; stdout: string }

async function walk(dir: string, out: string[], depth = 0) {
  if (depth > 30) return;
  let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out, depth + 1); else if (/\.(java|kt)$/.test(e.name)) out.push(p);
  }
}

/**
 * Source-scan discovery of JUnit 5 tests (and JUnit 4 @Test) under src/test/{java,kotlin} (also in sub-projects one level deep).
 * Static analysis only: inherited tests, @Nested classes, @TestFactory and dynamic tests are not discovered.
 */
export function scanTestSource(src: string): { pkg: string; classes: { name: string; line: number; methods: { name: string; line: number }[] }[] } {
  const lines = src.split(/\r?\n/);
  const pkg = /^\s*package\s+([\w.]+)/m.exec(src)?.[1] ?? '';
  const classes: { name: string; line: number; methods: { name: string; line: number }[] }[] = [];
  let pendingTest = false; let depth = 0; let cur: (typeof classes)[number] | null = null; let curDepth = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.replace(/\/\/.*$/, '');
    if (/@(Test|ParameterizedTest|RepeatedTest)\b/.test(l)) pendingTest = true;
    const cm = /\b(?:class|object)\s+([A-Za-z_]\w*)/.exec(l);
    if (cm && !/^\s*\*/.test(l) && (cur === null || depth <= curDepth)) { cur = { name: cm[1]!, line: i + 1, methods: [] }; curDepth = depth; classes.push(cur); }
    else if (pendingTest && cur) {
      const mm = /(?:\bvoid|\bfun)\s+`?([A-Za-z_][\w ]*?)`?\s*\(/.exec(l);
      if (mm) { cur.methods.push({ name: mm[1]!, line: i + 1 }); pendingTest = false; }
    }
    for (const ch of l) { if (ch === '{') depth++; else if (ch === '}') depth--; }
  }
  return { pkg, classes: classes.filter((c) => c.methods.length) };
}

export async function discoverTests(root: string): Promise<TestNode[]> {
  const roots = [root];
  try { for (const e of await fs.readdir(root, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && !['build', 'node_modules', 'bin', 'gradle'].includes(e.name)) roots.push(path.join(root, e.name)); } catch { /* ignore */ }
  const files: string[] = [];
  for (const r of roots) { await walk(path.join(r, 'src', 'test', 'java'), files); await walk(path.join(r, 'src', 'test', 'kotlin'), files); }
  const nodes: TestNode[] = [];
  for (const f of files.sort()) {
    const { pkg, classes } = scanTestSource(await fs.readFile(f, 'utf8'));
    const rel = path.relative(root, f).split(path.sep).join('/');
    for (const c of classes) {
      const fq = pkg ? `${pkg}.${c.name}` : c.name;
      nodes.push({ id: fq, className: fq, method: null, rel, line: c.line });
      for (const m of c.methods) nodes.push({ id: `${fq}.${m.name}`, className: fq, method: m.name, rel, line: m.line });
    }
  }
  return nodes;
}

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unesc = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m));
const attrs = (s: string) => { const o: Record<string, string> = {}; for (const m of s.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) o[m[1]!] = unesc(m[2]!); return o; };
const text = (s: string) => unesc(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, c: string) => c.replace(/&/g, '&amp;').replace(/</g, '&lt;')));

/** Parses Gradle/Surefire JUnit XML (`TEST-*.xml`). Method names drop the trailing `()` Gradle adds for JUnit 5. */
export function parseJUnitXml(xml: string): TestCase[] {
  const out: TestCase[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attrs(m[1]!); const body = m[3] ?? '';
    const name = (a.name ?? '').replace(/\(\)$/, '');
    const id = `${a.classname ?? ''}.${name}`;
    const fail = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const skipped = /<skipped\b/.test(body);
    const sysout = /<system-out>([\s\S]*?)<\/system-out>/.exec(body);
    out.push({
      id, name, timeMs: Math.round(Number(a.time ?? 0) * 1000),
      status: fail ? (fail[1] === 'error' ? 'error' : 'failed') : skipped ? 'skipped' : 'passed',
      message: fail ? attrs(fail[2]!).message ?? null : skipped ? attrs(/<skipped\b([^>]*)/.exec(body)![1]!).message ?? null : null,
      stack: fail?.[3] ? text(fail[3]).trim() : null,
      stdout: sysout ? text(sysout[1]!) : '',
    });
  }
  return out;
}

export async function readResults(root: string): Promise<TestCase[]> {
  const res: TestCase[] = [];
  const dirs = [path.join(root, 'build', 'test-results')];
  try { for (const e of await fs.readdir(root, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) dirs.push(path.join(root, e.name, 'build', 'test-results')); } catch { /* ignore */ }
  for (const d of dirs) {
    let tasks: string[] = []; try { tasks = await fs.readdir(d); } catch { continue; }
    for (const t of tasks) {
      let files: string[] = []; try { files = (await fs.readdir(path.join(d, t))).filter((f) => /^TEST-.*\.xml$/.test(f)); } catch { continue; }
      for (const f of files) res.push(...parseJUnitXml(await fs.readFile(path.join(d, t, f), 'utf8')));
    }
  }
  return res;
}

export async function clearResults(root: string) {
  await fs.rm(path.join(root, 'build', 'test-results'), { recursive: true, force: true });
  try { for (const e of await fs.readdir(root, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) await fs.rm(path.join(root, e.name, 'build', 'test-results'), { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Gradle args for running tests. `--rerun` (Gradle ≥7.6) forces execution even when the task is up to date. */
export function testArgs(filters: string[], debug: boolean): string[] {
  return ['test', ...filters.flatMap((f) => ['--tests', f]), '--rerun', ...(debug ? ['--debug-jvm'] : [])];
}
export const DEBUG_LISTEN_RE = /Listening for transport dt_socket at address: (\d+)/;
