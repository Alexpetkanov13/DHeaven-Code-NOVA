import { autoClose, closeApp } from './closeApp';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
autoClose();

// Real js-debug (dapDebugServer.js) in NOVA_SERVERS_DIR/js-debug: the layout of Microsoft's js-debug-dap release.
const appDir = path.resolve(__dirname, '..');
const fixture = path.resolve(appDir, '../../fixtures/node-app');
const shots = process.env.NOVA_SHOT_DIR;
const serversDir = process.env.NOVA_SERVERS_DIR;
const jsDebug = serversDir ? path.join(serversDir, 'js-debug', 'src', 'dapDebugServer.js') : '';
test.skip(!jsDebug || !fs.existsSync(jsDebug), 'js-debug not provisioned in NOVA_SERVERS_DIR/js-debug');
test.setTimeout(300_000);

async function boot(servers: string) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nova-nodedbg-'));
  const ws = path.join(tmp, 'node-app');
  await fsp.cp(fixture, ws, { recursive: true });
  const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox');
  const app = await electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_USER_DATA: path.join(tmp, 'ud'), NOVA_SERVERS_DIR: servers } });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await page.getByRole('button', { name: 'Trust Folder' }).click();
  return { app, page, tmp };
}
async function newNodeConfig(page: Page) {
  await page.getByRole('button', { name: 'Run and Debug' }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Debugger type').selectOption('node');
}
const state = (page: Page) => page.getByLabel('Debug status');
const top = (page: Page) => page.getByLabel('Call stack').locator('.frame').first();

test('node: js-debug child session, breakpoint, variables, console, step, live breakpoint removal, run to exit', async () => {
  const { app, page } = await boot(serversDir!);
  await page.locator('.tree [data-rel="src"]').click();
  await page.locator('.tree [data-rel="src/greeter.js"]').click();
  await page.locator('.monaco-editor .view-lines').first().locator('.view-line', { hasText: 'return greeting' }).click();
  await page.keyboard.press('F9');
  await expect(page.locator('.monaco-editor .nova-bp')).toHaveCount(1);

  await newNodeConfig(page);
  await expect(page.getByLabel('js-debug')).toContainText('servers folder');
  await page.getByLabel('Program', { exact: true }).fill('src/main.js');
  await page.getByRole('button', { name: '▶ Start' }).click();
  await expect(state(page)).toHaveAttribute('data-debug-state', 'stopped', { timeout: 120_000 });
  await expect(state(page)).toContainText('breakpoint');
  await expect(top(page)).toContainText('greet');
  await expect(top(page)).toContainText('greeter.js:3');
  await expect(page.getByLabel('Variables').locator('[data-var="name"]')).toContainText("'NOVA'");
  await page.getByLabel('Evaluate expression').fill('name.toUpperCase() + punctuation');
  await page.getByLabel('Evaluate expression').press('Enter');
  await expect(page.getByLabel('Debug Console')).toContainText("'NOVA!'");
  if (shots) await page.screenshot({ path: path.join(shots, 'nova-debug-node.png') });

  await page.getByRole('button', { name: 'Step Over' }).click();
  await expect(state(page)).toContainText('step', { timeout: 30_000 });
  await page.getByLabel('Breakpoints').getByRole('button', { name: '✕' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(state(page)).toHaveAttribute('data-debug-state', 'terminated', { timeout: 60_000 });
  await expect(page.getByLabel('Debug Console')).toContainText('Hello, Rust!');
  await closeApp(app);
});

test('node: without js-debug, setup guidance and Start disabled; Choose js-debug… enables it', async () => {
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'nova-noservers-'));
  const { app, page, tmp } = await boot(empty);
  await newNodeConfig(page);
  const box = page.getByLabel('js-debug');
  await expect(box).toContainText('Download js-debug-dap-v<version>.tar.gz');
  await expect(box).toContainText('NOVA does not download it');
  await expect(page.getByRole('button', { name: '▶ Start' })).toBeDisabled();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, jsDebug);
  await box.getByRole('button', { name: 'Choose js-debug…' }).click();
  await expect(box).toContainText('chosen by you');
  await page.getByLabel('Program', { exact: true }).fill('src/main.js');
  await expect(page.getByRole('button', { name: '▶ Start' })).toBeEnabled();
  const settings = JSON.parse(await fsp.readFile(path.join(tmp, 'ud', 'settings.json'), 'utf8')) as { debugAdapterPaths: Record<string, string> };
  expect(settings.debugAdapterPaths['js-debug']).toBe(jsDebug);
  await closeApp(app);
});
