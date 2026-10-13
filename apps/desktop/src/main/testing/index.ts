import { spawn, type ChildProcess } from 'node:child_process';
import { discoverTests, type TestFramework, type TestNode } from '../junit';
import { discoverPytest } from './pytest';
import { discoverCargo } from './cargo';

/** Static discovery for every supported framework (no project code runs; safe in Restricted Mode). */
export async function discoverAllTests(root: string): Promise<TestNode[]> {
  const [gradle, pytest, cargo] = await Promise.all([discoverTests(root), discoverPytest(root), discoverCargo(root)]);
  return [...gradle, ...pytest, ...cargo];
}

export function frameworksOf(nodes: TestNode[]): TestFramework[] {
  return (['gradle', 'pytest', 'cargo'] as const).filter((f) => nodes.some((n) => n.framework === f));
}

/** Gradle `--tests` patterns keep the original, stricter alphabet (class/method names and wildcards). */
export const GRADLE_FILTER = /^[A-Za-z0-9_$.*]+$/;

/** Runs a test tool without a shell, in its own process group (killed as a tree), stdin closed. */
export function spawnTool(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, onData: (s: string) => void, onExit: (code: number | null, output: string) => void): ChildProcess {
  const p = spawn(cmd, args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let all = '';
  const take = (b: Buffer) => { const s = b.toString('utf8'); if (all.length < 16 * 1024 * 1024) all += s; onData(s); };
  p.stdout!.on('data', take); p.stderr!.on('data', take);
  let done = false;
  p.on('error', (e) => { if (done) return; done = true; const msg = `\nFailed to start ${cmd}: ${e.message}\n`; onData(msg); onExit(null, all + msg); });
  p.on('close', (code) => { if (done) return; done = true; onExit(code, all); });
  return p;
}
