import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attrs, text, type TestCase, type TestNode } from '../junit';

const SKIP_DIRS = new Set(['node_modules', 'venv', 'env', 'build', 'dist', 'target', '__pycache__', 'site-packages', 'out']);
const isTestFile = (n: string) => /^test_.*\.py$/.test(n) || /^.+_test\.py$/.test(n);

async function walk(dir: string, out: string[], depth = 0) {
  if (depth > 8 || out.length > 5000) return;
  let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(p, out, depth + 1); }
    else if (e.isFile() && isTestFile(e.name)) out.push(p);
  }
}

/**
 * Static pytest discovery (nothing is imported or executed): `test_*` functions at module level and `test_*` methods
 * of `Test*` classes in test_*.py / *_test.py files. Fixtures-generated, plugin-collected and unittest.TestCase tests
 * outside these conventions are not listed (pytest still runs them; they show up in the counts).
 */
export function scanPytestSource(src: string): { classes: { name: string; line: number; methods: { name: string; line: number }[] }[]; functions: { name: string; line: number }[] } {
  const classes: { name: string; line: number; methods: { name: string; line: number }[] }[] = [];
  const functions: { name: string; line: number }[] = [];
  let cls: (typeof classes)[number] | null = null;
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim() || /^\s*(#|@)/.test(l)) continue;
    const indented = /^\s/.test(l);
    if (!indented) {
      cls = null;
      const c = /^class\s+(Test\w*)\s*[(:]/.exec(l);
      if (c) { cls = { name: c[1]!, line: i + 1, methods: [] }; classes.push(cls); continue; }
      const f = /^(?:async\s+)?def\s+(test\w*)\s*\(/.exec(l);
      if (f) functions.push({ name: f[1]!, line: i + 1 });
    } else if (cls) {
      const m = /^\s+(?:async\s+)?def\s+(test\w*)\s*\(/.exec(l);
      if (m) cls.methods.push({ name: m[1]!, line: i + 1 });
    }
  }
  return { classes: classes.filter((c) => c.methods.length), functions };
}

export async function discoverPytest(root: string): Promise<TestNode[]> {
  const files: string[] = [];
  await walk(root, files);
  const nodes: TestNode[] = [];
  for (const f of files.sort()) {
    let src: string; try { src = await fs.readFile(f, 'utf8'); } catch { continue; }
    const rel = path.relative(root, f).split(path.sep).join('/');
    const { classes, functions } = scanPytestSource(src);
    if (!classes.length && !functions.length) continue;
    if (functions.length) {
      nodes.push({ id: rel, framework: 'pytest', label: path.basename(rel), className: rel, method: null, rel, line: 1 });
      for (const fn of functions) nodes.push({ id: `${rel}::${fn.name}`, framework: 'pytest', label: fn.name, className: rel, method: fn.name, rel, line: fn.line });
    }
    for (const c of classes) {
      const cid = `${rel}::${c.name}`;
      nodes.push({ id: cid, framework: 'pytest', label: c.name, className: cid, method: null, rel, line: c.line });
      for (const m of c.methods) nodes.push({ id: `${cid}::${m.name}`, framework: 'pytest', label: m.name, className: cid, method: m.name, rel, line: m.line });
    }
  }
  return nodes;
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);
/** Project virtualenv (.venv / venv / env in the workspace) first, else the platform's python on PATH. */
export async function pythonFor(root: string): Promise<{ command: string; source: string }> {
  const win = process.platform === 'win32';
  for (const d of ['.venv', 'venv', 'env']) {
    const exe = win ? path.join(root, d, 'Scripts', 'python.exe') : path.join(root, d, 'bin', 'python');
    if (await exists(exe)) return { command: exe, source: `virtualenv ${d}` };
  }
  return { command: win ? 'python' : 'python3', source: 'PATH' };
}

export function pytestXmlPath(runId: number) { return path.join(os.tmpdir(), `nova-pytest-${process.pid}-${runId}.xml`); }

/** pytest arguments: xunit1 (has file/line), captured output kept in the XML, explicit rootdir so node ids match discovery. */
export function pytestArgs(root: string, ids: string[], xml: string): string[] {
  return ['-m', 'pytest', '-o', 'junit_family=xunit1', '-o', 'junit_logging=out-err', `--junitxml=${xml}`, `--rootdir=${root}`, '-q', '--color=no', ...(ids.length ? ['--', ...ids] : [])];
}

/**
 * Maps pytest's JUnit XML back to node ids: `file::Class::name[param]`. classname is the dotted module path,
 * followed by the class when there is one.
 */
export function parsePytestXml(xml: string): TestCase[] {
  const out: TestCase[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const a = attrs(m[1]!); const body = m[3] ?? '';
    const file = (a.file ?? '').split('\\').join('/');
    const name = a.name ?? '';
    const mod = file.replace(/\.py$/, '').split('/').join('.');
    const cn = a.classname ?? '';
    const cls = file && cn.startsWith(mod + '.') ? cn.slice(mod.length + 1) : '';
    const id = file ? [file, ...(cls ? [cls] : []), name].join('::') : `${cn}.${name}`;
    const fail = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const skip = /<skipped\b([^>]*?)(?:\/>|>([\s\S]*?)<\/skipped>)/.exec(body);
    const outs = [...body.matchAll(/<system-(out|err)>([\s\S]*?)<\/system-\1>/g)].map((x) => text(x[2]!).replace(/^-{5,} Captured (?:Out|Err|Log) -{5,}\r?\n?/gm, '')).join('\n').trim();
    out.push({
      id, framework: 'pytest', name, timeMs: Math.round(Number(a.time ?? 0) * 1000),
      status: fail ? (fail[1] === 'error' ? 'error' : 'failed') : skip ? 'skipped' : 'passed',
      message: fail ? attrs(fail[2]!).message ?? null : skip ? attrs(skip[1]!).message ?? null : null,
      stack: fail?.[3] ? text(fail[3]).trim() : null,
      stdout: outs,
    });
  }
  return out;
}

/** A clear reason when the run produced no XML because pytest itself is missing. */
export function pytestMissing(output: string, python: string): string | null {
  return /No module named pytest/.test(output) ? `pytest is not installed for ${python} (install it with: ${python} -m pip install pytest)` : null;
}
