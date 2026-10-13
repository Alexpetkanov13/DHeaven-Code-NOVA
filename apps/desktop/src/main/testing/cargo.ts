import fs from 'node:fs/promises';
import path from 'node:path';
import type { TestCase, TestNode } from '../junit';

const exists = (p: string) => fs.access(p).then(() => true, () => false);

/** Crate directories: the workspace root and members up to two levels down (crates/foo). */
async function crateDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string, depth: number) => {
    if (await exists(path.join(dir, 'Cargo.toml'))) out.push(dir);
    if (depth >= 2) return;
    let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && !['target', 'node_modules', 'src', 'tests'].includes(e.name)) await visit(path.join(dir, e.name), depth + 1);
  };
  await visit(root, 0);
  return out;
}
async function rsFiles(dir: string, out: string[], depth = 0) {
  if (depth > 12 || out.length > 5000) return;
  let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await rsFiles(p, out, depth + 1); else if (e.name.endsWith('.rs')) out.push(p);
  }
}

/** Module path of a source file inside src/ (main.rs, lib.rs and src/bin/*.rs are crate roots). */
export function modulePathOf(relToSrc: string): string[] {
  const parts = relToSrc.split(/[\\/]/);
  const file = parts.pop()!;
  if (parts[0] === 'bin') return [];
  if (!parts.length && (file === 'main.rs' || file === 'lib.rs')) return [];
  if (file === 'mod.rs') return parts;
  return [...parts, file.replace(/\.rs$/, '')];
}

/**
 * Static scan for `#[test]` (also `#[tokio::test]` and similar `…::test` attributes) functions, tracking inline
 * `mod name { … }` blocks so names match libtest's `module::path::fn`. Macro-generated tests are not listed.
 */
export function scanRustTests(src: string, base: string[]): { name: string; module: string[]; line: number }[] {
  const tests: { name: string; module: string[]; line: number }[] = [];
  const mods: { name: string; depth: number }[] = [];
  let depth = 0; let pending = false; let block = false;
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i]!;
    if (block) { const e = l.indexOf('*/'); if (e < 0) continue; l = l.slice(e + 2); block = false; }
    l = l.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])'/g, "''");
    const bs = l.indexOf('/*'); if (bs >= 0) { l = l.slice(0, bs); block = true; }
    if (/#\[\s*(?:[\w]+::)*test\s*[\]()]/.test(l)) pending = true;
    const mm = /\bmod\s+([A-Za-z_]\w*)\s*\{/.exec(l);
    if (mm) mods.push({ name: mm[1]!, depth });
    if (pending) {
      const fm = /\bfn\s+([A-Za-z_]\w*)\s*[(<]/.exec(l);
      if (fm) { tests.push({ name: fm[1]!, module: [...base, ...mods.map((m) => m.name)], line: i + 1 }); pending = false; }
    }
    for (const ch of l) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; while (mods.length && depth <= mods[mods.length - 1]!.depth) mods.pop(); }
    }
  }
  return tests;
}

export async function hasCargo(root: string) { return exists(path.join(root, 'Cargo.toml')); }

export async function discoverCargo(root: string): Promise<TestNode[]> {
  if (!(await hasCargo(root))) return [];
  const nodes: TestNode[] = [];
  for (const crate of await crateDirs(root)) {
    const files: { file: string; base: string[] }[] = [];
    const src: string[] = []; await rsFiles(path.join(crate, 'src'), src);
    for (const f of src) files.push({ file: f, base: modulePathOf(path.relative(path.join(crate, 'src'), f)) });
    try { for (const e of await fs.readdir(path.join(crate, 'tests'), { withFileTypes: true })) if (e.isFile() && e.name.endsWith('.rs')) files.push({ file: path.join(crate, 'tests', e.name), base: [] }); } catch { /* none */ }
    for (const { file, base } of files.sort((a, b) => a.file.localeCompare(b.file))) {
      let text: string; try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
      const found = scanRustTests(text, base);
      if (!found.length) continue;
      const rel = path.relative(root, file).split(path.sep).join('/');
      const groups = new Map<string, typeof found>();
      for (const t of found) { const k = t.module.join('::'); groups.set(k, [...(groups.get(k) ?? []), t]); }
      for (const [mod, ts] of groups) {
        const gid = `${rel}#${mod}`; // group node id (not a libtest name); leaves carry the real names
        nodes.push({ id: gid, framework: 'cargo', label: mod || path.basename(rel), className: gid, method: null, rel, line: ts[0]!.line });
        for (const t of ts) nodes.push({ id: [...t.module, t.name].join('::'), framework: 'cargo', label: t.name, className: gid, method: t.name, rel, line: t.line });
      }
    }
  }
  return nodes;
}

/** `cargo test` with every binary run (--no-fail-fast), passing tests' output shown, exact names when filtered. */
export async function cargoArgs(root: string, ids: string[]): Promise<string[]> {
  const toml = await fs.readFile(path.join(root, 'Cargo.toml'), 'utf8').catch(() => '');
  return ['test', ...(/^\s*\[workspace\]/m.test(toml) ? ['--workspace'] : []), '--no-fail-fast', '--color', 'never', '--', '--show-output', '--color', 'never', ...(ids.length ? ['--exact', ...ids] : [])];
}

/**
 * Parses libtest's stable text output (no JSON on stable Rust): `test NAME ... ok|FAILED|ignored[, reason]` lines,
 * and `---- NAME stdout ----` sections (failures, and successes because of --show-output). libtest reports no
 * per-test durations, so timeMs is null.
 */
export function parseCargoOutput(out: string): TestCase[] {
  const res = new Map<string, TestCase>();
  const lines = out.split(/\r?\n/);
  for (const l of lines) {
    const m = /^test (.+?) \.\.\. (ok|FAILED|ignored(?:, (.*))?)$/.exec(l);
    if (!m) continue;
    const id = m[1]!.replace(/ - should panic$/, '');
    const status = m[2] === 'ok' ? 'passed' : m[2] === 'FAILED' ? 'failed' : 'skipped';
    res.set(id, { id, framework: 'cargo', name: id.split('::').pop()!, status, timeMs: null, message: status === 'skipped' ? (m[3] ?? 'ignored') : null, stack: null, stdout: '' });
  }
  let cur: string | null = null; let buf: string[] = [];
  const flush = () => {
    const t = cur ? res.get(cur) : undefined;
    if (t) {
      const textOut = buf.join('\n').replace(/^\n+|\n+$/g, '');
      const p = textOut.search(/^thread '.*' (?:\(\d+\) )?panicked at /m);
      if (t.status === 'failed' && p >= 0) {
        t.stdout = textOut.slice(0, p).trim();
        t.stack = textOut.slice(p).trim();
        const after = t.stack.split('\n').slice(1).find((x) => x.trim() && !/^(stack backtrace:|note:)/.test(x));
        t.message = after?.trim() ?? t.stack.split('\n')[0]!;
      } else t.stdout = textOut;
    }
    cur = null; buf = [];
  };
  for (const l of lines) {
    const h = /^---- (.+?) stdout ----$/.exec(l);
    if (h) { flush(); cur = h[1]!.replace(/ - should panic$/, ''); continue; }
    if (cur !== null && (/^(failures|successes):$/.test(l) || /^test result:/.test(l))) { flush(); continue; }
    if (cur !== null) buf.push(l);
  }
  flush();
  return [...res.values()];
}
