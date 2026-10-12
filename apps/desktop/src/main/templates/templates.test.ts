import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { className, renderTemplate, substitute, validateOptions } from './engine';
import { cmpMc, resolveFabric, resolvePaper, type Fetch } from './resolvers';
import { TemplateService } from './service';

const B = path.resolve(__dirname, '../../../../../extensions/bundled/minecraft-dev/templates');
const opts = { name: 'Test Mod', modId: 'testmod', package: 'com.example.testmod', author: 'Ivan', description: 'A test' };
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'nova-tpl-'));

/** Stub of the official endpoints (shape copied from real responses on 2026-10-12). */
const stub = (fail = false): Fetch => async (u) => {
  const body = (s: string) => ({ ok: true, status: 200, text: async () => s });
  if (fail) return { ok: false, status: 503, text: async () => '' };
  if (u.includes('meta.fabricmc.net/v2/versions/game')) return body(JSON.stringify([{ version: '26.4-snapshot-1', stable: false }, { version: '26.3', stable: true }, { version: '26.2', stable: true }, { version: '1.21.11', stable: true }]));
  if (u.includes('versions/loader')) return body(JSON.stringify([{ version: '0.20.0-beta', stable: false }, { version: '0.19.5', stable: true }]));
  if (u.includes('fabric-api/maven-metadata')) return body('<versions><version>0.161.0+26.3</version><version>0.162.0+26.3</version><version>0.150.0+1.21.11</version></versions>');
  if (u.includes('fabric-example-mod')) return body('minecraft_version=26.3\nloom_version=1.18-SNAPSHOT\n');
  if (u.includes('version_manifest_v2')) return body(JSON.stringify({ versions: [{ id: '26.3', url: 'https://m/26.3.json' }, { id: '26.2', url: 'https://m/26.2.json' }] }));
  if (u.startsWith('https://m/')) return body(JSON.stringify({ javaVersion: { majorVersion: 25 } }));
  if (u.includes('fill.papermc.io')) return body(JSON.stringify({ versions: [{ version: { id: '26.3', java: { version: { minimum: 25 } } } }, { version: { id: '26.3-rc-3' } }, { version: { id: '1.21.11', java: { version: { minimum: 21 } } } }, { version: { id: '1.19.4' } }] }));
  if (u.includes('paper-api/maven-metadata')) return body('<version>26.3.build.9-stable</version><version>26.3.build.177-stable</version><version>26.3.build.12-stable</version><version>1.21.11-R0.1-SNAPSHOT</version>');
  if (u.includes('run-paper')) return body('<release>3.1.0</release>');
  return { ok: false, status: 404, text: async () => '' };
};

describe('template engine', () => {
  it('validates options and derives a Java class name', () => {
    expect(validateOptions(opts)).toEqual([]);
    expect(validateOptions({ ...opts, modId: 'Bad Id', package: 'com.class.x', description: 'has "quotes"' }).join('\n')).toMatch(/modId[\s\S]*package[\s\S]*description|modId[\s\S]*description[\s\S]*package/);
    expect(className('my cool-mod 2')).toBe('MyCoolMod2');
    expect(className('123')).toBe('MainPlugin');
  });
  it('fails on unknown variables instead of emitting {{x}}', () => {
    expect(substitute('a {{x}} b', { x: '1' })).toBe('a 1 b');
    expect(() => substitute('{{nope}}', {})).toThrow(/nope/);
    expect(substitute('${version}', {})).toBe('${version}');
  });
  it('refuses a non-empty target and path traversal through variables', async () => {
    const t = await tmp(); await fs.writeFile(path.join(t, 'x'), '');
    await expect(renderTemplate(path.join(B, 'paper-plugin'), null, t, {})).rejects.toThrow(/not empty/);
    const src = await tmp(); await fs.mkdir(path.join(src, '__packagePath__'), { recursive: true }); await fs.writeFile(path.join(src, '__packagePath__', 'A.java'), 'x');
    await expect(renderTemplate(src, null, path.join(await tmp(), 'out'), { packagePath: '../../evil' })).rejects.toThrow(/unsafe/);
  });
});

