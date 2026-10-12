import type { ExtContributions, ExtHostInfo, ExtInfo, ExtStatusItem, Events } from '@nova/ipc-contract';
import { call, on } from './ipc';
import { monaco } from './monaco';
import { sanitizeTheme, THEMABLE_VARS } from './themeSanitize';
import { YamlSchemaValidator } from './yamlSchema';
export { sanitizeTheme, THEMABLE_VARS };

export const DEFAULT_THEME = 'nova-dark';
export const monacoThemeName = (id: string) => `ext-${id.replace(/[^a-z0-9-]/gi, '-')}`.slice(0, 120);

/** JSON language configuration → Monaco: string patterns become RegExps, indent actions become enums (VS Code format). */
export function toLanguageConfiguration(raw: Record<string, unknown>): monaco.languages.LanguageConfiguration {
  const re = (v: unknown) => (typeof v === 'string' ? new RegExp(v) : v && typeof v === 'object' && typeof (v as { pattern?: unknown }).pattern === 'string' ? new RegExp((v as { pattern: string }).pattern, (v as { flags?: string }).flags ?? '') : undefined);
  const out: Record<string, unknown> = { ...raw };
  if (raw.wordPattern) out.wordPattern = re(raw.wordPattern);
  const ir = raw.indentationRules as Record<string, unknown> | undefined;
  if (ir) out.indentationRules = Object.fromEntries(Object.entries(ir).map(([k, v]) => [k, re(v)]).filter(([, v]) => v));
  const acts: Record<string, monaco.languages.IndentAction> = { none: monaco.languages.IndentAction.None, indent: monaco.languages.IndentAction.Indent, indentOutdent: monaco.languages.IndentAction.IndentOutdent, outdent: monaco.languages.IndentAction.Outdent };
  if (Array.isArray(raw.onEnterRules)) out.onEnterRules = (raw.onEnterRules as Record<string, unknown>[]).map((r) => {
    const a = (r.action ?? {}) as Record<string, unknown>;
    return { ...(r.beforeText ? { beforeText: re(r.beforeText) } : {}), ...(r.afterText ? { afterText: re(r.afterText) } : {}), ...(r.previousLineText ? { previousLineText: re(r.previousLineText) } : {}),
      action: { ...a, indentAction: acts[String(a.indent ?? a.indentAction ?? 'none')] ?? monaco.languages.IndentAction.None } };
  });
  return out as monaco.languages.LanguageConfiguration;
}

type Snip = { prefix: string | string[]; body: string | string[]; description?: string };

/** Renderer-side state for extensions: lists, contributions, host status, output channels, status items. */
export class ExtensionsClient {
  list: ExtInfo[] = [];
  contributions: ExtContributions = { commands: [], editorContext: [], themes: [], languages: [], grammars: [], snippets: [], views: [], tasks: [], outputChannels: [], jsonValidation: [], yamlValidation: [], gradleRunTasks: [], status: [] };
  host: ExtHostInfo | null = null;
  status: ExtStatusItem[] = [];
  channels = new Map<string, { key: string; extId: string; name: string; text: string }>();
  activeTheme = DEFAULT_THEME;
  private subs = new Set<() => void>();
  private statusSeq = 0;
  private offs: (() => void)[] = [];
  private langDisposables: monaco.IDisposable[] = [];
  private registeredLangs = new Set<string>();
  private firedLangs = new Set<string>();
  private extraExts = new Set<string>();
  private yaml: YamlSchemaValidator | null = null;
  constructor(private hooks: { onOutput(e: Events['ext.output.v1']): void; onMessage(e: Events['ext.message.v1']): void; onPermission(e: Events['ext.permissionRequest.v1']): void; onTree(viewId: string): void; onError(e: unknown): void }) {
    this.offs.push(
      on('ext.changed.v1', () => void this.refresh()),
      on('ext.host.v1', (h) => { this.host = h; this.notify(); }),
      on('ext.status.v1', (s) => { this.statusSeq++; this.status = s; this.notify(); }),
      on('ext.output.v1', (e) => { this.channels.set(e.key, { key: e.key, extId: e.extId, name: e.name, text: e.text }); this.notify(); this.hooks.onOutput(e); }),
      on('ext.message.v1', (e) => this.hooks.onMessage(e)),
      on('ext.permissionRequest.v1', (e) => this.hooks.onPermission(e)),
      on('ext.treeChanged.v1', (e) => this.hooks.onTree(e.viewId)),
    );
    monaco.editor.onDidCreateModel((m) => this.languageOpened(m.getLanguageId()));
  }
  dispose() { for (const o of this.offs) o(); for (const d of this.langDisposables) d.dispose(); this.yaml?.dispose(); }
  subscribe(f: () => void) { this.subs.add(f); return () => { this.subs.delete(f); }; }
  private notify() { for (const f of this.subs) f(); }

  async refresh() {
    const seq = this.statusSeq;
    try {
      const [list, contributions, host, chans] = await Promise.all([call('ext.list.v1', {}), call('ext.contributions.v1', {}), call('ext.hostInfo.v1', {}), call('ext.outputChannels.v1', {})]);
      this.list = list; this.contributions = contributions; this.host = host;
      if (seq === this.statusSeq) this.status = contributions.status; // a newer status event wins over this (possibly stale) snapshot
      for (const c of chans) if (!this.channels.has(c.key)) this.channels.set(c.key, c); // events carry full text and are newer than this snapshot
      for (const k of [...this.channels.keys()]) if (!chans.some((c) => c.key === k) && !list.some((x) => x.id === this.channels.get(k)!.extId)) this.channels.delete(k);
      this.applyLanguages();
      if (this.activeTheme !== DEFAULT_THEME && !contributions.themes.some((t) => t.id === this.activeTheme)) this.applyTheme(DEFAULT_THEME);
      else if (this.activeTheme !== DEFAULT_THEME) this.applyTheme(this.activeTheme);
    } catch (e) { this.hooks.onError(e); }
    this.notify();
  }

