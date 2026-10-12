import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createEntry, deleteEntry, renameEntry, statEntry, ExistsError, TrashError } from './workspaceFs';
import { PathError } from './pathGuard';
import { CoalescingWatcher } from './watcher';
import { TrustStore } from './trust';
import { applyReplace, buildRegex, replaceAll } from './replace';
import { DaemonClient } from './daemon';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'nova-s2-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('explorer file ops', () => {
  it('creates, renames, refuses collisions and escapes, deletes', async () => {
    const d = await tmp();
    expect(await createEntry(d, 'src/a.ts', 'file')).toEqual({ rel: 'src/a.ts' });
    await createEntry(d, 'lib', 'dir');
    await expect(createEntry(d, 'src/a.ts', 'file')).rejects.toBeInstanceOf(ExistsError);
    await expect(createEntry(d, '../evil.txt', 'file')).rejects.toBeInstanceOf(PathError);
    await expect(createEntry(d, 'bad:name', 'file')).rejects.toThrow();
    expect(await renameEntry(d, 'src/a.ts', 'src/b.ts')).toEqual({ rel: 'src/b.ts' });
    await expect(renameEntry(d, 'src/b.ts', 'lib')).rejects.toBeInstanceOf(ExistsError);
    await expect(renameEntry(d, 'src/b.ts', '../../x')).rejects.toBeInstanceOf(PathError);
    expect((await statEntry(d, 'src/b.ts'))?.kind).toBe('file');
    const trashed: string[] = [];
    expect(await deleteEntry(d, 'lib', false, async (p) => { trashed.push(p); })).toEqual({ trashed: true });
    expect(trashed).toEqual([path.join(d, 'lib')]);
    await expect(deleteEntry(d, 'src', false, async () => { throw new Error('no trash'); })).rejects.toBeInstanceOf(TrashError);
    expect(await deleteEntry(d, 'src', true, async () => {})).toEqual({ trashed: false });
    expect(await statEntry(d, 'src')).toBeNull();
    await expect(deleteEntry(d, '', true, async () => {})).rejects.toThrow();
  });
});

describe('CoalescingWatcher', () => {
  it('coalesces bursts and ignores .git', async () => {
    const d = await tmp();
    await fs.mkdir(path.join(d, '.git'));
    const batches: string[][] = [];
    const w = new CoalescingWatcher(d, (r) => batches.push(r), 200).start();
    await sleep(100);
    for (let i = 0; i < 20; i++) await fs.writeFile(path.join(d, 'f.txt'), String(i));
    await fs.writeFile(path.join(d, '.git', 'index'), 'x');
    await sleep(800);
    w.stop();
    expect(batches.length).toBeGreaterThanOrEqual(1);
    expect(batches.length).toBeLessThanOrEqual(3);
    expect(batches.flat()).toContain('f.txt');
    expect(batches.flat().some((r) => r.startsWith('.git'))).toBe(false);
  });
});

describe('TrustStore', () => {
  it('trusts roots and their children, revocable, survives restart', async () => {
    const d = await tmp(); const t = new TrustStore(d);
    const root = path.join(d, 'ws');
    expect(await t.isTrusted(root)).toBe(false);
    await t.set(root, true);
    expect(await new TrustStore(d).isTrusted(path.join(root, 'sub'))).toBe(true);
    expect(await t.isTrusted(root + '-other')).toBe(false);
    await t.set(root, false);
    expect(await t.isTrusted(root)).toBe(false);
  });
});

describe('replace', () => {
  it('literal mode escapes and does not expand $1', () => {
    const { out, n } = replaceAll('a.b a.b axb', buildRegex('a.b', false, true), '$1!', false);
    expect(out).toBe('$1! $1! axb'); expect(n).toBe(2);
  });
  it('regex mode supports groups, case-insensitive', () => {
    expect(replaceAll('Foo foo', buildRegex('(f)oo', true, false), '$1ee', true).out).toBe('Fee fee');
  });
  it('applies across files atomically', async () => {
    const d = await tmp();
    await fs.writeFile(path.join(d, 'a.txt'), 'hello hello'); await fs.writeFile(path.join(d, 'b.txt'), 'nothing');
    expect(await applyReplace(d, ['a.txt', 'b.txt'], 'hello', false, true, 'bye')).toEqual({ files: 1, replacements: 2 });
    expect(await fs.readFile(path.join(d, 'a.txt'), 'utf8')).toBe('bye bye');
    await expect(applyReplace(d, ['../x'], 'a', false, true, 'b')).rejects.toBeInstanceOf(PathError);
  });
});

const bin = path.resolve(__dirname, '../../../../target/release', process.platform === 'win32' ? 'novad.exe' : 'novad');
describe.skipIf(!existsSync(bin))('DaemonClient + novad', () => {
  it('pings, streams search, restarts after crash', async () => {
    const states: string[] = []; const notes: { method: string; params: unknown }[] = [];
    const c = new DaemonClient(bin, (method, params) => notes.push({ method, params }), (s) => states.push(s));
    c.start();
    expect(await c.call('ping', {})).toBe('pong');
    const d = await tmp(); await fs.writeFile(path.join(d, 'x.ts'), 'const needle = 1;\n');
    await c.call('search.start', { root: d, query: 'needle' });
    for (let i = 0; i < 50 && !notes.some((n) => n.method === 'search.done'); i++) await sleep(100);
    expect(notes.find((n) => n.method === 'search.matches')?.params).toMatchObject({ matches: [{ rel: 'x.ts', line: 1, start: 6, end: 12 }] });
    c.kill();
    for (let i = 0; i < 50 && !states.includes('restarting'); i++) await sleep(50);
    for (let i = 0; i < 50 && c.state !== 'ready'; i++) await sleep(100);
    expect(states).toContain('restarting');
    expect(await c.call('ping', {})).toBe('pong');
    await expect(c.call('nope', {})).rejects.toThrow(/unknown method/);
    c.stop();
  });
});
