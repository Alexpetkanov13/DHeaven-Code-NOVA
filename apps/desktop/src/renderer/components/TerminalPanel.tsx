import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { b64ToBytes, call, on } from '../lib/ipc';
import { terminalQueue } from '../lib/terminalQueue';

interface Pane { key: number; n: number; profileId: string | null }
interface Tab { key: number; panes: Pane[] }
interface Profile { id: string; name: string }
let seq = 0;
const nextKey = () => ++seq;

/** One xterm bound to one novad PTY. `active` panes receive AI-proposed commands. */
function TermPane({ pane, active, label, onFocus, onKill, onExit, onError }: {
  pane: Pane; active: boolean; label: string; onFocus(): void; onKill(): void; onExit(code: number | null): void; onError(e: unknown): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const ptyRef = useRef<number | null>(null);
  const [title, setTitle] = useState('starting…');
  const [exited, setExited] = useState<number | null | undefined>(undefined);
  const activeRef = useRef(active); activeRef.current = active;

  useEffect(() => {
    const h = () => { if (!activeRef.current || ptyRef.current === null) return; for (const cmd of terminalQueue.splice(0)) void call('terminal.write.v1', { ptyId: ptyRef.current, data: `${cmd}\r` }).catch(onError); };
    window.addEventListener('nova-terminal-run', h); return () => window.removeEventListener('nova-terminal-run', h);
  }, [onError]);

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace', fontSize: 13, cursorBlink: true,
      theme: { background: '#14161C', foreground: '#E6E9F5', cursor: '#3FE0FF', selectionBackground: '#2A1B5C', cyan: '#3FE0FF', magenta: '#9B6BFF' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    try { fit.fit(); } catch { /* not visible yet */ }
    let disposed = false;
    const offData = on('terminal.data.v1', (p) => { if (p.ptyId === ptyRef.current) term.write(b64ToBytes(p.data)); });
    const offExit = on('terminal.exit.v1', (p) => { if (p.ptyId === ptyRef.current) { term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n'); setExited(p.code); ptyRef.current = null; onExit(p.code); } });
    void call('terminal.spawn.v1', { cols: Math.max(2, term.cols), rows: Math.max(2, term.rows), ...(pane.profileId ? { profileId: pane.profileId } : {}) }).then((r) => {
      if (disposed) { void call('terminal.kill.v1', { ptyId: r.ptyId }); return; }
      ptyRef.current = r.ptyId; setTitle(r.profileName ?? 'shell');
      if (activeRef.current) for (const c of terminalQueue.splice(0)) void call('terminal.write.v1', { ptyId: r.ptyId, data: `${c}\r` }).catch(onError);
    }, onError);
    // Keystrokes must reach the PTY in order: chain writes instead of firing independent IPC calls.
    let chain: Promise<unknown> = Promise.resolve();
    const sub = term.onData((d) => {
      const id = ptyRef.current; if (id === null) return;
      chain = chain.then(() => call('terminal.write.v1', { ptyId: id, data: d })).catch(onError);
    });
    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { return; }
      if (ptyRef.current !== null) void call('terminal.resize.v1', { ptyId: ptyRef.current, cols: term.cols, rows: term.rows }).catch(() => {});
    });
    ro.observe(host.current);
    return () => {
      disposed = true; ro.disconnect(); sub.dispose(); offData(); offExit();
      if (ptyRef.current !== null) void call('terminal.kill.v1', { ptyId: ptyRef.current }).catch(() => {});
      ptyRef.current = null; term.dispose();
    };
    // pane identity is fixed for the component's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`term-pane${active ? ' active' : ''}`} data-term-pane={label} onMouseDown={onFocus}>
      <div className="term-pane-head">
        <span>{label} · {title}{exited !== undefined ? ` · exited (${exited ?? 'killed'})` : ''}</span>
        <button className="btn small" aria-label={`Kill ${label}`} title="Kill this terminal"
          onClick={() => { if (ptyRef.current !== null) void call('terminal.kill.v1', { ptyId: ptyRef.current }).catch(onError); onKill(); }}>Kill</button>
      </div>
      <div className="term-host" ref={host} aria-label={label} />
    </div>
  );
}

/** Real shells via novad PTYs: multiple tabs, each splittable into two panes. Requires workspace trust. */
export function TerminalPanel({ trusted, workspaceKey, onError, onTrust }: { trusted: boolean; workspaceKey: string; onError(e: unknown): void; onTrust(): void }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<number | null>(null);
  const [activePane, setActivePane] = useState<number | null>(null);
  const num = useRef(0); // stable "Terminal N" numbering within this workspace session
  const mkPane = (profile: string | null): Pane => ({ key: nextKey(), n: ++num.current, profileId: profile });

  useEffect(() => {
    if (!trusted) { setTabs([]); return; }
    let live = true;
    void call('terminal.profiles.v1', {}).then((r) => {
      if (!live) return;
      setProfiles(r.profiles); setProfileId(r.defaultId);
      num.current = 0; const p = mkPane(r.defaultId); const t = { key: nextKey(), panes: [p] };
      setTabs([t]); setActiveTab(t.key); setActivePane(p.key);
    }, onError);
    return () => { live = false; };
  }, [trusted, workspaceKey, onError]);

  const newTab = () => { const p = mkPane(profileId); const t = { key: nextKey(), panes: [p] }; setTabs((ts) => [...ts, t]); setActiveTab(t.key); setActivePane(p.key); };
  const split = () => {
    const p = mkPane(profileId);
    setTabs((ts) => ts.map((t) => (t.key === activeTab && t.panes.length < 2 ? { ...t, panes: [...t.panes, p] } : t))); setActivePane(p.key);
  };
  const removePane = (tabKey: number, paneKey: number) => setTabs((ts) => {
    const next = ts.map((t) => (t.key === tabKey ? { ...t, panes: t.panes.filter((p) => p.key !== paneKey) } : t)).filter((t) => t.panes.length);
    if (!next.some((t) => t.key === activeTab)) { const t = next[next.length - 1]; setActiveTab(t?.key ?? null); setActivePane(t?.panes[0]?.key ?? null); }
    return next;
  });
  const chooseProfile = (id: string) => { setProfileId(id); void call('settings.update.v1', { terminalProfile: id }).catch(onError); };

  if (!trusted) return (
    <div className="trust-note">Terminal is disabled in Restricted Mode. <button className="btn small" onClick={onTrust}>Trust Workspace…</button></div>
  );
  const cur = tabs.find((t) => t.key === activeTab);
  const labels = new Map<number, string>();
  for (const t of tabs) for (const p of t.panes) labels.set(p.key, `Terminal ${p.n}`);
  return (
    <div className="term-panel">
      <div className="toggles term-bar" style={{ padding: '0 12px' }}>
        <div role="tablist" aria-label="Terminals" className="term-tabs">
          {tabs.map((t, i) => (
            <button key={t.key} role="tab" aria-selected={t.key === activeTab} className={`btn small${t.key === activeTab ? ' primary' : ''}`}
              onClick={() => { setActiveTab(t.key); setActivePane(t.panes[0]!.key); }}>{i + 1}: {t.panes.map((p) => labels.get(p.key)!.replace('Terminal ', '#')).join(' | ')}</button>
          ))}
        </div>
        <button className="btn small" onClick={newTab}>New Terminal</button>
        <button className="btn small" onClick={split} disabled={!cur || cur.panes.length >= 2} title="Split the current terminal">Split</button>
        <label>Profile
          <select aria-label="Terminal profile" value={profileId ?? ''} onChange={(e) => chooseProfile(e.target.value)}>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>
      {tabs.length === 0 && <div className="trust-note">No terminals. <button className="btn small" onClick={newTab}>New Terminal</button></div>}
      {tabs.map((t) => (
        <div key={t.key} className="term-split" style={{ display: t.key === activeTab ? 'flex' : 'none' }}>
          {t.panes.map((p) => (
            <TermPane key={p.key} pane={p} label={labels.get(p.key)!} active={p.key === activePane} onError={onError}
              onFocus={() => setActivePane(p.key)} onKill={() => removePane(t.key, p.key)} onExit={() => {}} />
          ))}
        </div>
      ))}
    </div>
  );
}
