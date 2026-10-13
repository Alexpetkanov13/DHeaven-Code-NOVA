import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { externalLaunch, findExecutable, probeExecutable, withExeDirOnPath } from './discover';
import { LspManager } from './manager';
import { fileUri } from './uri';
import type { ServerDef } from './registry';

const isWin = process.platform === 'win32';
const fake = path.join(__dirname, 'fake-server.cjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 10000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(25); } }

/** A runnable shim script (sh on Unix, .cmd on Windows) — what npm/pip/rustup put on PATH. */
async function shim(dir: string, name: string, body: { sh: string; cmd: string }) {
  const p = path.join(dir, name + (isWin ? '.cmd' : ''));
  await fs.writeFile(p, isWin ? `@echo off\r\n${body.cmd}\r\n` : `#!/bin/sh\n${body.sh}\n`, { mode: 0o755 });
  return p;
}

describe('external server discovery', () => {
  it('finds executables on PATH, then extra dirs; skips non-executable files on Unix', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-disc-'));
    const a = path.join(dir, 'a'), b = path.join(dir, 'b with space');
    await fs.mkdir(a); await fs.mkdir(b);
    const env = { PATH: a, PATHEXT: '.EXE;.CMD' };
    expect(await findExecutable(['tool'], env, [b])).toBeNull();
    const inB = await shim(b, 'tool', { sh: 'echo b', cmd: 'echo b' });
    expect(await findExecutable(['tool'], env, [b])).toBe(inB);
    const inA = await shim(a, 'tool', { sh: 'echo a', cmd: 'echo a' });
    expect(await findExecutable(['tool'], env, [b])).toBe(inA); // PATH wins
    expect(await findExecutable(['missing', 'tool'], env, [])).toBe(inA); // first name that exists
    if (!isWin) {
      await fs.writeFile(path.join(a, 'plain'), 'x', { mode: 0o644 });
      expect(await findExecutable(['plain'], env, [])).toBeNull();
    }
  });
  it('probe resolves the first output line on exit 0 and rejects with the reason otherwise (paths with spaces)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nova disc '));
    const ok = await shim(dir, 'ok', { sh: 'echo "fake-ls 1.2.3"; echo second', cmd: 'echo fake-ls 1.2.3' });
    expect(await probeExecutable(ok, ['--version'])).toBe('fake-ls 1.2.3');
    const bad = await shim(dir, 'bad', { sh: "echo \"error: Unknown binary 'x'\" >&2; exit 1", cmd: "echo error: Unknown binary 'x' 1>&2\r\nexit /b 1" });
    await expect(probeExecutable(bad, ['--version'])).rejects.toThrow(/exited with code 1: error: Unknown binary/);
    const hang = await shim(dir, 'hang', { sh: 'sleep 30', cmd: 'ping -n 30 127.0.0.1 >nul' });
    await expect(probeExecutable(hang, ['--version'], 500)).rejects.toThrow(/did not finish/);
  }, 30_000);
  it('puts the executable\'s directory first on PATH (npm shims need the node next to them), once, keeping the key\'s spelling', () => {
    const exe = path.join(path.sep, 'opt', 'node', 'bin', 'pyright-langserver');
    const dir = path.dirname(exe);
    expect(withExeDirOnPath(exe, { PATH: '/usr/bin' }).PATH).toBe(dir + path.delimiter + '/usr/bin');
    expect(withExeDirOnPath(exe, { PATH: dir + path.delimiter + '/usr/bin' }).PATH).toBe(dir + path.delimiter + '/usr/bin');
    const w = withExeDirOnPath(exe, { Path: 'C:\\Windows' });
    expect(Object.keys(w)).toEqual(['Path']);
    expect(w.Path).toBe(dir + path.delimiter + 'C:\\Windows');
    expect(withExeDirOnPath(exe, {}).PATH).toBe(dir);
  });
  it.runIf(isWin)('runs .cmd shims through cmd.exe with quoted verbatim args and refuses cmd metacharacters', () => {
    const s = externalLaunch('C:\\Program Files\\npm\\tsls.cmd', ['--stdio'], 'C:\\w');
    expect(s.windowsVerbatimArguments).toBe(true);
    expect(s.args.slice(-1)[0]).toBe('""C:\\Program Files\\npm\\tsls.cmd" "--stdio""');
    expect(() => externalLaunch('C:\\a&calc.cmd', [], 'C:\\w')).toThrow(/unsafe/);
    expect(externalLaunch('C:\\x\\ra.exe', [], 'C:\\w')).toMatchObject({ command: 'C:\\x\\ra.exe', args: [] });
  });
});

