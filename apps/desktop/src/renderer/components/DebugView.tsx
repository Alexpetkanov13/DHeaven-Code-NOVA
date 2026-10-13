import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { LaunchConfig } from '@nova/ipc-contract';
import { call, on } from '../lib/ipc';
import type { DebugStore, Variable } from '../lib/debug';

interface Props { store: DebugStore; trusted: boolean; hasWorkspace: boolean; onError(e: unknown): void; askInstall(info: { name: string; version: string; url: string; sizeHint: string; license: string; sha256: string }): void }
type Jdk = { home: string; version: string; major: number };

const newConfig = (type: LaunchConfig['type'] = 'java'): LaunchConfig => (type === 'java'
  ? { id: `cfg-${Date.now()}`, name: 'Launch App', type: 'java', request: 'launch', mainClass: '', args: '', vmArgs: '', env: {}, cwd: '', javaHome: null, preLaunchTask: '' }
  : type === 'python'
    ? { id: `cfg-${Date.now()}`, name: 'Python: Current Module', type: 'python', request: 'launch', program: '', module: '', args: '', env: {}, cwd: '', justMyCode: true }
    : { id: `cfg-${Date.now()}`, name: 'Node: Launch Program', type: 'node', request: 'launch', program: '', args: '', env: {}, cwd: '' });
const envToText = (e?: Record<string, string>) => Object.entries(e ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
const textToEnv = (t: string) => Object.fromEntries(t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1)]));

function VarNode({ store, v, depth }: { store: DebugStore; v: Variable; depth: number }) {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<Variable[] | null>(null);
  const toggle = async () => {
    if (!v.variablesReference) return;
    if (!open && !kids) { try { setKids(await store.variables(v.variablesReference)); } catch (e) { setKids([{ name: '⚠', value: String(e instanceof Error ? e.message : e), variablesReference: 0 }]); } }
    setOpen(!open);
  };
  return (
    <div>
      <div className="var" data-var={v.name} style={{ paddingLeft: 6 + depth * 12 }} onClick={() => void toggle()}>
        <span className="twisty">{v.variablesReference ? (open ? '▾' : '▸') : ' '}</span>
        <span className="vname">{v.name}</span>: <span className="vval" title={v.type}>{v.value}</span>
      </div>
      {open && kids?.map((k, i) => <VarNode key={`${k.name}-${i}`} store={store} v={k} depth={depth + 1} />)}
    </div>
  );
}

function Scopes({ store, frameId }: { store: DebugStore; frameId: number | null }) {
  const [scopes, setScopes] = useState<{ name: string; vars: Variable[] }[]>([]);
  useEffect(() => {
    let live = true; setScopes([]);
    if (frameId == null) return;
    void (async () => {
      try {
        const out: { name: string; vars: Variable[] }[] = [];
        for (const s of await store.scopes()) out.push({ name: s.name, vars: s.variablesReference ? await store.variables(s.variablesReference) : [] });
        if (live) setScopes(out);
      } catch (e) { if (live) setScopes([{ name: 'Error', vars: [{ name: '⚠', value: String(e instanceof Error ? e.message : e), variablesReference: 0 }] }]); }
    })();
    return () => { live = false; };
  }, [store, frameId]);
  if (frameId == null) return <div className="muted pad">Not paused.</div>;
  return <div aria-label="Variables">{scopes.map((s) => (<div key={s.name}><div className="scope">{s.name}</div>{s.vars.map((v, i) => <VarNode key={`${v.name}-${i}`} store={store} v={v} depth={0} />)}</div>))}</div>;
}

