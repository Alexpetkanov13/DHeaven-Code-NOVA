import { autoClose, closeApp } from './closeApp';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
autoClose();

// Real pytest and cargo test runs in the Testing view. Skipped when the tool is not installed.
const appDir = path.resolve(__dirname, '..');
const fixtures = path.resolve(appDir, '../../fixtures');
const shots = process.env.NOVA_SHOT_DIR;
const python = process.platform === 'win32' ? 'python' : 'python3';
const ok = (cmd: string, args: string[]) => { try { execFileSync(cmd, args, { stdio: 'ignore', timeout: 60_000 }); return true; } catch { return false; } };
const hasPytest = ok(python, ['-m', 'pytest', '--version']);
const hasCargo = ok('cargo', ['--version']);
test.setTimeout(600_000);

async function boot(fixture: string) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-tl-'));
  const ws = path.join(tmp, fixture);
  await fs.cp(path.join(fixtures, fixture), ws, { recursive: true, filter: (s) => !/[/\\](target|__pycache__|\.pytest_cache)$/.test(s) });
  const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox');
  const app = await electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_DEMO_FAIL: '1', NOVA_USER_DATA: path.join(tmp, 'ud') } });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await page.getByRole('button', { name: 'Trust Folder' }).click();
  await page.getByRole('button', { name: 'Testing' }).click();
  return { app, page };
}
const summary = (p: Page) => p.getByLabel('Test summary');
const node = (p: Page, id: string) => p.locator(`[data-test-id="${id}"]`);
async function waitDone(p: Page) { await expect(summary(p)).toHaveAttribute('data-done', '1', { timeout: 400_000 }); }
async function counts(p: Page, passed: number, failed: number, skipped: number) {
  await expect(summary(p)).toHaveAttribute('data-passed', String(passed));
  await expect(summary(p)).toHaveAttribute('data-failed', String(failed));
  await expect(summary(p)).toHaveAttribute('data-skipped', String(skipped));
}

test('pytest: static discovery, run all (params, skip, failure), details with captured output, rerun failed, run one', async () => {
  test.skip(!hasPytest, `pytest not installed for ${python}`);
  const { app, page } = await boot('python');
  for (const id of ['tests/test_greeter.py::test_greets_by_name', 'tests/test_greeter.py::test_greets_each', 'tests/test_greeter.py::TestGreeter', 'tests/test_greeter.py::TestGreeter::test_deliberate_failure'])
    await expect(node(page, id)).toBeVisible();
  await expect(page.locator('.fw-badge').first()).toHaveText('pytest');

  await page.getByRole('button', { name: 'Run All' }).click();
  await waitDone(page);
  await counts(page, 4, 1, 1); // greets_by_name, each[Java], each[Rust], prefix | deliberate_failure | not_yet
  await expect(page.getByLabel('Test output')).toContainText('-m pytest');
  await expect(node(page, 'tests/test_greeter.py::test_greets_each')).toHaveAttribute('data-status', 'passed'); // both params
  await expect(node(page, 'tests/test_greeter.py::TestGreeter')).toHaveAttribute('data-status', 'failed');
  await expect(node(page, 'tests/test_greeter.py::test_not_yet')).toHaveAttribute('data-status', 'skipped');

  await node(page, 'tests/test_greeter.py::TestGreeter::test_deliberate_failure').click();
  await expect(page.getByLabel('Test details')).toContainText("AssertionError: assert 'Hello, NOVA?' == 'Hello, NOVA!'");
  await node(page, 'tests/test_greeter.py::test_greets_by_name').click();
  await expect(page.getByLabel('Test details')).toContainText('greeting NOVA');
  await node(page, 'tests/test_greeter.py::test_greets_each').click();
  await expect(page.getByLabel('Test details')).toContainText('test_greets_each[Java]');
  if (shots) await page.screenshot({ path: path.join(shots, 'nova-pytest.png') });

  await page.getByRole('button', { name: 'Rerun Failed' }).click();
  await waitDone(page);
  await expect(page.getByLabel('Test output')).toContainText('-- tests/test_greeter.py::TestGreeter::test_deliberate_failure');
  await expect(page.getByLabel('Test output')).toContainText('1 failed');
  await expect(summary(page)).toHaveAttribute('data-failed', '1');

  await node(page, 'tests/test_greeter.py::TestGreeter::test_prefix').hover();
  await node(page, 'tests/test_greeter.py::TestGreeter::test_prefix').getByTitle('Run').click();
  await waitDone(page);
  await expect(page.getByLabel('Test output')).toContainText('1 passed');
  await expect(summary(page)).toContainText('Exit 0');
  await closeApp(app);
});

test('cargo test: static discovery, run all, ignored reason, panic details, --show-output stdout, rerun failed, run one', async () => {
  test.skip(!hasCargo, 'cargo not installed');
  const { app, page } = await boot('rust-cargo');
  for (const id of ['src/greeter.rs#greeter::tests', 'greeter::tests::greets_by_name', 'greeter::tests::not_yet', 'greeter::tests::deliberate_failure'])
    await expect(node(page, id)).toBeVisible();

  await page.getByRole('button', { name: 'Run All' }).click();
  await waitDone(page);
  await counts(page, 2, 1, 1);
  await expect(summary(page)).toContainText('Exit 101');
  await expect(node(page, 'src/greeter.rs#greeter::tests')).toHaveAttribute('data-status', 'failed');
  await node(page, 'greeter::tests::deliberate_failure').click();
  await expect(page.getByLabel('Test details')).toContainText('assertion `left == right` failed');
  await expect(page.getByLabel('Test details')).toContainText(/panicked at src[\\/]greeter\.rs:39/); // rustc prints src\greeter.rs on Windows
  await node(page, 'greeter::tests::greets_by_name').click();
  await expect(page.getByLabel('Test details')).toContainText('greeting NOVA');
  await node(page, 'greeter::tests::not_yet').click();
  await expect(page.getByLabel('Test details')).toContainText('not implemented yet');
  if (shots) await page.screenshot({ path: path.join(shots, 'nova-cargo-test.png') });

  await page.getByRole('button', { name: 'Rerun Failed' }).click();
  await waitDone(page);
  await expect(page.getByLabel('Test output')).toContainText('--exact greeter::tests::deliberate_failure');
  await expect(page.getByLabel('Test output')).toContainText('1 failed');

  await node(page, 'greeter::tests::greets_by_name').hover();
  await node(page, 'greeter::tests::greets_by_name').getByTitle('Run').click();
  await waitDone(page);
  await expect(summary(page)).toContainText('Exit 0');
  await expect(node(page, 'greeter::tests::greets_by_name')).toHaveAttribute('data-status', 'passed');
  await closeApp(app);
});
