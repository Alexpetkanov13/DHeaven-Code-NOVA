import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { packFiles, readFolder } from '@nova/extension-api';
import { ExtensionStore } from './store';
import { ExtensionService } from './service';

// Real extension host process (Electron binary in Node mode + --permission), real example extensions.
const repo = path.resolve(__dirname, '../../../../..');
const examples = path.join(repo, 'extensions/examples');
const fixtures = path.join(repo, 'extensions/test-fixtures');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronBin: string = require('electron');
let hostScript = '';
beforeAll(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-host-'));
  hostScript = path.join(dir, 'extension-host.cjs');
  await build({ entryPoints: [path.resolve(__dirname, '../../exthost/host.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: hostScript, logLevel: 'silent' });
});

async function setup(opts: { trusted?: boolean; answer?: 'granted' | 'denied'; remember?: boolean } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-ext-'));
  const ws = path.join(tmp, 'ws'); await fs.mkdir(ws); await fs.writeFile(path.join(ws, 'README.md'), 'hello readme');
  const store = new ExtensionStore(path.join(tmp, 'exts'), '0.1.0'); await store.load();
  const events: [string, unknown][] = []; const asked: string[] = [];
  const svc = new ExtensionService({
    store, hostScript, execPath: electronBin, commandTimeoutMs: 3000,
    workspace: () => ({ root: ws, trusted: opts.trusted ?? true }),
    emit: (n, p) => events.push([n, p]),
    askPermission: async (_id, _n, perm) => { asked.push(perm); return { grant: opts.answer ?? 'granted', remember: opts.remember ?? false }; },
    fetch: async () => new Response('net ok'),
  });
  const install = async (dir: string) => store.commit((await store.inspect(dir)).token);
  return { tmp, ws, store, svc, events, asked, install };
}
const outputText = (events: [string, unknown][], name: string) => (events.filter(([n, p]) => n === 'ext.output.v1' && (p as { name: string }).name === name).pop()?.[1] as { text: string } | undefined)?.text ?? '';

describe('extension host + service (real host process)', () => {
  it('activates on command, runs it, output channel + status + message + tree; timings and logs recorded', async () => {
    const { svc, events, install } = await setup();
    await install(path.join(examples, 'hello-world'));
    expect(await svc.executeCommand('hello.sayHello')).toBe(1);
    expect(outputText(events, 'Hello World')).toContain('Hello, NOVA! (said 1 time)');
    expect(events.some(([n, p]) => n === 'ext.message.v1' && (p as { message: string }).message === 'Hello, NOVA!')).toBe(true);
    expect(events.some(([n, p]) => n === 'ext.status.v1' && JSON.stringify(p).includes('Hello ×1'))).toBe(true);
    expect(await svc.treeChildren('hello.items', undefined)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'greetings', collapsible: true })]));
    const info = (await svc.list()).find((x) => x.id === 'dheaven.hello-world')!;
    expect(info.status).toBe('active'); expect(info.activationMs).toBeGreaterThanOrEqual(0); expect(info.activatedBy).toBe('onCommand:hello.sayHello');
    expect(svc.logs('dheaven.hello-world').join('\n')).toMatch(/activated by onCommand:hello.sayHello/);
    expect(svc.hostInfo().startupMs).toBeGreaterThan(0);
    await svc.stopAll();
  }, 60_000);

  it('Restricted Mode blocks activation and commands', async () => {
    const { svc, install } = await setup({ trusted: false });
    await install(path.join(examples, 'hello-world'));
    await expect(svc.executeCommand('hello.sayHello')).rejects.toThrow(/Restricted Mode/);
    expect((await svc.list())[0]!.status).toBe('blocked');
    expect(svc.hostInfo().state).toBe('stopped');
  });

  it('permissions: prompt -> granted works; denied blocks; undeclared is refused without prompting', async () => {
    const a = await setup({ answer: 'granted', remember: true });
    await a.install(path.join(fixtures, 'net-peeker'));
    expect(await a.svc.executeCommand('peek.readme')).toBe('hello readme'.length);
    expect(a.asked).toEqual(['workspace.read']);
    expect(a.store.get('nova-tests.net-peeker')!.grants['workspace.read']).toBe('granted');
    await expect(a.svc.executeCommand('peek.net')).rejects.toThrow(/'network' is not declared/);
    expect(a.asked).toEqual(['workspace.read']); // no prompt for undeclared
    await a.svc.stopAll();
    const d = await setup({ answer: 'denied', remember: false });
    await d.install(path.join(fixtures, 'net-peeker'));
    await expect(d.svc.executeCommand('peek.readme')).rejects.toThrow(/denied by the user/);
    expect(outputText(d.events, 'Peek')).toContain('DENIED');
    expect(d.store.get('nova-tests.net-peeker')!.grants).toEqual({});
    await d.svc.stopAll();
  }, 60_000);

  it('sandbox: require("fs") is unavailable to extension code', async () => {
    const { svc, install } = await setup();
    await install(path.join(fixtures, 'bad-crash'));
    await expect(svc.executeCommand('bad.fsEscape')).rejects.toThrow(/Module 'fs' is not available/);
    await svc.stopAll();
  }, 60_000);

  it('crash isolation: a hanging command kills+restarts the host, quarantines the culprit, others keep working', async () => {
    const { svc, install, store } = await setup();
    await install(path.join(examples, 'hello-world'));
    await install(path.join(fixtures, 'bad-crash'));
    expect(await svc.executeCommand('hello.sayHello')).toBe(1);
    const pid1 = svc.hostInfo().pid;
    await expect(svc.executeCommand('bad.hang')).rejects.toThrow(/timed out/);
    await new Promise((r) => setTimeout(r, 1500));
    expect(store.get('nova-tests.bad-crash')!.quarantined).toMatch(/did not respond/);
    await expect(svc.executeCommand('bad.hang')).rejects.toThrow(/quarantined/);
    expect(await svc.executeCommand('hello.sayHello')).toBe(1); // fresh host: module state reset
    expect(svc.hostInfo().pid).not.toBe(pid1);
    await svc.stopAll();
  }, 60_000);

  it('activation errors are per-extension', async () => {
    const { svc, install } = await setup();
    await install(path.join(fixtures, 'bad-throws'));
    await install(path.join(examples, 'hello-world'));
    await svc.fire('onStartupFinished');
    const l = await svc.list();
    expect(l.find((x) => x.id === 'nova-tests.bad-throws')).toMatchObject({ status: 'error', lastError: expect.stringMatching(/boom from activate/) });
    expect(l.find((x) => x.id === 'dheaven.hello-world')!.status).toBe('active');
    await svc.stopAll();
  }, 60_000);
});

