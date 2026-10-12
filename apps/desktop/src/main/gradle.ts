import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { killTree } from './proc';
import { fileUri } from './lsp/uri';

export interface GradleInfo { isGradle: boolean; wrapper: boolean; buildFile: string | null }
export interface GradleTask { name: string; group: string; description: string }
export interface Problem { uri: string; line: number; col: number; severity: 'error' | 'warning'; message: string; source: string }

export async function detectGradle(root: string): Promise<GradleInfo> {
  const has = (f: string) => fs.access(path.join(root, f)).then(() => true, () => false);
  const buildFile = (await has('build.gradle.kts')) ? 'build.gradle.kts' : (await has('build.gradle')) ? 'build.gradle' : (await has('settings.gradle.kts')) ? 'settings.gradle.kts' : (await has('settings.gradle')) ? 'settings.gradle' : null;
  const wrapper = await has(process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  return { isGradle: !!buildFile || wrapper, wrapper, buildFile };
}

export function gradleCommand(root: string, wrapper: boolean): { cmd: string; pre: string[] } {
  if (!wrapper) return { cmd: process.platform === 'win32' ? 'gradle.bat' : 'gradle', pre: [] };
  if (process.platform === 'win32') return { cmd: 'cmd.exe', pre: ['/d', '/s', '/c', path.join(root, 'gradlew.bat')] };
  return { cmd: path.join(root, 'gradlew'), pre: [] };
}

/** Parses `gradle tasks --all --console=plain` output. */
export function parseTasks(out: string): GradleTask[] {
  const tasks: GradleTask[] = [];
  let group = '';
  const lines = out.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (lines[i + 1] && /^-{3,}$/.test(lines[i + 1]!.trim()) && /tasks$/i.test(l.trim())) { group = l.trim().replace(/ tasks$/i, ''); i++; continue; }
    const m = /^([A-Za-z0-9_:.-]+)(?: - (.*))?$/.exec(l);
    if (group && m && !/^-+$/.test(l) && !l.startsWith('BUILD') && !l.startsWith('To see')) tasks.push({ name: m[1]!, group, description: m[2] ?? '' });
  }
  return tasks;
}

/** javac: `/abs/A.java:12: error: msg`; kotlinc: `e: file:///abs/A.kt:12:5 msg` (also older `e: /abs/A.kt: (12, 5): msg`). */
export function parseProblems(out: string): Problem[] {
  const probs: Problem[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const l = raw.trim(); // Gradle repeats compiler output indented under "What went wrong"
    let m = /^(.+\.java):(\d+): (error|warning): (.*)$/.exec(l);
    if (m) { probs.push({ uri: fileUri(path.resolve(m[1]!)), line: Number(m[2]), col: 1, severity: m[3] as 'error' | 'warning', message: m[4]!, source: 'javac' }); continue; }
    m = /^([ew]): (file:\/\/\S+?\.kts?):(\d+):(\d+) (.*)$/.exec(l);
    if (m) { probs.push({ uri: fileUri(decodeURIComponent(new URL(m[2]!).pathname).replace(/^\/([A-Za-z]:)/, '$1')), line: Number(m[3]), col: Number(m[4]), severity: m[1] === 'e' ? 'error' : 'warning', message: m[5]!, source: 'kotlinc' }); continue; }
    m = /^([ew]): (.+\.kts?): \((\d+), (\d+)\): (.*)$/.exec(l);
    if (m) probs.push({ uri: fileUri(path.resolve(m[2]!)), line: Number(m[3]), col: Number(m[4]), severity: m[1] === 'e' ? 'error' : 'warning', message: m[5]!, source: 'kotlinc' });
  }
  const seen = new Set<string>();
  return probs.filter((p) => { const k = `${p.uri}|${p.line}|${p.col}|${p.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export interface Run { id: number; proc: ChildProcess; output: string[] }

export function runGradle(root: string, info: GradleInfo, args: string[], env: NodeJS.ProcessEnv, onData: (s: string) => void, onExit: (code: number | null, signal: string | null, problems: Problem[]) => void): ChildProcess {
  const { cmd, pre } = gradleCommand(root, info.wrapper);
  const p = spawn(cmd, [...pre, ...args, '--console=plain'], { cwd: root, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let all = '';
  const take = (b: Buffer) => { const s = b.toString('utf8'); if (all.length < 8 * 1024 * 1024) all += s; onData(s); };
  p.stdout!.on('data', take); p.stderr!.on('data', take);
  p.on('error', (e) => { onData(`\nFailed to start Gradle: ${e.message}\n`); onExit(null, null, []); });
  p.on('close', (code, sig) => onExit(code, sig, parseProblems(all)));
  return p;
}

export function killRun(p: ChildProcess) { if (p.pid) killTree(p.pid); }

export async function listTasks(root: string, info: GradleInfo, env: NodeJS.ProcessEnv, timeoutMs = 180_000): Promise<GradleTask[]> {
  return new Promise((resolve, reject) => {
    let out = '';
    const p = runGradle(root, info, ['tasks', '--all', '-q'], env, (s) => { out += s; }, (code) => {
      clearTimeout(t);
      if (code === 0) resolve(parseTasks(out)); else reject(new Error(`gradle tasks failed (exit ${code}):\n${out.slice(-2000)}`));
    });
    const t = setTimeout(() => { killRun(p); reject(new Error('gradle tasks timed out')); }, timeoutMs);
  });
}
