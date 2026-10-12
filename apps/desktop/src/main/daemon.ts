import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout };
export type DaemonState = 'starting' | 'ready' | 'restarting' | 'failed';

export class DaemonError extends Error { code = 'DAEMON_UNAVAILABLE' as const; }

/**
 * Supervises novad: newline-delimited JSON-RPC over stdio, per-request deadlines,
 * automatic restart with exponential backoff (gives up after 5 crashes within 60 s).
 */
export class DaemonClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private crashes: number[] = [];
  private stopped = false;
  state: DaemonState = 'starting';

  constructor(
    private binPath: string,
    private onNotify: (method: string, params: unknown) => void,
    private onState: (s: DaemonState, msg?: string) => void,
  ) {}

  start() {
    this.setState(this.state === 'restarting' ? 'restarting' : 'starting');
    const p = spawn(this.binPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = p;
    readline.createInterface({ input: p.stdout }).on('line', (line) => this.onLine(line));
    p.stderr.on('data', () => { /* daemon logs ignored in Phase 2 */ });
    p.on('error', (e) => this.onExit(`spawn failed: ${e.message}`));
    p.on('exit', (code, sig) => this.onExit(`exited code=${code} signal=${sig}`));
    this.call('ping', {}, 10_000).then(() => this.setState('ready'), () => {});
  }

  private setState(s: DaemonState, msg?: string) { this.state = s; this.onState(s, msg); }

  private onLine(line: string) {
    let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
    try { msg = JSON.parse(line); } catch { return; }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    } else if (msg.method) this.onNotify(msg.method, msg.params);
  }

  private onExit(reason: string) {
    if (!this.proc) return;
    this.proc = null;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new DaemonError(`novad ${reason}`)); }
    this.pending.clear();
    if (this.stopped) return;
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now];
    if (this.crashes.length > 5) { this.setState('failed', reason); return; }
    const delay = Math.min(8000, 250 * 2 ** (this.crashes.length - 1));
    this.setState('restarting', reason);
    setTimeout(() => !this.stopped && this.start(), delay);
  }

  call<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const p = this.proc;
    if (!p) return Promise.reject(new DaemonError(`novad is ${this.state}`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new DaemonError(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      p.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  /** Test hook / recovery: kill the current process (supervisor restarts it). */
  kill() { this.proc?.kill(); }
  stop() { this.stopped = true; this.proc?.stdin.end(); this.proc?.kill(); }
}
