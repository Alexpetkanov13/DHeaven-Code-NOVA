import { LspConnection, LspRequestError, type ServerState } from './server';
import { SERVERS, type ServerDef, type ExternalServerDef } from './registry';
import { externalLaunch, findExecutable, probeExecutable } from './discover';
import { canonicalUri, fileUri, mapUris, serverUri } from './uri';
import type { Jdk } from '../jdk';

export interface ServerStatus {
  id: string; name: string; version: string; languages: string[]; installed: boolean;
  state: ServerState | 'blocked'; reason: string | null; pid: number | null; capabilities: string[]; limitations: string;
  kind: 'jvm' | 'external';
  download: { url: string; sizeHint: string; license: string } | null;
  path: string | null; pathSource: 'configured' | 'PATH' | null;
  progress: string | null;
  setup: ExternalServerDef['setup'] | null;
}
/** Result of looking for an external server's executable; cached until re-detect/restart/path change. */
export interface Detection { path: string | null; source: 'configured' | 'PATH' | null; version: string | null; error: string | null }

export const CAPABILITY_BADGES: [string, string, string][] = [
  // [server capability key, dynamic registration method, badge]
  ['completionProvider', 'textDocument/completion', 'completion'],
  ['hoverProvider', 'textDocument/hover', 'hover'],
  ['signatureHelpProvider', 'textDocument/signatureHelp', 'signatureHelp'],
  ['definitionProvider', 'textDocument/definition', 'definition'],
  ['referencesProvider', 'textDocument/references', 'references'],
  ['renameProvider', 'textDocument/rename', 'rename'],
  ['documentFormattingProvider', 'textDocument/formatting', 'formatting'],
  ['codeActionProvider', 'textDocument/codeAction', 'codeActions'],
  ['documentSymbolProvider', 'textDocument/documentSymbol', 'symbols'],
];
export function badges(caps: Record<string, unknown>, dynamic: Set<string>): string[] {
  return CAPABILITY_BADGES.filter(([k, m]) => (caps[k] !== undefined && caps[k] !== false) || dynamic.has(m)).map(([, , b]) => b);
}

export const ALLOWED_REQUESTS = ['textDocument/completion', 'completionItem/resolve', 'textDocument/hover', 'textDocument/signatureHelp', 'textDocument/definition', 'textDocument/references', 'textDocument/prepareRename', 'textDocument/rename', 'textDocument/formatting', 'textDocument/codeAction', 'textDocument/documentSymbol', 'workspace/executeCommand'] as const;

interface Entry { def: ServerDef; logs: string[]; conn: LspConnection | null; crashes: number[]; dynamic: Set<string>; reason: string | null; state: ServerStatus['state']; progress: Map<string, string> }

/** Text for one $/progress value (LSP WorkDoneProgress begin/report), or null when it ended. */
export function progressText(prev: string | undefined, v: { kind?: string; title?: string; message?: string; percentage?: number }): string | null {
  if (v.kind === 'end') return null;
  const title = v.kind === 'begin' ? v.title ?? '' : (prev ?? '').split(' — ')[0]!;
  const detail = [v.message, typeof v.percentage === 'number' ? `${Math.round(v.percentage)}%` : ''].filter(Boolean).join(' ');
  return (detail ? `${title} — ${detail}` : title).slice(0, 200) || 'Working…';
}

export interface ManagerDeps {
  serversDir: string; storageDir: string;
  isTrusted(root: string): Promise<boolean>;
  jdkFor(root: string, minMajor: number, maxMajor?: number): Promise<Jdk | null>;
  /** Executable the user picked for an external server (settings.lspServerPaths), if any. */
  configuredPath?(serverId: string): Promise<string | null>;
  /** Overridable for tests. */
  find?(names: string[]): Promise<string | null>;
  emit(name: 'lsp.status.v1' | 'lsp.diagnostics.v1', payload: unknown): void;
}

/** Owns language-server processes for the current workspace; isolates crashes, restarts with backoff (max 3 in 60 s). */
export class LspManager {
  private root: string | null = null;
  private entries = new Map<string, Entry>();
  private defs: ServerDef[];
  private defFor(lang: string) { return this.defs.find((d) => d.languages.includes(lang)); }
  private inflight = new Map<string, { conn: LspConnection; id: number }>();
  private detections = new Map<string, Promise<Detection>>();
  constructor(private deps: ManagerDeps, defs: ServerDef[] = Object.values(SERVERS)) {
    this.defs = defs;
    for (const def of defs) this.entries.set(def.id, { def, logs: [], conn: null, crashes: [], dynamic: new Set(), reason: null, state: 'stopped', progress: new Map() });
  }

