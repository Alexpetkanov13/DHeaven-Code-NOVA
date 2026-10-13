import { autoClose, closeApp } from './closeApp';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
autoClose();

const appDir = path.resolve(__dirname, '..');
const fixture = path.resolve(appDir, '../../fixtures/sample-workspace');
const launch = (ud: string) => { const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox'); return electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_USER_DATA: ud } }); };
const tab = (page: Page, name: string) => page.getByRole('tab').filter({ hasText: name });

test('session restore: workspace, tabs, cursor, unsaved drafts (hot exit) with disk-conflict check', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-e2e-session-'));
  const ws = path.join(tmp, 'ws'); const ud = path.join(tmp, 'ud');
  await fs.cp(fixture, ws, { recursive: true });
  await fs.writeFile(path.join(ws, 'long.ts'), Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');

  let app = await launch(ud);
  let page = await app.firstWindow();
  await expect(page.getByText('novad: ready')).toBeVisible();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await page.getByRole('button', { name: 'Restricted Mode' }).click();

  const quickOpen = async (q: string) => { await page.keyboard.press('Control+P'); await page.getByRole('dialog', { name: 'Go to File' }).getByRole('textbox').fill(q); await page.keyboard.press('Enter'); };
  // long.ts: move the cursor far down (view state restore)
  await quickOpen('long.ts');
  await page.getByLabel('Editor 1').click({ position: { x: 300, y: 5 } });
  await page.keyboard.press('Control+End');
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('status')).toContainText('Ln 199,');
  // hello.ts and README.md: unsaved edits (drafts)
  await quickOpen('hello.ts');
  await page.getByLabel('Editor 1').click({ position: { x: 300, y: 5 } });
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('// draft hello\n');
  await quickOpen('README.md');
  await page.getByLabel('Editor 1').click({ position: { x: 300, y: 5 } });
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('draft readme\n');
  await expect(tab(page, 'README.md').getByLabel('unsaved changes')).toBeVisible();
  await quickOpen('long.ts');
  await expect(page.getByRole('status')).toContainText('Ln 199,');
  await closeApp(app); // window close flushes the session
  expect(await fs.readFile(path.join(ws, 'src/hello.ts'), 'utf8')).not.toContain('draft'); // nothing written to disk

  // While NOVA is closed, README.md changes on disk -> conflict on restore; hello.ts is untouched -> clean restore
  await new Promise((r) => setTimeout(r, 50));
  await fs.writeFile(path.join(ws, 'README.md'), 'changed outside NOVA\n');

  app = await launch(ud);
  page = await app.firstWindow();
  await expect(page.getByLabel('Sidebar')).toContainText('ws');
  await expect(page.getByText('changed on disk after NOVA kept your unsaved changes')).toBeVisible();
  await expect(page.getByLabel('Edit preview')).toHaveText('README.md');
  await page.getByRole('button', { name: 'Use Disk Version' }).click();
  await expect(tab(page, 'README.md').getByLabel('unsaved changes')).toHaveCount(0);
  await expect(tab(page, 'hello.ts').getByLabel('unsaved changes')).toBeVisible();
  await expect(tab(page, 'long.ts')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('status')).toContainText('Ln 199,'); // cursor restored
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('v198');
  await tab(page, 'hello.ts').click();
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('// draft hello');
  await tab(page, 'README.md').click();
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('changed outside NOVA');

  // Keep-my-changes path: edit README again, close, change on disk, restore and keep -> saving overwrites
  await page.getByLabel('Editor 1').click({ position: { x: 300, y: 5 } });
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('mine\n');
  await closeApp(app);
  await fs.writeFile(path.join(ws, 'README.md'), 'outside again\n');
  app = await launch(ud);
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'Keep My Changes' }).click();
  await tab(page, 'README.md').click();
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('mine');
  await expect(tab(page, 'README.md').locator('[data-disk="changed"]')).toBeVisible();
  await page.getByRole('button', { name: 'Command Palette' }).click();
  await page.getByLabel('Type a command').fill('file save');
  await page.keyboard.press('Enter');
  await expect(tab(page, 'README.md').getByLabel('unsaved changes')).toHaveCount(0);
  expect(await fs.readFile(path.join(ws, 'README.md'), 'utf8')).toBe('mine\nchanged outside NOVA\n');
});
