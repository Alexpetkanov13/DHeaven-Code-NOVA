import { useEffect, useRef } from 'react';
import { monaco } from '../lib/monaco';

/** One Monaco editor for an editor group. Models are shared between groups; view state is kept per model in this pane. */
export type ViewStates = Record<string, monaco.editor.ICodeEditorViewState>;

export function EditorPane({ model, visible, options, setup, onFocus, onShown, label, initialViews, exposeViews }: {
  model: monaco.editor.ITextModel | null; visible: boolean; label: string;
  options: monaco.editor.IEditorOptions;
  setup(ed: monaco.editor.IStandaloneCodeEditor): () => void;
  onFocus(): void; onShown(ed: monaco.editor.IStandaloneCodeEditor): void;
  /** view states (cursor, selection, scroll) by model URI, e.g. restored from the last session */
  initialViews?: ViewStates | undefined; exposeViews?(get: () => ViewStates): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const views = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>(Object.entries(initialViews ?? {})));
  useEffect(() => { exposeViews?.(() => {
    const out: ViewStates = {};
    for (const [k, v] of views.current) if (v) out[k] = v;
    const e = ed.current; const m = e?.getModel(); const cur = e?.saveViewState();
    if (m && cur) out[m.uri.toString()] = cur;
    return out;
  }); }, [exposeViews]);
  const cb = useRef({ onFocus, onShown }); cb.current = { onFocus, onShown };
  useEffect(() => {
    const e = monaco.editor.create(host.current!, { theme: 'nova-dark', automaticLayout: true, fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace', ...options });
    ed.current = e;
    const undo = setup(e);
    const f = e.onDidFocusEditorWidget(() => cb.current.onFocus());
    return () => { f.dispose(); undo(); e.dispose(); ed.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- created once per group
  }, []);
  useEffect(() => { ed.current?.updateOptions(options); }, [options]);
  useEffect(() => {
    const e = ed.current; if (!e) return;
    const prev = e.getModel();
    if (prev === model) return;
    if (prev && !prev.isDisposed()) views.current.set(prev.uri.toString(), e.saveViewState());
    e.setModel(model && !model.isDisposed() ? model : null);
    if (model) { const v = views.current.get(model.uri.toString()); if (v) e.restoreViewState(v); cb.current.onShown(e); }
  }, [model]);
  return <div className="editor-host" ref={host} aria-label={label} style={{ display: visible && model ? 'block' : 'none' }} />;
}
