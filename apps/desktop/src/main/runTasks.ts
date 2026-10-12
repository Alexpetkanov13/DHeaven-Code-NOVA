import fs from 'node:fs/promises';
import path from 'node:path';
import { assertWithin } from './pathGuard';

export interface RunTaskContribution { extId: string; extName: string; view: string; plugin: string; label: string; tasks: { name: string; label: string; requiresEula: boolean; runDir: string }[] }
export interface DetectedRunTasks { extId: string; view: string; label: string; plugin: string; buildFile: string; tasks: { name: string; label: string; requiresEula: boolean; runDir: string; eulaAccepted: boolean | null }[] }

const BUILD_FILES = ['build.gradle.kts', 'build.gradle'];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Matches `id("x")`, `id 'x'`, `id "x" version ...`, and legacy `apply plugin: 'x'`. Comments are stripped first. */
export function appliesPlugin(script: string, plugin: string): boolean {
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1');
  return new RegExp(`(?:\\bid\\s*\\(?\\s*|apply\\s+plugin\\s*:\\s*)["']${esc(plugin)}["']`).test(code);
}

export async function eulaAccepted(root: string, runDir: string): Promise<boolean> {
  const f = path.join(root, runDir, 'eula.txt'); assertWithin(root, f);
  try { return /^\s*eula\s*=\s*true\s*$/im.test(await fs.readFile(f, 'utf8')); } catch { return false; }
}
/** Writes eula.txt — only ever called after the user explicitly accepted the EULA in the consent dialog. */
export async function writeEula(root: string, runDir: string): Promise<string> {
  const dir = path.join(root, runDir); assertWithin(root, dir);
  await fs.mkdir(dir, { recursive: true });
  const f = path.join(dir, 'eula.txt');
  await fs.writeFile(f, `# Accepted by the user in DHeaven Code: NOVA on ${new Date().toISOString()}\n# Minecraft EULA: https://aka.ms/MinecraftEULA\neula=true\n`);
  return f;
}

/** Static detection from the root build script (no Gradle execution, so it works in Restricted Mode). */
export async function detectRunTasks(root: string, contribs: RunTaskContribution[]): Promise<DetectedRunTasks[]> {
  let buildFile: string | null = null; let script = '';
  for (const b of BUILD_FILES) { try { script = await fs.readFile(path.join(root, b), 'utf8'); buildFile = b; break; } catch { /* next */ } }
  if (!buildFile) return [];
  const out: DetectedRunTasks[] = [];
  for (const c of contribs) {
    if (!appliesPlugin(script, c.plugin)) continue;
    out.push({ extId: c.extId, view: c.view, label: c.label, plugin: c.plugin, buildFile,
      tasks: await Promise.all(c.tasks.map(async (t) => ({ ...t, eulaAccepted: t.requiresEula ? await eulaAccepted(root, t.runDir) : null }))) });
  }
  return out;
}

/** Returns the EULA-gated run dirs that a Gradle invocation would need but that are not accepted yet. */
export async function missingEula(root: string, args: string[], detected: DetectedRunTasks[]): Promise<string[]> {
  const names = new Set(args.filter((a) => !a.startsWith('-')).map((a) => a.replace(/^:/, '')));
  const dirs = new Set<string>();
  for (const d of detected) for (const t of d.tasks) if (t.requiresEula && names.has(t.name) && !(await eulaAccepted(root, t.runDir))) dirs.add(t.runDir);
  return [...dirs];
}
