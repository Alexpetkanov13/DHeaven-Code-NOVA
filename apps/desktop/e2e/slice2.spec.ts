import { closeApp } from './closeApp';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const appDir = path.resolve(__dirname, '..');
const fixture = path.resolve(appDir, '../../fixtures/sample-workspace');
const shots = process.env.NOVA_SHOT_DIR;
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const exists = (p: string) => fs.access(p).then(() => true, () => false);

async function confirmOrPermanent(page: Page, rel: string) {
  await page.getByRole('button', { name: 'Move to Trash' }).click();
  // Trash can fail in containers (no trash dir); then NOVA asks to delete permanently. That fallback can
  // take several seconds on a loaded box, so wait until either the dialog appears or the dialog layer closes.
  const perm = page.getByRole('button', { name: 'Delete Permanently' });
  await expect.poll(async () => (await perm.isVisible()) || (await page.locator(`.tree [data-rel="${rel}"]`).count()) === 0, { timeout: 30_000 }).toBe(true);
  if (await perm.isVisible()) await perm.click();
}

test('explorer ops, watcher, search/replace, terminal, git stage+commit, trust', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-e2e2-'));
  const ws = path.join(tmp, 'repo');
  await fs.cp(fixture, ws, { recursive: true });
  git(ws, 'init', '-q', '-b', 'main');
  git(ws, 'config', 'user.email', 'e2e@example.com'); git(ws, 'config', 'user.name', 'NOVA E2E');
  git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'initial');

  const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox');
  const app = await electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_USER_DATA: path.join(tmp, 'ud') } });
  const page = await app.firstWindow();
  page.on('dialog', (d) => void d.accept());
  await page.setViewportSize({ width: 1400, height: 860 }).catch(() => {});
  await expect(page.getByText('novad: ready')).toBeVisible();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();

  // --- Trust: restricted first, terminal must be blocked (UI and IPC)
  await page.getByRole('button', { name: 'Restricted Mode' }).click();
  await page.locator('.panel-tabs').getByText('Terminal').click();
  await expect(page.getByText('Terminal is disabled in Restricted Mode.')).toBeVisible();
  expect(await page.evaluate(() => window.nova.invoke('terminal.spawn.v1', { cols: 80, rows: 24 }))).toMatchObject({ ok: false, error: { code: 'UNTRUSTED' } });

  // --- Explorer: create, rename, delete
  await page.getByRole('button', { name: 'New File' }).click();
  await page.getByRole('textbox', { name: 'New file name' }).fill('notes.md');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-rel="notes.md"]').first()).toBeVisible();
  expect(await exists(path.join(ws, 'notes.md'))).toBe(true);
  await page.locator('.tree [data-rel="notes.md"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await page.getByRole('textbox', { name: 'Rename notes.md' }).fill('renamed.md');
  await page.keyboard.press('Enter');
  await expect(page.locator('.tree [data-rel="renamed.md"]')).toBeVisible();
  expect(await exists(path.join(ws, 'renamed.md'))).toBe(true);
  await page.locator('.tree [data-rel="renamed.md"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await confirmOrPermanent(page, 'renamed.md');
  await expect(page.locator('.tree [data-rel="renamed.md"]')).toHaveCount(0);
  expect(await exists(path.join(ws, 'renamed.md'))).toBe(false);
  await expect(page.locator('.tab[data-rel="renamed.md"] [data-disk="deleted"]')).toBeVisible();
  await page.getByRole('button', { name: 'Close renamed.md' }).click();

  // --- Watcher: external edits refresh tree and open (clean) tab
  await page.locator('.tree [data-rel="src"]').click();
  await page.locator('.tree [data-rel="src/hello.ts"]').click();
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('Hello');
  await fs.writeFile(path.join(ws, 'src/hello.ts'), 'export function hello(name: string): string {\n  return `Hello there, ${name}!`;\n}\n');
  await fs.writeFile(path.join(ws, 'external.txt'), 'made outside NOVA\n');
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('Hello there');
  await expect(page.locator('.tree [data-rel="external.txt"]')).toBeVisible();

  // --- Search + replace preview/apply
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByLabel('Search query').fill('Hello');
  await expect(page.getByLabel('Search status')).toContainText('result');
  await expect(page.getByLabel('Search results')).toContainText('src/hello.ts');
  await page.getByLabel('Replace with').fill('Greetings');
  await expect(page.getByLabel('Search results').locator('ins').first()).toHaveText('Greetings');
  if (shots) await page.screenshot({ path: path.join(shots, 'nova-search.png') });
  await page.getByRole('button', { name: 'Replace All' }).click();
  await expect.poll(() => fs.readFile(path.join(ws, 'src/hello.ts'), 'utf8')).toContain('Greetings there');
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('Greetings there');

  // --- Trust, then real terminal
  await page.getByRole('button', { name: 'Trust Workspace…' }).click();
  await page.getByRole('button', { name: 'Trust Folder' }).click();
  await expect(page.locator('.xterm')).toBeVisible();
  await page.locator('.xterm').click();
  await page.waitForTimeout(1500); // let the shell print its prompt
  await page.keyboard.type('echo NOVA_$((6*7)) && pwd\n');
  await expect(page.locator('.xterm-rows')).toContainText('NOVA_42');
  await expect(page.locator('.xterm-rows')).toContainText(path.basename(ws));
  if (shots) await page.screenshot({ path: path.join(shots, 'nova-terminal.png') });

  // --- Git: diff, stage, commit
  await page.getByRole('button', { name: 'Source Control' }).click();
  await expect(page.locator('[data-scm-change="src/hello.ts"]')).toBeVisible();
  await page.locator('[data-scm-change="src/hello.ts"]').click();
  await expect(page.getByLabel('Diff editor').locator('.monaco-diff-editor')).toBeVisible();
  await page.getByRole('button', { name: 'Stage src/hello.ts' }).click();
  await expect(page.locator('[data-scm-staged="src/hello.ts"]')).toBeVisible();
  expect(git(ws, 'diff', '--cached', '--name-only').trim()).toBe('src/hello.ts');
  await page.locator('[data-scm-staged="src/hello.ts"]').click();
  await page.getByLabel('Commit message').fill('NOVA e2e: greet differently');
  await page.waitForTimeout(800);
  if (shots) await page.screenshot({ path: path.join(shots, 'nova-git.png') });
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.locator('[data-scm-staged="src/hello.ts"]')).toHaveCount(0);
  expect(git(ws, 'log', '-1', '--format=%s').trim()).toBe('NOVA e2e: greet differently');
  expect(git(ws, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('src/hello.ts');
  await closeApp(app);
});
