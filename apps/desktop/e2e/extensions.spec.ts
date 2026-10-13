import { closeApp } from './closeApp';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const appDir = path.resolve(__dirname, '..');
const repo = path.resolve(appDir, '../..');
const cli = path.join(repo, 'packages/extension-api/bin/nova-ext.cjs');
const example = (n: string) => path.join(repo, 'extensions/examples', n);
const fixture = (n: string) => path.join(repo, 'extensions/test-fixtures', n);
const shot = process.env.NOVA_SHOT_DIR;
test.setTimeout(180_000);

async function boot() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-ext-e2e-'));
  const ws = path.join(tmp, 'ws'); await fs.mkdir(ws);
  await fs.writeFile(path.join(ws, 'README.md'), '# Extension test workspace\n');
  await fs.writeFile(path.join(ws, 'demo.nvs'), '# NovaScript sample\nfn greet(name) {\n  let msg = "Hello"\n  return 42\n}\n');
  if (!(await fs.stat(cli).catch(() => null))) execFileSync(process.execPath, ['build.mjs'], { cwd: path.join(repo, 'packages/extension-api') });
  const pkg = path.join(tmp, 'hello-world.novaext');
  execFileSync(process.execPath, [cli, 'pack', example('hello-world'), '-o', pkg]);
  const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox');
  const app = await electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_USER_DATA: path.join(tmp, 'ud'), NOVA_EXT_COMMAND_TIMEOUT_MS: '3000' } });
  const page = await app.firstWindow();
  await pick(app, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await page.getByRole('button', { name: 'Trust Folder' }).click();
  await expect(page.getByRole('status').getByText('Trusted')).toBeVisible();
  await page.getByRole('button', { name: 'Extensions', exact: true }).click();
  return { app, page, ws, pkg };
}
const pick = (app: ElectronApplication, p: string) => app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, p);
async function install(app: ElectronApplication, page: Page, p: string, kind: 'file' | 'folder') {
  await pick(app, p);
  await page.getByRole('button', { name: kind === 'file' ? 'Install from .novaext…' : 'Install from Folder…' }).click();
  const dlg = page.getByRole('alertdialog');
  await expect(dlg).toContainText('SHA-256: ');
  await dlg.getByRole('button', { name: 'Install' }).click();
}
const item = (page: Page, id: string) => page.locator(`[data-ext="${id}"]`);
async function palette(page: Page, text: string) {
  await page.getByRole('button', { name: 'Command Palette' }).click();
  await page.getByLabel('Type a command').fill(text);
  await expect(page.getByRole('dialog', { name: 'Command Palette' }).getByRole('option').first()).toContainText(text.split(':').pop()!.trim());
  await page.keyboard.press('Enter');
}
const output = (page: Page, name: string) => page.getByLabel(`Output: ${name}`);

test('install hello-world (.novaext), run its command, see output/status/message; theme + language contributions apply', async () => {
  const { app, page, ws, pkg } = await boot();
  await install(app, page, pkg, 'file');
  await expect(item(page, 'dheaven.hello-world').locator('[data-status]')).toHaveAttribute('data-status', 'active', { timeout: 20_000 });
  await expect(page.getByTestId('ext-status')).toContainText('activated by onStartupFinished');
  await expect(page.locator('[data-ext-status]')).toContainText('👋 Hello');

  await palette(page, 'Hello World: Say Hello');
  await expect(output(page, 'Hello World')).toContainText('Hello, NOVA! (said 1 time)');
  await expect(output(page, 'Hello World')).toContainText('Hello World activated (API 1.0.0).');
  await expect(page.locator('[data-ext-status]')).toHaveText('👋 Hello ×1');
  await expect(page.locator('.toast')).toContainText('Hello World: Hello, NOVA!');
  await page.locator('[data-ext-status]').click(); // status item runs its command
  await expect(output(page, 'Hello World')).toContainText('said 2 times');

  // Theme: declarative contribution from a folder install, applied to Monaco and the shell.
  await install(app, page, example('custom-theme'), 'folder');
  await expect(item(page, 'dheaven.custom-theme')).toBeVisible();
  await install(app, page, example('sample-language'), 'folder');
  await expect(item(page, 'dheaven.sample-language')).toBeVisible();
  await page.getByRole('button', { name: 'Explorer' }).click();
  await page.getByText('demo.nvs').click();
  await expect(page.getByRole('status')).toContainText('novascript');
  await expect(page.locator('.view-lines .mtk1, .view-lines span span').first()).toBeVisible();
  const fnColor = () => page.evaluate(() => [...document.querySelectorAll('.view-lines span span')].filter((s) => s.textContent === 'fn').map((s) => getComputedStyle(s).color)[0] ?? null);
  await expect.poll(fnColor).not.toBeNull(); // Monarch grammar tokenised 'fn' as its own (keyword) token
  const kw = await fnColor();
  await palette(page, 'Preferences: Color Theme: NOVA Sunset');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--nova-cyan').trim())).toBe('#FF9E64');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.monaco-editor .monaco-editor-background')!).backgroundColor)).toBe('rgb(30, 16, 32)');
  await expect.poll(fnColor).toBe('rgb(255, 122, 144)'); // keyword colour from the theme's tokenColors
  expect(kw).not.toBe('rgb(255, 122, 144)');
  // Snippet from the sample-language extension.
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End'); await page.keyboard.press('Enter');
  await page.keyboard.type('beyo');
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.suggest-widget')).toContainText('beyond');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Extensions', exact: true }).click();
  await item(page, 'dheaven.hello-world').click();
  if (shot) await page.screenshot({ path: path.join(shot, 'nova-extensions.png') });
  // Theme selection is persisted in settings.
  expect(JSON.parse(await fs.readFile(path.join(path.dirname(ws), 'ud', 'settings.json'), 'utf8')).colorTheme).toMatch(/^dheaven\.custom-theme\//);
  await closeApp(app);
});

