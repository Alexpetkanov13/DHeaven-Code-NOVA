import { execFileSync } from 'node:child_process';
import { test, _electron as electron, type ElectronApplication } from '@playwright/test';

/** Close the app; if it does not exit in time (Windows: child java/LSP processes keep it alive), kill the whole process tree. */
export async function closeApp(app: ElectronApplication, ms = 20_000): Promise<void> {
  live.delete(app);
  const pid = app.process().pid;
  const closed = await Promise.race([app.close().then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
  if (closed || !pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

// Track every launched app so a failing test (which never reaches its own closeApp) still tears down quickly,
// instead of Playwright's worker teardown waiting 180 s on a hung Electron process.
const live = new Set<ElectronApplication>();
const patched = electron as typeof electron & { __novaTracked?: boolean };
if (!patched.__novaTracked) {
  patched.__novaTracked = true;
  const orig = electron.launch.bind(electron);
  electron.launch = async (...a: Parameters<typeof orig>) => { const app = await orig(...a); live.add(app); return app; };
}
/** Call once at the top level of each spec file. */
export function autoClose() {
  test.afterEach(async () => { for (const app of [...live]) await closeApp(app, 10_000); });
}
