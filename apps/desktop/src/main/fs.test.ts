import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { atomicWrite } from './atomicWrite';
import { listDir, readFile, writeFile, FsError } from './workspaceFs';
import { Store } from './store';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'nova-t-'));

describe('atomicWrite', () => {
  it('replaces content and leaves no temp files', async () => {
    const d = await tmp(); const f = path.join(d, 'a.txt');
    await fs.writeFile(f, 'old');
    await atomicWrite(f, 'new');
    expect(await fs.readFile(f, 'utf8')).toBe('new');
    expect(await fs.readdir(d)).toEqual(['a.txt']);
  });
});

describe('workspaceFs', () => {
  it('lists dirs first, hides .git/node_modules', async () => {
    const d = await tmp();
    await fs.mkdir(path.join(d, 'src')); await fs.mkdir(path.join(d, '.git')); await fs.writeFile(path.join(d, 'b.txt'), '');
    expect((await listDir(d, '')).map((e) => e.name)).toEqual(['src', 'b.txt']);
  });
  it('detects conflicts via mtime', async () => {
    const d = await tmp(); await fs.writeFile(path.join(d, 'x.txt'), '1');
    const { mtimeMs } = await readFile(d, 'x.txt');
    await writeFile(d, 'x.txt', '2', mtimeMs);
    await expect(writeFile(d, 'x.txt', '3', mtimeMs - 10_000)).rejects.toBeInstanceOf(FsError);
  });
});

describe('Store', () => {
  it('persists settings with validation and recent list ordering', async () => {
    const d = await tmp(); const s = new Store(d);
    expect((await s.getSettings()).editorFontSize).toBe(14);
    await s.updateSettings({ editorFontSize: 18 });
    expect((await new Store(d).getSettings()).editorFontSize).toBe(18);
    await expect(s.updateSettings({ editorFontSize: 999 })).rejects.toThrow();
    await s.addRecent('/a', 'a', 1); await s.addRecent('/b', 'b', 2); await s.addRecent('/a', 'a', 3);
    expect((await s.listRecent()).map((r) => r.root)).toEqual(['/a', '/b']);
  });
  it('recovers from corrupt settings file', async () => {
    const d = await tmp(); await fs.writeFile(path.join(d, 'settings.json'), '{not json');
    expect((await new Store(d).getSettings()).mode).toBe('nova');
  });
});
