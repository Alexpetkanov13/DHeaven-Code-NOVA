import { closeApp } from './closeApp';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const appDir = path.resolve(__dirname, '..');
const shot = process.env.NOVA_SHOT_DIR;
const runServer = process.env.NOVA_E2E_MC_SERVER === '1'; // real Paper server start (downloads Paper, ~1-3 min)
test.setTimeout(900_000);

const pick = (app: ElectronApplication, p: string) => app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, p);
async function openRel(page: Page, rel: string) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const row = page.locator(`.tree [data-rel="${parts.slice(0, i).join('/')}"]`);
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  }
  await page.locator(`.tree [data-rel="${rel}"]`).click();
  await expect(page.locator(`.tab.active[data-rel="${rel}"]`)).toBeVisible();
}
async function openWorkspace(app: ElectronApplication, page: Page, dir: string) {
  await pick(app, dir);
  await page.getByRole('button', { name: 'Command Palette' }).click();
  await page.getByLabel('Type a command').fill('File: Open Folder');
  await page.keyboard.press('Enter');
  const trust = page.getByRole('button', { name: 'Trust Folder' });
  await trust.click();
  await expect(page.getByRole('status').getByText('Trusted')).toBeVisible();
}
async function createProject(page: Page, template: RegExp, name: string, location: string, shotPath?: string) {
  const dlg = page.getByRole('dialog', { name: 'New Project' });
  await dlg.getByRole('radio', { name: template }).check();
  const src = dlg.getByTestId('version-source');
  await expect(src).toHaveAttribute('data-resolver', /Fabric/.test(String(template)) ? 'fabric' : 'paper', { timeout: 60_000 });
  await expect(src).toHaveAttribute('data-source', /live|offline-fallback/);
  console.log(`[${name}] versions: ${(await src.textContent())?.slice(0, 300)}`);
  await dlg.getByLabel('Project name').fill(name);
  await dlg.getByLabel('Location').fill(location);
  await expect(dlg.getByLabel('JDK')).toContainText(/JDK 2[5-9]/); // MC 26.x requires Java 25; older JDKs hidden
  if (shotPath) await page.screenshot({ path: shotPath });
  const source = await src.getAttribute('data-source');
  await dlg.getByRole('button', { name: 'Create' }).click();
  await expect(dlg.getByLabel('Project created')).toBeVisible({ timeout: 30_000 });
  return { source, root: (await dlg.getByTestId('created-root').textContent())! };
}

