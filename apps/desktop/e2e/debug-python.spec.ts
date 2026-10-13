import { autoClose, closeApp } from './closeApp';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
autoClose();

// Real debugpy (installed with pip by the user; NOVA never downloads it). Skipped when it isn't installed.
const appDir = path.resolve(__dirname, '..');
const fixture = path.resolve(appDir, '../../fixtures/python');
const shots = process.env.NOVA_SHOT_DIR;
const python = process.platform === 'win32' ? 'python' : 'python3';
const has = (mod: string) => { try { execFileSync(python, ['-c', `import ${mod}`], { stdio: 'ignore', timeout: 60_000 }); return true; } catch { return false; } };
const hasDebugpy = has('debugpy');
test.setTimeout(300_000);

async function boot() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-pydbg-'));
  const ws = path.join(tmp, 'python');
  await fs.cp(fixture, ws, { recursive: true, filter: (s) => !/[/\\](__pycache__|\.pytest_cache)$/.test(s) });
  const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox');
  const app = await electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_USER_DATA: path.join(tmp, 'ud') } });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await page.getByRole('button', { name: 'Trust Folder' }).click();
  return { app, page };
}
async function openRel(page: Page, rel: string) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const row = page.locator(`.tree [data-rel="${parts.slice(0, i).join('/')}"]`);
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  }
  await page.locator(`.tree [data-rel="${rel}"]`).click();
  await expect(page.locator(`.tab.active[data-rel="${rel}"]`)).toBeVisible();
}
async function breakpointAt(page: Page, rel: string, lineText: string) {
  if (!(await page.locator('.tree').isVisible())) await page.getByRole('button', { name: 'Explorer', exact: true }).click(); // clicking the active view collapses the sidebar
  await openRel(page, rel);
  await page.locator('.monaco-editor .view-lines').first().locator('.view-line', { hasText: lineText }).click();
  await page.keyboard.press('F9');
  await expect(page.locator('.monaco-editor .nova-bp')).toHaveCount(1);
}
const state = (page: Page) => page.getByLabel('Debug status');
const top = (page: Page) => page.getByLabel('Call stack').locator('.frame').first();

test('python: debugpy launch config, breakpoint, variables, console, step out, live breakpoint removal, exit code', async () => {
  test.skip(!hasDebugpy, `debugpy not installed for ${python}`);
  const { app, page } = await boot();
  await breakpointAt(page, 'app/greeter.py', 'return f"Hello');

  await page.getByRole('button', { name: 'Run and Debug' }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Debugger type').selectOption('python');
  await expect(page.getByLabel('Main class')).toHaveCount(0); // Java-only fields are gone
  await page.getByLabel('Config name').fill('Run app');
  await page.getByLabel('Module').fill('app.main');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: '▶ Start' }).click();

  await expect(state(page)).toHaveAttribute('data-debug-state', 'stopped', { timeout: 120_000 });
  await expect(state(page)).toContainText('breakpoint');
  await expect(page.getByLabel('Debug Console')).toContainText(/Python: .* · debugpy \d/);
  await expect(top(page)).toContainText('greet');
  await expect(top(page)).toContainText('greeter.py');
  await expect(page.locator('.monaco-editor .nova-debug-line')).toBeVisible();
  await expect(page.getByLabel('Variables').locator('[data-var="name"]')).toContainText("'NOVA'");
  await page.getByLabel('Evaluate expression').fill('name.upper() + punctuation');
  await page.getByLabel('Evaluate expression').press('Enter');
  await expect(page.getByLabel('Debug Console')).toContainText("'NOVA!'");
  if (shots) await page.screenshot({ path: path.join(shots, 'nova-debug-python.png') });

  await page.getByRole('button', { name: 'Step Out' }).click();
  await expect(state(page)).toContainText('step', { timeout: 30_000 });
  await expect(top(page)).toContainText('main.py');
  // greet() runs three times; removing the breakpoint during the session lets the program finish.
  await page.getByLabel('Breakpoints').getByRole('button', { name: '✕' }).click();
  await expect(page.getByLabel('Breakpoints').locator('.row-item')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(state(page)).toHaveAttribute('data-debug-state', 'terminated', { timeout: 60_000 });
  await expect(page.getByLabel('Debug Console')).toContainText('> Hello, Rust!');
  await expect(page.getByLabel('Debug Console')).toContainText('exited with code 0');
  await closeApp(app);
});

test('python: 🐞 on a pytest test runs it under debugpy and stops inside the test', async () => {
  test.skip(!hasDebugpy || !has('pytest'), `debugpy and pytest needed for ${python}`);
  const { app, page } = await boot();
  await breakpointAt(page, 'tests/test_greeter.py', 'assert greet("NOVA") == "Hello, NOVA!"');
  await page.getByRole('button', { name: 'Testing' }).click();
  const n = page.locator('[data-test-id="tests/test_greeter.py::test_greets_by_name"]');
  await n.hover();
  await n.getByTitle(/Debug test/).click();
  await page.getByRole('button', { name: 'Run and Debug' }).click();
  await expect(state(page)).toHaveAttribute('data-debug-state', 'stopped', { timeout: 120_000 });
  await expect(top(page)).toContainText('test_greets_by_name');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(state(page)).toHaveAttribute('data-debug-state', 'terminated', { timeout: 60_000 });
  await expect(page.getByLabel('Debug Console')).toContainText('1 passed');
  await closeApp(app);
});
