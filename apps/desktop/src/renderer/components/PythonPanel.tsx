import { useCallback, useEffect, useState } from 'react';
import type { Res } from '@nova/ipc-contract';
import { call } from '../lib/ipc';

/** Python interpreter for this workspace: used by pytest runs, the debugger (debugpy) and Pyright. */
export function PythonPanel({ onError }: { onError(e: unknown): void }) {
  const [info, setInfo] = useState<Res<'python.list.v1'> | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setBusy(true); return call('python.list.v1', {}).then(setInfo).catch(onError).finally(() => setBusy(false)); }, [onError]);
  useEffect(() => { void load(); }, [load]);
  const select = (p: string | null) => void call('python.select.v1', { path: p }).then(load).catch(onError);
  const eff = info?.effective;
  return (
    <div className="ls-card" aria-label="Python interpreter">
      <div className="ls-head"><strong>Python</strong> {busy && <span className="muted">looking for interpreters…</span>}</div>
      {eff && (
        <div className="muted small" data-python-effective={eff.command}>
          In use: <code className="ls-path">{eff.command}</code>{eff.version ? ` · ${eff.version}` : ''} ({eff.source})
        </div>
      )}
      {eff?.note && <div className="warn small">{eff.note}</div>}
      {info && (
        <label className="muted small">This workspace
          <select aria-label="Workspace Python interpreter" value={info.selected ?? ''} onChange={(e) => select(e.target.value || null)}>
            <option value="">Automatic (workspace venv, else PATH)</option>
            {info.selected && !info.interpreters.some((p) => p.path === info.selected) && <option value={info.selected}>{info.selected} (chosen)</option>}
            {info.interpreters.map((p) => <option key={p.path} value={p.path}>{p.version} — {p.source} — {p.path}</option>)}
          </select>
        </label>
      )}
      <div className="toggles">
        <button className="btn small" onClick={() => void call('python.pick.v1', {}).then(load).catch(onError)}>Choose Interpreter…</button>
        <button className="btn small" disabled={busy} onClick={() => void load()}>Refresh</button>
      </div>
      <div className="muted small">Used for pytest runs, debugging (debugpy) and Pyright. Found: workspace .venv/venv/env, PATH, pyenv, conda{navigator.userAgent.includes('Windows') ? ', py launcher' : ''}.</div>
    </div>
  );
}
