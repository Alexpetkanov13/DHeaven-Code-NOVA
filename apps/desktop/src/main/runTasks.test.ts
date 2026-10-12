import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appliesPlugin, detectRunTasks, eulaAccepted, missingEula, writeEula, type RunTaskContribution } from './runTasks';

const C: RunTaskContribution[] = [
  { extId: 'd.mc', extName: 'MC', view: 'Minecraft', plugin: 'net.fabricmc.fabric-loom', label: 'Fabric', tasks: [{ name: 'runClient', label: 'c', requiresEula: false, runDir: 'run' }, { name: 'runServer', label: 's', requiresEula: true, runDir: 'run' }] },
  { extId: 'd.mc', extName: 'MC', view: 'Minecraft', plugin: 'xyz.jpenilla.run-paper', label: 'Paper', tasks: [{ name: 'runServer', label: 's', requiresEula: true, runDir: 'run' }] },
];
describe('run task discovery + EULA gate', () => {
  it('detects plugin ids in Groovy/Kotlin DSL, ignores comments', () => {
    expect(appliesPlugin(`plugins {\n\tid 'net.fabricmc.fabric-loom' version "\${loom_version}"\n}`, 'net.fabricmc.fabric-loom')).toBe(true);
    expect(appliesPlugin('plugins { id("xyz.jpenilla.run-paper") version "3.1.0" }', 'xyz.jpenilla.run-paper')).toBe(true);
    expect(appliesPlugin("apply plugin: 'fabric-loom'", 'fabric-loom')).toBe(true);
    expect(appliesPlugin('// id("xyz.jpenilla.run-paper")\n/* id("xyz.jpenilla.run-paper") */', 'xyz.jpenilla.run-paper')).toBe(false);
    expect(appliesPlugin("id 'net.fabricmc.fabric-loom'", 'fabric-loom')).toBe(false);
  });
  it('lists tasks per plugin with EULA status; gate blocks until eula.txt says true', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-rt-'));
    expect(await detectRunTasks(root, C)).toEqual([]);
    await fs.writeFile(path.join(root, 'build.gradle.kts'), 'plugins { java; id("xyz.jpenilla.run-paper") version "3.1.0" }');
    const d = await detectRunTasks(root, C);
    expect(d.map((x) => [x.label, x.buildFile, x.tasks.map((t) => [t.name, t.eulaAccepted])])).toEqual([['Paper', 'build.gradle.kts', [['runServer', false]]]]);
    expect(await missingEula(root, ['runServer'], d)).toEqual(['run']);
    expect(await missingEula(root, [':runServer', '--info'], d)).toEqual(['run']);
    expect(await missingEula(root, ['build'], d)).toEqual([]);
    await fs.mkdir(path.join(root, 'run')); await fs.writeFile(path.join(root, 'run/eula.txt'), 'eula=false\n');
    expect(await eulaAccepted(root, 'run')).toBe(false);
    const f = await writeEula(root, 'run');
    expect(await fs.readFile(f, 'utf8')).toMatch(/Accepted by the user[\s\S]*aka\.ms\/MinecraftEULA[\s\S]*^eula=true$/m);
    expect(await missingEula(root, ['runServer'], d)).toEqual([]);
    await expect(writeEula(root, '../outside')).rejects.toThrow();
  });
});