  /** Declarative language contributions: ids/extensions, Monarch grammar, language configuration, snippets. No extension code runs. */
  private applyLanguages() {
    for (const d of this.langDisposables) d.dispose();
    this.langDisposables = [];
    const c = this.contributions;
    for (const l of c.languages) {
      if (!this.registeredLangs.has(l.id) && !monaco.languages.getLanguages().some((x) => x.id === l.id)) { monaco.languages.register({ id: l.id, aliases: l.aliases, extensions: l.extensions }); this.registeredLangs.add(l.id); }
      else { // extra file extensions for an existing (e.g. built-in) language; Monaco merges registrations
        const add = l.extensions.filter((e) => !this.extraExts.has(`${l.id}:${e}`));
        if (add.length) { monaco.languages.register({ id: l.id, extensions: add }); for (const e of add) this.extraExts.add(`${l.id}:${e}`); }
      }
      if (l.configurationData && typeof l.configurationData === 'object' && !('__error' in l.configurationData)) {
        try { this.langDisposables.push(monaco.languages.setLanguageConfiguration(l.id, toLanguageConfiguration(l.configurationData as Record<string, unknown>))); } catch (e) { this.hooks.onError(`${l.extName}: language configuration rejected: ${e}`); }
      }
    }
    for (const g of c.grammars) {
      try { this.langDisposables.push(monaco.languages.setMonarchTokensProvider(g.language, g.data as monaco.languages.IMonarchLanguage)); } catch (e) { this.hooks.onError(`${g.extName}: grammar for ${g.language} rejected: ${e}`); }
    }
    // Schema validation + completion: JSON via Monaco's JSON language service; YAML via a CSP-safe validator.
    monaco.json.jsonDefaults.setDiagnosticsOptions({
      validate: true, enableSchemaRequest: false, allowComments: false, schemaValidation: 'error',
      schemas: c.jsonValidation.filter((v) => v.schema && typeof v.schema === 'object' && !('__error' in (v.schema as object))).map((v) => ({
        uri: `https://nova.invalid/schemas/${v.extId}/${v.schemaPath}`, fileMatch: v.fileMatch.map((f) => `**/${f}`), schema: v.schema as object,
      })),
    });
    this.yaml ??= new YamlSchemaValidator((uri) => uri.path);
    this.yaml.setSources(c.yamlValidation.filter((v) => v.schema && typeof v.schema === 'object').map((v) => ({ fileMatch: v.fileMatch, schema: v.schema, label: `${v.schemaPath.split('/').pop()!.replace('.schema.json', '')} schema (${v.extName})` })));
    const byLang = new Map<string, Snip[]>();
    for (const s of c.snippets) for (const v of Object.values((s.data ?? {}) as Record<string, Snip>)) if (v && v.body && v.prefix) byLang.set(s.language, [...(byLang.get(s.language) ?? []), v]);
    for (const [lang, snips] of byLang) {
      this.langDisposables.push(monaco.languages.registerCompletionItemProvider(lang, {
        provideCompletionItems: (model, pos) => {
          const w = model.getWordUntilPosition(pos);
          const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
          return { suggestions: snips.flatMap((s) => (Array.isArray(s.prefix) ? s.prefix : [s.prefix]).map((p) => ({
            label: p, kind: monaco.languages.CompletionItemKind.Snippet, documentation: s.description ?? '', detail: s.description ?? 'snippet',
            insertText: Array.isArray(s.body) ? s.body.join('\n') : s.body, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range,
          }))) };
        },
      }));
    }
  }
  private languageOpened(id: string) {
    if (this.firedLangs.has(id)) return; this.firedLangs.add(id);
    if (/^[A-Za-z0-9_.-]+$/.test(id)) void call('ext.fireEvent.v1', { event: `onLanguage:${id}` }).catch(() => {});
  }

  /** Applies a contributed (or the built-in) colour theme to Monaco and the workbench CSS variables. */
  applyTheme(id: string): boolean {
    const root = document.documentElement.style;
    for (const v of THEMABLE_VARS) root.removeProperty(`--${v}`);
    const t = this.contributions.themes.find((x) => x.id === id);
    if (id === DEFAULT_THEME || !t) { monaco.editor.setTheme(DEFAULT_THEME); this.activeTheme = DEFAULT_THEME; document.documentElement.dataset.theme = DEFAULT_THEME; this.notify(); return id === DEFAULT_THEME; }
    const s = sanitizeTheme(t.data, t.uiTheme);
    const name = monacoThemeName(t.id);
    monaco.editor.defineTheme(name, { base: s.base, inherit: true, rules: s.rules, colors: s.colors });
    monaco.editor.setTheme(name);
    for (const [k, v] of Object.entries(s.vars)) root.setProperty(`--${k}`, v);
    this.activeTheme = id; document.documentElement.dataset.theme = id;
    this.notify();
    return true;
  }
}