  async setWorkspace(root: string | null) {
    await this.stopAll();
    this.root = root;
    for (const e of this.entries.values()) { e.crashes = []; e.reason = null; e.state = 'stopped'; }
    this.publish();
  }

  /** Finds and (when the server supports it) probes an external server's executable. Never downloads anything. */
  detect(def: ExternalServerDef): Promise<Detection> {
    let d = this.detections.get(def.id);
    if (!d) {
      d = (async (): Promise<Detection> => {
        const configured = (await this.deps.configuredPath?.(def.id)) ?? null;
        const exe = configured ?? (await (this.deps.find ?? findExecutable)(def.executables));
        const source = configured ? 'configured' as const : exe ? 'PATH' as const : null;
        if (!exe) return { path: null, source: null, version: null, error: `Not found on PATH (looked for ${def.executables.join(', ')}).` };
        if (!def.probeArgs) return { path: exe, source, version: null, error: null };
        try { return { path: exe, source, version: (await probeExecutable(exe, def.probeArgs)) || null, error: null }; }
        catch (err) { return { path: exe, source, version: null, error: `Found ${exe} but it does not work: ${err instanceof Error ? err.message : err}` }; }
      })();
      this.detections.set(def.id, d);
    }
    return d;
  }
  /** Forget cached detections (after the user installs a server or picks a path). */
  redetect() { this.detections.clear(); this.publish(); }

