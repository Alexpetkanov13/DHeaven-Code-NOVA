import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { FrameDecoder, encodeFrame } from './jsonrpc';
import { killTree } from '../proc';

export type ServerState = 'stopped' | 'starting' | 'ready' | 'restarting' | 'crashed' | 'failed';
export interface LaunchSpec { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }
type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout; method: string };

export class LspRequestError extends Error { constructor(public code: number, message: string) { super(message); } }

/**
 * One language-server process. Handles framing, request/response with deadlines and
 * $/cancelRequest, server->client requests, logs, and crash detection. Restart policy lives in the manager.
 */
export class LspConnection extends EventEmitter {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  readonly logs: string[] = [];
  capabilities: Record<string, unknown> = {};
  state: ServerState = 'stopped';
  pid: number | undefined;

  constructor(private spec: LaunchSpec, private initParams: () => Record<string, unknown>, private onServerRequest: (method: string, params: unknown) => Promise<unknown> | unknown) { super(); }

  log(line: string) {
    this.logs.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
    if (this.logs.length > 1000) this.logs.splice(0, this.logs.length - 1000);
    this.emit('log', line);
  }
  private setState(s: ServerState, why?: string) { this.state = s; this.emit('state', s, why); }

  async start(timeoutMs = 120_000) {
    this.setState('starting');
    this.log(`spawn: ${this.spec.command} ${this.spec.args.join(' ')}`);
    const p = spawn(this.spec.command, this.spec.args, { cwd: this.spec.cwd, env: this.spec.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    this.proc = p; this.pid = p.pid;
    const dec = new FrameDecoder((m) => this.onMessage(m as Record<string, unknown>));
    p.stdout!.on('data', (c: Buffer) => { try { dec.push(c); } catch (e) { this.log(`protocol error: ${e}`); p.kill(); } });
    p.stderr!.on('data', (c: Buffer) => { for (const l of c.toString('utf8').split(/\r?\n/)) if (l.trim()) this.log(`stderr: ${l.slice(0, 2000)}`); });
    p.stdin!.on('error', () => {});
    p.on('error', (e) => this.onExit(`spawn error: ${e.message}`));
    p.on('exit', (code, sig) => this.onExit(`exited code=${code} signal=${sig}`));
    const res = (await this.request('initialize', this.initParams(), timeoutMs)) as { capabilities?: Record<string, unknown> };
    this.capabilities = res.capabilities ?? {};
    this.notify('initialized', {});
    this.setState('ready');
    return this.capabilities;
  }

  private onExit(reason: string) {
    if (!this.proc) return;
    this.proc = null;
    this.log(reason);
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new LspRequestError(-32099, `server ${reason}`)); }
    this.pending.clear();
    if (this.state !== 'stopped') { this.setState('crashed', reason); this.emit('crash', reason); }
  }

  private send(msg: unknown) { if (this.proc?.stdin?.writable) this.proc.stdin.write(encodeFrame(msg)); }

  private async onMessage(m: Record<string, unknown>) {
    if ('id' in m && ('result' in m || 'error' in m) && !('method' in m)) {
      const p = this.pending.get(m.id as number);
      if (!p) return; // late response to a cancelled/timed-out request: dropped
      this.pending.delete(m.id as number); clearTimeout(p.timer);
      const err = m.error as { code: number; message: string } | undefined;
      if (err) p.reject(new LspRequestError(err.code, err.message)); else p.resolve(m.result);
    } else if ('method' in m && 'id' in m) {
      try { this.send({ jsonrpc: '2.0', id: m.id, result: (await this.onServerRequest(m.method as string, m.params)) ?? null }); }
      catch (e) { this.send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(e) } }); }
    } else if ('method' in m) {
      if (m.method === 'window/logMessage' || m.method === 'window/showMessage') this.log(`${m.method === 'window/showMessage' ? 'message' : 'log'}: ${(m.params as { message?: string })?.message ?? ''}`.slice(0, 4000));
      this.emit('notification', m.method, m.params);
    }
  }

  request(method: string, params: unknown, timeoutMs = 15_000, onId?: (id: number) => void): Promise<unknown> {
    if (!this.proc) return Promise.reject(new LspRequestError(-32099, `server is ${this.state}`));
    const id = this.nextId++;
    onId?.(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new LspRequestError(-32800, `${method} timed out after ${timeoutMs} ms`)); this.cancel(id); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  cancel(id: number) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id); clearTimeout(p.timer);
    p.reject(new LspRequestError(-32800, 'cancelled'));
    this.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
  }
  notify(method: string, params: unknown) { this.send({ jsonrpc: '2.0', method, params }); }

  async stop() {
    const p = this.proc;
    this.setState('stopped');
    if (!p) return;
    try { await Promise.race([this.request('shutdown', null, 3000), new Promise((r) => setTimeout(r, 3000))]); this.notify('exit', null); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 300));
    if (this.proc && p.pid) killTree(p.pid);
    this.proc = null;
  }
}