describe('store lifecycle', () => {
  it('install .novaext with sidecar sha256, update, rollback, disable, uninstall; tampered sidecar refused', async () => {
    const { store, tmp } = await setup();
    const files = await readFolder(path.join(examples, 'hello-world'));
    const mk = async (version: string) => {
      const f = new Map(files); const m = JSON.parse(new TextDecoder().decode(f.get('nova-extension.json')!)); m.version = version;
      f.set('nova-extension.json', new TextEncoder().encode(JSON.stringify(m)));
      const p = packFiles(f); const file = path.join(tmp, `hello-${version}.novaext`);
      await fs.writeFile(file, p.data); await fs.writeFile(`${file}.sha256`, `${p.sha256}  x\n`); return file;
    };
    const v1 = await mk('1.0.0'); const v2 = await mk('1.1.0');
    const p1 = await store.inspect(v1); expect(p1.sidecar).toBe('match'); await store.commit(p1.token);
    const p2 = await store.inspect(v2); expect(p2).toMatchObject({ isUpdate: true, fromVersion: '1.0.0' }); await store.commit(p2.token);
    expect(store.get('dheaven.hello-world')).toMatchObject({ version: '1.1.0', previous: '1.0.0' });
    await store.rollback('dheaven.hello-world');
    expect(store.get('dheaven.hello-world')).toMatchObject({ version: '1.0.0', previous: '1.1.0' });
    expect((await store.list())[0]!.manifest.version).toBe('1.0.0');
    await store.update('dheaven.hello-world', { enabled: false });
    const reloaded = new ExtensionStore(store.root, '0.1.0'); await reloaded.load();
    expect(reloaded.get('dheaven.hello-world')!.enabled).toBe(false); // persisted
    await fs.writeFile(`${v2}.sha256`, `${'0'.repeat(64)}  x\n`);
    await expect(store.inspect(v2)).rejects.toThrow(/does not match/);
    await store.uninstall('dheaven.hello-world');
    expect(await store.list()).toEqual([]);
    await expect(fs.access(path.join(store.root, 'dheaven.hello-world'))).rejects.toThrow();
  });
  it('rejects incompatible engines and broken manifests before writing anything', async () => {
    const { store, tmp } = await setup();
    const dir = path.join(tmp, 'future'); await fs.cp(path.join(examples, 'custom-theme'), dir, { recursive: true });
    const m = JSON.parse(await fs.readFile(path.join(dir, 'nova-extension.json'), 'utf8')); m.engines.nova = '^9.0.0';
    await fs.writeFile(path.join(dir, 'nova-extension.json'), JSON.stringify(m));
    await expect(store.inspect(dir)).rejects.toThrow(/requires NOVA \^9.0.0/);
    expect(await fs.readdir(store.root)).toEqual([]);
  });
});
