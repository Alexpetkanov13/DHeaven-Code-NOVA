import path from 'node:path';
import { DapConnection, DapError } from './connection';

export interface LaunchConfig {
  id: string; name: string; type: 'java'; request: 'launch' | 'attach';
  mainClass?: string; projectName?: string; args?: string; vmArgs?: string; env?: Record<string, string>; cwd?: string;
  javaHome?: string | null; preLaunchTask?: string; hostName?: string; port?: number;
}
export interface SourceBreakpoint { line: number; condition?: string; logMessage?: string; hitCondition?: string }
export type DebugState = 'idle' | 'starting' | 'running' | 'stopped' | 'terminated';
export interface DebugStatus { sessionId: number; state: DebugState; reason: string | null; threadId: number | null; configName: string | null; capabilities: Record<string, boolean> }

/** What a debugger type must provide: an adapter connection plus the launch/attach arguments. */
export interface AdapterFactory {
  (cfg: LaunchConfig, ctx: { root: string; log(s: string): void; signal: AbortSignal }): Promise<{ conn: DapConnection; args: Record<string, unknown> }>;
}
export interface DebugDeps {
  isTrusted(root: string): Promise<boolean>;
  emit(name: 'debug.status.v1' | 'debug.event.v1' | 'debug.output.v1', payload: unknown): void;
  adapters: Record<string, AdapterFactory>;
  runPreLaunch(task: string, log: (s: string) => void, signal: AbortSignal): Promise<number | null>;
  saveBreakpoints(root: string, bps: Record<string, SourceBreakpoint[]>): Promise<void>;
}

/** Requests the renderer may forward to the adapter (everything else is refused). */
export const EXEC_COMMANDS = new Set(['continue', 'next', 'stepIn', 'stepOut']);
export const DAP_ALLOWED = new Set(['threads', 'stackTrace', 'scopes', 'variables', 'continue', 'next', 'stepIn', 'stepOut', 'pause', 'evaluate', 'source', 'setVariable', 'exceptionInfo']);

export class DebugManager {
  private root: string | null = null;
  private conn: DapConnection | null = null;
  private abort: AbortController | null = null;
  private seq = 0;
  private stopSeq = 0;
  private status: DebugStatus = { sessionId: 0, state: 'idle', reason: null, threadId: null, configName: null, capabilities: {} };
  breakpoints: Record<string, SourceBreakpoint[]> = {};
  private verified: Record<string, { line: number; verified: boolean; message?: string }[]> = {};

  constructor(private deps: DebugDeps) {}

  async setWorkspace(root: string | null, bps: Record<string, SourceBreakpoint[]> = {}) {
    await this.stop('workspace changed');
    this.root = root; this.breakpoints = bps; this.verified = {};
  }
  getStatus() { return this.status; }
  getBreakpoints() { return { breakpoints: this.breakpoints, verified: this.verified }; }

  private set(p: Partial<DebugStatus>) { this.status = { ...this.status, ...p }; this.deps.emit('debug.status.v1', this.status); }
  private log(text: string, category = 'console') { this.deps.emit('debug.output.v1', { sessionId: this.status.sessionId, category, output: text.endsWith('\n') ? text : text + '\n' }); }

  async start(cfg: LaunchConfig): Promise<number> {
    if (!this.root) throw new Error('No workspace open');
    if (!(await this.deps.isTrusted(this.root))) throw new Error('UNTRUSTED');
    if (this.status.state === 'starting' || this.status.state === 'running' || this.status.state === 'stopped') throw new Error('A debug session is already active; stop it first.');
    const factory = this.deps.adapters[cfg.type];
    if (!factory) throw new Error(`No debug adapter for type ${cfg.type}`);
    const sessionId = ++this.seq;
    const abort = new AbortController(); this.abort = abort;
    this.set({ sessionId, state: 'starting', reason: null, threadId: null, configName: cfg.name, capabilities: {} });
    void this.run(cfg, factory, abort, sessionId);
    return sessionId;
  }

