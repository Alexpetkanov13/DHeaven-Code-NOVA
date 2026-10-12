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
