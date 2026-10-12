import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { resolveInside, resolveInsideReal, PathError } from './pathGuard';

const root = path.resolve(os.tmpdir(), 'nova-root');
describe('pathGuard', () => {
  it('resolves normal relative paths', () => {
    expect(resolveInside(root, 'src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
    expect(resolveInside(root, '')).toBe(root);
  });
  it.each(['../x', 'a/../../x', '/etc/passwd', 'C:/Windows/x', 'C:\\Windows', '\\\\server\\share', '..\\x', 'a\0b'])('rejects %s', (p) => {
    expect(() => resolveInside(root, p)).toThrow(PathError);
  });
  it('rejects symlink escapes', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-sl-'));
    const ws = path.join(base, 'ws'); await fs.mkdir(ws);
    const outside = path.join(base, 'outside'); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(ws, 'link'), 'junction');
    await expect(resolveInsideReal(ws, 'link/secret.txt')).rejects.toThrow(PathError);
    await expect(resolveInsideReal(ws, 'new/file.txt')).resolves.toBe(path.join(ws, 'new', 'file.txt'));
  });
});