describe('LspManager with an external server', () => {
  const def = (probe?: string[]): ServerDef => ({
    kind: 'external', id: 'ext', name: 'Ext', languages: ['typescript'], executables: ['fake-ls'], args: [fake], probeArgs: probe,
    lspLanguageId: (lang, uri) => (uri.endsWith('.tsx') ? 'typescriptreact' : lang),
    setup: { summary: 'install it', commands: ['npm i -g fake-ls'], url: 'https://example.invalid', license: 'MIT' }, limitations: 'test only',
  });
  const base = { serversDir: os.tmpdir(), storageDir: os.tmpdir(), isTrusted: async () => true, jdkFor: async () => null };

  it('missing executable: blocked with setup guidance, no download offered, no process spawned', async () => {
    const m = new LspManager({ ...base, emit: () => {}, find: async () => null }, [def()]);
    await m.setWorkspace(os.tmpdir());
    expect(await m.ensure('typescript')).toBeNull();
    const st = (await m.status())[0]!;
    expect(st).toMatchObject({ kind: 'external', installed: false, state: 'blocked', download: null, path: null, setup: { commands: ['npm i -g fake-ls'] } });
    expect(st.reason).toMatch(/Not found on PATH \(looked for fake-ls\)/);
    expect(st.pid).toBeNull();
  }, 30_000);

  it('broken executable (probe fails): not installed, reason names the path and the error', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-ext-'));
    const exe = await shim(dir, 'fake-ls', { sh: 'echo "rustup: component missing" >&2; exit 1', cmd: 'echo rustup: component missing 1>&2\r\nexit /b 1' });
    const m = new LspManager({ ...base, emit: () => {}, find: async () => exe }, [def(['--version'])]);
    await m.setWorkspace(os.tmpdir());
    expect(await m.ensure('typescript')).toBeNull();
    const st = (await m.status())[0]!;
    expect(st).toMatchObject({ installed: false, state: 'blocked', path: exe, pathSource: 'PATH' });
    expect(st.reason).toMatch(/does not work: .*component missing/);
  }, 30_000);

  it('configured path wins over PATH; starts, maps languageId (.tsx -> typescriptreact), re-detects after a fix', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-ext-'));
    // Shim = the external server: probe prints a version, otherwise runs the fake server with the given args.
    const exe = await shim(dir, 'fake-ls', {
      sh: `if [ "$1" = "--version" ]; then echo "fake-ls 9.9"; exit 0; fi\nexec "${process.execPath}" "$@"`,
      cmd: `if "%~1"=="--version" (echo fake-ls 9.9& exit /b 0)\r\n"${process.execPath}" %*`,
    });
    let configured: string | null = path.join(dir, 'nope');
    const events: [string, unknown][] = [];
    const m = new LspManager({ ...base, emit: (n, p) => events.push([n, p]), find: async () => { throw new Error('PATH must not be searched when a path is configured'); }, configuredPath: async () => configured }, [def(['--version'])]);
    await m.setWorkspace(os.tmpdir());
    await m.ensure('typescript');
    expect((await m.status())[0]).toMatchObject({ installed: false, pathSource: 'configured', state: 'blocked' });
    configured = exe; m.redetect();
    await m.restart('ext');
    const ready = () => events.some(([n, p]) => n === 'lsp.status.v1' && (p as { servers: { state: string }[] }).servers[0]!.state === 'ready');
    await until(ready);
    const st = (await m.status())[0]!;
    expect(st).toMatchObject({ installed: true, version: 'fake-ls 9.9', path: exe, pathSource: 'configured', capabilities: ['completion', 'hover', 'formatting'] });
    await m.didOpen('typescript', fileUri(path.join(dir, 'App.tsx')), 1, 'x');
    await m.didOpen('typescript', fileUri(path.join(dir, 'a.ts')), 1, 'x');
    await until(() => m.logs('ext').some((l) => l.includes('didOpen languageId=typescript') && !l.includes('react')));
    expect(m.logs('ext').some((l) => l.includes('didOpen languageId=typescriptreact'))).toBe(true);
    await m.stopAll();
  }, 30_000);
});
