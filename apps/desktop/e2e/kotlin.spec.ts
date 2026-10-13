import { autoClose, closeApp } from './closeApp';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
autoClose();

// Best-effort: fwcd/kotlin-language-server lags Kotlin 2.x. Hard asserts cover what NOVA controls
// (start, capability negotiation, sync); server-quality checks are soft and reported in the log.
const appDir = path.resolve(__dirname, '..');
const fixture = path.resolve(appDir, '../../fixtures/kotlin-gradle');
const serversDir = process.env.NOVA_SERVERS_DIR;
test.skip(!serversDir, 'NOVA_SERVERS_DIR with pre-provisioned language servers is required');
/** kotlin-ls quality checks are informational (it often resolves only part of the classpath, e.g. on CI): recorded as annotations, not failures. */
async function bestEffort(what: string, f: () => Promise<unknown>) {
  try { await f(); test.info().annotations.push({ type: 'best-effort', description: `${what}: OK` }); }
  catch (e) { const m = `${what}: NOT MET — ${String((e as Error).message).split('\n').find((l) => l.includes('Received')) ?? ''}`; console.log(`[kotlin best-effort] ${m}`); test.info().annotations.push({ type: 'best-effort', description: m }); }
}
test.setTimeout(900_000);
const card = (page: Page) => page.locator('.ls-card[data-server="kotlin-ls"]');

test('kotlin (best effort): server starts, negotiates, diagnostics/completion soft-checked', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-kt-'));
  const ws = path.join(tmp, 'kotlin-gradle');
  await fs.cp(fixture, ws, { recursive: true });
  const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox');
  const app = await electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_USER_DATA: path.join(tmp, 'ud'), NOVA_SERVERS_DIR: serversDir! } });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await page.getByRole('button', { name: 'Trust Folder' }).click();
  for (const d of ['src', 'src/main', 'src/main/kotlin', 'src/main/kotlin/com', 'src/main/kotlin/com/dheaven', 'src/main/kotlin/com/dheaven/demo']) await page.locator(`.tree [data-rel="${d}"]`).click();
  await page.locator('.tree [data-rel="src/main/kotlin/com/dheaven/demo/Main.kt"]').click();
  await page.getByRole('button', { name: 'Language Servers' }).click();
  await expect(card(page).locator('[data-state]')).toHaveAttribute('data-state', /ready|failed/, { timeout: 600_000 });
  if ((await card(page).locator('[data-state]').getAttribute('data-state')) !== 'ready') {
    await card(page).getByRole('button', { name: 'Logs' }).click();
    await page.waitForTimeout(2000); console.log('kotlin-ls card:\n' + (await card(page).innerText()));
  }
  await expect(card(page).locator('[data-state]')).toHaveAttribute('data-state', 'ready');
  const caps = await card(page).locator('.badge.on').allInnerTexts();
  console.log('kotlin-ls capabilities:', caps.join(', '));
  expect(caps.length).toBeGreaterThan(0);

  const editor = page.locator('.monaco-editor .view-lines').first();
  await editor.locator('.view-line', { hasText: 'println' }).click();
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await page.keyboard.type('val broken: Int = "oops"');
  await page.locator('.panel-tabs').getByText('Problems').click();
  await bestEffort('type-mismatch diagnostic', () => expect(page.getByLabel('Problems')).toContainText(/mismatch|String/i, { timeout: 240_000 }));
  await editor.locator('.view-line', { hasText: 'val broken' }).click();
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await page.keyboard.type('greeter.gr');
  await page.keyboard.press('Control+Space');
  await bestEffort('completion', () => expect(page.locator('.suggest-widget')).toContainText('greet', { timeout: 120_000 }));
  if (process.env.NOVA_SHOT_DIR) await page.screenshot({ path: path.join(process.env.NOVA_SHOT_DIR, 'nova-kotlin.png') });
  await closeApp(app);
});
