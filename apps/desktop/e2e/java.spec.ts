import { autoClose, closeApp } from './closeApp';
import { test, expect, _electron as electron, type Page, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
autoClose();

const appDir = path.resolve(__dirname, '..');
const fixture = path.resolve(appDir, '../../fixtures/java-gradle');
const shots = process.env.NOVA_SHOT_DIR;
const serversDir = process.env.NOVA_SERVERS_DIR; // pre-provisioned JDT LS (tests never download)
test.skip(!serversDir, 'NOVA_SERVERS_DIR with pre-provisioned language servers is required');
test.setTimeout(900_000);

const card = (page: Page, id: string) => page.locator(`.ls-card[data-server="${id}"]`);
async function openRel(page: Page, rel: string) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    const row = page.locator(`.tree [data-rel="${dir}"]`);
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  }
  await page.locator(`.tree [data-rel="${rel}"]`).click();
  await expect(page.locator(`.tab.active[data-rel="${rel}"]`)).toBeVisible();
}

test('java: JDK select, JDT LS diagnostics, completion, definition, crash isolation', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-java-'));
  const ws = path.join(tmp, 'java-gradle');
  await fs.cp(fixture, ws, { recursive: true });
  const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox');
  const app: ElectronApplication = await electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_USER_DATA: path.join(tmp, 'ud'), NOVA_SERVERS_DIR: serversDir! } });
  const page = await app.firstWindow();
  page.on('dialog', (d) => void d.accept());
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await page.getByRole('button', { name: 'Trust Folder' }).click();

  // JDK selection UI: choose a discovered JDK 21 as global default
  await page.getByRole('button', { name: 'Language Servers' }).click();
  const jdkSelect = page.getByLabel('Global JDK');
  const opt = jdkSelect.locator('option', { hasText: /^21 — / }).first();
  await jdkSelect.selectOption(await opt.getAttribute('value') as string);
  await expect(page.getByLabel('Java Development Kits')).toContainText(/effective: .*21/);

  await page.getByRole('button', { name: 'Explorer' }).click();
  await openRel(page, 'src/main/java/com/dheaven/demo/App.java');
  await page.getByRole('button', { name: 'Language Servers' }).click();
  await expect(card(page, 'jdtls').locator('[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 300_000 });
  await expect(card(page, 'jdtls').getByLabel(/capabilities/).locator('.badge.on', { hasText: 'completion' })).toBeVisible();
  await expect(card(page, 'jdtls').getByLabel(/capabilities/).locator('.badge.on', { hasText: 'definition' })).toBeVisible();

  // Deliberate error -> diagnostic in Problems
  const editor = page.locator('.monaco-editor .view-lines').first();
  await editor.locator('.view-line', { hasText: 'System.out.println' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('int broken = "oops";');
  await page.locator('.panel-tabs').getByText('Problems').click();
  await expect(page.getByLabel('Problems')).toContainText(/Type mismatch/i, { timeout: 180_000 });
  await expect(page.locator('.squiggly-error').first()).toBeAttached();
  if (shots) await page.screenshot({ path: path.join(shots, 'nova-java.png') });

  // Completion from the server
  await editor.locator('.view-line', { hasText: 'int broken' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('greeter.gr');
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.suggest-widget')).toContainText('greet', { timeout: 60_000 });
  await page.keyboard.press('Escape');

  // Go to definition: Greeter -> Greeter.java
  await editor.locator('.view-line', { hasText: 'new Greeter' }).click();
  await page.keyboard.press('Home'); // first non-blank: start of the "Greeter" type name
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await page.keyboard.press('F12');
  await expect(page.locator('.tab.active[data-rel="src/main/java/com/dheaven/demo/Greeter.java"]')).toBeVisible({ timeout: 60_000 });

  // Crash isolation: kill the real server process; editor keeps working; server restarts and diagnostics return
  const pidText = await card(page, 'jdtls').getByText(/pid \d+/).innerText();
  const pid = Number(/pid (\d+)/.exec(pidText)![1]);
  process.kill(pid, 'SIGKILL');
  await expect(card(page, 'jdtls').locator('[data-state]')).toHaveAttribute('data-state', /restarting|starting/, { timeout: 30_000 });
  await page.locator('.tab[data-rel="src/main/java/com/dheaven/demo/App.java"]').click();
  await editor.locator('.view-line', { hasText: /greeter\.gr\s*$/ }).click();
  await page.keyboard.press('End');
  await page.keyboard.type('eet("again");');
  await expect(page.locator('.tab.active .dirty')).toBeVisible();
  await expect(card(page, 'jdtls').locator('[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 300_000 });
  const newPid = Number(/pid (\d+)/.exec(await card(page, 'jdtls').getByText(/pid \d+/).innerText())![1]);
  expect(newPid).not.toBe(pid);
  await expect(page.getByLabel('Problems')).toContainText(/Type mismatch/i, { timeout: 180_000 });
  await card(page, 'jdtls').getByRole('button', { name: 'Logs' }).click();
  await expect(card(page, 'jdtls').getByLabel(/logs/)).toContainText('exited');
  if (shots) await page.screenshot({ path: path.join(shots, 'nova-lsp-status.png') });

  await closeApp(app);
});
