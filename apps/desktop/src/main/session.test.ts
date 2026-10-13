import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store';

describe('session store', () => {
  it('saves per workspace, validates, bounds drafts and finds the last workspace', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-sess-'));
    const st = new Store(path.join(dir, 'ud'));
    const a = path.join(dir, 'a'); await fs.mkdir(a);
    expect(await st.getSession(a)).toBeNull();
    const big = 'x'.repeat(5 * 1024 * 1024);
    const drafts = [...Array.from({ length: 8 }, (_, i) => ({ rel: `big${i}.txt`, content: big, baseMtimeMs: 1 })), { rel: 'small.ts', content: 'hi', baseMtimeMs: 2 }];
    await st.saveSession(a, { layout: { dir: 'row' }, views: [], drafts, savedAt: 1 });
    const got = (await st.getSession(a))!;
    expect(got.layout).toEqual({ dir: 'row' });
    expect(got.drafts.map((d) => d.rel)).toContain('small.ts');
    expect(got.drafts.reduce((n, d) => n + d.content.length, 0)).toBeLessThanOrEqual(32 * 1024 * 1024); // largest dropped
    expect(await st.getSession(path.join(dir, 'b'))).toBeNull(); // other workspace
    const files = await fs.readdir(path.join(dir, 'ud', 'sessions'));
    await fs.writeFile(path.join(dir, 'ud', 'sessions', files[0]!), '{"root":"' + a.replace(/\\/g, '\\\\') + '","state":{"drafts":"nope"}}');
    expect(await st.getSession(a)).toBeNull(); // corrupt -> ignored
    expect(await st.lastWorkspace()).toBeNull();
    await st.addRecent(a, 'a');
    expect(await st.lastWorkspace()).toBe(a);
    await fs.rm(a, { recursive: true });
    expect(await st.lastWorkspace()).toBeNull(); // folder gone
  });
});

describe('settings: language server paths', () => {
  it('cannot be set by a renderer settings patch, only by the main-process setter', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-set-'));
    const st = new Store(dir);
    const after = await st.updateSettings({ editorFontSize: 15, lspServerPaths: { tsls: '/tmp/evil' } } as never);
    expect(after.editorFontSize).toBe(15);
    expect(after.lspServerPaths).toEqual({});
    expect((await st.setLspServerPath('tsls', '/opt/tsls')).lspServerPaths).toEqual({ tsls: '/opt/tsls' });
    expect((await st.updateSettings({ editorFontSize: 16 })).lspServerPaths).toEqual({ tsls: '/opt/tsls' }); // kept across patches
    expect((await st.setLspServerPath('tsls', null)).lspServerPaths).toEqual({});
  });
});
