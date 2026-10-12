import path from 'node:path';
import fs from 'node:fs/promises';

export class PathError extends Error {
  constructor(public code: 'PATH_OUTSIDE_WORKSPACE' | 'INVALID_REQUEST', message: string) {
    super(message);
  }
}

/** Resolve a workspace-relative path to an absolute one, refusing anything that escapes the root. */
export function resolveInside(root: string, rel: string): string {
  if (rel.includes('\0')) throw new PathError('INVALID_REQUEST', 'NUL in path');
  const normalizedRel = rel.replace(/\\/g, '/');
  if (path.isAbsolute(normalizedRel) || /^[a-zA-Z]:/.test(normalizedRel) || normalizedRel.startsWith('//')) {
    throw new PathError('PATH_OUTSIDE_WORKSPACE', 'Absolute paths are not allowed');
  }
  const abs = path.resolve(root, normalizedRel);
  assertWithin(root, abs);
  return abs;
}

export function assertWithin(root: string, abs: string): void {
  const r = path.relative(path.resolve(root), path.resolve(abs));
  if (r === '') return;
  if (r.startsWith('..') || path.isAbsolute(r)) {
    throw new PathError('PATH_OUTSIDE_WORKSPACE', 'Path escapes workspace root');
  }
}

/** Also defend against symlink escapes: the real path of the nearest existing ancestor must be inside the real root. */
export async function resolveInsideReal(root: string, rel: string): Promise<string> {
  const abs = resolveInside(root, rel);
  const realRoot = await fs.realpath(root);
  let probe = abs;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      assertWithin(realRoot, real);
      return abs;
    } catch (e) {
      if (e instanceof PathError) throw e;
      const parent = path.dirname(probe);
      if (parent === probe) throw new PathError('PATH_OUTSIDE_WORKSPACE', 'Cannot resolve path');
      probe = parent;
    }
  }
}

export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}
