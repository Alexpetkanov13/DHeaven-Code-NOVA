import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ExtInfo, ExtPreview } from '@nova/ipc-contract';
import { call } from '../lib/ipc';
import type { ExtensionsClient } from '../lib/extensions';

const STATUS_LABEL: Record<ExtInfo['status'], string> = { inactive: 'Inactive', activating: 'Activating…', active: 'Active', error: 'Error', quarantined: 'Quarantined', disabled: 'Disabled', blocked: 'Blocked (Restricted Mode)' };

export function ExtensionsView({ client, trusted, onError, onLog, confirmInstall }: {
  client: ExtensionsClient; trusted: boolean; onError(e: unknown): void; onLog(t: string): void;
  confirmInstall(p: ExtPreview, go: () => void, cancel: () => void): void;
}) {
  useSyncExternalStore((f) => client.subscribe(f), () => client.list);
  const host = useSyncExternalStore((f) => client.subscribe(f), () => client.host);
  const [sel, setSel] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const x = client.list.find((e) => e.id === sel) ?? null;
  useEffect(() => { if (sel) void call('ext.logs.v1', { id: sel }).then(setLogs).catch(() => setLogs([])); }, [sel, client.list]);

  const pick = (kind: 'file' | 'folder') => void call('ext.pickInstall.v1', { kind }).then((p) => {
    if (!p) return;
    confirmInstall(p, () => void call('ext.install.v1', { token: p.token }).then((r) => { onLog(`Installed extension ${r.id} ${r.version}`); setSel(r.id); }).catch(onError),
      () => void call('ext.cancelInstall.v1', { token: p.token }).catch(() => {}));
  }).catch(onError);
  const act = (f: () => Promise<unknown>) => void f().catch(onError);

  return (
    <div className="ext-view" aria-label="Extensions">
      <div className="ext-actions">
        <button className="btn small" onClick={() => pick('file')}>Install from .novaext…</button>
        <button className="btn small ghost" onClick={() => pick('folder')}>Install from Folder…</button>
      </div>
      <p className="muted small">Local installs only — there is no marketplace. Packages are checked for path traversal, size limits, manifest validity and SHA-256 integrity.</p>
      {!trusted && <p className="trust-note small">Restricted Mode: themes, grammars and snippets apply, but extension code does not run until you trust this folder.</p>}
      <div className="ext-host small" aria-label="Extension host">
        Host: <b data-host-state={host?.state ?? 'stopped'}>{host?.state ?? 'stopped'}</b>{host?.pid ? ` · pid ${host.pid}` : ''}{host?.startupMs != null ? ` · started in ${host.startupMs} ms` : ''}{host?.crashes ? ` · ${host.crashes} recent crash(es)` : ''}
        {host?.error && <div className="err">{host.error}</div>}
        <button className="link" onClick={() => act(() => call('ext.restartHost.v1', {}))}>Restart host</button>
      </div>
      <ul className="ext-list" role="listbox" aria-label="Installed extensions">
        {client.list.map((e) => (
          <li key={e.id} role="option" aria-selected={e.id === sel} data-ext={e.id} className={e.id === sel ? 'on' : ''} onClick={() => setSel(e.id)}>
            <div className="ext-name">{e.displayName} <small>{e.version}</small></div>
            <div className="small muted">{e.publisher} · <span className={`ext-status s-${e.status}`} data-status={e.status}>{!e.hasCode && e.status === 'inactive' ? 'Applied (declarative)' : STATUS_LABEL[e.status]}</span>{e.activationMs != null ? ` · ${e.activationMs} ms` : ''}</div>
          </li>
        ))}
        {client.list.length === 0 && <li className="muted small">No extensions installed.</li>}
      </ul>
      {x && (
        <section className="ext-details" aria-label={`Details for ${x.displayName}`}>
          <h3>{x.displayName} <small>{x.id}@{x.version}</small></h3>
          <p>{x.description}</p>
          <dl className="small">
            <dt>Status</dt><dd data-testid="ext-status">{!x.hasCode && x.status === 'inactive' ? 'Applied (declarative, no code)' : STATUS_LABEL[x.status]}{x.activatedBy ? ` (activated by ${x.activatedBy} in ${x.activationMs} ms)` : ''}</dd>
            {x.quarantined && <><dt>Quarantined</dt><dd className="err">{x.quarantined}</dd></>}
            {x.lastError && <><dt>Last error</dt><dd className="err" data-testid="ext-error">{x.lastError}</dd></>}
            <dt>Engine</dt><dd>nova {x.engines}</dd>
            <dt>License</dt><dd>{x.license ?? '—'}</dd>
            <dt>Source</dt><dd title={x.source}>{x.source}</dd>
            <dt>SHA-256</dt><dd className="mono">{x.sha256 ?? '—'}</dd>
            <dt>Contributes</dt><dd>{Object.entries(x.contributes).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing'}</dd>
            <dt>Activation</dt><dd>{x.hasCode ? x.activationEvents.join(', ') || 'never' : 'declarative only (no code)'}</dd>
          </dl>
          <div className="ext-actions">
            <button className="btn small" onClick={() => act(() => call('ext.setEnabled.v1', { id: x.id, enabled: !x.enabled || !!x.quarantined }))}>{x.enabled && !x.quarantined ? 'Disable' : x.quarantined ? 'Re-enable' : 'Enable'}</button>
            {x.previousVersion && <button className="btn small ghost" onClick={() => act(() => call('ext.rollback.v1', { id: x.id }))}>Roll back to {x.previousVersion}</button>}
            <button className="btn small ghost danger" onClick={() => act(async () => { await call('ext.uninstall.v1', { id: x.id }); setSel(null); onLog(`Uninstalled ${x.id}`); })}>Uninstall</button>
          </div>
          <h4>Permissions</h4>
          {x.permissions.length === 0 ? <p className="small muted">None requested. Undeclared capabilities are always denied.</p> : (
            <ul className="ext-perms">
              {x.permissions.map((p) => (
                <li key={p.id}><b>{p.id}</b> <span className="small muted">{p.description}</span>
                  <select aria-label={`Permission ${p.id}`} value={p.grant ?? 'ask'} onChange={(ev) => act(() => call('ext.setGrant.v1', { id: x.id, permission: p.id, grant: ev.target.value === 'ask' ? null : (ev.target.value as 'granted' | 'denied') }))}>
                    <option value="ask">Ask</option><option value="granted">Allow</option><option value="denied">Deny</option>
                  </select>
                </li>
              ))}
            </ul>
          )}
          {x.configuration.length > 0 && <><h4>Settings</h4>
            {x.configuration.map((c) => (
              <label key={c.key} className="ext-setting small">{c.key} <span className="muted">{c.description}</span>
                {c.type === 'boolean'
                  ? <input type="checkbox" checked={!!c.value} onChange={(ev) => act(() => call('ext.setConfig.v1', { id: x.id, key: c.key, value: ev.target.checked }))} />
                  : <input defaultValue={String(c.value ?? '')} onBlur={(ev) => act(() => call('ext.setConfig.v1', { id: x.id, key: c.key, value: c.type === 'number' ? Number(ev.target.value) : ev.target.value }))} />}
              </label>
            ))}</>}
          <h4>Log</h4>
          <pre className="ext-log" aria-label="Extension log">{logs.join('\n') || '(empty)'}</pre>
        </section>
      )}
    </div>
  );
}

export function ExtensionTreeViews({ client, onError }: { client: ExtensionsClient; onError(e: unknown): void }) {
  const c = useSyncExternalStore((f) => client.subscribe(f), () => client.contributions);
  if (!c.views.length) return null;
  return <>{c.views.map((v) => <TreeSection key={v.id} viewId={v.id} title={`${v.name}`} client={client} onError={onError} />)}</>;
}
type Item = { id?: string; label: string; description?: string; tooltip?: string; collapsible?: boolean; command?: string };
function TreeSection({ viewId, title, client, onError }: { viewId: string; title: string; client: ExtensionsClient; onError(e: unknown): void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => client.subscribe(() => {}), [client]);
  useEffect(() => { const h = (e: Event) => { if ((e as CustomEvent).detail === viewId) setRev((r) => r + 1); }; window.addEventListener('nova-ext-tree', h); return () => window.removeEventListener('nova-ext-tree', h); }, [viewId]);
  useEffect(() => { if (open) void call('ext.treeChildren.v1', { viewId }).then((r) => setItems(r as Item[])).catch((e) => { setItems([]); onError(e); }); }, [open, viewId, rev, onError]);
  return (
    <section className="ext-tree" aria-label={`View ${title}`}>
      <button className="ext-tree-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? '▾' : '▸'} {title}</button>
      {open && <ul>{(items ?? []).map((i, n) => <li key={i.id ?? n} title={i.tooltip} onClick={() => i.command && void call('ext.executeCommand.v1', { command: i.command }).catch(onError)}>{i.label} {i.description && <span className="muted small">{i.description}</span>}</li>)}{items?.length === 0 && <li className="muted small">(empty)</li>}</ul>}
    </section>
  );
}

export function PermissionPrompt({ req, onAnswer }: { req: { requestId: number; extName: string; permission: string; description: string }; onAnswer(grant: 'granted' | 'denied', remember: boolean): void }) {
  const [remember, setRemember] = useState(false);
  return (
    <div className="palette-backdrop">
      <div className="palette confirm" role="alertdialog" aria-label="Extension permission request">
        <p><b>{req.extName}</b> wants permission <b>{req.permission}</b>: {req.description}.</p>
        <label className="small"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember my choice for this extension</label>
        <div className="row-btns">
          <button className="btn ghost" onClick={() => onAnswer('denied', remember)}>Deny</button>
          <button className="btn primary" onClick={() => onAnswer('granted', remember)}>Allow</button>
        </div>
      </div>
    </div>
  );
}
