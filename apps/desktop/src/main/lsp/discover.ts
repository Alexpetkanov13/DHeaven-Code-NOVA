import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { LaunchSpec } from './server';

const isWin = process.platform === 'win32';

/** Extra directories searched after PATH (a GUI-launched app often has a shorter PATH than a login shell). */
export function extraBinDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = os.homedir();
  const dirs = [path.join(home, '.cargo', 'bin'), path.join(home, '.local', 'bin')];
  if (isWin) { if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm')); }
  else dirs.push('/usr/local/bin', '/opt/homebrew/bin');
  return dirs;
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    if (!(await fs.stat(p)).isFile()) return false;
    if (!isWin) await fs.access(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

/** First executable named one of `names` in PATH (then `extraDirs`). Windows tries PATHEXT extensions (.exe/.cmd/.bat…). */
export async function findExecutable(names: string[], env: NodeJS.ProcessEnv = process.env, extraDirs = extraBinDirs(env)): Promise<string | null> {
  const pathVar = env.PATH ?? env.Path ?? '';
  const dirs = [...new Set([...pathVar.split(path.delimiter), ...extraDirs].filter((d) => d && path.isAbsolute(d)))];
  const exts = isWin ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const name of names) for (const dir of dirs) for (const ext of exts) {
    const p = path.join(dir, name + ext);
    if (await isExecutableFile(p)) return p;
  }
  return null;
}

/** Characters that cmd.exe would interpret inside a command line; a path containing them is refused rather than escaped. */
const CMD_UNSAFE = /["%^&|<>!\r\n]/;

/**
 * Launch spec for an external executable. Windows .cmd/.bat shims (npm-installed servers) cannot be spawned
 * directly (Node refuses since CVE-2024-27980), so they run through cmd.exe with verbatim, fully quoted arguments.
 */
export function externalLaunch(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): LaunchSpec {
  if (isWin && /\.(cmd|bat)$/i.test(exe)) {
    for (const s of [exe, ...args]) if (CMD_UNSAFE.test(s)) throw new Error(`Refusing to run through cmd.exe: unsafe characters in ${JSON.stringify(s)}`);
    const line = [exe, ...args].map((s) => `"${s}"`).join(' ');
    return { command: env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], cwd, env, windowsVerbatimArguments: true };
  }
  return { command: exe, args, cwd, env };
}

/** Runs `exe probeArgs` (bounded); resolves to the first output line on exit code 0, otherwise rejects with the reason. */
export function probeExecutable(exe: string, probeArgs: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let spec: LaunchSpec;
    try { spec = externalLaunch(exe, probeArgs, os.tmpdir()); } catch (e) { reject(e); return; }
    const p = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const take = (c: Buffer) => { if (out.length < 8192) out += c.toString('utf8'); };
    p.stdout!.on('data', take); p.stderr!.on('data', take);
    const timer = setTimeout(() => { p.kill(); reject(new Error(`${path.basename(exe)} ${probeArgs.join(' ')} did not finish in ${timeoutMs / 1000} s`)); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('exit', (code) => {
      clearTimeout(timer);
      const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
      if (code === 0) resolve(first);
      else reject(new Error(`${path.basename(exe)} ${probeArgs.join(' ')} exited with code ${code}${first ? `: ${first.slice(0, 300)}` : ''}`));
    });
  });
}
