import * as monaco from 'monaco-editor';
import { parseDocument, isMap, isScalar, type Node } from 'yaml';
import { fileMatches, validateSchema, type Schema } from './schemaValidate';

export interface YamlSchemaSource { fileMatch: string[]; schema: unknown; label: string }
const OWNER = 'nova-yaml-schema';

/** Validates YAML models against contributed schemas and sets Monaco markers; offers top-level key completion. */
export class YamlSchemaValidator {
  private sources: YamlSchemaSource[] = [];
  private subs: monaco.IDisposable[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private relOf: (uri: monaco.Uri) => string | null) {
    this.subs.push(monaco.editor.onDidCreateModel((m) => this.watch(m)));
    for (const m of monaco.editor.getModels()) this.watch(m);
    this.subs.push(monaco.languages.registerCompletionItemProvider('yaml', {
      provideCompletionItems: (model, pos) => {
        const s = this.schemaFor(model); const props = s && typeof s === 'object' ? (s as { properties?: Record<string, { description?: string }> }).properties : null;
        if (!props) return { suggestions: [] };
        const line = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
        if (!/^[A-Za-z-]*$/.test(line)) return { suggestions: [] }; // top-level keys only
        const present = new Set(Object.keys((parseDocument(model.getValue()).toJS() ?? {}) as object));
        const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: 1, endColumn: pos.column };
        return { suggestions: Object.entries(props).filter(([k]) => !present.has(k)).map(([k, v]) => ({ label: k, kind: monaco.languages.CompletionItemKind.Property, insertText: `${k}: `, documentation: v.description ?? '', range })) };
      },
    }));
  }
  setSources(s: YamlSchemaSource[]) { this.sources = s; for (const m of monaco.editor.getModels()) this.validate(m); }
  dispose() { for (const d of this.subs) d.dispose(); }
  private schemaFor(model: monaco.editor.ITextModel): Schema | null {
    const rel = this.relOf(model.uri); if (rel === null || model.getLanguageId() !== 'yaml') return null;
    return (this.sources.find((s) => fileMatches(s.fileMatch, rel))?.schema as Schema) ?? null;
  }
  private watch(m: monaco.editor.ITextModel) {
    this.validate(m);
    const d = m.onDidChangeContent(() => {
      clearTimeout(this.timers.get(m.id)); this.timers.set(m.id, setTimeout(() => this.validate(m), 250));
    });
    m.onWillDispose(() => { d.dispose(); clearTimeout(this.timers.get(m.id)); });
  }
  validate(model: monaco.editor.ITextModel) {
    if (model.isDisposed()) return;
    const schema = this.schemaFor(model);
    if (!schema) { monaco.editor.setModelMarkers(model, OWNER, []); return; }
    const src = this.sources.find((s) => s.schema === schema)!;
    const text = model.getValue();
    const doc = parseDocument(text, { prettyErrors: false });
    const markers: monaco.editor.IMarkerData[] = [];
    const at = (start: number, end: number, message: string, severity = monaco.MarkerSeverity.Error) => {
      const a = model.getPositionAt(start), b = model.getPositionAt(Math.max(end, start + 1));
      markers.push({ startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column, message, severity, source: src.label });
    };
    for (const e of doc.errors) at(e.pos[0], e.pos[1], `YAML: ${e.message.split('\n')[0]}`);
    if (!doc.errors.length) {
      for (const e of validateSchema(schema, doc.toJS() ?? {})) {
        let node: Node | null = null; let keyNode: Node | null = null;
        if (e.path.length) {
          const parent = doc.getIn(e.path.slice(0, -1), true) as Node | undefined;
          if (parent && isMap(parent)) { const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === e.path[e.path.length - 1]); keyNode = (pair?.key as Node) ?? null; }
          node = (doc.getIn(e.path, true) as Node | undefined) ?? null;
        }
        const target = e.kind === 'key' ? keyNode ?? node : e.kind === 'missing' ? (node && isMap(node) ? (node.items[0]?.key as Node) ?? node : keyNode ?? node) : node ?? keyNode;
        const r = target?.range ?? (doc.contents as Node | null)?.range ?? [0, Math.min(text.length, 1)];
        at(r[0], r[1], e.message, e.kind === 'key' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error);
      }
    }
    monaco.editor.setModelMarkers(model, OWNER, markers);
  }
}