test('a hanging extension is killed and quarantined; the workbench and other extensions survive', async () => {
  const { app, page, pkg } = await boot();
  await install(app, page, pkg, 'file');
  await expect(item(page, 'dheaven.hello-world').locator('[data-status]')).toHaveAttribute('data-status', 'active', { timeout: 20_000 });
  await install(app, page, fixture('bad-crash'), 'folder');
  await expect(item(page, 'nova-tests.bad-crash')).toBeVisible();
  const pid1 = await page.evaluate(() => window.nova.invoke('ext.hostInfo.v1', {})).then((r) => (r.ok ? r.result.pid : null));
  await palette(page, 'Bad: Hang Forever');
  await expect(item(page, 'nova-tests.bad-crash').locator('[data-status]')).toHaveAttribute('data-status', 'quarantined', { timeout: 20_000 });
  await item(page, 'nova-tests.bad-crash').click();
  await expect(page.getByLabel('Details for Bad Crash (test fixture)').or(page.locator('.ext-details'))).toContainText(/did not respond|timed out|Quarantined/i);
  // Workbench still responsive; hello-world keeps working in a restarted host.
  await palette(page, 'Hello World: Say Hello');
  await expect(output(page, 'Hello World')).toContainText('Hello, NOVA!', { timeout: 20_000 });
  const pid2 = await page.evaluate(() => window.nova.invoke('ext.hostInfo.v1', {})).then((r) => (r.ok ? r.result.pid : null));
  expect(pid2).not.toBeNull(); expect(pid2).not.toBe(pid1);
  await page.getByRole('button', { name: 'Explorer' }).click();
  await page.getByText('README.md').click();
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('still alive ');
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('still alive');
  // Running the quarantined command is refused without touching the host.
  const r = await page.evaluate(() => window.nova.invoke('ext.executeCommand.v1', { command: 'bad.hang' }));
  expect(r).toMatchObject({ ok: false, error: { code: 'EXT_ERROR' } });
  expect(JSON.stringify(r)).toContain('quarantined');
  await closeApp(app);
});

test('permission denial blocks workspace access; undeclared network is denied without a prompt; allow works', async () => {
  const { app, page } = await boot();
  await install(app, page, fixture('net-peeker'), 'folder');
  await expect(item(page, 'nova-tests.net-peeker')).toBeVisible();
  await palette(page, 'Peek: Read README');
  const prompt = page.getByRole('alertdialog', { name: 'Extension permission request' });
  await expect(prompt).toContainText('workspace.read');
  await prompt.getByRole('button', { name: 'Deny' }).click();
  await expect(output(page, 'Peek')).toContainText("DENIED: Permission 'workspace.read' was denied by the user");

  await palette(page, 'Peek: Fetch example.com');
  await expect(output(page, 'Peek')).toContainText(/DENIED: .*network/);
  await expect(prompt).toHaveCount(0); // undeclared: no prompt at all

  // An unremembered answer lasts for this session: asked again only after resetting the permission to "Ask".
  await palette(page, 'Peek: Read README');
  await expect(output(page, 'Peek')).toContainText(/DENIED: Permission 'workspace.read' was denied by the user[\s\S]*DENIED: [\s\S]*DENIED: Permission 'workspace.read' was denied by the user/);
  await expect(prompt).toHaveCount(0);
  await item(page, 'nova-tests.net-peeker').click();
  await page.getByLabel('Permission workspace.read').selectOption('ask');
  await palette(page, 'Peek: Read README');
  await expect(prompt).toBeVisible();
  await prompt.getByLabel('Remember my choice for this extension').check();
  await prompt.getByRole('button', { name: 'Allow' }).click();
  await expect(output(page, 'Peek')).toContainText('README has 27 chars');
  await item(page, 'nova-tests.net-peeker').click();
  await expect(page.getByLabel('Permission workspace.read')).toHaveValue('granted');
  await page.getByLabel('Permission workspace.read').selectOption('denied');
  await palette(page, 'Peek: Read README');
  await expect(output(page, 'Peek')).toContainText("DENIED: Permission 'workspace.read' was denied", { timeout: 10_000 });
  await expect(prompt).toHaveCount(0);
  await closeApp(app);
});
