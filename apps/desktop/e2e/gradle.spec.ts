import { autoClose, closeApp } from './closeApp';
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
autoClose();

const appDir = path.resolve(__dirname, '..');
const fixture = path.resolve(appDir, '../../fixtures/java-gradle');
test.setTimeout(700_000);

test('gradle: tasks via wrapper, build output + exit 0, javac error -> Problems + nonzero exit, kill', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-gradle-'));
  const ws = path.join(tmp, 'java-gradle');
  await fs.cp(fixture, ws, { recursive: true, filter: (s) => !/[/\\](build|\.gradle)$/.test(s) });
  const args = ['.']; if (process.env.NOVA_E2E_NO_SANDBOX) args.unshift('--no-sandbox');
  const app = await electron.launch({ args, cwd: appDir, env: { ...process.env, NOVA_USER_DATA: path.join(tmp, 'ud') } });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, ws);
  await page.getByRole('button', { name: 'Open Folder…' }).click();
  await page.getByRole('button', { name: 'Trust Folder' }).click();
  await page.getByRole('button', { name: 'Gradle', exact: true }).click();
  const view = page.locator('.view.gradle');
  await expect(view).toContainText('build.gradle.kts · Gradle wrapper');

  await view.getByRole('button', { name: /Load Tasks/ }).click();
  await expect(view.locator('[data-task="build"]')).toBeVisible({ timeout: 300_000 });
  await expect(view.locator('[data-task="sleepDemo"]')).toBeVisible();

  const status = page.getByLabel('Gradle run status');
  const outp = page.getByLabel('Gradle output');
  await view.locator('[data-task="build"]').getByRole('button').click();
  await expect(status).toHaveAttribute('data-run-state', 'done', { timeout: 300_000 });
  await expect(status).toHaveAttribute('data-exit-code', '0');
  await expect(outp).toContainText('BUILD SUCCESSFUL');
  await expect(status).toContainText('Exit code 0');
  if (process.env.NOVA_SHOT_DIR) await page.screenshot({ path: path.join(process.env.NOVA_SHOT_DIR, 'nova-gradle.png') });

  // Deliberate compile error -> javac problem in Problems panel, nonzero exit.
  const app_java = path.join(ws, 'src/main/java/com/dheaven/demo/App.java');
  const src = await fs.readFile(app_java, 'utf8');
  await fs.writeFile(app_java, src.replace(/(public static void main\([^)]*\)\s*\{)/, '$1\n        int broken = "oops";'));
  const input = page.getByLabel('Gradle arguments');
  await input.fill('compileJava'); await input.press('Enter');
  await expect(status).toHaveAttribute('data-run-state', 'done', { timeout: 300_000 });
  await expect(status).not.toHaveAttribute('data-exit-code', '0');
  await expect(outp).toContainText('BUILD FAILED');
  await expect(status).toContainText('1 compiler problem(s)');
  await page.locator('.panel-tabs').getByText('Problems').click();
  await expect(page.getByLabel('Problems')).toContainText('[javac]');
  await expect(page.getByLabel('Problems')).toContainText('App.java');
  if (process.env.NOVA_SHOT_DIR) await page.screenshot({ path: path.join(process.env.NOVA_SHOT_DIR, 'nova-gradle-fail.png') });

  // Kill a long task.
  await input.fill('sleepDemo'); await input.press('Enter');
  await expect(outp).toContainText('> Task :sleepDemo', { timeout: 120_000 });
  await view.getByRole('button', { name: 'Kill' }).click();
  await expect(status).toContainText('Killed', { timeout: 30_000 });
  await closeApp(app);
});
