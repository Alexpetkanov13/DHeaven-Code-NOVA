import fs from 'node:fs/promises';
import path from 'node:path';
import { LIMITS, safeEntryPath } from './archive';

const SKIP = new Set(['.git', 'node_modules', '.DS_Store']);
/** Reads an extension folder into memory. Refuses symlinks (they could point outside the folder) and enforces limits. */
export async function readFolder(dir: string, limits = LIMITS): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>(); let total = 0;
  async function walk(abs: string, rel: string) {
    for (const e of await fs.readdir(abs, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.name.endsWith('.novaext') || e.name.endsWith('.novaext.sha256')) continue;
      const a = path.join(abs, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new Error(`symlinks are not allowed in extensions: ${r}`);
      if (e.isDirectory()) { await walk(a, r); continue; }
      if (!e.isFile()) continue;
      const b = await fs.readFile(a); total += b.length;
      if (b.length > limits.maxFileBytes || total > limits.maxTotalBytes) throw new Error('extension folder too large');
      if (out.size >= limits.maxEntries) throw new Error('too many files');
      out.set(safeEntryPath(r), b);
    }
  }
  await walk(dir, '');
  return out;
}

/** Writes a validated file map below `dest` (which must not exist), re-checking each target stays inside it. */
export async function writeFiles(dest: string, files: Map<string, Uint8Array>) {
  await fs.mkdir(dest, { recursive: false });
  const root = path.resolve(dest) + path.sep;
  for (const [rel, b] of files) {
    const target = path.resolve(dest, ...safeEntryPath(rel).split('/'));
    if (!target.startsWith(root)) throw new Error(`refusing to write outside the extension folder: ${rel}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, b, { flag: 'wx' });
  }
}