describe('version resolvers (stubbed official endpoints)', () => {
  it('Fabric: stable 26.1+ only, matching Fabric API build, Java from Mojang metadata', async () => {
    const r = await resolveFabric(stub());
    expect(r.source).toBe('live');
    expect(r.versions).toEqual([{ minecraft: '26.3', javaMajor: 25, deps: { fabricApiVersion: '0.162.0+26.3' } }]); // 26.2 has no Fabric API build in the stub; 1.21.11 needs mappings
    expect(r.shared).toEqual({ loaderVersion: '0.19.5', loomVersion: '1.18-SNAPSHOT' });
  });
  it('Paper: releases ≥1.20.6, newest stable build, Java minimum from Fill', async () => {
    const r = await resolvePaper(stub());
    expect(r.versions.map((v) => [v.minecraft, v.javaMajor, v.deps.paperApiVersion])).toEqual([['26.3', 25, '26.3.build.177-stable'], ['1.21.11', 21, '1.21.11-R0.1-SNAPSHOT']]);
  });
  it('falls back to pinned, labelled versions when offline', async () => {
    for (const r of [await resolveFabric(stub(true)), await resolvePaper(stub(true))]) {
      expect(r.source).toBe('offline-fallback'); expect(r.note).toMatch(/Offline fallback: versions pinned on \d{4}-\d{2}-\d{2}/); expect(r.errors[0]).toMatch(/HTTP 503/);
    }
  });
  it('compares Minecraft versions numerically', () => { expect(cmpMc('26.1', '1.21.11')).toBeGreaterThan(0); expect(cmpMc('26.1.2', '26.1')).toBeGreaterThan(0); expect(cmpMc('1.20.6', '1.20.6')).toBe(0); });
});

const svc = (fetch: Fetch) => new TemplateService({ fetch, templates: async () => (['fabric-mod', 'paper-plugin'] as const).map((id) => ({ key: `dheaven.minecraft-dev/${id}`, extId: 'dheaven.minecraft-dev', extName: 'MC', id, label: id, description: '', resolver: id === 'fabric-mod' ? 'fabric' : 'paper', dir: path.join(B, id), wrapperDir: path.join(B, '_gradle-wrapper') })) });

describe('generation', () => {
  it('renders Fabric + Paper projects with wrapper and resolved versions; rejects versions that were not resolved', async () => {
    const s = svc(stub()); const parent = await tmp();
    const f = await s.generate({ key: 'dheaven.minecraft-dev/fabric-mod', options: opts, minecraft: '26.3', parentDir: parent, folderName: 'fab' });
    expect(f.files).toEqual(expect.arrayContaining(['gradlew', 'gradle/wrapper/gradle-wrapper.jar', '.gitignore', 'src/main/java/com/example/testmod/TestMod.java', 'src/client/java/com/example/testmod/client/TestModClient.java']));
    expect(await fs.readFile(path.join(f.root, 'gradle.properties'), 'utf8')).toMatch(/minecraft_version=26\.3[\s\S]*fabric_api_version=0\.162\.0\+26\.3/);
    expect((await fs.stat(path.join(f.root, 'gradlew'))).mode & 0o111).toBeTruthy();
    expect(JSON.parse(await fs.readFile(path.join(f.root, 'src/main/resources/fabric.mod.json'), 'utf8')).depends.java).toBe('>=25');
    const p = await s.generate({ key: 'dheaven.minecraft-dev/paper-plugin', options: { ...opts, modId: 'testplugin' }, minecraft: '1.21.11', parentDir: parent, folderName: 'pap' });
    expect(await fs.readFile(path.join(p.root, 'build.gradle.kts'), 'utf8')).toMatch(/paper-api:1\.21\.11-R0\.1-SNAPSHOT[\s\S]*release\.set\(21\)[\s\S]*minecraftVersion\("1\.21\.11"\)/);
    await expect(s.generate({ key: 'dheaven.minecraft-dev/paper-plugin', options: opts, minecraft: '9.9', parentDir: parent, folderName: 'x' })).rejects.toThrow(/not one of the resolved/);
    const off = await svc(stub(true)).generate({ key: 'dheaven.minecraft-dev/paper-plugin', options: opts, minecraft: '26.3', parentDir: parent, folderName: 'off' });
    expect(await fs.readFile(path.join(off.root, 'build.gradle.kts'), 'utf8')).toMatch(/Offline fallback: versions pinned on/);
  });

  // Real end-to-end: live official APIs + `./gradlew build`. Opt-in (network + Gradle downloads): NOVA_MC_BUILD=1, JAVA_HOME = JDK 25.
  it.runIf(process.env.NOVA_MC_BUILD === '1')('LIVE: generated Fabric and Paper projects build with ./gradlew build', async () => {
    const s = svc((u) => fetch(u)); const parent = await tmp();
    for (const [key, modId] of [['dheaven.minecraft-dev/fabric-mod', 'livemod'], ['dheaven.minecraft-dev/paper-plugin', 'liveplugin']] as const) {
      const r = await s.resolve(key); expect(r.source).toBe('live');
      const g = await s.generate({ key, options: { ...opts, modId }, minecraft: r.versions[0]!.minecraft, parentDir: parent, folderName: modId });
      execFileSync('./gradlew', ['build', '--no-daemon', '-q'], { cwd: g.root, stdio: 'inherit', timeout: 1_500_000 });
      expect((await fs.readdir(path.join(g.root, 'build/libs'))).some((x) => x.startsWith(`${modId}-1.0.0`))).toBe(true);
    }
  }, 1_800_000);
});
