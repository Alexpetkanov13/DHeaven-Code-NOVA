import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { HostToMain, MainToHost } from '@nova/extension-api';
import { killTree } from '../proc';

export type HostState = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed';
export interface HostOptions { script: string; readPaths: string[]; execPath?: string; env?: NodeJS.ProcessEnv }
type ReqMethod = Extract<MainToHost, { t: 'req' }>['method'];

/**
 * Supervises the extension host process. Requests carry the extension they run on behalf of, so a hang/crash can be
 * attributed: emits 'crash'(reason, culpritExtId|null). Restarts are done by the owner (ExtensionService).
 */
export class ExtensionHost extends EventEmitter {
  private proc: ChildProcess | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout; extId: string | null; method: string }>();
  state: HostState = 'stopped';
  pid: number | null = null;
  startedAt = 0;
  readyMs: number | null = null;
  constructor(private opts: HostOptions, private onRequest: (m: Extract<HostToMain, { t: 'req' }>) => Promise<unknown>) { super(); }

  start(): Promise<void> {
    if (this.proc) return Promise.resolve();
    this.state = 'starting'; this.emit('state', this.state);
    const t0 = Date.now();
    const execArgv = ['--permission', ...this.opts.readPaths.map((p) => `--allow-fs-read=${p}`), '--max-old-space-size=512'];
    const p = fork(this.opts.script, [], {
      execPath: this.opts.execPath ?? process.execPath, execArgv,
      env: { ...(this.opts.env ?? {}), ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json', detached: process.platform !== 'win32', windowsHide: true,
    });
    this.proc = p; this.pid = p.pid ?? null; this.startedAt = t0;
    p.stdout?.on('data', (b: Buffer) => this.emit('log', null, 'info', b.toString('utf8').trimEnd()));
    p.stderr?.on('data', (b: Buffer) => this.emit('log', null, 'warn', b.toString('utf8').trimEnd()));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('extension host did not start within 15 s')); this.kill('startup timeout', null); }, 15_000);
      p.on('message', (m: HostToMain) => {
        if (m.t === 'ready') { clearTimeout(timer); this.readyMs = Date.now() - t0; this.state = 'running'; this.emit('state', this.state); resolve(); return; }
        this.onMessage(m);
      });
      p.on('exit', (code, signal) => {
        clearTimeout(timer);
        if (this.proc !== p) return;
        this.proc = null; this.pid = null;
        const culprit = this.lastCulprit ?? [...this.pending.values()].find((x) => x.extId)?.extId ?? null;
        this.lastCulprit = null;
        for (const x of this.pending.values()) { clearTimeout(x.timer); x.reject(new Error(`extension host exited (code ${code}, signal ${signal})`)); }
        this.pending.clear();
        const why = this.killReason ?? `exited (code ${code}, signal ${signal})`; this.killReason = null;
        if (this.state === 'stopped') return;
        this.emit('crash', why, culprit);
        reject(new Error(why));
      });
    });
  }
  private lastCulprit: string | null = null;
  private killReason: string | null = null;

  private onMessage(m: HostToMain) {
    if (m.t === 'res') {
      const x = this.pending.get(m.id); if (!x) return;
      this.pending.delete(m.id); clearTimeout(x.timer);
      if (m.error !== undefined) x.reject(new Error(m.error)); else x.resolve(m.result);
    } else if (m.t === 'req') {
      void this.onRequest(m).then((result) => this.send({ t: 'res', id: m.id, result: result ?? null }), (e) => this.send({ t: 'res', id: m.id, error: e instanceof Error ? e.message : String(e) }));
    } else if (m.t === 'log') this.emit('log', m.extId, m.level, m.message);
    else if (m.t === 'registered') this.emit('registered', m.extId, m.kind, m.key);
  }
  private send(m: MainToHost) { try { this.proc?.send(m); } catch { /* host gone */ } }

  /** A request that times out means the host is stuck in extension code: the host is killed and the extension blamed. */
  request<T = unknown>(method: ReqMethod, params: unknown, extId: string | null, timeoutMs = 10_000): Promise<T> {
    if (!this.proc || this.state !== 'running') return Promise.reject(new Error('extension host is not running'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
        this.kill(`${extId ?? 'extension host'} did not respond to ${method} within ${timeoutMs} ms`, extId);
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, extId, method });
      this.send({ t: 'req', id, method, params } as MainToHost);
    });
  }
  kill(reason: string, culprit: string | null) {
    if (!this.proc?.pid) return;
    this.killReason = reason; this.lastCulprit = culprit;
    killTree(this.proc.pid);
  }
  async stop() {
    this.state = 'stopped'; this.emit('state', this.state);
    const p = this.proc; if (!p?.pid) return;
    p.disconnect?.();
    await new Promise<void>((r) => { const t = setTimeout(() => { killTree(p.pid!); r(); }, 2000); p.once('exit', () => { clearTimeout(t); r(); }); });
  }
}
