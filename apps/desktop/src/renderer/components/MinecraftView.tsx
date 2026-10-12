import { useCallback, useEffect, useRef, useState } from 'react';
import type { DetectedRunTasks } from '@nova/ipc-contract';
import { call, on } from '../lib/ipc';

const MAX_OUT = 512 * 1024;
type Task = DetectedRunTasks['tasks'][number];

/**
 * Gradle run tasks contributed by extensions (e.g. Minecraft runClient/runServer), detected statically from the build
 * script. Server tasks require explicit Minecraft EULA consent before eula.txt is written — never auto-accepted.
 */
export function MinecraftView({ title, trusted, hasWorkspace, onError }: { title: string; trusted: boolean; hasWorkspace: boolean; onError(e: unknown): void }) {
  const [detected, setDetected] = useState<DetectedRunTasks[] | null>(null);
  const [eulaFor, setEulaFor] = useState<Task | null>(null);
  const [agree, setAgree] = useState(false);
  const [run, setRun] = useState<{ runId: number; task: string; state: 'running' | 'done'; code: number | null; killed: boolean } | null>(null);
  const [output, setOutput] = useState('');
  const runRef = useRef<number | null>(null);
  const outRef = useRef<HTMLPreElement>(null);
  useEffect(() => { if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight; }, [output]);

  const refresh = useCallback(() => { if (hasWorkspace) void call('runTasks.detect.v1', {}).then(setDetected).catch(onError); else setDetected(null); }, [hasWorkspace, onError]);
  useEffect(() => { refresh(); const off = on('fs.changed.v1', refresh); return off; }, [refresh]);
  useEffect(() => {
    const a = on('gradle.output.v1', ({ runId, data }) => { if (runId === runRef.current) setOutput((o) => (o + data).slice(-MAX_OUT)); });
    const b = on('gradle.exit.v1', (e) => { if (e.runId === runRef.current) setRun((r) => r && { ...r, state: 'done', code: e.code, killed: e.killed }); });
    return () => { a(); b(); };
  }, []);

  const start = async (t: Task) => {
    try {
      setOutput(''); const r = await call('gradle.run.v1', { args: [t.name] });
      runRef.current = r.runId; setRun({ runId: r.runId, task: t.name, state: 'running', code: null, killed: false });
    } catch (e) { onError(e); }
  };
  const runTask = (t: Task) => { if (t.requiresEula && !t.eulaAccepted) { setAgree(false); setEulaFor(t); } else void start(t); };
  const accept = async () => {
    const t = eulaFor!; setEulaFor(null);
    try { await call('runTasks.acceptEula.v1', { runDir: t.runDir }); refresh(); await start({ ...t, eulaAccepted: true }); } catch (e) { onError(e); }
  };

  const groups = (detected ?? []).filter((d) => d.view === title);
  return (
    <div className="mc-view" aria-label={`${title} view`}>
      {!hasWorkspace ? <p className="small pad">Open a folder to detect run tasks.</p>
        : detected === null ? <p className="small pad">Detecting…</p>
        : !groups.length ? <p className="small pad">No {title} run tasks: the root build script applies none of the supported Gradle plugins (Fabric Loom, run-paper). Create a project with File: New Project….</p>
        : groups.map((g) => (
          <section key={`${g.extId}/${g.plugin}`} className="mc-group">
            <div className="mc-group-h"><b>{g.label}</b> <span className="small">— {g.plugin} in {g.buildFile}</span></div>
            <ul aria-label={`${g.label} run tasks`}>
              {g.tasks.map((t) => (
                <li key={t.name} className="mc-task" data-task={t.name}>
                  <span className="mc-name">{t.label} <code>{t.name}</code></span>
                  {t.requiresEula && <span className={`small ${t.eulaAccepted ? 'ok' : 'warn'}`}>{t.eulaAccepted ? 'EULA accepted' : 'EULA required'}</span>}
                  <button className="btn" disabled={!trusted || run?.state === 'running'} title={trusted ? `gradlew ${t.name}` : 'Trust the workspace to run Gradle'} onClick={() => runTask(t)}>Run</button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      {!trusted && hasWorkspace && <p className="small pad">Restricted Mode: tasks are listed but running Gradle needs workspace trust.</p>}
      <p className="small pad">Tasks are detected from the build script (plugin ids), not by running Gradle. Minecraft/Paper jars are downloaded by the Gradle plugins on first run; NOVA bundles no Mojang assets.</p>
      {run && (
        <div className="mc-run">
          <div className="small">{run.task}: {run.state === 'running' ? 'running…' : run.killed ? 'stopped' : `exited with ${run.code}`} {run.state === 'running' && <button className="btn" onClick={() => void call('gradle.kill.v1', { runId: run.runId })}>Stop</button>}</div>
          <pre ref={outRef} className="gradle-out" aria-label="Minecraft run output">{output}</pre>
        </div>
      )}
      {eulaFor && (
        <div className="palette-backdrop">
          <div className="palette confirm" role="alertdialog" aria-label="Minecraft EULA">
            <h3>Minecraft End User License Agreement</h3>
            <p>Running a Minecraft server (<code>{eulaFor.name}</code>) requires accepting the Minecraft EULA. NOVA will write <code>{eulaFor.runDir}/eula.txt</code> with <code>eula=true</code> only if you accept.</p>
            <p>Read it first: <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">https://aka.ms/MinecraftEULA</a></p>
            <label><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} aria-label="I have read and accept the Minecraft EULA" /> I have read and accept the Minecraft EULA</label>
            <div className="row-btns">
              <button className="btn" autoFocus onClick={() => setEulaFor(null)}>Decline</button>
              <button className="btn primary" disabled={!agree} onClick={() => void accept()}>Accept and run</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
