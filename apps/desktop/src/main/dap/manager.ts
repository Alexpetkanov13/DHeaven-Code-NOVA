import path from 'node:path';
import { DapConnection, DapError } from './connection';

export interface LaunchConfig {
  id: string; name: string; type: 'java' | 'python' | 'node'; request: 'launch' | 'attach';
  mainClass?: string; projectName?: string; args?: string; vmArgs?: string; env?: Record<string, string>; cwd?: string;
  javaHome?: string | null; preLaunchTask?: string; hostName?: string; port?: number;
  program?: string; module?: string; justMyCode?: boolean;
}
export interface SourceBreakpoint { line: number; condition?: string; logMessage?: string; hitCondition?: string }
export type DebugState = 'idle' | 'starting' | 'running' | 'stopped' | 'terminated';
export interface DebugStatus { sessionId: number; state: DebugState; reason: string | null; threadId: number | null; configName: string | null; capabilities: Record<string, boolean> }

/** What a debugger type must provide: an adapter connection plus the launch/attach arguments. */
export interface AdapterFactory {
  (cfg: LaunchConfig, ctx: { root: string; log(s: string): void; signal: AbortSignal }): Promise<{
    conn: DapConnection; args: Record<string, unknown>;
    /** Multi-session adapters (js-debug): a new connection for a `startDebugging` child session. */
    openChild?(): Promise<DapConnection>;
  }>;
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
  /** Every connection of the current session: the adapter's own, plus children opened for `startDebugging`. */
  private sessions: DapConnection[] = [];
  /** Resolved by each connection's `initialized` event; created before any request so the event can't be missed. */
  private initialized = new Map<DapConnection, { promise: Promise<void>; resolve(): void }>();
  private exitedSeen = false;
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
      const { conn, args, openChild } = await factory(cfg, { root, log: (s) => this.log(s), signal: abort.signal });
      if (abort.signal.aborted) { conn.close('cancelled'); return fail('Cancelled'); }
      this.conn = conn; this.sessions = [conn]; this.exitedSeen = false;
      if (openChild) {
        // js-debug's first session is a launcher; the real target arrives as a reverse `startDebugging` request.
        const prev = conn.onReverse;
        conn.onReverse = (command, a) => {
          if (command !== 'startDebugging') return prev(command, a);
          const { request, configuration } = (a ?? {}) as { request?: string; configuration?: Record<string, unknown> };
          void (async () => {
            try {
              const child = await openChild();
              if (this.status.sessionId !== sessionId) { child.close('session ended'); return; }
              this.sessions.push(child);
              this.wire(child, sessionId);
              this.conn = child; // the child is the session the user debugs (threads, stack, variables, stepping)
              await this.handshake(child, cfg.type, request === 'attach' ? 'attach' : 'launch', configuration ?? {}, sessionId);
            } catch (e) { this.log(`Child debug session failed: ${e instanceof Error ? e.message : e}`, 'stderr'); }
          })();
          return {};
        };
      }
      this.wire(conn, sessionId);
      await this.handshake(conn, cfg.type, cfg.request, args, sessionId);
      if (this.status.sessionId === sessionId && this.status.state === 'starting' && !openChild) this.set({ state: 'running' });
    } catch (e) {
      fail(`Debug session failed: ${e instanceof Error ? e.message : e}`);
      this.conn?.close('start failed');
    }
  }

  /** Event/close routing for one adapter connection (the session itself, or a js-debug child). */
  private wire(conn: DapConnection, sessionId: number) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    this.initialized.set(conn, { promise, resolve });
    conn.on('event', (event: string, body: Record<string, unknown>) => {
      if (this.status.sessionId !== sessionId) return;
      if (event === 'initialized') this.initialized.get(conn)?.resolve();
      else if (event === 'output') { if (body.category !== 'telemetry') this.deps.emit('debug.output.v1', { sessionId, category: (body.category as string) ?? 'console', output: String(body.output ?? '') }); return; }
      else if (event === 'stopped') { this.conn = conn; this.stopSeq++; this.set({ state: 'stopped', reason: String(body.reason ?? 'paused'), threadId: (body.threadId as number) ?? null }); }
      else if (event === 'continued') this.set({ state: 'running', reason: null, threadId: null });
      else if (event === 'terminated' || event === 'exited') {
        // java-debug sometimes sends only 'terminated' when the VM dies before it reads the exit code.
        if (event === 'exited') { this.exitedSeen = true; this.log(`Process exited with code ${body.exitCode}`); }
        if (event === 'terminated' && this.status.state !== 'terminated') {
          this.set({ state: 'terminated', reason: 'Debuggee terminated', threadId: null });
          // 'exited' (and trailing output) may still follow 'terminated'; then every connection of the session closes.
          const all = [...this.sessions];
          setTimeout(() => { if (!this.exitedSeen) this.log('Process ended (the debug adapter did not report an exit code)'); for (const c of all) c.close('terminated'); }, 1000);
        }
      } else if (event === 'breakpoint') this.onBreakpointEvent(body);
      this.deps.emit('debug.event.v1', { sessionId, event, body });
    });
    conn.on('close', (why: string) => {
      if (this.conn === conn) this.conn = this.sessions.find((c) => c !== conn && !c.closed) ?? null;
      if (this.status.sessionId === sessionId && this.status.state !== 'terminated' && !this.sessions.some((c) => !c.closed)) this.set({ state: 'terminated', reason: `Adapter disconnected: ${why}`, threadId: null });
    });
  }

  /** initialize → launch/attach → (initialized) → breakpoints → configurationDone, on one connection. */
  private async handshake(conn: DapConnection, adapterID: string, request: 'launch' | 'attach', args: Record<string, unknown>, sessionId: number) {
    const caps = (await conn.request<Record<string, unknown>>('initialize', {
      clientID: 'nova', clientName: 'DHeaven Code NOVA', adapterID, locale: 'en', linesStartAt1: true, columnsStartAt1: true,
      pathFormat: 'path', supportsVariableType: true, supportsVariablePaging: false, supportsRunInTerminalRequest: false, supportsProgressReporting: false,
      supportsStartDebuggingRequest: true,
    })) ?? {};
    const capabilities: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(caps)) if (typeof v === 'boolean') capabilities[k] = v;
    if (this.status.sessionId === sessionId) this.set({ capabilities });
    const initializedP = this.initialized.get(conn)!.promise;
    const req = conn.request(request, args, 120_000);
    await Promise.race([initializedP, req]);
    await initializedP;
    for (const file of Object.keys(this.breakpoints)) await this.sendBreakpoints(file, conn).catch((e) => this.log(`setBreakpoints ${file}: ${e.message}`, 'stderr'));
    await conn.request('setExceptionBreakpoints', { filters: [] }).catch(() => {});
    if (caps.supportsConfigurationDoneRequest) await conn.request('configurationDone', {});
    await req;
    if (this.status.sessionId === sessionId && this.status.state === 'starting') this.set({ state: 'running' });
  }

  private onBreakpointEvent(body: Record<string, unknown>) {
    const bp = body.breakpoint as { id?: number; verified: boolean; line?: number; source?: { path?: string } } | undefined;
    const file = bp?.source?.path; if (!file || !bp) return;
    const key = Object.keys(this.verified).find((k) => path.resolve(k) === path.resolve(file)); if (!key) return;
    const list = this.verified[key]!;
    const it = list.find((x) => x.line === bp.line); if (it) it.verified = bp.verified;
  }

  private async sendBreakpoints(file: string, conn: DapConnection | null = this.conn) {
    if (!conn) return;
    const bps = this.breakpoints[file] ?? [];
    const caps = this.status.capabilities;
    const res = await conn.request<{ breakpoints: { verified: boolean; line?: number; message?: string }[] }>('setBreakpoints', {
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
    // Children first (they own the debuggee), then the adapter's own session.
    const all = [...this.sessions].reverse(); this.sessions = []; this.conn = null;
    for (const c of all) {
      if (c.closed) continue;
      await Promise.race([c.request('disconnect', { terminateDebuggee: true, restart: false }, 5000).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
      c.close(reason);
    }
    if (this.status.state !== 'idle' && this.status.state !== 'terminated') this.set({ state: 'terminated', reason, threadId: null });
  }
}
