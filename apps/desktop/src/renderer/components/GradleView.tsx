import { useEffect, useRef, useState } from 'react';
import type { GradleProblem } from '@nova/ipc-contract';
import { call, on } from '../lib/ipc';

interface Props { trusted: boolean; hasWorkspace: boolean; onError(e: unknown): void; onProblems(p: GradleProblem[]): void }
type Task = { name: string; group: string; description: string };
type RunState = { runId: number; args: string[]; state: 'running' | 'done'; code: number | null; signal: string | null; killed: boolean; problems: number };

const MAX_OUT = 512 * 1024;

/** Gradle: detect, list tasks via the wrapper, run with live output, exit code, kill (whole process tree). */
export function GradleView({ trusted, hasWorkspace, onError, onProblems }: Props) {
  const [info, setInfo] = useState<{ isGradle: boolean; wrapper: boolean; buildFile: string | null } | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [custom, setCustom] = useState('build');
  const [run, setRun] = useState<RunState | null>(null);
  const [output, setOutput] = useState('');
  const runRef = useRef<number | null>(null);
  const outRef = useRef<HTMLPreElement>(null);
  useEffect(() => { if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight; }, [output]);

  useEffect(() => {
    setInfo(null); setTasks(null);
    if (hasWorkspace) void call('gradle.detect.v1', {}).then(setInfo).catch(onError);
  }, [hasWorkspace, onError]);
  useEffect(() => {
    const a = on('gradle.output.v1', ({ runId, data }) => { if (runId === runRef.current) setOutput((o) => (o + data).slice(-MAX_OUT)); });
    const b = on('gradle.exit.v1', (e) => {
      if (e.runId !== runRef.current) return;
      setRun((r) => r && { ...r, state: 'done', code: e.code, signal: e.signal, killed: e.killed, problems: e.problems.length });
      onProblems(e.problems);
    });
    return () => { a(); b(); };
  }, [onProblems]);

  const loadTasks = async () => {
    setLoading(true);
    try { setTasks(await call('gradle.tasks.v1', {})); } catch (e) { onError(e); } finally { setLoading(false); }
  };
  const start = async (args: string[]) => {
    if (!args.length) return;
    setOutput(`> gradle ${args.join(' ')}\n`);
    try {
      const { runId } = await call('gradle.run.v1', { args });
      runRef.current = runId;
      setRun({ runId, args, state: 'running', code: null, signal: null, killed: false, problems: 0 });
    } catch (e) { onError(e); }
  };
  const busy = run?.state === 'running';

  if (!hasWorkspace) return <div className="view"><div className="muted pad">Open a folder to use Gradle.</div></div>;
  if (info && !info.isGradle) return <div className="view"><div className="muted pad">No build.gradle(.kts), settings.gradle(.kts) or gradlew found in this folder.</div></div>;
  const groups = new Map<string, Task[]>();
  for (const t of tasks ?? []) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
  return (
    <div className="view gradle" aria-label="Gradle">
      <div className="pad">
        <div className="muted">{info ? `${info.buildFile ?? 'no build file'} · ${info.wrapper ? 'Gradle wrapper' : 'gradle on PATH (no wrapper)'}` : 'Detecting…'}</div>
        {!trusted && <div className="warn">Restricted Mode: running Gradle executes build scripts, so it needs a trusted folder.</div>}
        <form className="gradle-row" onSubmit={(ev) => { ev.preventDefault(); void start(custom.trim().split(/\s+/).filter(Boolean)); }}>
          <input aria-label="Gradle arguments" value={custom} onChange={(ev) => setCustom(ev.target.value)} placeholder="build --info" />
          <button className="btn small" type="submit" disabled={!trusted || busy}>Run</button>
          <button className="btn small" type="button" disabled={!busy} onClick={() => run && void call('gradle.kill.v1', { runId: run.runId }).catch(onError)}>Kill</button>
        </form>
        {run && (
          <div className="gradle-status" data-run-state={run.state} data-exit-code={run.code ?? ''} aria-label="Gradle run status">
            {run.state === 'running' ? `Running: ${run.args.join(' ')}…`
              : run.killed ? `Killed (${run.signal ?? `exit ${run.code}`})`
              : `Exit code ${run.code ?? '—'}${run.signal ? ` (${run.signal})` : ''} · ${run.code === 0 ? 'BUILD SUCCESSFUL' : 'FAILED'}${run.problems ? ` · ${run.problems} compiler problem(s) → Problems` : ''}`}
          </div>
        )}
        <div className="gradle-row"><button className="btn small" disabled={!trusted || loading} onClick={() => void loadTasks()}>{loading ? 'Loading tasks…' : tasks ? 'Reload Tasks' : 'Load Tasks (runs gradlew tasks)'}</button></div>
      </div>
      <div className="gradle-tasks" aria-label="Gradle tasks">
        {[...groups].map(([g, ts]) => (
          <div key={g}>
            <div className="file">{g}</div>
            {ts.map((t) => (
              <div key={t.name} className="task" data-task={t.name} title={t.description}>
                <button className="link" disabled={!trusted || busy} onClick={() => void start([t.name])}>▶ {t.name}</button> <span className="muted">{t.description}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <pre ref={outRef} className="gradle-out" aria-label="Gradle output">{output}</pre>
    </div>
  );
}