  async status(): Promise<ServerStatus[]> {
    const out: ServerStatus[] = [];
    for (const e of this.entries.values()) {
      const common = {
        id: e.def.id, name: e.def.name, languages: e.def.languages,
        state: e.state, reason: e.reason, pid: e.conn?.pid ?? null, limitations: e.def.limitations,
        capabilities: e.conn && e.state === 'ready' ? badges(e.conn.capabilities, e.dynamic) : [],
        progress: e.conn && e.progress.size ? [...e.progress.values()].join(' · ') : null,
      };
      if (e.def.kind === 'jvm') {
        out.push({ ...common, kind: 'jvm', version: e.def.version, installed: await e.def.isInstalled(this.deps.serversDir),
          download: { url: e.def.download.url, sizeHint: e.def.download.sizeHint, license: e.def.download.license }, path: null, pathSource: null, setup: null });
      } else {
        const d = await this.detect(e.def);
        out.push({ ...common, kind: 'external', version: d.version ?? (d.path ? 'version unknown' : 'not installed'), installed: !!d.path && !d.error,
          reason: e.reason ?? (e.state === 'stopped' && d.error ? d.error : null),
          download: null, path: d.path, pathSource: d.source, setup: e.def.setup });
      }
    }
    return out;
  }
  logs(id: string) { return this.entries.get(id)?.logs ?? []; }
  private publish() { if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = null; } void this.status().then((s) => this.deps.emit('lsp.status.v1', { servers: s })); }
  private publishTimer: NodeJS.Timeout | null = null;
  /** Progress can arrive hundreds of times per second (indexing); coalesce to at most ~4 status events/s. */
  private publishSoon() { this.publishTimer ??= setTimeout(() => { this.publishTimer = null; this.publish(); }, 250); }

  /** Start (if needed) the server for a language. Returns the connection only when ready. */
  async ensure(languageId: string): Promise<LspConnection | null> {
    const def = this.defFor(languageId);
    if (!def || !this.root) return null;
    const e = this.entries.get(def.id)!;
    if (e.conn && e.state === 'ready') return e.conn;
    if (e.state === 'starting' || e.state === 'restarting' || e.state === 'failed') return null;
    const block = (reason: string) => { e.state = 'blocked'; e.reason = reason; this.publish(); return null; };
    if (!(await this.deps.isTrusted(this.root))) return block('Workspace is not trusted (Restricted Mode).');
    if (def.kind === 'external') {
      const d = await this.detect(def);
      if (!d.path || d.error) return block(`${d.error ?? 'Not installed.'} See the setup steps in the Language Servers view.`);
      if (e.state !== 'stopped' && e.state !== 'blocked') return null; // another ensure() started it while we were detecting
      void this.spawn(e, null);
      return null;
    }
    if (!(await def.isInstalled(this.deps.serversDir))) return block('Not installed. Install it from the Language Servers view.');
    const jdk = await this.deps.jdkFor(this.root, def.minJava, def.maxJava);
    if (!jdk) return block(`Needs a JDK ${def.minJava}${def.maxJava ? `–${def.maxJava}` : '+'}; select one in the Language Servers view.`);
    if (e.state !== 'stopped' && e.state !== 'blocked') return null;
    void this.spawn(e, jdk);
    return null;
  }

  private async launchSpec(def: ServerDef, root: string, jdk: Jdk | null) {
    if (def.kind === 'jvm') return def.launch({ serversDir: this.deps.serversDir, storageDir: this.deps.storageDir, root, jdk: jdk! });
    const d = await this.detect(def);
    if (!d.path) throw new Error(d.error ?? 'not installed');
    return externalLaunch(d.path, def.args, root);
  }

  private async spawn(e: Entry, jdk: Jdk | null) {
    const root = this.root!;
    e.state = 'starting'; e.reason = null; e.dynamic = new Set(); e.progress.clear(); this.publish();
    let conn: LspConnection;
    try {
      const spec = await this.launchSpec(e.def, root, jdk);
      conn = new LspConnection(spec, () => ({
        processId: process.pid, clientInfo: { name: 'DHeaven Code NOVA', version: '0.1.0' },
        rootUri: serverUri(fileUri(root)), workspaceFolders: [{ uri: serverUri(fileUri(root)), name: root.split(/[\\/]/).pop() }],
        initializationOptions: e.def.kind === 'jvm' ? e.def.initOptions?.(jdk!, this.deps.serversDir) : e.def.initOptions?.(),
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          workspace: { applyEdit: false, workspaceFolders: true, configuration: true, workspaceEdit: { documentChanges: true } },
          textDocument: {
            synchronization: { didSave: true, dynamicRegistration: true },
            publishDiagnostics: { relatedInformation: false, versionSupport: true },
            completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], resolveSupport: { properties: ['documentation', 'detail'] } }, contextSupport: true },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true } } },
            definition: { linkSupport: true }, references: {}, rename: { prepareSupport: true }, formatting: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports'] } } },
          },
          window: { workDoneProgress: true },
        },
      }), (method, params) => this.onServerRequest(e, method, params));
    } catch (err) { e.state = 'failed'; e.reason = String(err); this.publish(); return; }
    e.conn = conn;
    conn.on('log', (l: string) => { e.logs.push(`[${new Date().toISOString().slice(11, 19)}] ${l}`); if (e.logs.length > 2000) e.logs.splice(0, e.logs.length - 2000); });
    conn.on('notification', (method: string, params: unknown) => {
      if (method === 'textDocument/publishDiagnostics') {
        const p = mapUris(params, canonicalUri) as { uri: string; diagnostics: unknown[]; version?: number };
        this.deps.emit('lsp.diagnostics.v1', { serverId: e.def.id, uri: p.uri, diagnostics: p.diagnostics });
      } else if (method === '$/progress') {
        const { token, value } = (params ?? {}) as { token?: string | number; value?: { kind?: string } };
        if (token === undefined || !value || typeof value !== 'object') return;
        const k = String(token), t = progressText(e.progress.get(k), value);
        if (t === null) e.progress.delete(k); else e.progress.set(k, t);
        this.publishSoon();
      }
    });
    conn.on('crash', (why: string) => this.onCrash(e, conn, jdk, why));
    try {
      await conn.start(e.def.initTimeoutMs);
      if (e.conn !== conn) return;
      e.state = 'ready'; this.publish();
    } catch (err) {
      if (e.conn !== conn) return;
      conn.log(`initialize failed: ${err}`);
      if (conn.state !== 'crashed') { e.state = 'failed'; e.reason = `initialize failed: ${err instanceof Error ? err.message : err}`; void conn.stop(); this.publish(); }
    }
  }

  private onServerRequest(e: Entry, method: string, params: unknown): unknown {
    switch (method) {
      case 'workspace/configuration': return ((params as { items?: unknown[] })?.items ?? []).map(() => null);
      case 'client/registerCapability':
        for (const r of (params as { registrations?: { method: string }[] })?.registrations ?? []) e.dynamic.add(r.method);
        this.publish(); return null;
      case 'client/unregisterCapability':
        for (const r of (params as { unregisterations?: { method: string }[] })?.unregisterations ?? []) e.dynamic.delete(r.method);
        this.publish(); return null;
      case 'window/workDoneProgress/create': case 'window/showMessageRequest': return null;
      // Refresh requests (rust-analyzer, pyright): NOVA has no semantic-token/inlay/code-lens/pull-diagnostic UI to refresh yet.
      case 'workspace/semanticTokens/refresh': case 'workspace/inlayHint/refresh': case 'workspace/codeLens/refresh': case 'workspace/diagnostic/refresh': return null;
      case 'workspace/workspaceFolders': return this.root ? [{ uri: serverUri(fileUri(this.root)), name: 'root' }] : [];
      case 'workspace/applyEdit': return { applied: false, failureReason: 'NOVA does not yet support server-initiated edits' };
      default: throw new Error(`Unhandled server request ${method}`);
    }
  }

  private onCrash(e: Entry, conn: LspConnection, jdk: Jdk | null, why: string) {
    if (e.conn !== conn) return;
    e.conn = null; e.progress.clear();
    for (const [k, v] of this.inflight) if (v.conn === conn) this.inflight.delete(k);
    const now = Date.now();
    e.crashes = [...e.crashes.filter((t) => now - t < 60_000), now];
    if (e.crashes.length > 3) { e.state = 'failed'; e.reason = `Crashed ${e.crashes.length} times in 60 s (${why}). Use Restart.`; this.publish(); return; }
    e.state = 'restarting'; e.reason = `Crashed: ${why}. Restarting…`; this.publish();
    setTimeout(() => { if (e.state === 'restarting' && this.root) void this.spawn(e, jdk); }, 500 * 2 ** (e.crashes.length - 1));
  }

  async restart(id: string) {
    const e = this.entries.get(id)!;
    const c = e.conn; e.conn = null; e.state = 'stopped'; e.crashes = []; e.reason = null;
    this.detections.delete(id);
    await c?.stop();
    const lang = e.def.languages[0]!;
    await this.ensure(lang);
    this.publish();
  }
  async stop(id: string) {
    const e = this.entries.get(id)!;
    const c = e.conn; e.conn = null; e.state = 'stopped'; e.reason = 'Stopped by user'; this.publish();
    await c?.stop();
  }
  async stopAll() { await Promise.all([...this.entries.values()].map(async (e) => { const c = e.conn; e.conn = null; e.state = 'stopped'; await c?.stop(); })); }

  private connFor(languageId: string) {
    const def = this.defFor(languageId);
    const e = def && this.entries.get(def.id);
    return e?.conn && e.state === 'ready' ? e.conn : null;
  }

  async didOpen(languageId: string, uri: string, version: number, text: string) {
    const c = await this.ensure(languageId);
    const lspLang = this.defFor(languageId)?.lspLanguageId?.(languageId, uri) ?? languageId;
    c?.notify('textDocument/didOpen', { textDocument: { uri: serverUri(uri), languageId: lspLang, version, text } });
  }
  didChange(languageId: string, uri: string, version: number, changes: unknown[]) {
    this.connFor(languageId)?.notify('textDocument/didChange', { textDocument: { uri: serverUri(uri), version }, contentChanges: changes });
  }
  didSave(languageId: string, uri: string) { this.connFor(languageId)?.notify('textDocument/didSave', { textDocument: { uri: serverUri(uri) } }); }
  didClose(languageId: string, uri: string) { this.connFor(languageId)?.notify('textDocument/didClose', { textDocument: { uri: serverUri(uri) } }); }

  async request(languageId: string, reqId: string, method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    const c = this.connFor(languageId);
    if (!c) throw new LspRequestError(-32099, 'Language server not ready');
    try {
      const r = await c.request(method, mapUris(params, serverUri), timeoutMs, (id) => this.inflight.set(reqId, { conn: c, id }));
      return mapUris(r, canonicalUri);
    } finally { this.inflight.delete(reqId); }
  }
  /** Starts the server for languageId if needed and resolves once it is ready. */
  async waitReady(languageId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const def = this.defFor(languageId); if (!def) throw new Error(`No language server for ${languageId}`);
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new Error('Cancelled');
      if (await this.ensure(languageId)) return;
      const e = this.entries.get(def.id)!;
      if (e.state === 'blocked' || e.state === 'failed') throw new Error(`${def.name}: ${e.reason ?? e.state}`);
      if (Date.now() > end) throw new Error(`${def.name} did not become ready in ${Math.round(timeoutMs / 1000)} s`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  /** Lets main-process features (debugger) know if a bundle-dependent server must restart to pick it up. */
  isRunning(id: string) { const e = this.entries.get(id); return !!e && (e.state === 'ready' || e.state === 'starting' || e.state === 'restarting'); }
  cancel(reqId: string) { const f = this.inflight.get(reqId); if (f) { this.inflight.delete(reqId); f.conn.cancel(f.id); } }
}
