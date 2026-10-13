import { autoClose } from './closeApp';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
autoClose();

const appDir = path.resolve(__dirname, '..');
const fixture = path.resolve(appDir, '../../fixtures/sample-workspace');

test('navigation: Quick Open (Ctrl+P), Go to Symbol (Ctrl+Shift+O), breadcrumbs, back/forward', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-e2e-nav-'));
  const ws = path.join(tmp, 'ws');
  await fs.cp(fixture, ws, { recursive: true });
  await fs.writeFile(path.join(ws, 'src/util/shapes.ts'), [
    'export class Circle {', '  constructor(public r: number) {}', '  area(): number {', '    return Math.PI * this.r * this.r;', '  }', '}',
    ...Array.from({ length: 30 }, (_, i) => `// filler ${i}`),
    'export function perimeter(c: Circle): number {', '  return 2 * Math.PI * c.r;', '}', ''].join('\n'));
  await fs.mkdir(path.join(ws, 'ignored'));
  await fs.writeFile(path.join(ws, 'ignored/shapes-copy.ts'), '');
  await fs.writeFile(path.join(ws, '.gitignore'), 'ignored/\n');
  await fs.mkdir(path.join(ws, '.git')); // so .gitignore applies to the novad walker

  const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox');
  const app = await electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_USER_DATA: path.join(tmp, 'ud') } });
  const page = await app.firstWindow();
  await expect(page.getByText('novad: ready')).toBeVisible();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await page.getByRole('button', { name: 'Restricted Mode' }).click();

  // Quick Open: fuzzy, honours .gitignore
  await page.keyboard.press('Control+P');
  const qo = page.getByRole('dialog', { name: 'Go to File' });
  await expect(qo).toBeVisible();
  await qo.getByRole('textbox').fill('hello');
  await expect(qo.getByRole('option').first()).toContainText('src/hello.ts');
  await page.keyboard.press('Enter');
  await expect(page.locator('.tab.active')).toContainText('hello.ts');
  await expect(page.getByLabel('Breadcrumbs')).toContainText('src›hello.ts');

  await page.keyboard.press('Control+P'); // works with focus inside Monaco
  await qo.getByRole('textbox').fill('shapes');
  await expect(qo.getByRole('option')).toHaveCount(1);
  await expect(qo.getByRole('option')).toContainText('src/util/shapes.ts');
  await page.keyboard.press('Enter');
  await expect(page.locator('.tab.active')).toContainText('shapes.ts');

  // Go to Symbol (TypeScript worker outline)
  await page.locator('.monaco-editor textarea').first().focus();
  await page.keyboard.press('Control+Shift+O');
  const gs = page.getByRole('dialog', { name: 'Go to Symbol' });
  await expect(gs.getByRole('option').filter({ hasText: 'area' })).toContainText('Circle');
  await gs.getByRole('textbox').fill('perim');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('Ln 37,');
  await expect(page.getByLabel('Breadcrumbs')).toContainText('perimeter');

  await page.keyboard.press('Control+Shift+O');
  await gs.getByRole('textbox').fill('area');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('Ln 3,');
  await expect(page.getByLabel('Breadcrumbs')).toContainText('Circle›area');

  // Back: area → perimeter → hello.ts; Forward again
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.getByRole('status')).toContainText('Ln 37,');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.getByRole('status')).toContainText('Ln 1,'); // shapes.ts opened at line 1
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('.tab.active')).toContainText('hello.ts');
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.locator('.tab.active')).toContainText('shapes.ts');
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.getByRole('status')).toContainText('Ln 37,');
});
