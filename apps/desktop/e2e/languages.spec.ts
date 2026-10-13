import { autoClose, closeApp } from './closeApp';
import { test, expect, _electron as electron, type Page, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
autoClose();

// Real external language servers (typescript-language-server, Pyright, rust-analyzer) installed by the user's own
// toolchain. NOVA never downloads them; each test is skipped when its server is not on PATH.
const appDir = path.resolve(__dirname, '..');
const fixtures = path.resolve(appDir, '../../fixtures');
const shots = process.env.NOVA_SHOT_DIR;
const isWin = process.platform === 'win32';
test.setTimeout(600_000);

function which(name: string, probe?: string[]): string | null {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.cargo', 'bin'), path.join(os.homedir(), '.local', 'bin')];
  for (const d of dirs) for (const ext of isWin ? ['.exe', '.cmd'] : ['']) {
    const p = path.join(d, name + ext);
    if (!fs.existsSync(p)) continue;
    const viaCmd = isWin && ext === '.cmd';
    if (probe) try { execFileSync(viaCmd ? `"${p}"` : p, probe, { stdio: 'ignore', timeout: 20_000, shell: viaCmd }); } catch { continue; }
    return p;
  }
  return null;
}
const tsls = which('typescript-language-server', ['--version']);
const pyright = which('pyright-langserver');
const ra = which('rust-analyzer', ['--version']);

const card = (page: Page, id: string) => page.locator(`.ls-card[data-server="${id}"]`);
async function openRel(page: Page, rel: string) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const row = page.locator(`.tree [data-rel="${parts.slice(0, i).join('/')}"]`);
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  }
  await page.locator(`.tree [data-rel="${rel}"]`).click();
  await expect(page.locator(`.tab.active[data-rel="${rel}"]`)).toBeVisible();
}
async function launch(fixture: string, env: NodeJS.ProcessEnv = {}): Promise<{ app: ElectronApplication; page: Page; ws: string; tmp: string }> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nova-lang-'));
  const ws = path.join(tmp, fixture);
  await fsp.cp(path.join(fixtures, fixture), ws, { recursive: true });
  const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox');
  const app = await electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_USER_DATA: path.join(tmp, 'ud'), ...env } });
  const page = await app.firstWindow();
  page.on('dialog', (d) => void d.accept());
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await page.getByRole('button', { name: 'Trust Folder' }).click();
  return { app, page, ws, tmp };
}
async function waitReady(page: Page, id: string, timeout = 240_000) {
  await page.getByRole('button', { name: 'Language Servers' }).click();
  await expect(card(page, id).locator('[data-state]')).toHaveAttribute('data-state', 'ready', { timeout });
  await page.getByRole('button', { name: 'Explorer' }).click();
}
const editor = (page: Page) => page.locator('.monaco-editor .view-lines').first();
async function typeAfter(page: Page, lineText: string | RegExp, text: string) {
  await editor(page).locator('.view-line', { hasText: lineText }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
}
async function completionContains(page: Page, text: string) {
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.suggest-widget')).toContainText(text, { timeout: 60_000 });
  await page.keyboard.press('Escape');
}
/** F12, retried like a user would while the server is still analysing (it answers "no definition" until then). */
async function goToDefinition(page: Page, line: string, word: string, targetRel: string) {
  const target = page.locator(`.tab.active[data-rel="${targetRel}"]`);
  for (let i = 0; i < 8 && !(await target.isVisible()); i++) {
    await page.keyboard.press('Escape');
    const l = editor(page).locator('.view-line', { hasText: line }).first();
    await l.getByText(word, { exact: true }).first().click();
    await page.keyboard.press('F12');
    await target.waitFor({ timeout: 10_000 }).catch(() => {});
  }
  await expect(target).toBeVisible();
}
/** Waits until the server reports no work-done progress (indexing, cargo metadata, …). */
async function waitIdle(page: Page, id: string, timeout = 300_000) {
  await page.getByRole('button', { name: 'Language Servers' }).click();
  await expect(card(page, id).locator('[data-progress]')).toHaveCount(0, { timeout });
  await page.getByRole('button', { name: 'Explorer' }).click();
}

test('typescript: project-wide diagnostics, completion, definition from typescript-language-server; Monaco worker switched off', async () => {
  test.skip(!tsls, 'typescript-language-server not on PATH (npm install -g typescript-language-server typescript)');
  const { app, page } = await launch('typescript-node');
  await openRel(page, 'src/main.ts');
  await waitReady(page, 'tsls');
  await page.getByRole('button', { name: 'Language Servers' }).click();
  await expect(card(page, 'tsls')).toContainText('found on PATH');
  await expect(card(page, 'tsls').getByLabel(/capabilities/).locator('.badge.on', { hasText: 'definition' })).toBeVisible();
  await page.getByRole('button', { name: 'Explorer' }).click();

  // Cross-file type error: only a project-aware server knows greet()'s signature from greeter.ts.
  await typeAfter(page, "console.log(greet('NOVA'));", 'greet(42);');
  await page.locator('.panel-tabs').getByText('Problems').click();
  const problems = page.getByLabel('Problems');
  await expect(problems).toContainText(/Argument of type 'number' is not assignable to parameter of type 'string'/, { timeout: 120_000 });
  await expect(problems).not.toContainText(/Cannot find module/); // single-file worker would flag './greeter.js'
  await expect(page.locator('.squiggly-error').first()).toBeAttached();

  await typeAfter(page, 'greet(42);', 'greeter.gre');
  await completionContains(page, 'greetAll');
  await page.keyboard.press('Control+z'); // keep the file compiling apart from the deliberate error

  await goToDefinition(page, "import { greet, Greeter }", 'Greeter', 'src/greeter.ts');
  if (shots) await page.screenshot({ path: path.join(shots, 'nova-typescript.png') });
  await closeApp(app);
});

test('python: Pyright diagnostics, completion, definition', async () => {
  test.skip(!pyright, 'pyright-langserver not on PATH (pipx install pyright)');
  const { app, page } = await launch('python');
  await openRel(page, 'app/main.py');
  await waitReady(page, 'pyright');
  await typeAfter(page, 'print(greet("NOVA"))', 'greet(42)');
  await page.locator('.panel-tabs').getByText('Problems').click();
  await expect(page.getByLabel('Problems')).toContainText(/cannot be assigned to parameter "name"/, { timeout: 120_000 });
  await typeAfter(page, 'greet(42)', 'greeter.gre');
  await completionContains(page, 'greet_all');
  await goToDefinition(page, 'from app.greeter import', 'Greeter', 'app/greeter.py');
  if (shots) await page.screenshot({ path: path.join(shots, 'nova-python.png') });
  await closeApp(app);
});

test('rust: rust-analyzer completion, definition, cargo check diagnostics after save', async () => {
  test.skip(!ra, 'rust-analyzer not available (rustup component add rust-analyzer)');
  const { app, page } = await launch('rust-cargo');
  await openRel(page, 'src/main.rs');
  await waitReady(page, 'rust-analyzer', 400_000);
  await waitIdle(page, 'rust-analyzer');
  await goToDefinition(page, 'use greeter::', 'Greeter', 'src/greeter.rs');
  await page.locator('.tab[data-rel="src/main.rs"]').click();
  await typeAfter(page, 'let greeter = Greeter', 'let broken: i32 = "oops";');
  await page.keyboard.press('Enter');
  await page.keyboard.type('greeter.gre');
  await completionContains(page, 'greet_all');
  await page.keyboard.press('Control+z');
  // Save via the palette (Ctrl+S is a native menu accelerator that synthetic key events don't reach).
  await page.getByRole('button', { name: 'Command Palette' }).click();
  await page.getByLabel('Type a command').fill('file save');
  await page.keyboard.press('Enter');
  await expect(page.locator('.tab[data-rel="src/main.rs"] .dirty')).toHaveCount(0);
  await page.locator('.panel-tabs').getByText('Problems').click();
  await expect(page.getByLabel('Problems')).toContainText(/mismatched types|expected i32/, { timeout: 300_000 });
  if (shots) await page.screenshot({ path: path.join(shots, 'nova-rust.png') });
  await closeApp(app);
});

test('missing server: setup guidance, nothing spawned, then Choose Executable… starts it', async () => {
  test.skip(!pyright, 'needs pyright-langserver to finish the flow');
  // PATH and HOME without the server: NOVA must report "not found" and show the install commands.
  const empty = path.join(os.tmpdir(), 'nova-empty-home');
  // node stays reachable (a system-wide Node install is on PATH for GUI apps) unless the server lives in node's own
  // directory (setup-node/nvm layout): then that directory must stay off PATH, and NOVA's exe-dir-on-PATH launch
  // provides node.
  const nodeDir = path.dirname(process.execPath);
  const keepNode = ['', '.cmd', '.exe'].some((e) => fs.existsSync(path.join(nodeDir, 'pyright-langserver' + e))) ? [] : [nodeDir];
  const bare = [...(isWin ? [`${process.env.SystemRoot}\\System32`] : ['/usr/bin', '/bin']), ...keepNode].join(path.delimiter);
  const { app, page, tmp } = await launch('python', { PATH: bare, Path: bare, HOME: empty, USERPROFILE: empty, APPDATA: empty });
  await openRel(page, 'app/main.py');
  await page.getByRole('button', { name: 'Language Servers' }).click();
  const c = card(page, 'pyright');
  await expect(c.locator('[data-state]')).toHaveAttribute('data-state', 'blocked');
  await expect(c).toContainText('Not found on PATH');
  await expect(c.getByLabel('Pyright setup')).toContainText('pipx install pyright');
  await expect(c.getByRole('button', { name: 'Install…' })).toHaveCount(0); // NOVA never downloads external servers
  await expect(c.getByText(/pid \d+/)).toHaveCount(0);
  if (shots) await page.screenshot({ path: path.join(shots, 'nova-lsp-setup.png') });
  // Editing still works without a server.
  await typeAfter(page, 'print(greet("NOVA"))', '# still editable');
  await expect(page.locator('.tab.active .dirty')).toBeVisible();

  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, pyright!);
  await c.getByRole('button', { name: 'Choose Executable…' }).click();
  await expect(c).toContainText('chosen by you');
  await c.getByRole('button', { name: 'Start' }).click();
  await expect(c.locator('[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 240_000 });
  const settings = JSON.parse(await fsp.readFile(path.join(tmp, 'ud', 'settings.json'), 'utf8')) as { lspServerPaths: Record<string, string> };
  expect(settings.lspServerPaths.pyright).toBe(pyright);
  await c.getByRole('button', { name: 'Use PATH' }).click();
  await expect(c).toContainText('Not found on PATH', { timeout: 30_000 });
  await closeApp(app);
});
