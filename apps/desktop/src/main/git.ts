import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertWithin } from './pathGuard';

export class GitError extends Error { constructor(public code: 'DIRTY' | 'INVALID' | 'GIT_FAILED' | 'NO_UPSTREAM', m: string) { super(m); } }

/** Remove credentials from anything git prints (URLs with user:token@, auth headers, token-like query params). */
export function redact(s: string): string {
  return s
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@')
    .replace(/(authorization:\s*)(basic|bearer|token)\s+\S+/gi, '$1$2 ***')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g, '***')
    .replace(/([?&](?:access_token|token|private_token)=)[^&\s]+/gi, '$1***');
}

/**
 * Runs the git CLI. Uses the user's own config and credential helper; never prompts (GIT_TERMINAL_PROMPT=0, no askpass),
 * so a missing credential fails fast instead of hanging. Output is redacted before it reaches logs or the UI.
 */
export function git(root: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: root, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never', LC_ALL: 'C' },
    }, (err, stdout, stderr) => {
      if (err) reject(new GitError('GIT_FAILED', redact((stderr || stdout || err.message).trim()).slice(0, 4000)));
      else resolve(stdout);
    });
  });
}

export interface Branch { name: string; current: boolean; remote: boolean; upstream: string | null }
export async function listBranches(root: string): Promise<Branch[]> {
  const out = await git(root, ['for-each-ref', '--format=%(refname)%00%(HEAD)%00%(upstream:short)', 'refs/heads', 'refs/remotes']);
  return out.split('\n').filter(Boolean).map((l) => {
    const [ref, head, up] = l.split('\0');
    const remote = ref!.startsWith('refs/remotes/');
    return { name: ref!.replace(/^refs\/(heads|remotes)\//, ''), current: head === '*', remote, upstream: up || null };
  }).filter((b) => !(b.remote && b.name.endsWith('/HEAD')));
}

async function validBranch(root: string, name: string) {
  if (!name || name.startsWith('-')) throw new GitError('INVALID', `Invalid branch name: ${name}`);
  try { await git(root, ['check-ref-format', '--branch', name]); } catch { throw new GitError('INVALID', `Invalid branch name: ${name}`); }
}
/** Tracked modifications (staged or not). Untracked files carry over a switch safely, so they don't count. */
export async function isDirty(root: string) { return (await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim().length > 0; }

export async function createBranch(root: string, name: string, checkout: boolean) {
  await validBranch(root, name);
  await git(root, checkout ? ['switch', '-c', name] : ['branch', name]);
}
/** Switch to a local branch, or create a tracking branch for a remote one. Refuses on a dirty tree unless `force` (carry changes). */
export async function switchBranch(root: string, name: string, opts: { allowDirty: boolean }) {
  const branches = await listBranches(root);
  const b = branches.find((x) => x.name === name);
  if (!b) throw new GitError('INVALID', `No such branch: ${name}`);
  if (!opts.allowDirty && (await isDirty(root))) throw new GitError('DIRTY', 'You have uncommitted changes. Commit or stash them, or switch anyway (changes are carried over when possible).');
  if (b.remote) {
    const local = name.slice(name.indexOf('/') + 1);
    await git(root, branches.some((x) => !x.remote && x.name === local) ? ['switch', local] : ['switch', '--track', name]);
  } else await git(root, ['switch', name]);
}

/** Discard local changes: tracked files are restored from HEAD (index + worktree), untracked files are deleted. */
export async function discard(root: string, rels: string[]) {
  for (const r of rels) assertWithin(root, path.resolve(root, r));
  const st = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...rels]);
  const entries = st.split('\0').filter(Boolean).map((e) => ({ xy: e.slice(0, 2), p: e.slice(3) }));
  const untracked = entries.filter((e) => e.xy === '??').map((e) => e.p);
  const added = new Set((await git(root, ['diff', '--cached', '--name-only', '--diff-filter=A', '-z', '--', ...rels])).split('\0').filter(Boolean));
  const fromHead = entries.filter((e) => e.xy !== '??' && !added.has(e.p)).map((e) => e.p);
  if (fromHead.length) await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...fromHead]);
  if (added.size) await git(root, ['rm', '--cached', '-q', '--', ...added]);
  for (const p of [...untracked, ...added]) { const abs = path.resolve(root, p); assertWithin(root, abs); await fs.rm(abs, { force: true }); }
}

export interface Tracking { branch: string | null; upstream: string | null; ahead: number; behind: number }
export async function tracking(root: string): Promise<Tracking> {
  const branch = (await git(root, ['branch', '--show-current']).catch(() => '')).trim() || null;
  const upstream = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim() || null;
  if (!upstream) return { branch, upstream: null, ahead: 0, behind: 0 };
  const [ahead, behind] = (await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).trim().split(/\s+/).map(Number);
  return { branch, upstream, ahead: ahead ?? 0, behind: behind ?? 0 };
}

export async function sync(root: string, op: 'fetch' | 'pull' | 'push'): Promise<string> {
  const t = 120_000;
  if (op === 'fetch') return git(root, ['fetch', '--prune'], t);
  if (op === 'pull') return git(root, ['pull', '--ff-only'], t);
  const tr = await tracking(root);
  if (!tr.branch) throw new GitError('INVALID', 'Cannot push a detached HEAD');
  if (tr.upstream) return git(root, ['push'], t);
  const remotes = (await git(root, ['remote'])).split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!remote) throw new GitError('NO_UPSTREAM', 'No remote configured');
  return git(root, ['push', '-u', remote, tr.branch], t);
}
