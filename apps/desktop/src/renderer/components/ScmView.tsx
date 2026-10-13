import { useCallback, useEffect, useState } from 'react';
import type { GitStatus } from '@nova/ipc-contract';
import { IpcError, call } from '../lib/ipc';

type Branch = { name: string; current: boolean; remote: boolean; upstream: string | null };
type Tracking = { branch: string | null; upstream: string | null; ahead: number; behind: number };

interface Props { refreshKey: number; trusted: boolean; onOpenDiff(rel: string, staged: boolean, untracked: boolean): void; onError(e: unknown): void; onLog(t: string): void }

export function ScmView({ refreshKey, trusted, onOpenDiff, onError, onLog }: Props) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [msg, setMsg] = useState('');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [tr, setTr] = useState<Tracking | null>(null);
  const [target, setTarget] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const s = await call('git.status.v1', {}); setSt(s);
      if (s.isRepo && trusted) { setBranches(await call('git.branches.v1', {})); setTr(await call('git.tracking.v1', {})); }
      window.dispatchEvent(new Event('nova-git-changed'));
    } catch (e) { onError(e); }
  }, [onError, trusted]);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);
  if (!st) return <div className="view muted">Loading…</div>;
  if (!st.isRepo) return <div className="view muted">This folder is not a Git repository.</div>;
  const staged = st.files.filter((f) => f.index !== '.' && f.index !== '?');
  const changes = st.files.filter((f) => f.worktree !== '.');
  const act = (fn: () => Promise<unknown>) => fn().then(refresh).catch(onError);
  const doSwitch = (name: string) => act(async () => {
    try { await call('git.switch.v1', { name, allowDirty: false }); }
    catch (e) {
      if (!(e instanceof IpcError && e.code === 'GIT_DIRTY')) throw e;
      if (!window.confirm(`${e.message}\n\nSwitch to ${name} anyway?`)) return;
      await call('git.switch.v1', { name, allowDirty: true });
    }
    onLog(`Switched to ${name}`); setTarget('');
  });
  const create = () => act(async () => { await call('git.createBranch.v1', { name: newName.trim(), checkout: true }); onLog(`Created and switched to ${newName.trim()}`); setNewName(''); });
  const discard = (rel: string) => { if (window.confirm(`Discard all changes to ${rel}? This cannot be undone.`)) void act(() => call('git.discard.v1', { rels: [rel] })); };
  const sync = (op: 'fetch' | 'pull' | 'push') => { setBusy(op); void act(async () => { const r = await call('git.sync.v1', { op }); onLog(`git ${op}: ${r.output.trim() || 'done'}`); }).finally(() => setBusy(null)); };
  const commit = () => act(async () => {
    const r = await call('git.commit.v1', { message: msg });
    onLog(`Committed ${r.commit}`); setMsg('');
  });
  return (
    <div className="view" aria-label="Source Control">
      <div className="muted">Branch: <span data-scm-branch>{st.branch ?? '(detached)'}</span>{tr?.upstream ? <span aria-label="Ahead/behind"> · ↑{tr.ahead} ↓{tr.behind} ({tr.upstream})</span> : null}</div>
      {trusted ? (
        <div className="scm-branches" aria-label="Branches">
          <div className="toggles">
            <select aria-label="Branch" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Switch to…</option>
              {branches.filter((b) => !b.current).map((b) => <option key={b.name} value={b.name}>{b.remote ? `${b.name} (remote)` : b.name}</option>)}
            </select>
            <button className="btn small" disabled={!target} onClick={() => void doSwitch(target)}>Switch</button>
          </div>
          <div className="toggles">
            <input aria-label="New branch name" placeholder="new-branch" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) void create(); }} />
            <button className="btn small" disabled={!newName.trim()} onClick={() => void create()}>Create Branch</button>
          </div>
          <div className="toggles">
            {(['fetch', 'pull', 'push'] as const).map((op) => (
              <button key={op} className="btn small" disabled={!!busy} onClick={() => sync(op)}>{busy === op ? `${op}…` : op[0]!.toUpperCase() + op.slice(1)}</button>
            ))}
          </div>
        </div>
      ) : <div className="muted">Branches, discard and fetch/pull/push need a trusted workspace.</div>}
      <textarea aria-label="Commit message" rows={3} placeholder="Commit message" value={msg} onChange={(e) => setMsg(e.target.value)} />
      <button className="btn small" disabled={!msg.trim() || !staged.length || !trusted} title={trusted ? '' : 'Commit runs Git hooks; trust the workspace first'} onClick={() => void commit()}>Commit</button>
      <div className="scm-group">Staged Changes ({staged.length})</div>
      {staged.map((f) => (
        <div key={'s' + f.path} className="scm-file" data-scm-staged={f.path} onClick={() => onOpenDiff(f.path, true, false)}>
          <span className="st">{f.index}</span><span className="grow">{f.path}</span>
          <button className="icon-btn" aria-label={`Unstage ${f.path}`} onClick={(e) => { e.stopPropagation(); void act(() => call('git.unstage.v1', { rels: [f.path] })); }}>−</button>
        </div>
      ))}
      <div className="scm-group">Changes ({changes.length})</div>
      {changes.map((f) => (
        <div key={'c' + f.path} className="scm-file" data-scm-change={f.path} onClick={() => onOpenDiff(f.path, false, f.worktree === '?')}>
          <span className="st">{f.worktree === '?' ? 'U' : f.worktree}</span><span className="grow">{f.path}</span>
          {trusted && <button className="icon-btn" aria-label={`Discard ${f.path}`} title="Discard changes" onClick={(e) => { e.stopPropagation(); discard(f.path); }}>↺</button>}
          <button className="icon-btn" aria-label={`Stage ${f.path}`} onClick={(e) => { e.stopPropagation(); void act(() => call('git.stage.v1', { rels: [f.path] })); }}>+</button>
        </div>
      ))}
    </div>
  );
}
