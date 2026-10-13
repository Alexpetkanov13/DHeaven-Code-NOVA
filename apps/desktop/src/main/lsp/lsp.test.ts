import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { FrameDecoder, encodeFrame } from './jsonrpc';
import { canonicalUri, fileUri, mapUris, serverUri } from './uri';
import { LspConnection } from './server';
import { LspManager, badges, progressText } from './manager';
import type { ServerDef } from './registry';

const fake = path.join(__dirname, 'fake-server.cjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 10000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(25); } }

describe('jsonrpc framing', () => {
  it('decodes split, merged and multibyte frames', () => {
    const got: unknown[] = [];
    const d = new FrameDecoder((m) => got.push(m));
    const a = encodeFrame({ x: 'é😀' }), b = encodeFrame({ y: 2 });
    const all = Buffer.concat([a, b]);
    for (let i = 0; i < all.length; i += 7) d.push(all.subarray(i, i + 7));
    expect(got).toEqual([{ x: 'é😀' }, { y: 2 }]);
  });
  it('rejects oversized frames', () => {
    const d = new FrameDecoder(() => {}, 10);
    expect(() => d.push(Buffer.from('Content-Length: 100\r\n\r\n'))).toThrow(/too large/);
  });
});

describe('uri normalization', () => {
  it('produces monaco-style canonical URIs', () => {
    expect(fileUri('/home/a b/x.java')).toBe('file:///home/a%20b/x.java');
    expect(fileUri('C:\\Work\\X.java')).toBe('file:///c%3A/Work/X.java');
    expect(canonicalUri('file:///C:/Work/X.java')).toBe(process.platform === 'win32' ? 'file:///c%3A/Work/X.java' : canonicalUri('file:///C:/Work/X.java'));
    expect(canonicalUri('file:///home/a%20b/x.java')).toBe('file:///home/a%20b/x.java');
    expect(canonicalUri('jdt://contents/x')).toBe('jdt://contents/x');
  });
  it('round-trips through server form and maps nested + key URIs', () => {
    const u = fileUri(path.resolve('/tmp/p/Main.java')); // absolute on every OS (D:\\tmp\\... on Windows)
    expect(canonicalUri(serverUri(u))).toBe(u);
    expect(mapUris({ changes: { [u]: [{ uri: u }] }, n: 1 }, () => 'X')).toEqual({ changes: { X: [{ uri: 'X' }] }, n: 1 });
  });
});

describe('LspConnection (fake server)', () => {
  it('initializes, gets responses, cancels, survives crash', async () => {
    const c = new LspConnection({ command: process.execPath, args: [fake], cwd: os.tmpdir() }, () => ({ rootUri: 'file:///tmp' }), () => null);
    const caps = await c.start(10000);
    expect(caps).toMatchObject({ hoverProvider: true });
    const h = await c.request('textDocument/hover', { textDocument: { uri: 'file:///a' }, position: { line: 3, character: 0 } });
    expect(h).toMatchObject({ contents: { value: 'hover at 3 file:///a' } });
    let id = 0;
    const slow = c.request('textDocument/completion', {}, 15000, (i) => { id = i; });
    c.cancel(id);
    await expect(slow).rejects.toThrow(/cancelled/);
    await until(() => c.logs.some((l) => l.includes(`got cancel ${id}`)));
    let crashed = false; c.on('crash', () => { crashed = true; });
    void c.request('workspace/executeCommand', { command: 'crash' }).catch(() => {});
    await until(() => crashed);
    expect(c.state).toBe('crashed');
    await expect(c.request('textDocument/hover', {})).rejects.toThrow();
  });
});

describe('LspManager', () => {
  const def: ServerDef = {
    kind: 'jvm', id: 'fake', name: 'Fake', languages: ['fakelang'], version: '0', minJava: 0,
    download: { url: 'https://example.invalid', sha256: '', kind: 'zip', sizeHint: '', license: '' },
    installDir: (d) => d, isInstalled: async () => true, limitations: 'test only',
    launch: async ({ root }) => ({ command: process.execPath, args: [fake], cwd: root }),
  };
  const jdk = { home: '/x', version: '21', major: 21, source: 'test' };
  it('gates on trust, starts, syncs docs, routes diagnostics, restarts after crash', async () => {
    const events: [string, unknown][] = [];
    let trusted = false;
    const m = new LspManager({ serversDir: os.tmpdir(), storageDir: os.tmpdir(), isTrusted: async () => trusted, jdkFor: async () => jdk, emit: (n, p) => events.push([n, p]) }, [def]);
    await m.setWorkspace(os.tmpdir());
    expect(await m.ensure('fakelang')).toBeNull();
    expect((await m.status())[0]).toMatchObject({ state: 'blocked', reason: expect.stringMatching(/not trusted/) });
    trusted = true;
    await m.restart('fake');
    await until(() => events.some(([n, p]) => n === 'lsp.status.v1' && (p as { servers: { state: string }[] }).servers[0]!.state === 'ready'));
    const st = (await m.status())[0]!;
    expect(st.capabilities).toEqual(['completion', 'hover', 'formatting']); // formatting came from dynamic registration
    const uri = fileUri(path.join(os.tmpdir(), 'A.fake'));
    await m.didOpen('fakelang', uri, 7, 'x');
    await until(() => events.some(([n]) => n === 'lsp.diagnostics.v1'));
    expect(events.find(([n]) => n === 'lsp.diagnostics.v1')![1]).toMatchObject({ uri, diagnostics: [{ message: 'fake error v7' }] });
    const pid = st.pid!;
    process.kill(pid, 'SIGKILL');
    await until(() => events.some(([n, p]) => n === 'lsp.status.v1' && (p as { servers: { state: string }[] }).servers[0]!.state === 'restarting'));
    await until(() => events.filter(([n, p]) => n === 'lsp.status.v1' && (p as { servers: { state: string }[] }).servers[0]!.state === 'ready').length >= 2);
    expect((await m.status())[0]!.pid).not.toBe(pid);
    await m.stopAll();
  });
  it('formats work-done progress (begin/report/end)', () => {
    const b = progressText(undefined, { kind: 'begin', title: 'Indexing' })!;
    expect(b).toBe('Indexing');
    expect(progressText(b, { kind: 'report', message: '45/120 (std)', percentage: 37.4 })).toBe('Indexing — 45/120 (std) 37%');
    expect(progressText('Indexing — 1/2', { kind: 'report', percentage: 80 })).toBe('Indexing — 80%');
    expect(progressText(b, { kind: 'end' })).toBeNull();
  });
  it('answers workspace/configuration per section and re-sends on configurationChanged (Pyright pythonPath)', async () => {
    let py = '/venv/a/bin/python';
    const m = new LspManager({ serversDir: os.tmpdir(), storageDir: os.tmpdir(), isTrusted: async () => true, jdkFor: async () => jdk, emit: () => {},
      configuration: async (id, section) => (id === 'fake' && section === 'python' ? { pythonPath: py } : null) }, [def]);
    await m.setWorkspace(os.tmpdir());
    await m.restart('fake');
    await until(() => m.logs('fake').some((l) => l.includes('config [{"pythonPath":"/venv/a/bin/python"},null]')));
    py = '/venv/b/bin/python';
    m.configurationChanged('fake');
    await until(() => m.logs('fake').some((l) => l.includes('config [{"pythonPath":"/venv/b/bin/python"},null]')));
    await m.stopAll();
  }, 30_000);
  it('badges reflect static and dynamic capabilities only', () => {
    expect(badges({ hoverProvider: false, definitionProvider: true }, new Set(['textDocument/rename']))).toEqual(['definition', 'rename']);
  });
});

