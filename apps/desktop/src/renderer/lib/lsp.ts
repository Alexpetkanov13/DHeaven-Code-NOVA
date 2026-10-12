import type { LspDiagnostic, ServerStatus } from '@nova/ipc-contract';
import { monaco } from './monaco';
import { call, on } from './ipc';
import { flattenWorkspaceEdit, type TextEdit, type WorkspaceEditLike } from './textEdits';

export const LSP_LANGS = ['java', 'kotlin'];
type R = { start: { line: number; character: number }; end: { line: number; character: number } };
const toRange = (r: R) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const toPos = (p: monaco.IPosition) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const toLspRange = (r: monaco.IRange): R => ({ start: { line: r.startLineNumber - 1, character: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, character: r.endColumn - 1 } });
const md = (c: unknown): monaco.IMarkdownString[] => {
  if (!c) return [];
  if (Array.isArray(c)) return c.flatMap(md);
  if (typeof c === 'string') return [{ value: c }];
  const o = c as { kind?: string; value?: string; language?: string };
  if (o.language) return [{ value: '```' + o.language + '\n' + (o.value ?? '') + '\n```' }];
  return [{ value: o.value ?? '' }];
};
const K = monaco.languages.CompletionItemKind;
const KIND: Record<number, monaco.languages.CompletionItemKind> = { 1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field, 6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module, 10: K.Property, 11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet, 16: K.Color, 17: K.File, 18: K.Reference, 19: K.Folder, 20: K.EnumMember, 21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator, 25: K.TypeParameter };
const SEV: Record<number, monaco.MarkerSeverity> = { 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning, 3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint };

export interface BridgeUi {
  ensureModel(uri: string): Promise<void>;
  prompt(title: string, initial: string): Promise<string | null>;
  confirmEdit(title: string, summary: { uri: string; edits: number }[]): Promise<boolean>;
  log(msg: string, err?: boolean): void;
  writeUnopened(uri: string, edits: TextEdit[]): Promise<void>;
  onDiagnostics(uri: string, serverId: string, d: LspDiagnostic[]): void;
}

let seq = 0;
/** Wires Monaco models/providers to language servers in main. Editing stays local; sync is async and batched. */
export class LspBridge {
  private tracked = new Map<string, { model: monaco.editor.ITextModel; lang: string; sub: monaco.IDisposable; pending: { range?: R; text: string }[]; timer: number | null }>();
  status = new Map<string, ServerStatus>();
  private ready = new Set<string>();
  private disposers: (() => void)[] = [];

  constructor(private ui: BridgeUi) {
    this.disposers.push(on('lsp.status.v1', ({ servers }) => this.onStatus(servers)));
    this.disposers.push(on('lsp.diagnostics.v1', ({ uri, serverId, diagnostics }) => {
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (model) monaco.editor.setModelMarkers(model, `lsp:${serverId}`, diagnostics.map((d) => ({ ...toRange(d.range as R), startLineNumber: d.range.start.line + 1, startColumn: d.range.start.character + 1, endLineNumber: d.range.end.line + 1, endColumn: d.range.end.character + 1, message: d.message, severity: SEV[d.severity ?? 1] ?? monaco.MarkerSeverity.Error, source: d.source ?? serverId, code: d.code === undefined ? undefined : String(d.code) })));
      ui.onDiagnostics(uri, serverId, diagnostics);
    }));
    void call('lsp.status.v1', {}).then((s) => this.onStatus(s)).catch(() => {});
    for (const lang of LSP_LANGS) this.register(lang);
    monaco.editor.registerCommand('nova.lsp.command', (_a, lang: string, cmd: { command: string; arguments?: unknown[] }) => void this.runCommand(lang, cmd));
  }

  private langReady(lang: string) { return [...this.status.values()].some((s) => s.languages.includes(lang) && s.state === 'ready'); }
  private caps(lang: string) { return [...this.status.values()].find((s) => s.languages.includes(lang))?.capabilities ?? []; }

  private onStatus(servers: ServerStatus[]) {
    for (const s of servers) {
      this.status.set(s.id, s);
      const wasReady = this.ready.has(s.id);
      if (s.state === 'ready' && !wasReady) {
        this.ready.add(s.id);
        for (const t of this.tracked.values()) if (s.languages.includes(t.lang)) this.sendOpen(t.model, t.lang); // first start or after crash restart
      } else if (s.state !== 'ready') this.ready.delete(s.id);
    }
  }

