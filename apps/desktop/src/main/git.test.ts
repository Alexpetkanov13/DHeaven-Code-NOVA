import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBranch, discard, git, isDirty, listBranches, redact, switchBranch, sync, tracking } from './git';

async function repoWithRemote() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-git-'));
  const bare = path.join(tmp, 'remote.git'); const a = path.join(tmp, 'a'); const b = path.join(tmp, 'b');
  await fs.mkdir(bare); await git(bare, ['init', '-q', '--bare', '-b', 'main']);
  await fs.mkdir(a); await git(a, ['init', '-q', '-b', 'main']);
  for (const r of [a]) { await git(r, ['config', 'user.email', 't@e.x']); await git(r, ['config', 'user.name', 'T']); await git(r, ['config', 'core.autocrlf', 'false']); }
  await fs.writeFile(path.join(a, 'f.txt'), 'one\n'); await git(a, ['add', '-A']); await git(a, ['commit', '-qm', 'init']);
  await git(a, ['remote', 'add', 'origin', bare]);
  return { tmp, bare, a, b };
}

describe('git', () => {
  it('redacts credentials from output', () => {
    expect(redact('fatal: unable to access https://alice:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x.git/')).toBe('fatal: unable to access https://***@github.com/x.git/');
    expect(redact('Authorization: Bearer abc.def')).toBe('Authorization: Bearer ***');
    expect(redact('token github_pat_ABCDEFGHIJKLMNOPQRSTUVWX_y here')).toBe('token *** here');
    expect(redact('https://h/x?access_token=s3cret&a=1')).toBe('https://h/x?access_token=***&a=1');
  });

  it('branches: create/switch with dirty-tree guard, invalid names, push -u, fetch/pull, ahead/behind, discard', async () => {
    const { a, b, bare } = await repoWithRemote();
    await expect(createBranch(a, '-x', true)).rejects.toThrow('Invalid');
    await expect(createBranch(a, 'bad..name', true)).rejects.toThrow('Invalid');
    await createBranch(a, 'feature', false);
    expect((await listBranches(a)).map((x) => `${x.name}${x.current ? '*' : ''}`).sort()).toEqual(['feature', 'main*']);

    await fs.writeFile(path.join(a, 'f.txt'), 'dirty\n');
    expect(await isDirty(a)).toBe(true);
    await expect(switchBranch(a, 'feature', { allowDirty: false })).rejects.toMatchObject({ code: 'DIRTY' });
    await switchBranch(a, 'feature', { allowDirty: true }); // carried over
    expect(await fs.readFile(path.join(a, 'f.txt'), 'utf8')).toBe('dirty\n');

    // discard: modified tracked, staged new file, untracked file
    await fs.writeFile(path.join(a, 'new.txt'), 'n'); await git(a, ['add', 'new.txt']);
    await fs.writeFile(path.join(a, 'junk.txt'), 'j');
    await discard(a, ['f.txt', 'new.txt', 'junk.txt']);
    expect(await fs.readFile(path.join(a, 'f.txt'), 'utf8')).toBe('one\n');
    await expect(fs.access(path.join(a, 'new.txt'))).rejects.toThrow();
    await expect(fs.access(path.join(a, 'junk.txt'))).rejects.toThrow();
    expect(await isDirty(a)).toBe(false);
    await expect(discard(a, ['../outside'])).rejects.toThrow();

    await switchBranch(a, 'main', { allowDirty: false });
    expect(await tracking(a)).toEqual({ branch: 'main', upstream: null, ahead: 0, behind: 0 });
    await sync(a, 'push'); // no upstream -> push -u origin main
    expect((await tracking(a)).upstream).toBe('origin/main');

    await fs.writeFile(path.join(a, 'f.txt'), 'two\n'); await git(a, ['commit', '-qam', 'two']);
    expect(await tracking(a)).toMatchObject({ ahead: 1, behind: 0 });
    await sync(a, 'push');
    expect(await tracking(a)).toMatchObject({ ahead: 0, behind: 0 });

    await git(path.dirname(b), ['clone', '-q', bare, b]);
    await git(b, ['config', 'user.email', 't@e.x']); await git(b, ['config', 'user.name', 'T']);
    await fs.writeFile(path.join(b, 'g.txt'), 'g\n'); await git(b, ['add', '-A']); await git(b, ['commit', '-qm', 'from b']); await git(b, ['push', '-q']);
    await sync(a, 'fetch');
    expect(await tracking(a)).toMatchObject({ ahead: 0, behind: 1 });
    await sync(a, 'pull');
    expect(await tracking(a)).toMatchObject({ ahead: 0, behind: 0 });
    expect(await fs.readFile(path.join(a, 'g.txt'), 'utf8')).toBe('g\n');

    // remote branch -> local tracking branch
    await git(b, ['switch', '-qc', 'remote-only']); await git(b, ['push', '-qu', 'origin', 'remote-only']);
    await sync(a, 'fetch');
    await switchBranch(a, 'origin/remote-only', { allowDirty: false });
    expect(await tracking(a)).toMatchObject({ branch: 'remote-only', upstream: 'origin/remote-only' });
  }, 60_000);

  it('a failing remote reports a redacted error and never prompts', async () => {
    const { a } = await repoWithRemote();
    await git(a, ['remote', 'set-url', 'origin', 'https://bob:ghp_000000000000000000000000000000000000@127.0.0.1:9/x.git']);
    const e = await sync(a, 'fetch').catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect(String((e as Error).message)).not.toContain('ghp_0000');
    expect(String((e as Error).message)).not.toContain('bob:');
  }, 30_000);
});
