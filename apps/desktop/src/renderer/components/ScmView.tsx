import { useCallback, useEffect, useState } from 'react';
import type { GitStatus } from '@nova/ipc-contract';
import { call } from '../lib/ipc';

interface Props { refreshKey: number; trusted: boolean; onOpenDiff(rel: string, staged: boolean, untracked: boolean): void; onError(e: unknown): void; onLog(t: string): void }

export function ScmView({ refreshKey, trusted, onOpenDiff, onError, onLog }: Props) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [msg, setMsg] = useState('');
  const refresh = useCallback(() => call('git.status.v1', {}).then(setSt).catch(onError), [onError]);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);
  if (!st) return <div className="view muted">Loading…</div>;
  if (!st.isRepo) return <div className="view muted">This folder is not a Git repository.</div>;
  const staged = st.files.filter((f) => f.index !== '.' && f.index !== '?');
  const changes = st.files.filter((f) => f.worktree !== '.');
  const act = (fn: () => Promise<unknown>) => fn().then(refresh).catch(onError);
  const commit = () => act(async () => {
    const r = await call('git.commit.v1', { message: msg });
    onLog(`Committed ${r.commit}`); setMsg('');
  });
  return (
    <div className="view" aria-label="Source Control">
      <div className="muted">Branch: {st.branch ?? '(detached)'}</div>
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
          <button className="icon-btn" aria-label={`Stage ${f.path}`} onClick={(e) => { e.stopPropagation(); void act(() => call('git.stage.v1', { rels: [f.path] })); }}>+</button>
        </div>
      ))}
    </div>
  );
}
