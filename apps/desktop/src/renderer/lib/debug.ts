import * as monaco from 'monaco-editor';
import type { DebugStatus, SourceBreakpoint } from '@nova/ipc-contract';
import { call, on } from './ipc';

export interface Frame { id: number; name: string; line: number; column: number; source?: { path?: string; name?: string } }
export interface Variable { name: string; value: string; type?: string; variablesReference: number }
export interface Thread { id: number; name: string }
export interface ConsoleLine { category: string; text: string }
interface State {
  status: DebugStatus; threads: Thread[]; frames: Frame[]; frameId: number | null;
  breakpoints: Record<string, SourceBreakpoint[]>; verified: Record<string, { line: number; verified: boolean; message?: string }[]>;
  console: ConsoleLine[]; watches: string[]; watchValues: Record<string, string>;
}

const IDLE: DebugStatus = { sessionId: 0, state: 'idle', reason: null, threadId: null, configName: null, capabilities: {} };
const MAX_CONSOLE = 5000;

/**
 * Renderer-side debug state. Everything shown (current line, frames, variables) comes from real adapter events/responses;
 * the gutter only edits the breakpoint list, which main persists per workspace and forwards to the adapter.
 */
export class DebugStore {
  state: State = { status: IDLE, threads: [], frames: [], frameId: null, breakpoints: {}, verified: {}, console: [], watches: [], watchValues: {} };
  private subs = new Set<() => void>();
  private editors = new Set<monaco.editor.IStandaloneCodeEditor>();
  private decos = new Map<monaco.editor.IStandaloneCodeEditor, monaco.editor.IEditorDecorationsCollection>();
  private offs: (() => void)[] = [];
  constructor(private ui: { openPath(path: string, line: number): Promise<void>; onError(e: unknown): void; prompt(title: string, initial?: string): Promise<string | null> }) {
    this.offs.push(on('debug.status.v1', (s) => this.onStatus(s)));
    this.offs.push(on('debug.output.v1', (o) => { if (o.category !== 'telemetry') this.pushConsole(o.category, o.output); }));
    this.offs.push(on('debug.event.v1', (e) => { if (e.event === 'breakpoint') void this.reloadBreakpoints(); }));
  }
  dispose() { for (const o of this.offs) o(); }
  subscribe = (cb: () => void) => { this.subs.add(cb); return () => { this.subs.delete(cb); }; };
  getSnapshot = () => this.state;
  private patch(p: Partial<State>) { this.state = { ...this.state, ...p }; for (const s of this.subs) s(); this.redecorate(); }

  async load() {
    try { const [st, bps] = await Promise.all([call('debug.status.v1', {}), call('debug.getBreakpoints.v1', {})]); this.patch({ status: st, breakpoints: bps.breakpoints, verified: bps.verified }); } catch (e) { this.ui.onError(e); }
  }
  async reloadBreakpoints() { try { const b = await call('debug.getBreakpoints.v1', {}); this.patch({ breakpoints: b.breakpoints, verified: b.verified }); } catch { /* no ws */ } }
  pushConsole(category: string, text: string) {
    const c = [...this.state.console, { category, text }]; if (c.length > MAX_CONSOLE) c.splice(0, c.length - MAX_CONSOLE);
    this.patch({ console: c });
  }

  private async onStatus(s: DebugStatus) {
    const prev = this.state.status;
    if (s.sessionId !== prev.sessionId && s.state === 'starting') this.patch({ console: [], watchValues: {} });
    this.patch({ status: s });
    if (s.state === 'stopped' && s.threadId != null) await this.loadStack(s.threadId, true);
    else if (s.state !== 'stopped') this.patch({ frames: [], frameId: null, threads: s.state === 'running' ? this.state.threads : [] });
  }
  async loadStack(threadId: number, reveal: boolean) {
    const sid = this.state.status.sessionId;
    try {
      const [th, st] = await Promise.all([
        call('debug.request.v1', { sessionId: sid, command: 'threads', args: {} }) as Promise<{ threads: Thread[] }>,
        call('debug.request.v1', { sessionId: sid, command: 'stackTrace', args: { threadId, startFrame: 0, levels: 50 } }) as Promise<{ stackFrames: Frame[] }>,
      ]);
      if (this.state.status.sessionId !== sid) return;
      this.patch({ threads: th.threads, frames: st.stackFrames });
      const top = st.stackFrames.find((f) => f.source?.path) ?? st.stackFrames[0];
      if (top) await this.selectFrame(top.id, reveal);
    } catch (e) { this.ui.onError(e); }
  }
  async selectFrame(frameId: number, reveal = true) {
    this.patch({ frameId });
    const f = this.state.frames.find((x) => x.id === frameId);
    if (reveal && f?.source?.path) await this.ui.openPath(f.source.path, f.line).catch(() => {});
    this.redecorate();
    await this.refreshWatches();
  }
  get currentFrame() { return this.state.frames.find((f) => f.id === this.state.frameId) ?? null; }

