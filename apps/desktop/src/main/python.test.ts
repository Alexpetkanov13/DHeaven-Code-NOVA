import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverPythons, probePython, resolvePython } from './python';

const isWin = process.platform === 'win32';
const realPython = (() => { try { return execFileSync(isWin ? 'python' : 'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim(); } catch { return null; } })();

/** A workspace with a fake ".venv" whose python is a link/copy-free wrapper around the real interpreter. */
async function workspaceWithVenv(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-pyws-'));
  const bin = isWin ? path.join(root, '.venv', 'Scripts') : path.join(root, '.venv', 'bin');
  await fs.mkdir(bin, { recursive: true });
  if (isWin) await fs.copyFile(realPython!, path.join(bin, 'python.exe'));
  else await fs.symlink(realPython!, path.join(bin, 'python'));
  return root;
}

describe.skipIf(!realPython)('python interpreters', () => {
  it('probes a real interpreter and rejects things that are not Python', async () => {
    const r = await probePython(realPython!);
    expect(r.version).toMatch(/^3\.\d+\.\d+/);
    await expect(probePython(path.join(os.tmpdir(), 'no-such-python'))).rejects.toThrow();
    if (!isWin) await expect(probePython('/bin/echo')).rejects.toThrow(/is not a working Python/);
  });

  it('resolution order: selected (if it runs) > workspace venv > PATH; a broken selection is reported, not hidden', async () => {
    const root = await workspaceWithVenv();
    const venv = isWin ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
    expect(await resolvePython(root, realPython)).toMatchObject({ command: realPython, source: 'selected for this workspace', note: null });
    const broken = await resolvePython(root, path.join(root, 'gone', 'python'));
    expect(broken).toMatchObject({ command: venv, source: 'virtualenv .venv' });
    expect(broken.note).toMatch(/selected interpreter .*gone.* does not work/);
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-pyws-'));
    const auto = await resolvePython(empty, null);
    expect(auto.source).toBe('PATH');
    expect(path.isAbsolute(auto.command)).toBe(true); // a full path, so Pyright and the debugger get the same file
    expect(auto.version).toMatch(/^3\./);
  }, 60_000);

  it('discovers the workspace venv and PATH interpreters, each probed', async () => {
    const root = await workspaceWithVenv();
    const found = await discoverPythons(root);
    expect(found.find((p) => p.source === 'workspace .venv')).toMatchObject({ path: expect.stringContaining('.venv'), version: expect.stringMatching(/^3\./) });
    expect(found.some((p) => p.source === 'PATH')).toBe(true);
    expect(found.every((p) => /^\d+\.\d+/.test(p.version))).toBe(true);
  }, 60_000);
});