  private sendOpen(model: monaco.editor.ITextModel, lang: string) {
    void call('lsp.open.v1', { languageId: lang, uri: model.uri.toString(), version: model.getVersionId(), text: model.getValue() }).catch((e) => this.ui.log(String(e), true));
  }

  attach(model: monaco.editor.ITextModel) {
    const lang = model.getLanguageId();
    const uri = model.uri.toString();
    if (!LSP_LANGS.includes(lang) || this.tracked.has(uri)) return;
    const t = { model, lang, pending: [] as { range?: R; text: string }[], timer: null as number | null, sub: null as unknown as monaco.IDisposable };
    t.sub = model.onDidChangeContent((e) => {
      for (const c of e.changes) t.pending.push({ range: toLspRange(c.range), text: c.text });
      if (t.timer === null) t.timer = window.setTimeout(() => this.flush(uri), 40);
    });
    this.tracked.set(uri, t);
    this.sendOpen(model, lang); // main starts the server if allowed; we re-open on 'ready'
  }
  /** Send queued incremental changes now (also called before any request so the server sees current text). */
  flush(uri: string) {
    const t = this.tracked.get(uri);
    if (!t) return;
    if (t.timer !== null) { clearTimeout(t.timer); t.timer = null; }
    if (!t.pending.length) return;
    const changes = t.pending.splice(0);
    void call('lsp.change.v1', { languageId: t.lang, uri, version: t.model.getVersionId(), changes }).catch(() => {});
  }
  saved(model: monaco.editor.ITextModel) { const t = this.tracked.get(model.uri.toString()); if (t) { this.flush(model.uri.toString()); void call('lsp.save.v1', { languageId: t.lang, uri: model.uri.toString() }).catch(() => {}); } }
  detach(model: monaco.editor.ITextModel) {
    const uri = model.uri.toString(); const t = this.tracked.get(uri);
    if (!t) return;
    t.sub.dispose(); this.tracked.delete(uri);
    void call('lsp.close.v1', { languageId: t.lang, uri }).catch(() => {});
  }

