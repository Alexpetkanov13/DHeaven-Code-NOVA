import { autoClose, closeApp } from './closeApp';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
autoClose();

const appDir = path.resolve(__dirname, '..');
const fixture = path.resolve(appDir, '../../fixtures/sample-workspace');
const launch = (ud: string) => { const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox'); return electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_USER_DATA: ud } }); };
const group = (page: Page, n: number) => page.getByLabel(`Editor group ${n}`, { exact: true });
const tabsOf = (page: Page, n: number) => page.getByRole('tablist', { name: `Tabs of editor group ${n}` }).getByRole('tab');

test('split editors: split right/down, shared models, drag tab between groups, layout persists across relaunch', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-e2e-split-'));
  const ws = path.join(tmp, 'ws'); const ud = path.join(tmp, 'ud');
  await fs.cp(fixture, ws, { recursive: true });

  let app = await launch(ud);
  let page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 860 }).catch(() => {});
  await expect(page.getByText('novad: ready')).toBeVisible();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await page.getByRole('button', { name: 'Restricted Mode' }).click();
  await page.getByRole('treeitem', { name: /src/ }).first().click();
  await page.getByRole('treeitem', { name: /hello\.ts/ }).click();
  await expect(tabsOf(page, 1)).toHaveText(['hello.ts×']);

  // Split right: same file in two groups, one shared model
  await page.getByRole('button', { name: 'Split editor group 1 right' }).click();
  await expect(group(page, 2)).toBeVisible();
  await expect(tabsOf(page, 2)).toHaveText(['hello.ts×']);
  await page.getByLabel('Editor 2').locator('.view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// from group 2\n');
  await expect(page.getByLabel('Editor 1').locator('.view-lines')).toContainText('// from group 2');
  await expect(tabsOf(page, 1).first().getByLabel('unsaved changes')).toBeVisible();

  // Open another file into group 2 via Quick Open (focused group)
  await page.keyboard.press('Control+P');
  await page.getByRole('dialog', { name: 'Go to File' }).getByRole('textbox').fill('math');
  await page.keyboard.press('Enter');
  await expect(tabsOf(page, 2)).toHaveText(['hello.ts×', 'math.ts×']);
  await expect(tabsOf(page, 1)).toHaveText(['hello.ts×']);

  // Drag math.ts from group 2 to group 1 (move)
  await tabsOf(page, 2).filter({ hasText: 'math.ts' }).dragTo(tabsOf(page, 1).first());
  await expect(tabsOf(page, 1)).toHaveText(['math.ts×', 'hello.ts×']);
  await expect(tabsOf(page, 2)).toHaveText(['hello.ts×']);
  await expect(page.getByLabel('Editor 1').locator('.view-lines')).toContainText('export const add');

  // Split down from group 2 → 3 groups (layout direction stays row with >1 group)
  await group(page, 2).locator('.view-lines').click();
  await page.keyboard.press('Control+\\');
  await expect(group(page, 3)).toBeVisible();
  if (process.env.NOVA_SHOT_DIR) { await page.waitForTimeout(500); await page.screenshot({ path: path.join(process.env.NOVA_SHOT_DIR, 'nova-split.png') }); }

  // Close group 3; save hello.ts so the relaunch is clean
  await page.getByRole('button', { name: 'Close editor group 3' }).click();
  await expect(group(page, 3)).toHaveCount(0);
  await page.getByLabel('Editor 2').locator('.view-lines').click();
  await page.getByRole('button', { name: 'Command Palette' }).click();
  await page.getByLabel('Type a command').fill('file save');
  await page.keyboard.press('Enter');
  await expect(tabsOf(page, 2).first().getByLabel('unsaved changes')).toHaveCount(0);
  await closeApp(app);

  // Relaunch: the workspace is restored with both groups and their tabs
  app = await launch(ud);
  page = await app.firstWindow();
  await expect(tabsOf(page, 1)).toHaveText(['math.ts×', 'hello.ts×']);
  await expect(tabsOf(page, 2)).toHaveText(['hello.ts×']);
  await expect(page.getByLabel('Editor 2').locator('.view-lines')).toContainText('// from group 2');
});
