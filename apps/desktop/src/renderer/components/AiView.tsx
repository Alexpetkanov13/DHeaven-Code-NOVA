import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AiClient, PrepareReq } from '../lib/ai';
import { recentTerminal } from '../lib/ai';
import { call } from '../lib/ipc';

const ACTION_LABEL: Record<string, string> = { chat: 'Chat', explainSelection: 'Explain selection', explainError: 'Explain error', generateTests: 'Generate tests', documentFunction: 'Document function', inlineEdit: 'Inline edit' };

export function AiView({ client, activeRel, openRels, hasWorkspace, onRunCommand }: {
  client: AiClient; activeRel: string | null; openRels: string[]; hasWorkspace: boolean; onRunCommand(cmd: string): void;
}) {
  useSyncExternalStore((f) => client.subscribe(f), () => client.config);
  const cur = useSyncExternalStore((f) => client.subscribe(f), () => client.current);
  const history = useSyncExternalStore((f) => client.subscribe(f), () => client.history);
  const [text, setText] = useState('');
  const [incActive, setIncActive] = useState(true);
  const [incOpen, setIncOpen] = useState(false);
  const [incTerm, setIncTerm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const c = client.config; const p = client.active;
  useEffect(() => { void client.refresh(); }, [client, hasWorkspace]);
  if (!c) return <div className="ai-view muted small">Loading…</div>;
  if (!c.enabled) return (
    <div className="ai-view" aria-label="NOVA AI">
      <p><b>NOVA AI is off.</b></p>
      <p className="small muted">When on, NOVA sends only what you choose — after showing you the exact request — to the provider you configure. Local (Ollama) keeps everything on this machine. Sensitive files (.env, keys, ignored, binary, oversized) are never attached and secrets are redacted.</p>
      <button className="btn primary" onClick={() => void client.setConfig({ enabled: true })}>Enable NOVA AI</button>
    </div>
  );
  const send = () => {
    const files = [...new Set([...(incActive && activeRel ? [activeRel] : []), ...(incOpen ? openRels : [])])];
    const req: PrepareReq = { action: 'chat', prompt: text, ...(files.length ? { files } : {}), ...(incTerm && recentTerminal() ? { terminal: recentTerminal() } : {}) };
    void client.ask(req);
  };
  const streaming = cur && !cur.done;
  return (
    <div className="ai-view" aria-label="NOVA AI">
      <div className="ai-head small">
        <span className="ai-provider" data-testid="ai-provider">{p ? `${p.label} · ${p.model || 'no model'}` : 'no provider'} <span className={`badge ${p?.local ? 'ok' : 'warn'}`}>{p?.local ? 'local' : 'remote'}</span></span>
        <span>
          <button className="link" onClick={() => setShowSettings((s) => !s)}>{showSettings ? 'Close settings' : 'Settings'}</button>
          <button className="link" onClick={() => void client.setConfig({ enabled: false })}>Turn off</button>
        </span>
      </div>
      {showSettings && <AiSettings client={client} />}
      <div className="ai-thread" aria-label="AI conversation" role="log">
        {history.length === 0 && !cur && <p className="muted small">No AI history for this workspace.</p>}
        {history.map((h) => <div key={h.id} className={`ai-msg ${h.role}`}><div className="small muted">{h.role === 'user' ? `You · ${ACTION_LABEL[h.action] ?? h.action}` : `${h.provider} · ${h.model}`}{h.error ? ` · ${h.error}` : ''}</div><pre>{h.content}</pre></div>)}
        {cur && !cur.done && (
          <div className="ai-msg assistant streaming" data-testid="ai-streaming"><div className="small muted">{cur.provider} · {cur.model} · {ACTION_LABEL[cur.action]}{cur.status ? ` · ${cur.status}` : ''}</div><pre>{cur.text}<span className="caret">▍</span></pre></div>
        )}
        {cur?.done && (
          <div className="ai-msg assistant" data-testid="ai-last">
            <div className="small muted">{cur.provider} · {cur.model} · {cur.done.cancelled ? 'Cancelled' : cur.done.error ? 'Failed' : 'Done'}{cur.status ? ` · ${cur.status}` : ''}</div>
            {cur.done.error && <div className="err small" role="alert">{cur.done.error}</div>}
            {cur.done.cancelled && <pre data-testid="ai-cancelled-text">{cur.text}</pre>}
            {cur.done.commands.length > 0 && <div className="ai-cmds"><div className="small muted">Proposed commands (not run):</div>{cur.done.commands.map((cmd, i) => (
              <div key={i} className="ai-cmd"><code>{cmd}</code><button className="btn small" onClick={() => onRunCommand(cmd)}>Run in terminal…</button></div>
            ))}</div>}
          </div>
        )}
      </div>
      <div className="ai-compose">
        <textarea aria-label="Ask NOVA AI" placeholder={hasWorkspace ? 'Ask about your code…' : 'Open a folder to use NOVA AI with workspace history'} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} />
        <div className="small ai-opts">
          <label><input type="checkbox" checked={incActive} onChange={(e) => setIncActive(e.target.checked)} /> Active file{activeRel ? ` (${activeRel})` : ''}</label>
          <label><input type="checkbox" checked={incOpen} onChange={(e) => setIncOpen(e.target.checked)} /> Open editors ({openRels.length})</label>
          <label><input type="checkbox" checked={incTerm} onChange={(e) => setIncTerm(e.target.checked)} /> Recent terminal output</label>
        </div>
        <div className="row-btns">
          <button className="btn ghost small" onClick={() => void client.clearHistory()}>Clear AI history</button>
          {streaming ? <button className="btn small" onClick={() => client.cancel()}>Cancel</button>
            : <button className="btn primary small" disabled={!text.trim()} onClick={send}>Preview &amp; send…</button>}
        </div>
      </div>
    </div>
  );
}

