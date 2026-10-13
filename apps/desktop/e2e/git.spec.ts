import { autoClose, closeApp } from './closeApp';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
autoClose();

const appDir = path.resolve(__dirname, '..');
const fixture = path.resolve(appDir, '../../fixtures/sample-workspace');
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const ident = (cwd: string) => { git(cwd, 'config', 'user.email', 'e2e@example.com'); git(cwd, 'config', 'user.name', 'NOVA E2E'); git(cwd, 'config', 'core.autocrlf', 'false'); };

test('git: branches (dirty-tree warning), discard with confirmation, push/fetch/pull against a local bare remote, ahead/behind', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-e2e-git-'));
  const bare = path.join(tmp, 'remote.git'); const ws = path.join(tmp, 'repo'); const other = path.join(tmp, 'other');
  await fs.mkdir(bare); git(bare, 'init', '-q', '--bare', '-b', 'main');
  await fs.cp(fixture, ws, { recursive: true });
  git(ws, 'init', '-q', '-b', 'main'); ident(ws);
  git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'initial'); git(ws, 'remote', 'add', 'origin', bare);

  const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox');
  const app = await electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_USER_DATA: path.join(tmp, 'ud') } });
  const page = await app.firstWindow();
  let answer = true; const asked: string[] = [];
  page.on('dialog', (d) => { asked.push(d.message()); void (answer ? d.accept() : d.dismiss()); });
  await page.setViewportSize({ width: 1400, height: 860 }).catch(() => {});
  await expect(page.getByText('novad: ready')).toBeVisible();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();

  // Restricted: branch/sync UI is gated
  await page.getByRole('button', { name: 'Restricted Mode' }).click();
  await page.getByRole('button', { name: 'Source Control' }).click();
  await expect(page.getByText('need a trusted workspace')).toBeVisible();
  expect(await page.evaluate(() => window.nova.invoke('git.sync.v1', { op: 'push' }))).toMatchObject({ ok: false, error: { code: 'UNTRUSTED' } });
  await page.locator('.panel-tabs').getByText('Terminal').click();
  await page.getByRole('button', { name: 'Trust Workspace…' }).click();
  await page.getByRole('button', { name: 'Trust Folder' }).click();
  await expect(page.getByLabel('Branches')).toBeVisible();
  const bar = page.getByLabel('Git branch status');
  await expect(bar).toHaveText(/⎇ main$/);

  // push without upstream -> push -u origin main; status bar shows tracking
  await page.getByRole('button', { name: 'Push' }).click();
  await expect(bar).toContainText('↑0 ↓0');
  expect(git(bare, 'rev-parse', 'main').trim()).toBe(git(ws, 'rev-parse', 'HEAD').trim());

  // create + switch branch
  await page.getByLabel('New branch name').fill('feature/nova');
  await page.getByRole('button', { name: 'Create Branch' }).click();
  await expect(page.locator('[data-scm-branch]')).toHaveText('feature/nova');
  expect(git(ws, 'branch', '--show-current').trim()).toBe('feature/nova');

  // dirty tree: switching warns; cancelling keeps the branch
  await fs.writeFile(path.join(ws, 'README.md'), 'local edit\n');
  await expect(page.locator('[data-scm-change="README.md"]')).toBeVisible();
  await page.getByLabel('Branch', { exact: true }).selectOption('main');
  answer = false;
  await page.getByRole('button', { name: 'Switch', exact: true }).click();
  await expect.poll(() => asked.some((m) => m.includes('uncommitted changes'))).toBe(true);
  expect(git(ws, 'branch', '--show-current').trim()).toBe('feature/nova');

  // discard with confirmation (cancel first, then accept)
  asked.length = 0;
  await page.getByRole('button', { name: 'Discard README.md' }).click();
  await expect.poll(() => asked.length).toBe(1);
  expect(await fs.readFile(path.join(ws, 'README.md'), 'utf8')).toBe('local edit\n');
  answer = true;
  await page.getByRole('button', { name: 'Discard README.md' }).click();
  await expect(page.locator('[data-scm-change="README.md"]')).toHaveCount(0);
  expect(git(ws, 'status', '--porcelain').trim()).toBe('');

  // clean switch back to main, commit locally -> ahead 1, push -> 0
  await page.getByLabel('Branch', { exact: true }).selectOption('main');
  await page.getByRole('button', { name: 'Switch', exact: true }).click();
  await expect(page.locator('[data-scm-branch]')).toHaveText('main');
  await fs.writeFile(path.join(ws, 'notes.txt'), 'n\n'); git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'local');
  await page.getByRole('button', { name: 'Fetch' }).click();
  await expect(bar).toContainText('↑1 ↓0');
  await page.getByRole('button', { name: 'Push' }).click();
  await expect(bar).toContainText('↑0 ↓0');

  // someone else pushes -> fetch shows behind, pull fast-forwards
  git(tmp, 'clone', '-q', bare, other); ident(other);
  await fs.writeFile(path.join(other, 'theirs.txt'), 't\n'); git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'theirs'); git(other, 'push', '-q');
  await page.getByRole('button', { name: 'Fetch' }).click();
  await expect(bar).toContainText('↑0 ↓1');
  await page.getByRole('button', { name: 'Pull' }).click();
  await expect(bar).toContainText('↑0 ↓0');
  expect(await fs.readFile(path.join(ws, 'theirs.txt'), 'utf8')).toBe('t\n');
  if (process.env.NOVA_GIT_SHOT) await page.screenshot({ path: process.env.NOVA_GIT_SHOT });
  await closeApp(app);
});
