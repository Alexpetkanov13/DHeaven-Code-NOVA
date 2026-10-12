import { useCallback, useEffect, useState } from 'react';
import type { Res } from '@nova/ipc-contract';
import { call } from '../lib/ipc';

/** JDK discovery + selection: global default and per-workspace override. */
export function JdkPanel({ onError, hasWorkspace }: { onError(e: unknown): void; hasWorkspace: boolean }) {
  const [info, setInfo] = useState<Res<'jdk.list.v1'> | null>(null);
  const [custom, setCustom] = useState('');
  const load = useCallback(() => call('jdk.list.v1', {}).then(setInfo).catch(onError), [onError]);
  useEffect(() => { void load(); }, [load]);
  const select = (home: string | null, scope: 'global' | 'workspace') => void call('jdk.select.v1', { home, scope }).then(load).catch(onError);
  if (!info) return null;
  return (
    <div className="ls-card" aria-label="Java Development Kits">
      <div className="ls-head"><strong>Java (JDK)</strong> <span className="muted">effective: {info.effective ?? 'none found'}</span></div>
      {info.jdks.length === 0 && <div className="muted">No JDK found in JAVA_HOME, PATH or common install folders. Add one below.</div>}
      <label className="muted small">Global default
        <select aria-label="Global JDK" value={info.globalHome ?? ''} onChange={(e) => select(e.target.value || null, 'global')}>
          <option value="">Auto (newest)</option>
          {info.jdks.map((j) => <option key={j.home} value={j.home}>{j.major} — {j.version} ({j.source}) {j.home}</option>)}
        </select>
      </label>
      {hasWorkspace && (
        <label className="muted small">This workspace
          <select aria-label="Workspace JDK" value={info.workspaceHome ?? ''} onChange={(e) => select(e.target.value || null, 'workspace')}>
            <option value="">Use global</option>
            {info.jdks.map((j) => <option key={j.home} value={j.home}>{j.major} — {j.version} {j.home}</option>)}
          </select>
        </label>
      )}
      <div className="toggles">
        <input type="text" aria-label="Custom JDK path" placeholder="/path/to/jdk" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button className="btn small" disabled={!custom} onClick={() => select(custom, hasWorkspace ? 'workspace' : 'global')}>Use</button>
      </div>
      <div className="muted small">JDT LS itself needs JDK 21+; if the selected JDK is older, NOVA runs the server on the newest 21+ JDK found.</div>
    </div>
  );
}
