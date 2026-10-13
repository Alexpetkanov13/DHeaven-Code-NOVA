import { renameRetry } from './fsRetry';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DirEntry } from '@nova/ipc-contract';
import { resolveInsideReal, toRel } from './pathGuard';
import { atomicWrite } from './atomicWrite';

export const MAX_READ_BYTES = 32 * 1024 * 1024;
export const MAX_DIR_ENTRIES = 20000;
const HIDDEN = new Set(['.git', 'node_modules']);

export class FsError extends Error {
  constructor(public code: 'NOT_FOUND' | 'CONFLICT' | 'TOO_LARGE', message: string) { super(message); }
}

export async function listDir(root: string, rel: string): Promise<DirEntry[]> {
  const abs = await resolveInsideReal(root, rel);
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  return dirents
    .filter((d) => !HIDDEN.has(d.name))
    .slice(0, MAX_DIR_ENTRIES)
    .map((d): DirEntry => ({ name: d.name, rel: toRel(root, path.join(abs, d.name)), kind: d.isDirectory() ? 'dir' : 'file' }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
}

export async function readFile(root: string, rel: string) {
  const abs = await resolveInsideReal(root, rel);
  const st = await fs.stat(abs).catch(() => { throw new FsError('NOT_FOUND', `Not found: ${rel}`); });
  if (st.size > MAX_READ_BYTES) throw new FsError('TOO_LARGE', 'File exceeds 32 MB limit');
  return { content: await fs.readFile(abs, 'utf8'), mtimeMs: st.mtimeMs };
}

export async function writeFile(root: string, rel: string, content: string, expectedMtimeMs?: number) {
  const abs = await resolveInsideReal(root, rel);
  if (expectedMtimeMs !== undefined) {
    const st = await fs.stat(abs).catch(() => undefined);
    if (st && Math.abs(st.mtimeMs - expectedMtimeMs) > 1) throw new FsError('CONFLICT', 'File changed on disk since it was opened');
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await atomicWrite(abs, content);
  return { mtimeMs: (await fs.stat(abs)).mtimeMs };
}

export class ExistsError extends Error { code = 'EXISTS' as const; }

function validName(rel: string) {
  const name = rel.split('/').pop() ?? '';
  if (!name || name === '.' || name === '..' || /[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) {
    throw new FsError('NOT_FOUND', `Invalid file name: ${name}`); // reject names Windows can't hold, too
  }
}

export async function statEntry(root: string, rel: string) {
  const abs = await resolveInsideReal(root, rel);
  const st = await fs.stat(abs).catch(() => null);
  return st ? { mtimeMs: st.mtimeMs, kind: st.isDirectory() ? ('dir' as const) : ('file' as const) } : null;
}

export async function createEntry(root: string, rel: string, kind: 'file' | 'dir') {
  validName(rel);
  const abs = await resolveInsideReal(root, rel);
  if (rel === '' ) throw new FsError('NOT_FOUND', 'Empty path');
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    if (kind === 'dir') await fs.mkdir(abs);
    else await (await fs.open(abs, 'wx')).close();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ExistsError(`${rel} already exists`);
    throw e;
  }
  return { rel: toRel(root, abs) };
}

export async function renameEntry(root: string, from: string, to: string) {
  validName(to);
  if (!from) throw new FsError('NOT_FOUND', 'Cannot rename workspace root');
  const a = await resolveInsideReal(root, from);
  const b = await resolveInsideReal(root, to);
  const exists = await fs.lstat(b).then(() => true, () => false);
  // allow case-only renames on case-insensitive filesystems
  if (exists && a.toLowerCase() !== b.toLowerCase()) throw new ExistsError(`${to} already exists`);
  await fs.mkdir(path.dirname(b), { recursive: true });
  await renameRetry(a, b);
  return { rel: toRel(root, b) };
}

export async function deleteEntry(root: string, rel: string, permanent: boolean, trash: (abs: string) => Promise<void>) {
  if (!rel) throw new FsError('NOT_FOUND', 'Cannot delete workspace root');
  const abs = await resolveInsideReal(root, rel);
  await fs.lstat(abs).catch(() => { throw new FsError('NOT_FOUND', `Not found: ${rel}`); });
  if (permanent) { await fs.rm(abs, { recursive: true, force: false, maxRetries: 10, retryDelay: 100 }); return { trashed: false }; }
  try { await trash(abs); } catch (e) { throw new TrashError(`Could not move to trash: ${e instanceof Error ? e.message : e}`); }
  return { trashed: true };
}
export class TrashError extends Error { code = 'TRASH_FAILED' as const; }

/** Reads at most `limit` bytes; reports the real size so callers can refuse oversized files without loading them. */
export async function readFileHead(root: string, rel: string, limit: number): Promise<{ bytes: Uint8Array; size: number }> {
  const abs = await resolveInsideReal(root, rel);
  const st = await fs.stat(abs).catch(() => { throw new FsError('NOT_FOUND', `Not found: ${rel}`); });
  if (!st.isFile()) throw new FsError('NOT_FOUND', `Not a file: ${rel}`);
  const fh = await fs.open(abs, 'r');
  try { const buf = Buffer.alloc(Math.min(st.size, limit)); await fh.read(buf, 0, buf.length, 0); return { bytes: buf, size: st.size }; } finally { await fh.close(); }
}
