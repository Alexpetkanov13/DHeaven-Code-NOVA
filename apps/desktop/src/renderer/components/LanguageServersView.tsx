import { useEffect, useState, type ReactNode } from 'react';
import type { ServerStatus } from '@nova/ipc-contract';
import { call, on } from '../lib/ipc';

const ALL = ['completion', 'hover', 'signatureHelp', 'definition', 'references', 'rename', 'formatting', 'codeActions'];

interface Props { trusted: boolean; onError(e: unknown): void; askInstall(s: ServerStatus): void; children?: ReactNode }

/** Honest status: badges come only from capabilities the running server actually advertised/registered. */
export function LanguageServersView({ trusted, onError, askInstall, children }: Props) {
  const [servers, setServers] = useState<ServerStatus[]>([]);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [install, setInstall] = useState<Record<string, string>>({});
  useEffect(() => {
    void call('lsp.status.v1', {}).then(setServers).catch(onError);
    const a = on('lsp.status.v1', ({ servers: s }) => setServers(s));
    const b = on('lsp.install.v1', (p) => setInstall((m) => ({ ...m, [p.serverId]: p.message })));
    return () => { a(); b(); };
  }, [onError]);
  useEffect(() => {
    if (!logsFor) return;
    const load = () => void call('lsp.logs.v1', { serverId: logsFor }).then(setLogs).catch(() => {});
    load(); const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [logsFor]);
  return (
    <div className="view" aria-label="Language Servers">
      {children}
      {servers.map((s) => (
        <div key={s.id} className="ls-card" data-server={s.id}>
          <div className="ls-head"><strong>{s.name}</strong> <span className="muted">{s.version} · {s.languages.join(', ')}</span></div>
          <div><span className={`ls-state st-${s.state}`} data-state={s.state}>{s.state}</span>{s.pid ? <span className="muted"> pid {s.pid}</span> : null}</div>
          {s.reason && <div className="muted">{s.reason}</div>}
          <div className="badges" aria-label={`${s.name} capabilities`}>
            {ALL.map((c) => <span key={c} className={`badge${s.capabilities.includes(c) ? ' on' : ''}`} title={s.capabilities.includes(c) ? 'Advertised by the running server' : s.state === 'ready' ? 'Not advertised by server' : 'Server not running'}>{c}</span>)}
          </div>
          <div className="toggles">
            {!s.installed && <button className="btn small" onClick={() => askInstall(s)}>Install…</button>}
            {s.installed && <button className="btn small" disabled={!trusted} onClick={() => void call('lsp.restart.v1', { serverId: s.id }).catch(onError)}>{s.state === 'ready' ? 'Restart' : 'Start'}</button>}
            {s.state !== 'stopped' && s.state !== 'blocked' && <button className="btn small" onClick={() => void call('lsp.stop.v1', { serverId: s.id }).catch(onError)}>Stop</button>}
            <button className="btn small" onClick={() => setLogsFor(logsFor === s.id ? null : s.id)}>{logsFor === s.id ? 'Hide Logs' : 'Logs'}</button>
          </div>
          {install[s.id] && <div className="muted">{install[s.id]}</div>}
          <div className="muted small">{s.limitations}</div>
          {logsFor === s.id && <pre className="ls-logs" aria-label={`${s.name} logs`}>{logs.slice(-200).join('\n') || '(no output yet)'}</pre>}
        </div>
      ))}
    </div>
  );
}
