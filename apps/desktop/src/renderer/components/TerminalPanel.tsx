import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { b64ToBytes, call, on } from '../lib/ipc';

/** Real shell via novad PTY. Requires workspace trust. */
export function TerminalPanel({ trusted, workspaceKey, onError, onTrust }: { trusted: boolean; workspaceKey: string; onError(e: unknown): void; onTrust(): void }) {
  const host = useRef<HTMLDivElement>(null);
  const [gen, setGen] = useState(0);
  const [exited, setExited] = useState<number | null | undefined>(undefined);
  const ptyRef = useRef<number | null>(null);

  useEffect(() => {
    if (!trusted || !host.current) return;
    const term = new Terminal({
      fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace', fontSize: 13, cursorBlink: true,
      theme: { background: '#14161C', foreground: '#E6E9F5', cursor: '#3FE0FF', selectionBackground: '#2A1B5C', cyan: '#3FE0FF', magenta: '#9B6BFF' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    try { fit.fit(); } catch { /* not visible yet */ }
    let disposed = false;
    setExited(undefined);
    const offData = on('terminal.data.v1', (p) => { if (p.ptyId === ptyRef.current) term.write(b64ToBytes(p.data)); });
    const offExit = on('terminal.exit.v1', (p) => { if (p.ptyId === ptyRef.current) { term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n'); setExited(p.code); ptyRef.current = null; } });
    void call('terminal.spawn.v1', { cols: Math.max(2, term.cols), rows: Math.max(2, term.rows) }).then((r) => {
      if (disposed) { void call('terminal.kill.v1', { ptyId: r.ptyId }); return; }
      ptyRef.current = r.ptyId;
    }, onError);
    const sub = term.onData((d) => { if (ptyRef.current !== null) void call('terminal.write.v1', { ptyId: ptyRef.current, data: d }).catch(onError); });
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
  }, [trusted, gen, workspaceKey, onError]);

  if (!trusted) return (
    <div className="trust-note">Terminal is disabled in Restricted Mode. <button className="btn small" onClick={onTrust}>Trust Workspace…</button></div>
  );
  return (
    <>
      <div className="toggles" style={{ padding: '0 12px' }}>
        <button className="btn small" onClick={() => setGen((g) => g + 1)}>New Terminal</button>
        <button className="btn small" aria-label="Kill Terminal" onClick={() => ptyRef.current !== null && void call('terminal.kill.v1', { ptyId: ptyRef.current })}>Kill</button>
        {exited !== undefined && <span>exited ({exited ?? 'killed'})</span>}
      </div>
      <div className="term-host" ref={host} aria-label="Terminal" />
    </>
  );
}
