import { autoClose, closeApp } from './closeApp';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
autoClose();

const appDir = path.resolve(__dirname, '..');
const fixture = path.resolve(appDir, '../../fixtures/sample-workspace');
const win = process.platform === 'win32';

async function boot(tmp: string, ws: string) {
  const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox');
  const app = await electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_USER_DATA: path.join(tmp, 'ud') } });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 860 }).catch(() => {});
  await expect(page.getByText('novad: ready')).toBeVisible();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  return { app, page };
}
const rows = (page: Page, label: string) => page.locator(`[data-term-pane="${label}"] .xterm-rows`);
async function run(page: Page, label: string, cmd: string) {
  await page.locator(`[data-term-pane="${label}"] .xterm`).click();
  await page.keyboard.type(`${cmd}\n`);
}

test('terminals: tabs, split, per-terminal kill, profile choice persists', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-e2e-term-'));
  const ws = path.join(tmp, 'ws');
  await fs.cp(fixture, ws, { recursive: true });
  let { app, page } = await boot(tmp, ws);
  await page.getByRole('button', { name: 'Trust Folder' }).click();
  await page.locator('.panel-tabs').getByText('Terminal').click();

  const profile = page.getByLabel('Terminal profile');
  await expect(profile.locator('option')).not.toHaveCount(0);
  const ids = await profile.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  await expect(rows(page, 'Terminal 1')).toBeVisible();
  await page.waitForTimeout(1500);
  await run(page, 'Terminal 1', 'echo ONE_$((1+1))'.replace('$((1+1))', win ? '$(1+1)' : '$((1+1))'));
  await expect(rows(page, 'Terminal 1')).toContainText('ONE_2');

  // split: a second, independent shell next to the first
  await page.getByRole('button', { name: 'Split' }).click();
  await expect(rows(page, 'Terminal 2')).toBeVisible();
  await page.waitForTimeout(1500);
  await run(page, 'Terminal 2', 'echo TWO_OK');
  await expect(rows(page, 'Terminal 2')).toContainText('TWO_OK');
  await expect(rows(page, 'Terminal 1')).not.toContainText('TWO_OK');

  // second tab with a different profile (cmd on Windows, sh on Unix) and the choice is saved
  const other = ids.find((id) => id === (win ? 'cmd' : 'sh')) ?? ids[ids.length - 1]!;
  await profile.selectOption(other);
  await page.getByRole('button', { name: 'New Terminal' }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(rows(page, 'Terminal 3')).toBeVisible();
  await page.waitForTimeout(1500);
  await run(page, 'Terminal 3', 'echo THREE_OK');
  await expect(rows(page, 'Terminal 3')).toContainText('THREE_OK');
  await expect(page.locator('[data-term-pane="Terminal 3"] .term-pane-head')).toContainText(win && other === 'cmd' ? 'Command Prompt' : other);

  // per-terminal kill: only that pane goes away
  await page.getByRole('tab').first().click();
  if (process.env.NOVA_SHOT_DIR || process.env.NOVA_TERM_SHOT) await page.screenshot({ path: process.env.NOVA_TERM_SHOT ?? path.join(process.env.NOVA_SHOT_DIR!, 'nova-terminals.png') });
  await page.getByRole('button', { name: 'Kill Terminal 2' }).click();
  await expect(page.locator('[data-term-pane="Terminal 2"]')).toHaveCount(0);
  await run(page, 'Terminal 1', 'echo STILL_ALIVE');
  await expect(rows(page, 'Terminal 1')).toContainText('STILL_ALIVE');

  await closeApp(app);
  ({ app, page } = await boot(tmp, ws));
  await page.locator('.panel-tabs').getByText('Terminal').click();
  await expect(page.getByLabel('Terminal profile')).toHaveValue(other);
  await closeApp(app);
});
