import { execFileSync } from 'node:child_process';
import type { ElectronApplication } from '@playwright/test';

/** Close the app; if it does not exit in time (Windows: child java/LSP processes keep it alive), kill the whole process tree. */
export async function closeApp(app: ElectronApplication, ms = 20_000): Promise<void> {
  const pid = app.process().pid;
  const closed = await Promise.race([app.close().then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
  if (closed || !pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}