  /** Request with cancellation + stale-response guard (drops results computed for an older model version). */
  private async req<T>(model: monaco.editor.ITextModel, method: Parameters<typeof call<'lsp.request.v1'>>[1]['method'], params: unknown, token?: monaco.CancellationToken): Promise<T | null> {
    const lang = model.getLanguageId();
    if (!this.langReady(lang)) return null;
    this.flush(model.uri.toString());
    const version = model.getVersionId();
    const reqId = `r${++seq}`;
    const sub = token?.onCancellationRequested(() => void call('lsp.cancel.v1', { reqId }).catch(() => {}));
    try {
      const r = (await call('lsp.request.v1', { languageId: lang, reqId, method, params })) as T;
      if (token?.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return null;
      return r;
    } catch (e) {
      if (!token?.isCancellationRequested) this.ui.log(`${method}: ${e instanceof Error ? e.message : e}`, true);
      return null;
    } finally { sub?.dispose(); }
  }

  private register(lang: string) {
    const L = monaco.languages;
    const doc = (m: monaco.editor.ITextModel) => ({ uri: m.uri.toString() });
    L.registerCompletionItemProvider(lang, {
      triggerCharacters: ['.', ':', '@'],
      provideCompletionItems: async (model, position, ctx, token) => {
        if (!this.caps(lang).includes('completion')) return null;
        const r = await this.req<{ items?: unknown[]; isIncomplete?: boolean } | unknown[]>(model, 'textDocument/completion', { textDocument: doc(model), position: toPos(position), context: { triggerKind: ctx.triggerKind + 1, triggerCharacter: ctx.triggerCharacter } }, token);
        if (!r) return null;
        const items = (Array.isArray(r) ? r : r.items ?? []) as { label: string; kind?: number; detail?: string; documentation?: unknown; insertText?: string; insertTextFormat?: number; textEdit?: { range?: R; insert?: R; newText: string }; sortText?: string; filterText?: string; additionalTextEdits?: TextEdit[] }[];
        const w = model.getWordUntilPosition(position);
        const def = new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn);
        return {
          incomplete: !Array.isArray(r) && !!r.isIncomplete,
          suggestions: items.slice(0, 1000).map((it) => ({
            label: it.label, kind: KIND[it.kind ?? 1] ?? K.Text, detail: it.detail,
            documentation: it.documentation ? md(it.documentation)[0] : undefined,
            insertText: it.textEdit?.newText ?? it.insertText ?? it.label,
            insertTextRules: it.insertTextFormat === 2 ? L.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
            range: it.textEdit ? toRange((it.textEdit.range ?? it.textEdit.insert)!) : def,
            sortText: it.sortText, filterText: it.filterText,
            additionalTextEdits: it.additionalTextEdits?.map((e) => ({ range: toRange(e.range), text: e.newText })),
          })),
        };
      },
    });
    L.registerHoverProvider(lang, {
      provideHover: async (model, position, token) => {
        if (!this.caps(lang).includes('hover')) return null;
        const r = await this.req<{ contents: unknown; range?: R }>(model, 'textDocument/hover', { textDocument: doc(model), position: toPos(position) }, token);
        if (!r) return null;
        const contents = md(r.contents).filter((c) => c.value.trim());
        return contents.length ? { contents, range: r.range ? toRange(r.range) : undefined } : null;
      },
    });
    L.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: ['(', ','], signatureHelpRetriggerCharacters: [','],
      provideSignatureHelp: async (model, position, token) => {
        if (!this.caps(lang).includes('signatureHelp')) return null;
        const r = await this.req<{ signatures: { label: string; documentation?: unknown; parameters?: { label: string | [number, number]; documentation?: unknown }[] }[]; activeSignature?: number; activeParameter?: number }>(model, 'textDocument/signatureHelp', { textDocument: doc(model), position: toPos(position) }, token);
        if (!r?.signatures?.length) return null;
        return { value: { activeSignature: r.activeSignature ?? 0, activeParameter: r.activeParameter ?? 0, signatures: r.signatures.map((s) => ({ label: s.label, documentation: s.documentation ? md(s.documentation)[0] : undefined, parameters: (s.parameters ?? []).map((p) => ({ label: p.label, documentation: p.documentation ? md(p.documentation)[0] : undefined })) })) }, dispose() {} };
      },
    });
    const locs = (r: unknown): monaco.languages.Location[] => {
      const arr = (Array.isArray(r) ? r : r ? [r] : []) as { uri?: string; range?: R; targetUri?: string; targetSelectionRange?: R; targetRange?: R }[];
      return arr.map((l) => ({ uri: l.targetUri ?? l.uri ?? '', range: (l.targetSelectionRange ?? l.targetRange ?? l.range)! }))
        .filter((l) => l.uri.startsWith('file:') && l.range) // library (jdt://) locations aren't browsable yet
        .map((l) => ({ uri: monaco.Uri.parse(l.uri), range: toRange(l.range) }));
    };
    L.registerDefinitionProvider(lang, {
      provideDefinition: async (model, position, token) => {
        if (!this.caps(lang).includes('definition')) return null;
        const r = locs(await this.req(model, 'textDocument/definition', { textDocument: doc(model), position: toPos(position) }, token));
        await Promise.all(r.map((l) => this.ui.ensureModel(l.uri.toString())));
        return r;
      },
    });
    L.registerReferenceProvider(lang, {
      provideReferences: async (model, position, ctx, token) => {
        if (!this.caps(lang).includes('references')) return null;
        const r = locs(await this.req(model, 'textDocument/references', { textDocument: doc(model), position: toPos(position), context: { includeDeclaration: ctx.includeDeclaration } }, token));
        await Promise.all([...new Set(r.map((l) => l.uri.toString()))].slice(0, 200).map((u) => this.ui.ensureModel(u)));
        return r.filter((l) => monaco.editor.getModel(l.uri));
      },
    });
    L.registerDocumentFormattingEditProvider(lang, {
      provideDocumentFormattingEdits: async (model, options, token) => {
        if (!this.caps(lang).includes('formatting')) return null;
        const r = await this.req<TextEdit[]>(model, 'textDocument/formatting', { textDocument: doc(model), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } }, token);
        return r?.map((e) => ({ range: toRange(e.range), text: e.newText })) ?? null;
      },
    });
    L.registerCodeActionProvider(lang, {
      provideCodeActions: async (model, range, ctx, token) => {
        if (!this.caps(lang).includes('codeActions')) return null;
        const diagnostics = ctx.markers.map((m) => ({ range: toLspRange(m), message: m.message, severity: m.severity === monaco.MarkerSeverity.Error ? 1 : m.severity === monaco.MarkerSeverity.Warning ? 2 : 3, source: m.source, code: typeof m.code === 'string' ? m.code : undefined }));
        const r = await this.req<({ title: string; kind?: string; edit?: WorkspaceEditLike; command?: { command: string; arguments?: unknown[] } | string; arguments?: unknown[]; isPreferred?: boolean })[]>(model, 'textDocument/codeAction', { textDocument: doc(model), range: toLspRange(range), context: { diagnostics, only: ctx.only ? [ctx.only] : undefined } }, token);
        if (!r) return null;
        return {
          actions: r.map((a) => {
            const cmd = typeof a.command === 'string' ? { command: a.command, arguments: a.arguments } : a.command;
            return { title: a.title, kind: a.kind, isPreferred: a.isPreferred, diagnostics: ctx.markers,
              command: { id: 'nova.lsp.command', title: a.title, arguments: [lang, a.edit ? { command: '__nova.applyEdit', arguments: [a.edit, cmd] } : cmd] } };
          }),
          dispose() {},
        };
      },
    });
  }

  private async runCommand(lang: string, cmd: { command: string; arguments?: unknown[] } | undefined): Promise<void> {
    if (!cmd) return;
    if (cmd.command === '__nova.applyEdit') { await this.applyEdit(cmd.arguments![0] as WorkspaceEditLike, 'Apply code action'); return this.runCommand(lang, cmd.arguments![1] as never); }
    if (cmd.command === 'java.apply.workspaceEdit') { await this.applyEdit(cmd.arguments?.[0] as WorkspaceEditLike, 'Apply code action'); return; }
    try { await call('lsp.request.v1', { languageId: lang, reqId: `c${++seq}`, method: 'workspace/executeCommand', params: { command: cmd.command, arguments: cmd.arguments } }); }
    catch (e) { this.ui.log(`Command ${cmd.command} failed: ${e instanceof Error ? e.message : e}`, true); }
  }

  /** Applies a WorkspaceEdit: open models via undoable edits, other files written via validated main fs. */
  async applyEdit(we: WorkspaceEditLike, title: string, preview = false) {
    const { byUri, unsupported } = flattenWorkspaceEdit(we);
    if (unsupported.length) this.ui.log(`Skipped unsupported resource operations: ${unsupported.join(', ')}`, true);
    if (preview && !(await this.ui.confirmEdit(title, [...byUri].map(([uri, e]) => ({ uri, edits: e.length }))))) return false;
    for (const [uri, edits] of byUri) {
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (model) model.pushEditOperations([], edits.map((e) => ({ range: toRange(e.range), text: e.newText })), () => null);
      else await this.ui.writeUnopened(uri, edits);
    }
    return true;
  }

  /** F2 rename with preview. */
  async rename(editor: monaco.editor.ICodeEditor) {
    const model = editor.getModel(); const pos = editor.getPosition();
    if (!model || !pos) return;
    const lang = model.getLanguageId();
    if (!this.caps(lang).includes('rename')) { this.ui.log('Rename is not supported by the active language server', true); return; }
    const prep = await this.req<{ range?: R; placeholder?: string } | R>(model, 'textDocument/prepareRename', { textDocument: { uri: model.uri.toString() }, position: toPos(pos) });
    const word = model.getWordAtPosition(pos)?.word ?? '';
    const initial = prep && 'placeholder' in prep && prep.placeholder ? prep.placeholder : word;
    const newName = await this.ui.prompt(`Rename '${initial}' to`, initial);
    if (!newName || newName === initial) return;
    const we = await this.req<WorkspaceEditLike>(model, 'textDocument/rename', { textDocument: { uri: model.uri.toString() }, position: toPos(pos), newName });
    if (!we) { this.ui.log('Rename returned no edits', true); return; }
    await this.applyEdit(we, `Rename '${initial}' → '${newName}'`, true);
  }

  dispose() { for (const d of this.disposers) d(); }
}