function AiSettings({ client }: { client: AiClient }) {
  const c = client.config!;
  const [models, setModels] = useState<string[] | null>(null);
  const [key, setKey] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const p = client.active!;
  const update = (patch: Partial<typeof p>) => void client.setConfig({ providers: c.providers.map((x) => (x.id === p.id ? { id: x.id, kind: x.kind, label: x.label, baseUrl: x.baseUrl, model: x.model, ...(x.temperature !== undefined ? { temperature: x.temperature } : {}), ...(x.seed !== undefined ? { seed: x.seed } : {}), ...patch } : { id: x.id, kind: x.kind, label: x.label, baseUrl: x.baseUrl, model: x.model, ...(x.temperature !== undefined ? { temperature: x.temperature } : {}), ...(x.seed !== undefined ? { seed: x.seed } : {}) })) });
  return (
    <div className="ai-settings small" aria-label="AI settings">
      <label>Provider <select aria-label="AI provider" value={c.activeProvider} onChange={(e) => void client.setConfig({ activeProvider: e.target.value })}>{c.providers.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
      <label>Base URL <input aria-label="Base URL" defaultValue={p.baseUrl} key={`u${p.id}`} onBlur={(e) => update({ baseUrl: e.target.value })} /></label>
      <label>Model <input aria-label="Model" defaultValue={p.model} key={`m${p.id}${p.model}`} onBlur={(e) => update({ model: e.target.value })} list="ai-models" />
        <datalist id="ai-models">{(models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
        <button className="link" onClick={() => void call('ai.listModels.v1', { providerId: p.id }).then(setModels, (e) => setErr(String(e.message ?? e)))}>List models</button></label>
      {models && <div className="muted">{models.length ? models.join(', ') : 'No models found'}</div>}
      {p.kind === 'openai' && (
        <label>API key {p.hasKey ? <span className="badge ok">stored in OS keychain</span> : <span className="badge warn">none</span>}
          <input type="password" aria-label="API key" value={key} placeholder={c.keychain.available ? 'paste key' : c.keychain.reason ?? ''} disabled={!c.keychain.available} onChange={(e) => setKey(e.target.value)} />
          <button className="link" disabled={!key} onClick={() => void call('ai.setKey.v1', { providerId: p.id, key }).then(() => { setKey(''); void client.refresh(); }, (e) => setErr(String(e.message ?? e)))}>Save</button>
          {p.hasKey && <button className="link" onClick={() => void call('ai.setKey.v1', { providerId: p.id, key: null }).then(() => client.refresh())}>Remove</button>}
        </label>
      )}
      <div className="muted">Keychain: {c.keychain.available ? c.keychain.backend : `unavailable — ${c.keychain.reason}`}. Timeout {Math.round(c.timeoutMs / 1000)} s, retries {c.retries}.</div>
      <label><input type="checkbox" checked={c.includeHistory} onChange={(e) => void client.setConfig({ includeHistory: e.target.checked })} /> Include earlier chat turns in requests</label>
      {err && <div className="err">{err}</div>}
    </div>
  );
}

export function AiPreviewDialog({ client }: { client: AiClient }) {
  const p = useSyncExternalStore((f) => client.subscribe(f), () => client.preview);
  if (!p) return null;
  const redactions = p.included.reduce((n, i) => n + i.redactions.reduce((m, r) => m + r.count, 0), 0);
  return (
    <div className="palette-backdrop">
      <div className="palette confirm ai-preview" role="dialog" aria-label="AI request preview">
        <p><b>{ACTION_LABEL[p.action]}</b> → <b data-testid="preview-provider">{p.provider.label}</b> · {p.provider.model} · {p.provider.baseUrl} <span className={`badge ${p.provider.local ? 'ok' : 'warn'}`}>{p.provider.local ? 'stays on this machine' : 'leaves this machine'}</span></p>
        <div className="small">
          <div>Included: {p.included.length ? p.included.map((i) => `${i.source} (${i.chars} chars${i.redactions.length ? `, ${i.redactions.map((r) => `${r.count} ${r.kind}`).join(', ')} redacted` : ''})`).join('; ') : 'only your message'}</div>
          {p.excluded.length > 0 && <ul className="ai-excluded" aria-label="Excluded from request">{p.excluded.map((e) => <li key={e.rel}>Not sent: <b>{e.rel}</b> — {e.reason}: {e.detail}</li>)}</ul>}
          {redactions > 0 && <div>{redactions} secret(s) replaced with [REDACTED:…]</div>}
        </div>
        <details open><summary className="small">Exact request messages</summary><pre className="ai-payload" aria-label="Request payload">{JSON.stringify(p.messages, null, 2)}</pre></details>
        <div className="row-btns">
          <button className="btn" onClick={() => client.dismissPreview()}>Cancel</button>
          <button className="btn primary" autoFocus onClick={() => void client.confirmSend()}>Send to {p.provider.label}</button>
        </div>
      </div>
    </div>
  );
}

export function InlineDiffDialog({ client, onApply }: { client: AiClient; onApply(rel: string, startLine: number, endLine: number, text: string): Promise<void> }) {
  const i = useSyncExternalStore((f) => client.subscribe(f), () => client.inline);
  if (!i || !i.hunks.length) return null;
  const accepted = [...i.decision.values()].filter((v) => v === 'accept').length;
  return (
    <div className="palette-backdrop">
      <div className="palette confirm ai-diff" role="dialog" aria-label="AI inline edit">
        <p><b>Inline edit</b> · {i.rel} lines {i.startLine}–{i.endLine} · “{i.instruction}”. Nothing changes until you apply.</p>
        <div className="ai-hunks">
          {i.hunks.map((h) => (
            <div key={h.id} className={`ai-hunk d-${i.decision.get(h.id) ?? 'none'}`} data-hunk={h.id} aria-label={`Hunk ${h.id + 1}`}>
              <div className="small muted">Hunk {h.id + 1} · line {i.startLine + h.oldStart}</div>
              <pre>{h.contextBefore.map((l) => `  ${l}\n`).join('')}{h.oldLines.map((l) => `- ${l}\n`).join('')}{h.newLines.map((l) => `+ ${l}\n`).join('')}{h.contextAfter.map((l) => `  ${l}\n`).join('')}</pre>
              <div className="row-btns">
                <button className={`btn small${i.decision.get(h.id) === 'reject' ? ' on' : ''}`} onClick={() => client.decide(h.id, 'reject')}>Reject</button>
                <button className={`btn small${i.decision.get(h.id) === 'accept' ? ' primary' : ''}`} onClick={() => client.decide(h.id, 'accept')}>Accept</button>
              </div>
            </div>
          ))}
        </div>
        <div className="row-btns">
          <button className="btn" onClick={() => client.closeInline()}>Discard all</button>
          <button className="btn primary" disabled={!accepted} onClick={() => void onApply(i.rel, i.startLine, i.endLine, client.merged()).then(() => client.closeInline())}>Apply {accepted} accepted hunk{accepted === 1 ? '' : 's'}</button>
        </div>
      </div>
    </div>
  );
}