export function DebugView({ store, trusted, hasWorkspace, onError, askInstall }: Props) {
  const st = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [configs, setConfigs] = useState<LaunchConfig[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<LaunchConfig | null>(null);
  const [envText, setEnvText] = useState('');
  const [jdks, setJdks] = useState<Jdk[]>([]);
  const [adapter, setAdapter] = useState<Awaited<ReturnType<typeof call<'debug.adapter.v1'>>> | null>(null);
  const [installMsg, setInstallMsg] = useState<string | null>(null);
  const [watchInput, setWatchInput] = useState('');
  const [jsDebug, setJsDebug] = useState<Awaited<ReturnType<typeof call<'debug.jsDebug.v1'>>> | null>(null);
  const loadJsDebug = useCallback(() => void call('debug.jsDebug.v1', {}).then(setJsDebug).catch(onError), [onError]);
  useEffect(() => { if (draft?.type === 'node') loadJsDebug(); }, [draft?.type, loadJsDebug]);

  const loadAdapter = useCallback(() => void call('debug.adapter.v1', {}).then(setAdapter).catch(onError), [onError]);
  useEffect(() => {
    if (!hasWorkspace) return;
    void call('debug.getConfigs.v1', {}).then((c) => { setConfigs(c); if (c[0]) { setSel(c[0].id); setDraft(c[0]); setEnvText(envToText(c[0].env)); } }).catch(onError);
    void call('jdk.list.v1', {}).then((r) => setJdks(r.jdks)).catch(() => {});
    loadAdapter();
    return on('debug.install.v1', (p) => { setInstallMsg(p.message); if (p.done) loadAdapter(); });
  }, [hasWorkspace, onError, loadAdapter]);

  const persist = async (next: LaunchConfig[]) => { setConfigs(next); await call('debug.setConfigs.v1', { configs: next }).catch(onError); };
  const save = async () => {
    if (!draft) return null;
    const c: LaunchConfig = { ...draft, env: textToEnv(envText) };
    await persist(configs.some((x) => x.id === c.id) ? configs.map((x) => (x.id === c.id ? c : x)) : [...configs, c]);
    setDraft(c); setSel(c.id); return c;
  };
  const s = st.status;
  const active = s.state === 'starting' || s.state === 'running' || s.state === 'stopped';
  const start = async () => { const c = await save(); if (c) await call('debug.start.v1', { config: c }).catch(onError); };

  if (!hasWorkspace) return <div className="view"><div className="muted pad">Open a folder to debug.</div></div>;
  return (
    <div className="view debug" aria-label="Run and Debug">
      {draft?.type === 'node' && jsDebug && (
        <div className={`pad ${jsDebug.path ? '' : 'warn-box'}`} aria-label="js-debug">
          {jsDebug.path
            ? <div className="muted small">js-debug ({jsDebug.source === 'chosen' ? 'chosen by you' : 'servers folder'}): <code className="ls-path">{jsDebug.path}</code></div>
            : <div className="small">{jsDebug.setup}</div>}
          <div className="toggles">
            <button className="btn small" onClick={() => void call('debug.jsDebugPath.v1', { pick: true }).then(loadJsDebug).catch(onError)}>Choose js-debug…</button>
            {jsDebug.source === 'chosen' && <button className="btn small" onClick={() => void call('debug.jsDebugPath.v1', { pick: false }).then(loadJsDebug).catch(onError)}>Forget</button>}
          </div>
        </div>
      )}
      {adapter && !adapter.installed && draft?.type === 'java' && (
        <div className="pad warn-box">
          {adapter.name} {adapter.version} is not installed. <button className="btn small" onClick={() => askInstall(adapter)}>Install…</button>
          {installMsg && <div className="muted">{installMsg}</div>}
        </div>
      )}
      <div className="pad debug-configs">
        <div className="gradle-row">
          <select aria-label="Launch configuration" value={sel ?? ''} onChange={(e) => { const c = configs.find((x) => x.id === e.target.value) ?? null; setSel(c?.id ?? null); setDraft(c); setEnvText(envToText(c?.env)); }}>
            {!configs.length && <option value="">(no configurations)</option>}
            {configs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="btn small" onClick={() => { const c = newConfig(); setDraft(c); setSel(c.id); setEnvText(''); }}>New</button>
          {draft && configs.some((c) => c.id === draft.id) && <button className="btn small" onClick={() => { void persist(configs.filter((c) => c.id !== draft.id)); setDraft(null); setSel(null); }}>Delete</button>}
        </div>
        {draft && (
          <div className="cfg-form">
            <label>Name<input aria-label="Config name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label>Type<select aria-label="Debugger type" value={draft.type} onChange={(e) => { const c = { ...newConfig(e.target.value as LaunchConfig['type']), id: draft.id }; setDraft(c); setEnvText(''); }}>
              <option value="java">Java (java-debug)</option><option value="python">Python (debugpy)</option><option value="node">Node.js (js-debug)</option>
            </select></label>
            <label>Request<select aria-label="Request" value={draft.request} onChange={(e) => setDraft({ ...draft, request: e.target.value as 'launch' | 'attach' })}><option value="launch">launch</option><option value="attach">attach</option></select></label>
            {draft.type === 'node' ? (draft.request === 'launch' ? (<>
              <label>Program<input aria-label="Program" placeholder="e.g. src/main.js" value={draft.program ?? ''} onChange={(e) => setDraft({ ...draft, program: e.target.value })} /></label>
              <label>Arguments<input aria-label="Program arguments" value={draft.args ?? ''} onChange={(e) => setDraft({ ...draft, args: e.target.value })} /></label>
              <label>Env (KEY=VALUE per line)<textarea aria-label="Environment" rows={2} value={envText} onChange={(e) => setEnvText(e.target.value)} /></label>
              <label>Working dir<input aria-label="Working directory" placeholder="(workspace root)" value={draft.cwd ?? ''} onChange={(e) => setDraft({ ...draft, cwd: e.target.value })} /></label>
              <div className="muted small">Runs with the <code>node</code> on PATH. JavaScript files; TypeScript via compiled output with source maps.</div>
            </>) : (<>
              <label>Host<input aria-label="Host" value={draft.hostName ?? '127.0.0.1'} onChange={(e) => setDraft({ ...draft, hostName: e.target.value })} /></label>
              <label>Port<input aria-label="Port" type="number" value={draft.port ?? 9229} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })} /></label>
              <div className="muted small">Attach to <code>node --inspect=9229 …</code></div>
            </>)) : draft.type === 'python' ? (draft.request === 'launch' ? (<>
              <label>Program<input aria-label="Program" placeholder="script path, e.g. app/main.py" value={draft.program ?? ''} onChange={(e) => setDraft({ ...draft, program: e.target.value })} /></label>
              <label>or Module<input aria-label="Module" placeholder="python -m …, e.g. app.main or pytest" value={draft.module ?? ''} onChange={(e) => setDraft({ ...draft, module: e.target.value })} /></label>
              <label>Arguments<input aria-label="Program arguments" value={draft.args ?? ''} onChange={(e) => setDraft({ ...draft, args: e.target.value })} /></label>
              <label>Env (KEY=VALUE per line)<textarea aria-label="Environment" rows={2} value={envText} onChange={(e) => setEnvText(e.target.value)} /></label>
              <label>Working dir<input aria-label="Working directory" placeholder="(workspace root)" value={draft.cwd ?? ''} onChange={(e) => setDraft({ ...draft, cwd: e.target.value })} /></label>
              <label className="check"><input type="checkbox" aria-label="Just my code" checked={draft.justMyCode ?? true} onChange={(e) => setDraft({ ...draft, justMyCode: e.target.checked })} /> Just my code</label>
              <div className="muted small">Uses the workspace's Python (choose it in Language Servers → Python; default: .venv / venv / env, else PATH). Needs debugpy: <code>python -m pip install debugpy</code>.</div>
            </>) : (<>
              <label>Host<input aria-label="Host" value={draft.hostName ?? '127.0.0.1'} onChange={(e) => setDraft({ ...draft, hostName: e.target.value })} /></label>
              <label>Port<input aria-label="Port" type="number" value={draft.port ?? 5678} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })} /></label>
              <div className="muted small">Attach to <code>python -m debugpy --listen 5678 …</code></div>
            </>)) : draft.request === 'launch' ? (<>
              <label>Main class<input aria-label="Main class" placeholder="(auto-detect)" value={draft.mainClass ?? ''} onChange={(e) => setDraft({ ...draft, mainClass: e.target.value })} /></label>
              <label>Program args<input aria-label="Program arguments" value={draft.args ?? ''} onChange={(e) => setDraft({ ...draft, args: e.target.value })} /></label>
              <label>VM args<input aria-label="VM arguments" value={draft.vmArgs ?? ''} onChange={(e) => setDraft({ ...draft, vmArgs: e.target.value })} /></label>
              <label>Env (KEY=VALUE per line)<textarea aria-label="Environment" rows={2} value={envText} onChange={(e) => setEnvText(e.target.value)} /></label>
              <label>Working dir<input aria-label="Working directory" placeholder="(workspace root)" value={draft.cwd ?? ''} onChange={(e) => setDraft({ ...draft, cwd: e.target.value })} /></label>
              <label>JDK<select aria-label="Debuggee JDK" value={draft.javaHome ?? ''} onChange={(e) => setDraft({ ...draft, javaHome: e.target.value || null })}><option value="">(workspace default)</option>{jdks.map((j) => <option key={j.home} value={j.home}>{j.version} — {j.home}</option>)}</select></label>
              <label>preLaunch Gradle task<input aria-label="preLaunch task" placeholder="e.g. classes" value={draft.preLaunchTask ?? ''} onChange={(e) => setDraft({ ...draft, preLaunchTask: e.target.value })} /></label>
            </>) : (<>
              <label>Host<input aria-label="Host" value={draft.hostName ?? 'localhost'} onChange={(e) => setDraft({ ...draft, hostName: e.target.value })} /></label>
              <label>Port<input aria-label="Port" type="number" value={draft.port ?? 5005} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })} /></label>
            </>)}
            <div className="gradle-row"><button className="btn small" onClick={() => void save()}>Save</button></div>
          </div>
        )}
        {!trusted && <div className="warn">Restricted Mode: debugging runs code, so it needs a trusted folder.</div>}
      </div>
      <div className="debug-toolbar" role="toolbar" aria-label="Debug toolbar">
        <button className="btn small" disabled={!trusted || !draft || active || (draft.type === 'java' && !adapter?.installed) || (draft.type === 'node' && !jsDebug?.path)} onClick={() => void start()} title="Start Debugging (F5)">▶ Start</button>
        <button className="btn small" disabled={s.state !== 'stopped'} onClick={() => void store.control('continue')} title="Continue">Continue</button>
        <button className="btn small" disabled={s.state !== 'running'} onClick={() => void store.control('pause')} title="Pause">Pause</button>
        <button className="btn small" disabled={s.state !== 'stopped'} onClick={() => void store.control('next')} title="Step Over (F10)">Step Over</button>
        <button className="btn small" disabled={s.state !== 'stopped'} onClick={() => void store.control('stepIn')} title="Step Into (F11)">Step In</button>
        <button className="btn small" disabled={s.state !== 'stopped'} onClick={() => void store.control('stepOut')} title="Step Out (Shift+F11)">Step Out</button>
        <button className="btn small" disabled={!active} onClick={() => void call('debug.stop.v1', {}).catch(onError)} title="Stop">■ Stop</button>
      </div>
      <div className="debug-status" data-debug-state={s.state} aria-label="Debug status">
        {s.state === 'idle' ? 'Not debugging' : `${s.configName ?? ''}: ${s.state}${s.reason ? ` (${s.reason})` : ''}`}
      </div>
      <div className="debug-section"><div className="sec-title">Threads</div>
        <div aria-label="Threads">{st.threads.map((t) => <div key={t.id} className={`row-item${t.id === s.threadId ? ' on' : ''}`} onClick={() => void store.loadStack(t.id, true)}>{t.name}{t.id === s.threadId ? ` — paused (${s.reason})` : ''}</div>)}</div>
      </div>
      <div className="debug-section"><div className="sec-title">Call Stack</div>
        <div aria-label="Call stack">{st.frames.map((f) => <div key={f.id} className={`row-item frame${f.id === st.frameId ? ' on' : ''}`} onClick={() => void store.selectFrame(f.id)}>{f.name} <span className="muted" title={f.source?.path}>{(f.source?.name ?? f.source?.path ?? '').split(/[\\/]/).pop()}:{f.line}</span></div>)}</div>
      </div>
      <div className="debug-section"><div className="sec-title">Variables</div><Scopes store={store} frameId={s.state === 'stopped' ? st.frameId : null} /></div>
      <div className="debug-section"><div className="sec-title">Watch</div>
        <form className="gradle-row" onSubmit={(e) => { e.preventDefault(); if (watchInput.trim()) { store.setWatches([...st.watches, watchInput.trim()]); setWatchInput(''); } }}>
          <input aria-label="Add watch expression" placeholder="expression" value={watchInput} onChange={(e) => setWatchInput(e.target.value)} />
        </form>
        <div aria-label="Watch">{st.watches.map((w) => <div key={w} className="var" data-watch={w}><span className="vname">{w}</span>: <span className="vval">{st.watchValues[w] ?? ''}</span> <button className="link" onClick={() => store.setWatches(st.watches.filter((x) => x !== w))}>✕</button></div>)}</div>
      </div>
      <div className="debug-section"><div className="sec-title">Breakpoints</div>
        <div aria-label="Breakpoints">{Object.entries(st.breakpoints).flatMap(([p, bs]) => bs.map((b) => (
          <div key={`${p}:${b.line}`} className="row-item">{p.split(/[\\/]/).pop()}:{b.line}{b.condition ? ` if ${b.condition}` : ''}{b.logMessage ? ` log "${b.logMessage}"` : ''} <button className="link" onClick={() => store.toggle(p, b.line)}>✕</button></div>
        )))}</div>
        {active && <div className="muted small">Adapter supports: {['supportsConditionalBreakpoints', 'supportsLogPoints', 'supportsHitConditionalBreakpoints'].map((k) => `${k.replace('supports', '')} ${s.capabilities[k] ? '✓' : '✗'}`).join(' · ')}</div>}
      </div>
    </div>
  );
}

export function DebugConsole({ store }: { store: DebugStore }) {
  const st = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [expr, setExpr] = useState('');
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [st.console]);
  return (
    <div className="panel-body debug-console" aria-label="Debug Console">
      <pre ref={ref} className="dc-out">{st.console.map((l, i) => <span key={i} className={`dc-${l.category}`}>{l.text}</span>)}</pre>
      <form onSubmit={(e) => {
        e.preventDefault(); const x = expr.trim(); if (!x) return; setExpr('');
        store.pushConsole('input', `> ${x}\n`);
        void store.evaluate(x, 'repl').then((r) => store.pushConsole('result', r.result + '\n')).catch((err) => store.pushConsole('stderr', `${err instanceof Error ? err.message : err}\n`));
      }}>
        <input aria-label="Evaluate expression" placeholder={st.status.state === 'stopped' ? 'Evaluate in the selected frame' : 'Pause the program to evaluate'} value={expr} onChange={(e) => setExpr(e.target.value)} />
      </form>
    </div>
  );
}