  req(command: Parameters<typeof call<'debug.request.v1'>>[1]['command'], args: unknown) {
    return call('debug.request.v1', { sessionId: this.state.status.sessionId, command, args });
  }
  async scopes(): Promise<{ name: string; variablesReference: number }[]> {
    if (this.state.frameId == null) return [];
    return ((await this.req('scopes', { frameId: this.state.frameId })) as { scopes: { name: string; variablesReference: number }[] }).scopes;
  }
  async variables(ref: number): Promise<Variable[]> { return ((await this.req('variables', { variablesReference: ref })) as { variables: Variable[] }).variables; }
  async evaluate(expression: string, context: 'repl' | 'watch' | 'hover'): Promise<{ result: string; variablesReference: number }> {
    return (await this.req('evaluate', { expression, frameId: this.state.frameId ?? undefined, context })) as { result: string; variablesReference: number };
  }
  async refreshWatches() {
    const vals: Record<string, string> = {};
    for (const w of this.state.watches) {
      if (this.state.status.state !== 'stopped') { vals[w] = 'not available'; continue; }
      try { vals[w] = (await this.evaluate(w, 'watch')).result; } catch (e) { vals[w] = `⚠ ${e instanceof Error ? e.message : e}`; }
    }
    this.patch({ watchValues: vals });
  }
  setWatches(ws: string[]) { this.patch({ watches: ws }); void this.refreshWatches(); }
  async control(cmd: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause') {
    const threadId = this.state.status.threadId ?? this.state.threads[0]?.id ?? 1;
    try { await this.req(cmd, { threadId }); } catch (e) { this.ui.onError(e); }
  }

  // ---- breakpoints
  async setBps(path: string, bps: SourceBreakpoint[]) {
    const breakpoints = { ...this.state.breakpoints }; if (bps.length) breakpoints[path] = bps; else delete breakpoints[path];
    this.patch({ breakpoints });
    try { const v = await call('debug.setBreakpoints.v1', { path, breakpoints: bps }); const verified = { ...this.state.verified }; if (v) verified[path] = v; else delete verified[path]; this.patch({ verified }); } catch (e) { this.ui.onError(e); }
  }
  toggle(path: string, line: number) {
    const cur = this.state.breakpoints[path] ?? [];
    void this.setBps(path, cur.some((b) => b.line === line) ? cur.filter((b) => b.line !== line) : [...cur, { line }].sort((a, b) => a.line - b.line));
  }
  async editBp(path: string, line: number, kind: 'condition' | 'logMessage') {
    const cur = this.state.breakpoints[path] ?? [];
    const old = cur.find((b) => b.line === line);
    const v = await this.ui.prompt(kind === 'condition' ? `Breakpoint condition (line ${line}), e.g. i > 3` : `Log message (line ${line}); {expr} is interpolated`, old?.[kind] ?? '');
    if (v === null) return;
    const nb = { ...(old ?? { line }), [kind]: v.trim() || undefined };
    await this.setBps(path, [...cur.filter((b) => b.line !== line), nb].sort((a, b) => a.line - b.line));
  }

  // ---- editor integration
  attach(ed: monaco.editor.IStandaloneCodeEditor) {
    this.editors.add(ed);
    ed.updateOptions({ glyphMargin: true });
    this.decos.set(ed, ed.createDecorationsCollection());
    ed.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return;
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS && !e.event.altKey) return;
      const line = e.target.position?.lineNumber; const m = ed.getModel(); if (!line || !m) return;
      if (e.event.rightButton) return;
      this.toggle(m.uri.fsPath, line);
    });
    ed.addAction({ id: 'nova.debug.toggleBp', label: 'Debug: Toggle Breakpoint', keybindings: [monaco.KeyCode.F9], contextMenuGroupId: '9_debug', run: (e) => { const m = e.getModel(); const p = e.getPosition(); if (m && p) this.toggle(m.uri.fsPath, p.lineNumber); } });
    ed.addAction({ id: 'nova.debug.condBp', label: 'Debug: Add Conditional Breakpoint…', contextMenuGroupId: '9_debug', run: (e) => { const m = e.getModel(); const p = e.getPosition(); if (m && p) void this.editBp(m.uri.fsPath, p.lineNumber, 'condition'); } });
    ed.addAction({ id: 'nova.debug.logpoint', label: 'Debug: Add Logpoint…', contextMenuGroupId: '9_debug', run: (e) => { const m = e.getModel(); const p = e.getPosition(); if (m && p) void this.editBp(m.uri.fsPath, p.lineNumber, 'logMessage'); } });
    ed.onDidChangeModel(() => this.redecorate());
    ed.onDidDispose(() => { this.editors.delete(ed); this.decos.delete(ed); });
    this.redecorate();
  }
  private redecorate() {
    const f = this.currentFrame;
    for (const ed of this.editors) {
      const m = ed.getModel(); const col = this.decos.get(ed); if (!m || !col) continue;
      const p = m.uri.fsPath;
      const ver = this.state.verified[p];
      const ds: monaco.editor.IModelDeltaDecoration[] = (this.state.breakpoints[p] ?? []).map((b) => {
        const v = ver?.find((x) => x.line === b.line);
        const kind = b.logMessage ? 'log' : b.condition ? 'cond' : 'bp';
        const unverified = this.state.status.state !== 'idle' && this.state.status.state !== 'terminated' && v && !v.verified;
        return { range: new monaco.Range(b.line, 1, b.line, 1), options: { glyphMarginClassName: `nova-bp nova-bp-${kind}${unverified ? ' unverified' : ''}`, glyphMarginHoverMessage: { value: b.logMessage ? `Logpoint: ${b.logMessage}` : b.condition ? `Condition: ${b.condition}` : unverified ? `Unverified breakpoint${v?.message ? `: ${v.message}` : ''}` : 'Breakpoint' }, stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } };
      });
      if (f?.source?.path && this.state.status.state === 'stopped' && samePath(f.source.path, p)) {
        ds.push({ range: new monaco.Range(f.line, 1, f.line, 1), options: { isWholeLine: true, className: 'nova-debug-line', glyphMarginClassName: 'nova-debug-arrow' } });
      }
      col.set(ds);
    }
  }
}
export const samePath = (a: string, b: string) => {
  const n = (x: string) => x.replace(/\\/g, '/');
  return /^[a-zA-Z]:/.test(a) ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};