  private async run(cfg: LaunchConfig, factory: AdapterFactory, abort: AbortController, sessionId: number) {
    const root = this.root!;
    const fail = (why: string) => { if (this.status.sessionId === sessionId) { this.log(why, 'stderr'); this.set({ state: 'terminated', reason: why, threadId: null }); } };
    try {
      if (cfg.preLaunchTask) {
        this.log(`> preLaunch: gradle ${cfg.preLaunchTask}`);
        const code = await this.deps.runPreLaunch(cfg.preLaunchTask, (s) => this.log(s, 'stdout'), abort.signal);
        if (abort.signal.aborted) return fail('Cancelled');
        if (code !== 0) return fail(`preLaunch task '${cfg.preLaunchTask}' failed (exit ${code}); not starting the debugger.`);
      }
      const { conn, args } = await factory(cfg, { root, log: (s) => this.log(s), signal: abort.signal });
      if (abort.signal.aborted) { conn.close('cancelled'); return fail('Cancelled'); }
      this.conn = conn;
      let initialized!: () => void;
      const initializedP = new Promise<void>((r) => { initialized = r; });
      conn.on('event', (event: string, body: Record<string, unknown>) => {
        if (this.status.sessionId !== sessionId) return;
        if (event === 'initialized') initialized();
        else if (event === 'output') { this.deps.emit('debug.output.v1', { sessionId, category: (body.category as string) ?? 'console', output: String(body.output ?? '') }); return; }
        else if (event === 'stopped') { this.stopSeq++; this.set({ state: 'stopped', reason: String(body.reason ?? 'paused'), threadId: (body.threadId as number) ?? null }); }
        else if (event === 'continued') this.set({ state: 'running', reason: null, threadId: null });
        else if (event === 'terminated' || event === 'exited') {
          if (event === 'exited') this.log(`Process exited with code ${body.exitCode}`);
          if (event === 'terminated') { this.set({ state: 'terminated', reason: 'Debuggee terminated', threadId: null }); conn.close('terminated'); }
        } else if (event === 'breakpoint') this.onBreakpointEvent(body);
        this.deps.emit('debug.event.v1', { sessionId, event, body });
      });
      conn.on('close', (why: string) => {
        if (this.conn === conn) this.conn = null;
        if (this.status.sessionId === sessionId && this.status.state !== 'terminated') this.set({ state: 'terminated', reason: `Adapter disconnected: ${why}`, threadId: null });
      });
      const caps = (await conn.request<Record<string, unknown>>('initialize', {
        clientID: 'nova', clientName: 'DHeaven Code NOVA', adapterID: cfg.type, locale: 'en', linesStartAt1: true, columnsStartAt1: true,
        pathFormat: 'path', supportsVariableType: true, supportsVariablePaging: false, supportsRunInTerminalRequest: false, supportsProgressReporting: false,
      })) ?? {};
      const capabilities: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(caps)) if (typeof v === 'boolean') capabilities[k] = v;
      this.set({ capabilities });
      const req = conn.request(cfg.request, args, 120_000);
      await Promise.race([initializedP, req]);
      await initializedP;
      for (const file of Object.keys(this.breakpoints)) await this.sendBreakpoints(file).catch((e) => this.log(`setBreakpoints ${file}: ${e.message}`, 'stderr'));
      await conn.request('setExceptionBreakpoints', { filters: [] }).catch(() => {});
      if (caps.supportsConfigurationDoneRequest) await conn.request('configurationDone', {});
      await req;
      if (this.status.sessionId === sessionId && this.status.state === 'starting') this.set({ state: 'running' });
    } catch (e) {
      fail(`Debug session failed: ${e instanceof Error ? e.message : e}`);
      this.conn?.close('start failed');
    }
  }

  private onBreakpointEvent(body: Record<string, unknown>) {
    const bp = body.breakpoint as { id?: number; verified: boolean; line?: number; source?: { path?: string } } | undefined;
    const file = bp?.source?.path; if (!file || !bp) return;
    const key = Object.keys(this.verified).find((k) => path.resolve(k) === path.resolve(file)); if (!key) return;
    const list = this.verified[key]!;
    const it = list.find((x) => x.line === bp.line); if (it) it.verified = bp.verified;
  }

  private async sendBreakpoints(file: string) {
    if (!this.conn) return;
    const bps = this.breakpoints[file] ?? [];
    const caps = this.status.capabilities;
    const res = await this.conn.request<{ breakpoints: { verified: boolean; line?: number; message?: string }[] }>('setBreakpoints', {
      source: { path: file, name: path.basename(file) }, lines: bps.map((b) => b.line),
      breakpoints: bps.map((b) => ({ line: b.line, condition: caps.supportsConditionalBreakpoints ? b.condition || undefined : undefined, hitCondition: caps.supportsHitConditionalBreakpoints ? b.hitCondition || undefined : undefined, logMessage: caps.supportsLogPoints ? b.logMessage || undefined : undefined })),
      sourceModified: false,
    });
    this.verified[file] = (res?.breakpoints ?? []).map((r, i) => ({ line: r.line ?? bps[i]!.line, verified: r.verified, message: r.message }));
  }

  async setBreakpoints(file: string, bps: SourceBreakpoint[]) {
    if (!this.root) throw new Error('No workspace open');
    if (bps.length) this.breakpoints[file] = bps; else delete this.breakpoints[file];
    delete this.verified[file];
    await this.deps.saveBreakpoints(this.root, this.breakpoints);
    if (this.conn) await this.sendBreakpoints(file).catch((e) => this.log(`setBreakpoints: ${e instanceof Error ? e.message : e}`, 'stderr'));
    return this.verified[file] ?? null;
  }

  async request(sessionId: number, command: string, args: unknown): Promise<unknown> {
    if (!DAP_ALLOWED.has(command)) throw new Error(`DAP command not allowed: ${command}`);
    if (sessionId !== this.status.sessionId || !this.conn) throw new DapError(command, 'No active debug session');
    if (!EXEC_COMMANDS.has(command)) return this.conn.request(command, args, command === 'evaluate' ? 15_000 : 30_000);
    // Execution control: a step's response arrives before its 'stopped' event, and java-debug does not always send
    // 'continued'. Mark the session running as soon as the adapter accepts the command (unless a newer stop already
    // arrived), so the UI cannot send Continue into a step that is still in flight (java-debug drops it).
    if (this.status.state !== 'stopped') throw new DapError(command, 'The debuggee is not paused');
    const seq = this.stopSeq;
    const r = await this.conn.request(command, args, 30_000);
    if (this.status.sessionId === sessionId && this.stopSeq === seq && this.status.state === 'stopped') this.set({ state: 'running', reason: null, threadId: null });
    return r;
  }

  async stop(reason = 'Stopped by user') {
    this.abort?.abort(); this.abort = null;
    const c = this.conn; this.conn = null;
    if (c && !c.closed) {
      await Promise.race([c.request('disconnect', { terminateDebuggee: true, restart: false }, 5000).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
      c.close(reason);
    }
    if (this.status.state !== 'idle' && this.status.state !== 'terminated') this.set({ state: 'terminated', reason, threadId: null });
  }
}
