import { spawn } from 'node:child_process';

/** Kill a process and all its descendants. Unix: children are spawned detached (own process group). Windows: taskkill /T. */
export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM') {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    return;
  }
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
  if (signal !== 'SIGKILL') setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
}
