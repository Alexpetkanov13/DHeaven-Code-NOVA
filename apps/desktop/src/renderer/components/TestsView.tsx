import { useCallback, useEffect, useRef, useState } from 'react';
import type { TestCase, TestNode } from '@nova/ipc-contract';
import { call, on } from '../lib/ipc';

interface Props { trusted: boolean; hasWorkspace: boolean; onError(e: unknown): void; onOpen(rel: string, line: number): void; onLog(s: string): void }
const ICON: Record<string, string> = { passed: '✔', failed: '✘', error: '⚠', skipped: '⊘', running: '…' };

/** JUnit tests: source-scan discovery, Gradle `test --tests` runs, results from the JUnit XML Gradle writes. */
export function TestsView({ trusted, hasWorkspace, onError, onOpen, onLog }: Props) {
  const [nodes, setNodes] = useState<TestNode[]>([]);
  const [results, setResults] = useState<Record<string, TestCase>>({});
  const [run, setRun] = useState<{ runId: number; filters: string[]; debug: boolean; done: boolean; code: number | null; killed: boolean; error: string | null } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [output, setOutput] = useState('');
  const runRef = useRef<number | null>(null);
  // Gradle output (and on fast runs even 'done') can arrive before tests.run.v1 returns the run id; buffer events for
  // unknown runs while a start is pending and replay them, instead of dropping them.
  const pendingStart = useRef(false);
  const early = useRef<{ output: Map<number, string>; done: Map<number, Parameters<Parameters<typeof on<'tests.done.v1'>>[1]>[0]> }>({ output: new Map(), done: new Map() });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const discover = useCallback(() => void call('tests.discover.v1', {}).then(setNodes).catch(onError), [onError]);
  useEffect(() => { if (hasWorkspace) discover(); else setNodes([]); }, [hasWorkspace, discover]);
  useEffect(() => {
    const a = on('tests.output.v1', ({ runId, data }) => {
      if (runId === runRef.current) setOutput((o) => (o + data).slice(-256 * 1024));
      else if (pendingStart.current) early.current.output.set(runId, ((early.current.output.get(runId) ?? '') + data).slice(-256 * 1024));
    });
    const b = on('tests.done.v1', (e) => {
      if (e.runId === runRef.current) applyDone(e);
      else if (pendingStart.current) early.current.done.set(e.runId, e);
    });
    const c = on('tests.debugReady.v1', (e) => {
      if (e.runId !== runRef.current) return;
      onLog(`Test JVM is waiting for a debugger on port ${e.port}; attaching…`);
      void call('debug.start.v1', { config: { id: 'test-attach', name: 'Debug Test (attach)', type: 'java', request: 'attach', hostName: 'localhost', port: e.port } }).catch(onError);
    });
    return () => { a(); b(); c(); };
  }, [onError, onLog]);

  function applyDone(e: { code: number | null; killed: boolean; error: string | null; results: TestCase[] }) {
    setRun((r) => r && { ...r, done: true, code: e.code, killed: e.killed, error: e.error });
    setResults((prev) => { const n = { ...prev }; for (const t of e.results) n[t.id] = t; return n; });
  }
  const start = async (filters: string[], debug = false) => {
    // Show the new run as started immediately: the previous run's "done" must not linger while this one spins up.
    runRef.current = null; pendingStart.current = true; early.current.output.clear(); early.current.done.clear();
    setRun({ runId: -1, filters, debug, done: false, code: null, killed: false, error: null });
    setOutput(`> gradle ${['test', ...filters.flatMap((f) => ['--tests', f]), '--rerun', ...(debug ? ['--debug-jvm'] : [])].join(' ')}\n`);
    // Mark targets as running; results for other tests are kept from earlier runs.
    setResults((prev) => { const n = { ...prev }; for (const k of Object.keys(n)) if (!filters.length || filters.some((f) => k === f || k.startsWith(f + '.'))) delete n[k]; return n; });
    try {
      const { runId } = await call('tests.run.v1', { filters, debug });
      runRef.current = runId; setRun({ runId, filters, debug, done: false, code: null, killed: false, error: null });
      const out = early.current.output.get(runId); if (out) setOutput((o) => (o + out).slice(-256 * 1024));
      const d = early.current.done.get(runId); if (d) applyDone(d);
    } catch (e) { setRun((r) => r && { ...r, done: true, error: String(e) }); onError(e); }
    finally { pendingStart.current = false; early.current.output.clear(); early.current.done.clear(); }
  };
  const busy = !!run && !run.done;
  const all = Object.values(results);
  const count = (s: string) => all.filter((t) => t.status === s).length;
  const failedIds = all.filter((t) => t.status === 'failed' || t.status === 'error').map((t) => t.id);
  const statusOf = (n: TestNode): string | null => {
    if (n.method) return results[n.id]?.status ?? (busy && (!run!.filters.length || run!.filters.some((f) => n.id === f || n.id.startsWith(f + '.') || n.className === f)) ? 'running' : null);
    const kids = all.filter((t) => t.id.startsWith(n.className + '.'));
    if (!kids.length) return busy && (!run!.filters.length || run!.filters.some((f) => f === n.className || f.startsWith(n.className + '.'))) ? 'running' : null;
    return kids.some((t) => t.status === 'failed') ? 'failed' : kids.some((t) => t.status === 'error') ? 'error' : kids.every((t) => t.status === 'skipped') ? 'skipped' : 'passed';
  };
  const sel = selected ? results[selected] : undefined;
  const byFile = new Map<string, TestNode[]>();
  for (const n of nodes) byFile.set(n.rel, [...(byFile.get(n.rel) ?? []), n]);

  if (!hasWorkspace) return <div className="view"><div className="muted pad">Open a folder to run tests.</div></div>;
  return (
    <div className="view tests" aria-label="Testing">
      <div className="pad">
        <div className="gradle-row">
          <button className="btn small" disabled={!trusted || busy || !nodes.length} onClick={() => void start([])}>Run All</button>
          <button className="btn small" disabled={!trusted || busy || !failedIds.length} onClick={() => void start(failedIds)}>Rerun Failed</button>
          <button className="btn small" disabled={!busy} onClick={() => run && void call('tests.cancel.v1', { runId: run.runId }).catch(onError)}>Cancel</button>
          <button className="btn small" onClick={discover} title="Rescan test sources">⟳</button>
        </div>
        {!trusted && <div className="warn">Restricted Mode: running tests executes build scripts and code, so it needs a trusted folder.</div>}
        <div className="test-summary" aria-label="Test summary" data-passed={count('passed')} data-failed={count('failed')} data-skipped={count('skipped')} data-errors={count('error')} data-done={run?.done ? '1' : '0'}>
          {run ? (run.done ? (run.killed ? 'Cancelled · ' : `Exit ${run.code} · `) : 'Running… · ') : ''}
          <span className="t-pass">{count('passed')} passed</span> · <span className="t-fail">{count('failed')} failed</span> · <span>{count('error')} errors</span> · <span className="muted">{count('skipped')} skipped</span>
          {run?.done && !all.length && !run.killed && <div className="warn">No JUnit XML results were produced{run.error ? `: ${run.error}` : ' (compile error or no matching tests? see output)'}.</div>}
        </div>
      </div>
      <div className="test-tree" aria-label="Test tree">
        {!nodes.length && <div className="muted pad">No tests found under src/test/java or src/test/kotlin.</div>}
        {[...byFile].map(([rel, ns]) => (
          <div key={rel}>
            <div className="file test-file" data-test-file={rel}>
              <span onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(rel)) n.delete(rel); else n.add(rel); return n; })}>{collapsed.has(rel) ? '▸' : '▾'} {rel.split('/').pop()}</span>
              <button className="link" title="Run tests in file" disabled={!trusted || busy} onClick={() => void start(ns.filter((n) => !n.method).map((n) => n.className))}>▶</button>
            </div>
            {!collapsed.has(rel) && ns.map((n) => {
              const s = statusOf(n); const r = results[n.id];
              return (
                <div key={n.id} className={`test-node ${n.method ? 'method' : 'class'} ${s ? `st-${s}` : ''}${selected === n.id ? ' on' : ''}`} data-test-id={n.id} data-status={s ?? 'none'}
                  onClick={() => { setSelected(n.id); onOpen(n.rel, n.line); }}>
                  <span className="ticon">{s ? ICON[s] : '○'}</span> {n.method ?? n.className.split('.').pop()}
                  {r && <span className="muted"> {r.timeMs} ms</span>}
                  <span className="actions">
                    <button className="link" title="Run" disabled={!trusted || busy} onClick={(e) => { e.stopPropagation(); void start([n.id]); }}>▶</button>
                    {n.method && <button className="link" title="Debug test (Gradle --debug-jvm + attach)" disabled={!trusted || busy} onClick={(e) => { e.stopPropagation(); void start([n.id], true); }}>🐞</button>}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {sel && (
        <div className="test-detail" aria-label="Test details">
          <div><strong>{sel.id}</strong> — {sel.status} ({sel.timeMs} ms)</div>
          {sel.message && <div className="t-msg">{sel.message}</div>}
          {sel.stack && <pre className="t-stack">{sel.stack}</pre>}
          {sel.stdout && <><div className="muted">stdout</div><pre className="t-stdout">{sel.stdout}</pre></>}
        </div>
      )}
      <pre className="gradle-out" aria-label="Test output">{output}</pre>
    </div>
  );
}
