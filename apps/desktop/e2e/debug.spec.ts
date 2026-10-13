import { autoClose, closeApp } from './closeApp';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
autoClose();

const appDir = path.resolve(__dirname, '..');
const fixture = path.resolve(appDir, '../../fixtures/java-gradle');
const shots = process.env.NOVA_SHOT_DIR;
const serversDir = process.env.NOVA_SERVERS_DIR; // pre-provisioned JDT LS + java-debug (tests never download)
test.skip(!serversDir, 'NOVA_SERVERS_DIR with pre-provisioned JDT LS + java-debug is required');
test.setTimeout(900_000);

async function openRel(page: Page, rel: string) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const row = page.locator(`.tree [data-rel="${parts.slice(0, i).join('/')}"]`);
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  }
  await page.locator(`.tree [data-rel="${rel}"]`).click();
  await expect(page.locator(`.tab.active[data-rel="${rel}"]`)).toBeVisible();
}
async function boot(extraEnv: Record<string, string> = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-dbg-'));
  const ws = path.join(tmp, 'java-gradle');
  await fs.cp(fixture, ws, { recursive: true, filter: (s) => !/[/\\](build|\.gradle|bin)$/.test(s) });
  const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox');
  const app = await electron.launch({ args, cwd: appDir, env: { ...process.env, ...extraEnv, NOVA_USER_DATA: path.join(tmp, 'ud'), NOVA_SERVERS_DIR: serversDir! } });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await page.getByRole('button', { name: 'Trust Folder' }).click();
  return { app, page, ws };
}
const state = (page: Page) => page.getByLabel('Debug status');

test('debug: breakpoint hit, local variable, watch + console evaluate, step, continue to exit', async () => {
  const { app, page } = await boot();
  await openRel(page, 'src/main/java/com/dheaven/demo/Greeter.java');
  const editor = page.locator('.monaco-editor .view-lines').first();
  await editor.locator('.view-line', { hasText: 'return prefix' }).click();
  await page.keyboard.press('F9');
  await expect(page.locator('.monaco-editor .nova-bp')).toHaveCount(1);

  await page.getByRole('button', { name: 'Run and Debug' }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Config name').fill('Launch App');
  await page.getByLabel('Main class').fill('com.dheaven.demo.App');
  await page.getByLabel('preLaunch task').fill('classes');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByLabel('Launch configuration')).toHaveValue(/cfg-/);
  await page.getByRole('button', { name: '▶ Start' }).click();

  await expect(state(page)).toHaveAttribute('data-debug-state', 'stopped', { timeout: 600_000 });
  await expect(state(page)).toContainText('breakpoint');
  await expect(page.getByLabel('Call stack').locator('.frame').first()).toContainText('greet');
  await expect(page.locator('.monaco-editor .nova-debug-line')).toBeVisible();
  await expect(page.locator('.tab.active[data-rel="src/main/java/com/dheaven/demo/Greeter.java"]')).toBeVisible();
  await expect(page.getByLabel('Variables').locator('[data-var="name"]')).toContainText('"NOVA"');
  await page.getByLabel('Add watch expression').fill('prefix + "!"');
  await page.getByLabel('Add watch expression').press('Enter');
  await expect(page.locator('[data-watch=\'prefix + "!"\']')).toContainText('Hello!');
  await page.getByLabel('Evaluate expression').fill('name.length()');
  await page.getByLabel('Evaluate expression').press('Enter');
  await expect(page.getByLabel('Debug Console')).toContainText('4');
  if (shots) await page.screenshot({ path: path.join(shots, 'nova-debug.png') });

  // greet() is a single statement, so Step Out from the breakpoint returns to the caller, App.main (line 6); then
  // Step Over runs the println and stays in main. (Stepping out of main itself would land in JDK Thread code.)
  const top = page.getByLabel('Call stack').locator('.frame').first();
  await page.getByRole('button', { name: 'Step Out' }).click();
  await expect(state(page)).toHaveAttribute('data-debug-state', 'stopped', { timeout: 30_000 });
  await expect(state(page)).toContainText('step');
  await expect(top).toContainText('main', { timeout: 30_000 });
  await expect(top).toContainText('App.java');
  await page.getByRole('button', { name: 'Step Over' }).click();
  await expect(page.getByLabel('Debug Console')).toContainText('Hello, NOVA!', { timeout: 30_000 });
  await expect(state(page)).toHaveAttribute('data-debug-state', 'stopped', { timeout: 30_000 });
  await expect(top).toContainText('App.java');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(state(page)).toHaveAttribute('data-debug-state', 'terminated', { timeout: 60_000 });
  await expect(page.getByLabel('Debug Console')).toContainText('Hello, NOVA!');
  // java-debug reports the exit code only if it reads it before the VM dies (DAP trace on Windows CI: 'terminated' without 'exited').
  await expect(page.getByLabel('Debug Console')).toContainText(/exited with code 0|did not report an exit code/);
  await closeApp(app);
});
