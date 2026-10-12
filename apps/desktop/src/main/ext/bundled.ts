import fs from 'node:fs/promises';
import path from 'node:path';
import { MANIFEST_FILE } from '@nova/extension-api';
import type { ExtensionStore } from './store';

export const isBundledSource = (s: string) => s.startsWith('bundled:');

/**
 * Installs/updates first-party extensions shipped with the app (`extensions/bundled/<name>`). They go through the same
 * validation + integrity path as user installs. Enabled/disabled state and grants are preserved across updates; an
 * extension the user installed themselves under the same id is never overwritten.
 */
export async function installBundled(store: ExtensionStore, dir: string, log: (m: string) => void = () => {}): Promise<string[]> {
  const done: string[] = [];
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of names.sort()) {
    const src = path.join(dir, name);
    if (!(await fs.stat(path.join(src, MANIFEST_FILE)).then(() => true, () => false))) continue;
    try {
      const p = await store.inspect(src);
      const cur = store.get(p.id);
      if (cur && !isBundledSource(cur.source)) { store.cancel(p.token); log(`bundled ${p.id}: user-installed copy present, left untouched`); continue; }
      if (cur && cur.sha256 === p.sha256 && cur.version === p.manifest.version) { store.cancel(p.token); continue; }
      p.source = `bundled:${name}`;
      await store.commit(p.token); done.push(p.id);
      log(`bundled ${p.id}@${p.manifest.version} installed`);
    } catch (e) { log(`bundled ${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return done;
}
