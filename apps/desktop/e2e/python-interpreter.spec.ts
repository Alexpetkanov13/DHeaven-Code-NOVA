import { autoClose, closeApp } from './closeApp';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
autoClose();

// One interpreter choice drives pytest runs, the debugger and Pyright. The workspace gets a bare .venv (no pytest, no
// debugpy, no packages) that the automatic choice picks; selecting the system interpreter (which has pytest) fixes all three.
const appDir = path.resolve(__dirname, '..');
const fixture = path.resolve(appDir, '../../fixtures/python');
const shots = process.env.NOVA_SHOT_DIR;
const isWin = process.platform === 'win32';
const python = isWin ? 'python' : 'python3';
const sys = (() => { try { return execFileSync(python, ['-c', 'import sys, pytest; print(sys.executable)'], { encoding: 'utf8', timeout: 60_000 }).trim(); } catch { return null; } })();
const pyright = (() => { for (const d of (process.env.PATH ?? '').split(path.delimiter)) for (const e of isWin ? ['.cmd', '.exe'] : ['']) if (fs.existsSync(path.join(d, 'pyright-langserver' + e))) return true; return false; })();
test.setTimeout(300_000);

const panel = (page: Page) => page.getByLabel('Workspace Python interpreter');
async function openRel(page: Page, rel: string) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const row = page.locator(`.tree [data-rel="${parts.slice(0, i).join('/')}"]`);
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  }
  await page.locator(`.tree [data-rel="${rel}"]`).click();
}

test('interpreter choice drives pytest runs, the debugger and Pyright', async () => {
  test.skip(!sys, `${python} with pytest is needed`);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nova-pyint-'));
  await fsp.cp(fixture, path.join(tmp, 'python'), { recursive: true, filter: (s) => !/[/\\](__pycache__|\.pytest_cache)$/.test(s) });
  // Canonical path: on Windows CI os.tmpdir() is the 8.3 form (C:\Users\RUNNER~1\…), NOVA reports the long one.
  const ws = await fsp.realpath(path.join(tmp, 'python'));
  execFileSync(sys!, ['-m', 'venv', '--without-pip', path.join(ws, '.venv')], { timeout: 120_000 });
  const venvPy = isWin ? path.join(ws, '.venv', 'Scripts', 'python.exe') : path.join(ws, '.venv', 'bin', 'python');
  const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox');
  const app = await electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_USER_DATA: path.join(tmp, 'ud') } });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await page.getByRole('button', { name: 'Trust Folder' }).click();

  // Automatic choice: the workspace .venv.
  await page.getByRole('button', { name: 'Language Servers' }).click();
  const card = page.locator('[aria-label="Python interpreter"].ls-card');
  await expect(card.locator('[data-python-effective]')).toHaveAttribute('data-python-effective', venvPy, { timeout: 60_000 });
  await expect(card).toContainText('virtualenv .venv');
  await expect(panel(page).locator('option', { hasText: 'workspace .venv' })).toHaveCount(1);

  // 1. pytest runs with it (and says pytest is missing there).
  await page.getByRole('button', { name: 'Testing' }).click();
  await page.getByRole('button', { name: 'Run All' }).click();
  await expect(page.getByLabel('Test summary')).toHaveAttribute('data-done', '1', { timeout: 120_000 });
  await expect(page.getByLabel('Test output')).toContainText(`# Python: ${venvPy} (virtualenv .venv`);
  await expect(page.getByLabel('Test summary')).toContainText(`pytest is not installed for ${venvPy}`);

  // 2. The debugger uses it too (no debugpy there).
  await page.getByRole('button', { name: 'Run and Debug' }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Debugger type').selectOption('python');
  await page.getByLabel('Module').fill('app.main');
  await page.getByRole('button', { name: '▶ Start' }).click();
  await expect(page.getByLabel('Debug Console')).toContainText(`debugpy is not installed for ${venvPy}`, { timeout: 60_000 });

  // 3. Pyright resolves imports against it: pytest is unresolved in the bare venv.
  if (pyright) {
    await page.getByRole('button', { name: 'Explorer', exact: true }).click();
    await openRel(page, 'tests/test_greeter.py');
    await page.locator('.panel-tabs').getByText('Problems').click();
    await expect(page.getByLabel('Problems')).toContainText(/Import "pytest" could not be resolved/, { timeout: 120_000 });
  }

  // Select the system interpreter (it has pytest): every consumer follows.
  await page.getByRole('button', { name: 'Language Servers' }).click();
  const sysOption = panel(page).locator('option', { hasText: '— PATH —' }).first(); // not "Automatic (… else PATH)"
  const sysPath = await sysOption.getAttribute('value');
  await panel(page).selectOption(sysPath!);
  await expect(card).toContainText('selected for this workspace');
  if (shots) await page.screenshot({ path: path.join(shots, 'nova-python-interpreter.png') });
  // With nothing left the Problems list is replaced by its empty-state text, so check the panel body.
  if (pyright) await expect(page.locator('.panel-body').first()).not.toContainText(/Import "pytest" could not be resolved/, { timeout: 120_000 });

  await page.getByRole('button', { name: 'Testing' }).click();
  await page.getByRole('button', { name: 'Run All' }).click();
  await expect(page.getByLabel('Test summary')).toHaveAttribute('data-done', '1', { timeout: 120_000 });
  await expect(page.getByLabel('Test output')).toContainText(`# Python: ${sysPath} (selected for this workspace`);
  await expect(page.getByLabel('Test summary')).toHaveAttribute('data-passed', '4');

  // Persisted per workspace (userData, not the repository).
  const saved = JSON.parse(await fsp.readFile(path.join(tmp, 'ud', 'workspace-settings.json'), 'utf8')) as Record<string, { pythonPath: string }>;
  expect(Object.values(saved)[0]!.pythonPath).toBe(sysPath);
  await closeApp(app);
});