test('Minecraft pack: wizard creates Fabric + Paper, schemas diagnose, Skript highlighted, Minecraft view lists run tasks (+EULA)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-mc-e2e-'));
  const projects = path.join(tmp, 'projects'); await fs.mkdir(projects);
  const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox');
  const app = await electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_USER_DATA: path.join(tmp, 'ud') } });
  const page = await app.firstWindow();

  // --- Wizard from the welcome screen (no workspace needed)
  await page.getByRole('button', { name: 'New Project…' }).click();
  const fab = await createProject(page, /Fabric mod/, 'Nova Fabric', projects, shot && path.join(shot, 'nova-mc-wizard.png'));
  expect(fab.root).toBe(path.join(projects, 'novafabric'));
  await page.getByRole('dialog', { name: 'New Project' }).getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'New Project…' }).click();
  const pap = await createProject(page, /Paper plugin/, 'Nova Paper', projects);
  expect(pap.root).toBe(path.join(projects, 'novapaper'));
  await page.getByRole('dialog', { name: 'New Project' }).getByRole('button', { name: 'Close' }).click();
  console.log(`version sources: fabric=${fab.source} paper=${pap.source}`);
  for (const f of ['gradlew', 'gradle/wrapper/gradle-wrapper.jar', 'build.gradle', 'gradle.properties', 'src/main/resources/fabric.mod.json', 'src/main/java/com/example/novafabric/NovaFabric.java']) await fs.access(path.join(fab.root, f));
  for (const f of ['gradlew', 'build.gradle.kts', 'src/main/resources/plugin.yml', 'src/main/java/com/example/novapaper/NovaPaper.java']) await fs.access(path.join(pap.root, f));
  expect(await fs.readFile(path.join(pap.root, 'build.gradle.kts'), 'utf8')).toMatch(/xyz\.jpenilla\.run-paper/);

  // --- Fabric workspace: Minecraft view + fabric.mod.json diagnostics + Skript
  await openWorkspace(app, page, fab.root);
  await page.getByRole('button', { name: 'Minecraft', exact: true }).click();
  const fabGroup = page.getByLabel('Fabric (Loom) run tasks');
  await expect(fabGroup.locator('[data-task="runClient"]')).toBeVisible();
  await expect(fabGroup.locator('[data-task="runServer"]')).toContainText('EULA required');

  await page.getByRole('button', { name: 'Explorer' }).click();
  await openRel(page, 'src/main/resources/fabric.mod.json');
  await expect(page.locator('.squiggly-error')).toHaveCount(0);
  const editor = page.locator('.monaco-editor .view-lines').first();
  await editor.locator('.view-line', { hasText: '"id": "novafabric"' }).click();
  await page.keyboard.press('End');
  for (let i = 0; i < '"novafabric",'.length; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('"Invalid Id!",');
  await expect(page.locator('.squiggly-error').first()).toBeAttached({ timeout: 20_000 });
  const marker = await page.evaluate(() => (window as unknown as { __novaMarkers?: () => string[] }).__novaMarkers?.() ?? []);
  console.log('fabric.mod.json markers:', marker);
  expect(marker.join('\n')).toMatch(/pattern|does not match/i);

  // Skript: highlighted with the contributed grammar (syntax only)
  await fs.writeFile(path.join(fab.root, 'hello.sk'), '# greet players\non join:\n\tsend "Welcome, %player%!" to player\n\tset {joins::%uuid of player%} to 1\n\ncommand /hello:\n\ttrigger:\n\t\tbroadcast "hi"\n');
  await openRel(page, 'hello.sk');
  await expect(page.locator('footer')).toContainText('skript');
  const classes = await editor.locator('.view-line span span').evaluateAll((els) => els.map((e) => `${e.className}:${e.textContent}`));
  console.log('skript tokens:', classes.slice(0, 14).join(' | '));
  expect(new Set(classes.map((c) => c.split(':')[0])).size).toBeGreaterThanOrEqual(4);
  // Indentation: Enter after a line ending in ':' indents
  await editor.locator('.view-line', { hasText: 'broadcast "hi"' }).click();
  await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await page.keyboard.type('every 5 minutes:'); await page.waitForTimeout(300); await page.keyboard.press('Escape'); await page.keyboard.press('Enter'); await page.keyboard.type('x');
  const text = (await page.evaluate(() => (window as unknown as { __novaModelText: (s: string) => string | null }).__novaModelText('/hello.sk')))!;
  const lines = text.split('\n'); const i = lines.findIndex((l) => l.includes('every 5 minutes:'));
  console.log('after enter:', JSON.stringify(lines.slice(i - 1, i + 2)));
  const ind = (l: string) => /^\s*/.exec(l)![0].replace(/\t/g, '    ').length;
  expect(ind(lines[i + 1]!)).toBeGreaterThan(ind(lines[i]!)); // colon-ending line → next line indented
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');

  // --- Paper workspace: plugin.yml YAML diagnostics, Minecraft view, EULA consent
  await openWorkspace(app, page, pap.root);
  await openRel(page, 'src/main/resources/plugin.yml');
  await page.waitForTimeout(500);
  console.log('plugin.yml initial markers:', await page.evaluate(() => (window as unknown as { __novaMarkers: () => string[] }).__novaMarkers().filter((m) => m.startsWith('plugin.yml'))));
  await expect(page.locator('.squiggly-error')).toHaveCount(0);
  await editor.locator('.view-line', { hasText: /^main:/ }).click();
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+End'); await page.keyboard.type('load: LATER');
  await expect(page.locator('.squiggly-error').first()).toBeAttached({ timeout: 20_000 });
  const ymarkers = await page.evaluate(() => (window as unknown as { __novaMarkers?: () => string[] }).__novaMarkers?.() ?? []);
  console.log('plugin.yml markers:', ymarkers);
  expect(ymarkers.join('\n')).toMatch(/Missing required property "main"/);
  expect(ymarkers.join('\n')).toMatch(/Must be one of: "STARTUP", "POSTWORLD"/);
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');

  await page.getByRole('button', { name: 'Minecraft', exact: true }).click();
  const papGroup = page.getByLabel('Paper (run-paper) run tasks');
  const task = papGroup.locator('[data-task="runServer"]');
  await expect(task).toContainText('EULA required');
  if (shot) await page.screenshot({ path: path.join(shot, 'nova-mc-view.png') });

  // Main refuses to run an EULA-gated task without consent, even if asked directly.
  const direct = await page.evaluate(() => window.nova.invoke('gradle.run.v1', { args: ['runServer'] }));
  expect(JSON.stringify(direct)).toMatch(/EULA not accepted/);
  // Decline: nothing written.
  await task.getByRole('button', { name: 'Run' }).click();
  const eula = page.getByRole('alertdialog', { name: 'Minecraft EULA' });
  await expect(eula).toContainText('https://aka.ms/MinecraftEULA');
  await expect(eula.getByRole('button', { name: 'Accept and run' })).toBeDisabled();
  await eula.getByRole('button', { name: 'Decline' }).click();
  await expect(fs.access(path.join(pap.root, 'run/eula.txt'))).rejects.toThrow();

  if (runServer) {
    await task.getByRole('button', { name: 'Run' }).click();
    await eula.getByLabel('I have read and accept the Minecraft EULA').check();
    await eula.getByRole('button', { name: 'Accept and run' }).click();
    expect(await fs.readFile(path.join(pap.root, 'run/eula.txt'), 'utf8')).toMatch(/^eula=true$/m);
    const out = page.getByLabel('Minecraft run output');
    await expect(out).toContainText(/Done \([\d.,]+s\)!/, { timeout: 600_000 });
    await expect(out).toContainText('[NovaPaper] Nova Paper enabled'); // the generated plugin's onEnable log
    expect((await out.textContent())!.match(/> /g)?.length ?? 0).toBeLessThan(50); // no console-prompt flood (stdin kept open)
    await expect(task).toContainText('EULA accepted');
    if (shot) await page.screenshot({ path: path.join(shot, 'nova-mc-view.png') });
    await page.getByLabel('Server console command').fill('list'); await page.keyboard.press('Enter');
    await expect(out).toContainText(/There are 0 of a max of \d+ players online/, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Stop', exact: true }).click(); // graceful: console `stop`
    await expect(out).toContainText('Stopping server', { timeout: 60_000 });
    await expect(page.locator('.mc-run-h')).toContainText(/exited with|stopped/, { timeout: 120_000 });
  }
  await closeApp(app);
});
