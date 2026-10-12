import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const appDir = path.resolve(__dirname, '..');
const fixture = path.resolve(appDir, '../../fixtures/sample-workspace');
const shot = process.env.NOVA_SCREENSHOT;

async function launch(userData: string): Promise<ElectronApplication> {
  const args = ['.'];
  if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox'); // container lacks SUID chrome-sandbox
  return electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_USER_DATA: userData } });
}

test('open folder, edit, save, relaunch shows recent', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-e2e-'));
  const ws = path.join(tmp, 'sample-workspace');
  await fs.cp(fixture, ws, { recursive: true });
  const userData = path.join(tmp, 'userdata');

  let app = await launch(userData);
  let page = await app.firstWindow();
  await expect(page.getByText('Build Beyond Limits.')).toBeVisible();

  // Security: renderer has no Node, only the frozen nova API; CSP header is served.
  const sec = await page.evaluate(async () => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    api: Object.keys(window.nova).sort(),
    frozen: Object.isFrozen(window.nova),
    csp: (await fetch('nova://app/index.html')).headers.get('content-security-policy'),
  }));
  expect(sec).toMatchObject({ require: 'undefined', process: 'undefined', api: ['invoke', 'onMenu'], frozen: true });
  expect(sec.csp).toContain("script-src 'self'");
  // Unknown channel and path traversal are rejected by main.
  const bad = await page.evaluate(() => window.nova.invoke('fs.exec.v1' as never, {} as never));
  expect(bad).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CHANNEL' } });

  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await page.locator('[data-rel="src"]').click();
  await page.locator('[data-rel="src/hello.ts"]').click();
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('Hello');

  const escape = await page.evaluate(() => window.nova.invoke('fs.read.v1', { rel: '../../etc/passwd' }));
  expect(escape).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });

  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// edited by NOVA e2e');
  await expect(page.locator('.tab.active .dirty')).toBeVisible();

  // Save through the command palette (exercises palette + IPC write path)
  await page.getByRole('button', { name: 'Command Palette' }).click();
  await page.getByLabel('Type a command').fill('file save');
  await page.keyboard.press('Enter');
  await expect(page.locator('.tab.active .dirty')).toHaveCount(0);
  expect(await fs.readFile(path.join(ws, 'src/hello.ts'), 'utf8')).toContain('// edited by NOVA e2e');
  expect((await fs.readdir(path.join(ws, 'src'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  if (shot) await page.screenshot({ path: shot });
  await app.close();

  app = await launch(userData);
  page = await app.firstWindow();
  await expect(page.getByRole('list', { name: 'Recent workspaces' })).toContainText('sample-workspace');
  const settings = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8').catch(() => '{}'));
  expect(typeof settings).toBe('object');
  await app.close();
});
