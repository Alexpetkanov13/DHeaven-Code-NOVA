import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionStore } from './store';
import { installBundled } from './bundled';

const BUNDLED = path.resolve(__dirname, '../../../../../extensions/bundled');
describe('bundled first-party extensions', () => {
  it('installs minecraft-dev once, is idempotent, keeps disabled state, never overwrites a user install', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-bundled-'));
    const store = new ExtensionStore(root, '0.1.0'); await store.load();
    expect(await installBundled(store, BUNDLED)).toEqual(['dheaven.minecraft-dev']);
    const e = store.get('dheaven.minecraft-dev')!; expect(e.source).toBe('bundled:minecraft-dev');
    const [x] = await store.list(); expect(x!.manifest.contributes.projectTemplates.map((t) => t.id)).toEqual(['fabric-mod', 'paper-plugin']);
    await store.update('dheaven.minecraft-dev', { enabled: false });
    expect(await installBundled(store, BUNDLED)).toEqual([]); // same content → no reinstall
    expect(store.get('dheaven.minecraft-dev')!.enabled).toBe(false);
    await store.update('dheaven.minecraft-dev', {}); Object.assign(store.get('dheaven.minecraft-dev')!, { source: '/home/me/my-fork', sha256: 'x' });
    expect(await installBundled(store, BUNDLED)).toEqual([]);
    expect(store.get('dheaven.minecraft-dev')!.source).toBe('/home/me/my-fork');
  });
});
