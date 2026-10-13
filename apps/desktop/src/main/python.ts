import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findExecutable } from './lsp/discover';

const isWin = process.platform === 'win32';
export interface PyInterpreter { path: string; version: string; source: string }
export interface PyResolved { command: string; source: string; version: string | null; note: string | null }

/** Runs the interpreter and asks for its version and real executable (bounded; waits for 'close' so stdout is complete). */
export function probePython(exe: string, timeoutMs = 10_000): Promise<{ version: string; executable: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, ['-c', 'import sys; print(sys.version.split()[0]); print(sys.executable)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout!.on('data', (b: Buffer) => { out += b.toString(); });
    p.stderr!.on('data', (b: Buffer) => { err += b.toString(); });
    const t = setTimeout(() => { p.kill(); reject(new Error(`${exe} did not answer within ${timeoutMs / 1000} s`)); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      const [version, executable] = out.split(/\r?\n/).map((l) => l.trim());
      if (code === 0 && version && /^\d+\.\d+/.test(version)) resolve({ version, executable: executable || exe });
      else reject(new Error(`${exe} is not a working Python (exit ${code}): ${(err || out).trim().slice(0, 300)}`));
    });
  });
}

const venvPython = (dir: string) => (isWin ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python'));
const exists = (p: string) => fs.access(p).then(() => true, () => false);
const subdirs = async (d: string) => { try { return (await fs.readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)); } catch { return []; } };
/** The Microsoft Store "python.exe" alias is a stub that opens the Store; it is never offered. */
const isStoreStub = (p: string) => isWin && /[\\/]WindowsApps[\\/]/i.test(p);

/** `py -0p` (Windows launcher) lists installed interpreters with their paths. */
function pyLauncherPaths(): Promise<string[]> {
  if (!isWin) return Promise.resolve([]);
  return new Promise((resolve) => {
    const p = spawn('py', ['-0p'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout!.on('data', (b: Buffer) => { out += b.toString(); });
    const t = setTimeout(() => { p.kill(); resolve([]); }, 5000);
    p.on('error', () => { clearTimeout(t); resolve([]); });
    p.on('close', () => { clearTimeout(t); resolve(out.split(/\r?\n/).map((l) => /([A-Za-z]:\\.*python(w)?\.exe)\s*$/i.exec(l.trim())?.[1]).filter((x): x is string => !!x)); });
  });
}

/**
 * Candidate interpreters: workspace virtualenvs, python3/python on PATH, pyenv versions, conda base + envs, and the
 * Windows `py` launcher's list. Each is probed (it must run); duplicates (same real executable) are dropped.
 */
export async function discoverPythons(root: string | null, env: NodeJS.ProcessEnv = process.env): Promise<PyInterpreter[]> {
  const home = os.homedir();
  const cands: { path: string; source: string }[] = [];
  if (root) for (const d of ['.venv', 'venv', 'env']) cands.push({ path: venvPython(path.join(root, d)), source: `workspace ${d}` });
  for (const name of ['python3', 'python']) { const p = await findExecutable([name], env); if (p && !isStoreStub(p)) cands.push({ path: p, source: 'PATH' }); }
  for (const v of await subdirs(path.join(env.PYENV_ROOT ?? path.join(home, '.pyenv'), 'versions'))) cands.push({ path: venvPython(v), source: 'pyenv' });
  for (const base of ['miniconda3', 'anaconda3', 'miniforge3', 'mambaforge'].map((b) => path.join(home, b))) {
    cands.push({ path: isWin ? path.join(base, 'python.exe') : path.join(base, 'bin', 'python'), source: 'conda base' });
    for (const e of await subdirs(path.join(base, 'envs'))) cands.push({ path: isWin ? path.join(e, 'python.exe') : path.join(e, 'bin', 'python'), source: `conda ${path.basename(e)}` });
  }
  for (const p of await pyLauncherPaths()) cands.push({ path: p, source: 'py launcher' });
  const present = (await Promise.all(cands.map(async (c) => ((await exists(c.path)) ? c : null)))).filter((c): c is { path: string; source: string } => !!c);
  const probed = await Promise.all(present.slice(0, 40).map(async (c) => { try { const r = await probePython(c.path); return { ...c, version: r.version, real: await fs.realpath(r.executable).catch(() => r.executable) }; } catch { return null; } }));
  const seen = new Set<string>(); const out: PyInterpreter[] = [];
  for (const c of probed) {
    if (!c) continue;
    const key = isWin ? c.real.toLowerCase() : c.real;
    // Venvs often symlink to the base interpreter: keep the venv path (its site-packages differ) but drop exact repeats.
    const k = c.source.startsWith('workspace') ? `${key}|${c.path}` : key;
    if (seen.has(k)) continue; seen.add(k);
    out.push({ path: c.path, version: c.version, source: c.source });
  }
  return out;
}

/**
 * The interpreter used for tests, the debugger and Pyright. Order: the one chosen for this workspace (if it still runs),
 * then a workspace virtualenv, then python3/python on PATH (as a full path when found). A chosen interpreter that no
 * longer works is reported in `note` instead of being silently replaced.
 */
export async function resolvePython(root: string, selected: string | null, env: NodeJS.ProcessEnv = process.env): Promise<PyResolved> {
  let note: string | null = null;
  if (selected) {
    try { const r = await probePython(selected); return { command: selected, source: 'selected for this workspace', version: r.version, note: null }; }
    catch (e) { note = `The selected interpreter ${selected} does not work (${e instanceof Error ? e.message : e}); using the automatic choice.`; }
  }
  for (const d of ['.venv', 'venv', 'env']) {
    const exe = venvPython(path.join(root, d));
    if (await exists(exe)) return { command: exe, source: `virtualenv ${d}`, version: (await probePython(exe).catch(() => null))?.version ?? null, note };
  }
  for (const name of isWin ? ['python', 'python3'] : ['python3', 'python']) {
    const p = await findExecutable([name], env);
    if (p && !isStoreStub(p)) return { command: p, source: 'PATH', version: (await probePython(p).catch(() => null))?.version ?? null, note };
  }
  return { command: isWin ? 'python' : 'python3', source: 'PATH (not found)', version: null, note };
}
