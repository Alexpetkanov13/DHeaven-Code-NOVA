import { closeApp } from './closeApp';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const appDir = path.resolve(__dirname, '..');
const fixture = path.resolve(appDir, '../../fixtures/java-gradle');
const shots = process.env.NOVA_SHOT_DIR;
const serversDir = process.env.NOVA_SERVERS_DIR;
test.setTimeout(900_000);

async function boot(env: Record<string, string>) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-tests-'));
  const ws = path.join(tmp, 'java-gradle');
  await fs.cp(fixture, ws, { recursive: true, filter: (s) => !/[/\\](build|\.gradle|bin)$/.test(s) });
  const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox');
  const app = await electron.launch({ args, cwd: appDir, env: { ...process.env, ...env, NOVA_USER_DATA: path.join(tmp, 'ud'), ...(serversDir ? { NOVA_SERVERS_DIR: serversDir } : {}) } });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await page.getByRole('button', { name: 'Trust Folder' }).click();
  await page.getByRole('button', { name: 'Testing' }).click();
  return { app, page, ws };
}
const summary = (p: Page) => p.getByLabel('Test summary');
const node = (p: Page, id: string) => p.locator(`[data-test-id="${id}"]`);
async function waitDone(p: Page) { await expect(summary(p)).toHaveAttribute('data-done', '1', { timeout: 300_000 }); }

test('tests: discovery, run all with real pass/fail/skip counts, details, rerun failed, run one', async () => {
  const { app, page } = await boot({ NOVA_DEMO_FAIL: '1' });
  for (const id of ['com.dheaven.demo.GreeterTest', 'com.dheaven.demo.GreeterTest.greetsByName', 'com.dheaven.demo.GreeterTest.deliberateFailure', 'com.dheaven.demo.GreeterTest.notYet', 'com.dheaven.demo.MathTest.addition'])
    await expect(node(page, id)).toBeVisible();

  await page.getByRole('button', { name: 'Run All' }).click();
  await waitDone(page);
  await expect(summary(page)).toHaveAttribute('data-passed', '3');
  await expect(summary(page)).toHaveAttribute('data-failed', '1');
  await expect(summary(page)).toHaveAttribute('data-skipped', '1');
  await expect(summary(page)).toHaveAttribute('data-errors', '0');
  await expect(summary(page)).not.toContainText('Exit 0'); // gradle exits nonzero on failures
  await expect(node(page, 'com.dheaven.demo.GreeterTest.deliberateFailure')).toHaveAttribute('data-status', 'failed');
  await expect(node(page, 'com.dheaven.demo.GreeterTest')).toHaveAttribute('data-status', 'failed');
  await expect(node(page, 'com.dheaven.demo.MathTest')).toHaveAttribute('data-status', 'passed');
  await expect(node(page, 'com.dheaven.demo.GreeterTest.notYet')).toHaveAttribute('data-status', 'skipped');
  await node(page, 'com.dheaven.demo.GreeterTest.deliberateFailure').click();
  await expect(page.getByLabel('Test details')).toContainText('expected: <Goodbye, NOVA!> but was: <Hello, NOVA!>');
  await expect(page.getByLabel('Test details')).toContainText('GreeterTest.java:29');
  if (shots) await page.screenshot({ path: path.join(shots, 'nova-tests.png') });
  await node(page, 'com.dheaven.demo.GreeterTest.usesPrefix').click();
  await expect(page.getByLabel('Test details')).toContainText('checking prefix'); // captured stdout

  await page.getByRole('button', { name: 'Rerun Failed' }).click();
  await waitDone(page);
  await expect(page.getByLabel('Test output')).toContainText('--tests com.dheaven.demo.GreeterTest.deliberateFailure');
  await expect(summary(page)).toHaveAttribute('data-failed', '1');
  await expect(summary(page)).toHaveAttribute('data-passed', '3'); // earlier results kept

  await node(page, 'com.dheaven.demo.MathTest.addition').hover();
  await node(page, 'com.dheaven.demo.MathTest.addition').getByTitle('Run').click();
  await waitDone(page);
  await expect(summary(page)).toContainText('Exit 0');
  await expect(node(page, 'com.dheaven.demo.MathTest.addition')).toHaveAttribute('data-status', 'passed');
  await closeApp(app);
});

test('tests: without NOVA_DEMO_FAIL the deliberate failure is skipped and gradle exits 0', async () => {
  const { app, page } = await boot({ NOVA_DEMO_FAIL: '0' });
  await page.getByRole('button', { name: 'Run All' }).click();
  await waitDone(page);
  await expect(summary(page)).toHaveAttribute('data-passed', '3');
  await expect(summary(page)).toHaveAttribute('data-failed', '0');
  await expect(summary(page)).toHaveAttribute('data-skipped', '2');
  await expect(summary(page)).toContainText('Exit 0');
  await closeApp(app);
});

test('tests: debug a single test (gradle --debug-jvm + attach) stops at a breakpoint', async () => {
  test.skip(!serversDir, 'needs JDT LS + java-debug');
  const { app, page } = await boot({ NOVA_DEMO_FAIL: '0' });
  await node(page, 'com.dheaven.demo.MathTest.addition').click(); // opens MathTest.java at the method
  const editor = page.locator('.monaco-editor .view-lines').first();
  await editor.locator('.view-line', { hasText: 'assertTrue(sum' }).click();
  await page.keyboard.press('F9');
  await node(page, 'com.dheaven.demo.MathTest.addition').hover();
  await node(page, 'com.dheaven.demo.MathTest.addition').getByTitle(/Debug test/).click();
  await page.getByRole('button', { name: 'Run and Debug' }).click();
  const st = page.getByLabel('Debug status');
  await expect(st).toHaveAttribute('data-debug-state', 'stopped', { timeout: 600_000 });
  await expect(page.getByLabel('Variables').locator('[data-var="sum"]')).toContainText('5');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(st).toHaveAttribute('data-debug-state', 'terminated', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Testing' }).click();
  await expect(summary(page)).toHaveAttribute('data-done', '1', { timeout: 120_000 });
  await expect(node(page, 'com.dheaven.demo.MathTest.addition')).toHaveAttribute('data-status', 'passed');
  await closeApp(app);
});
