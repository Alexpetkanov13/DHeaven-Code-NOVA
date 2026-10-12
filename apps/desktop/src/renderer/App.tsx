import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DirEntry, RecentEntry, Settings, WorkspaceInfo } from '@nova/ipc-contract';
import { call, IpcError, on } from './lib/ipc';
import { monaco } from './lib/monaco';
import { Explorer } from './components/Explorer';
import { CommandPalette, type Command } from './components/CommandPalette';
import { SettingsView } from './components/SettingsView';
import { Splitter } from './components/Splitter';
import { SearchView } from './components/SearchView';
import { ScmView } from './components/ScmView';
import { TerminalPanel } from './components/TerminalPanel';
import { ConfirmBox, ContextMenu, InputBox, type MenuItem } from './components/InputBox';
import { parentOf, joinRel, joinAbs, uriToRel } from './lib/paths';
import { LspBridge } from './lib/lsp';
import { applyTextEdits } from './lib/textEdits';
import { LanguageServersView } from './components/LanguageServersView';
import { JdkPanel } from './components/JdkPanel';
import { ProblemsPanel, type ProblemItem } from './components/ProblemsPanel';
import logo from './logo.svg';

type DiskState = 'ok' | 'changed' | 'deleted';
interface Tab { rel: string; model: monaco.editor.ITextModel; savedAltId: number; mtimeMs: number; disk: DiskState }
interface DiffState { rel: string; staged: boolean; original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel }
type View = 'explorer' | 'search' | 'scm' | 'lsp';
type Dialog =
  | { kind: 'input'; title: string; initial?: string; submit(v: string): void; cancel?(): void }
  | { kind: 'confirm'; message: string; confirmLabel: string; confirm(): void; extra?: { label: string; run(): void }; list?: string[]; cancel?(): void }
  | null;
const SETTINGS_TAB = '__settings__';
const DIFF_TAB = '__diff__';

export function App() {
  const [ws, setWs] = useState<WorkspaceInfo | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [children, setChildren] = useState(new Map<string, DirEntry[]>());
  const [expanded, setExpanded] = useState(new Set<string>());
  const [selected, setSelected] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffState | null>(null);
  const [view, setView] = useState<View>('explorer');
  const [panelTab, setPanelTab] = useState<'output' | 'terminal' | 'problems'>('output');
  const [problems, setProblems] = useState(new Map<string, ProblemItem[]>());
  const [palette, setPalette] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showPanel, setShowPanel] = useState(true);
  const [daemon, setDaemon] = useState('starting');
  const [scmKey, setScmKey] = useState(0);
  const [log, setLog] = useState<{ t: string; err?: boolean }[]>([{ t: 'DHeaven Code: NOVA started.' }]);
  const [cursor, setCursor] = useState({ ln: 1, col: 1 });
  const [, bump] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const diffHostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const diffEdRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const activeRef = useRef(active); activeRef.current = active;
  const childrenRef = useRef(children); childrenRef.current = children;
  const wsRef = useRef(ws); wsRef.current = ws;
  const modelUri = (rel: string) => monaco.Uri.file(joinAbs(wsRef.current!.root, rel));
  const bridgeRef = useRef<LspBridge | null>(null);

  const out = useCallback((t: string, err = false) => setLog((l) => [...l.slice(-500), { t: `[${new Date().toLocaleTimeString()}] ${t}`, err }]), []);
  const fail = useCallback((e: unknown) => out(e instanceof IpcError ? `${e.code}: ${e.message}` : String(e), true), [out]);

  useEffect(() => {
    void call('settings.get.v1', {}).then(setSettings).catch(fail);
    void call('recent.list.v1', {}).then(setRecent).catch(fail);
    void call('daemon.status.v1', {}).then((r) => setDaemon((d) => (d === 'starting' ? r.state : d))).catch(fail);
    return on('daemon.status.v1', (p) => { setDaemon(p.state); out(`novad ${p.state}${p.message ? `: ${p.message}` : ''}`, p.state === 'failed'); });
  }, [fail, out]);

  const loadDir = useCallback(async (rel: string) => {
    const entries = await call('fs.list.v1', { rel });
    setChildren((m) => new Map(m).set(rel, entries));
  }, []);

  const askTrust = useCallback((info: WorkspaceInfo) => setDialog({
    kind: 'confirm',
    message: `Do you trust the authors of the files in "${info.name}"? Trusting enables the terminal, Git commit (hooks) and, later, tasks and extensions. Restricted Mode still lets you browse, edit, search and stage.`,
    confirmLabel: 'Trust Folder',
    confirm: () => { setDialog(null); void call('trust.set.v1', { trusted: true }).then((r) => { setTrusted(r.trusted); out(`Workspace trusted: ${info.root}`); }).catch(fail); },
    extra: { label: 'Restricted Mode', run: () => setDialog(null) },
  }), [fail, out]);

  const adoptWorkspace = useCallback(async (info: WorkspaceInfo | null) => {
    if (!info) return;
    for (const t of tabsRef.current) { bridgeRef.current?.detach(t.model); t.model.dispose(); }
    for (const m of monaco.editor.getModels()) if (m.uri.scheme === 'file') m.dispose();
    setTabs([]); setActive(null); setChildren(new Map()); setExpanded(new Set()); setDiff(null); setProblems(new Map());
    setWs(info);
    out(`Opened folder ${info.root}`);
    await loadDir('');
    setRecent(await call('recent.list.v1', {}));
    const t = (await call('trust.get.v1', {})).trusted;
    setTrusted(t);
    if (!t) askTrust(info);
  }, [loadDir, out, askTrust]);

  const openFolder = useCallback(() => call('workspace.openDialog.v1', {}).then(adoptWorkspace).catch(fail), [adoptWorkspace, fail]);
  const openRecent = useCallback((root: string) => call('workspace.open.v1', { root }).then(adoptWorkspace).catch(fail), [adoptWorkspace, fail]);

  const openFile = useCallback(async (rel: string, line?: number, col?: number) => {
    if (!tabsRef.current.some((t) => t.rel === rel)) {
      try {
        const { content, mtimeMs } = await call('fs.read.v1', { rel });
        const existing = monaco.editor.getModel(modelUri(rel)); // may exist from go-to-definition/references
        const model = existing ?? monaco.editor.createModel(content, undefined, modelUri(rel));
        if (existing && existing.getValue() !== content && existing.getAlternativeVersionId() === 1) existing.setValue(content);
        model.onDidChangeContent(() => bump((n) => n + 1));
        bridgeRef.current?.attach(model);
        setTabs((ts) => [...ts, { rel, model, savedAltId: model.getAlternativeVersionId(), mtimeMs, disk: 'ok' }]);
      } catch (e) { fail(e); return; }
    }
    setActive(rel);
    if (line) setTimeout(() => { const ed = editorRef.current; if (ed) { ed.setPosition({ lineNumber: line, column: col ?? 1 }); ed.revealLineInCenter(line); ed.focus(); } }, 50);
  }, [fail]);

  const toggleDir = useCallback((rel: string) => {
    setExpanded((s) => { const n = new Set(s); if (n.has(rel)) n.delete(rel); else { n.add(rel); void loadDir(rel).catch(fail); } return n; });
  }, [loadDir, fail]);

  // ---- LSP bridge (created once; UI callbacks read refs)
  const openFileRef = useRef(openFile); openFileRef.current = openFile;
  useEffect(() => {
    const relOf = (uri: string) => (wsRef.current ? uriToRel(monaco.Uri.parse(uri).fsPath, wsRef.current.root) : null);
    const b = new LspBridge({
      ensureModel: async (uri) => {
        if (monaco.editor.getModel(monaco.Uri.parse(uri))) return;
        const rel = relOf(uri); if (rel === null) return;
        const { content } = await call('fs.read.v1', { rel });
        if (!monaco.editor.getModel(monaco.Uri.parse(uri))) monaco.editor.createModel(content, undefined, monaco.Uri.parse(uri));
      },
      prompt: (title, initial) => new Promise((resolve) => setDialog({ kind: 'input', title, initial, submit: (v) => { setDialog(null); resolve(v); }, cancel: () => resolve(null) })),
      confirmEdit: (title, summary) => new Promise((resolve) => setDialog({
        kind: 'confirm', message: `${title}: ${summary.reduce((a, x) => a + x.edits, 0)} edit(s) in ${summary.length} file(s)`, confirmLabel: 'Apply',
        list: summary.map((x) => `${relOf(x.uri) ?? x.uri} — ${x.edits} edit(s)`), confirm: () => { setDialog(null); resolve(true); }, cancel: () => resolve(false),
      })),
      log: (m, err) => out(m, err),
      writeUnopened: async (uri, edits) => {
        const rel = relOf(uri); if (rel === null) throw new Error(`Edit outside workspace refused: ${uri}`);
        const { content, mtimeMs } = await call('fs.read.v1', { rel });
        await call('fs.write.v1', { rel, content: applyTextEdits(content, edits), expectedMtimeMs: mtimeMs });
      },
      onDiagnostics: (uri, serverId, ds) => {
        const rel = relOf(uri);
        setProblems((m) => {
          const n = new Map(m); const key = `${serverId}|${uri}`;
          if (!ds.length || rel === null) n.delete(key);
          else n.set(key, ds.map((d) => ({ uri, rel, line: d.range.start.line + 1, col: d.range.start.character + 1, severity: d.severity === 2 ? 'warning' : d.severity && d.severity > 2 ? 'info' : 'error', message: d.message, source: d.source ?? serverId })));
          return n;
        });
      },
    });
    bridgeRef.current = b;
    const opener = monaco.editor.registerEditorOpener({
      openCodeEditor: (_src, resource, sel) => {
        const rel = relOf(resource.toString()); if (rel === null) return false;
        const pos = sel && 'startLineNumber' in sel ? { l: sel.startLineNumber, c: sel.startColumn } : sel && 'lineNumber' in sel ? { l: sel.lineNumber, c: sel.column } : null;
        void openFileRef.current(rel, pos?.l, pos?.c);
        return true;
      },
    });
    return () => { opener.dispose(); b.dispose(); bridgeRef.current = null; };
  }, [out]);

  // ---- watcher: refresh loaded dirs, flag/reload open tabs changed on disk
  useEffect(() => on('fs.changed.v1', ({ rels }) => {
    const dirs = new Set<string>();
    for (const r of rels) { dirs.add(parentOf(r)); dirs.add(r); }
    for (const d of dirs) if (childrenRef.current.has(d)) void loadDir(d).catch(() => setChildren((m) => { const n = new Map(m); n.delete(d); return n; }));
    const touched = new Set(rels);
    for (const t of tabsRef.current) {
      if (!touched.has(t.rel)) continue;
      void call('fs.stat.v1', { rel: t.rel }).then(async (st) => {
        const cur = tabsRef.current.find((x) => x.rel === t.rel);
        if (!cur) return;
        const dirty = cur.model.getAlternativeVersionId() !== cur.savedAltId;
        if (!st) { setTabs((ts) => ts.map((x) => (x.rel === t.rel ? { ...x, disk: 'deleted' } : x))); return; }
        if (Math.abs(st.mtimeMs - cur.mtimeMs) <= 1) return;
        if (dirty) { setTabs((ts) => ts.map((x) => (x.rel === t.rel ? { ...x, disk: 'changed' } : x))); return; }
        const { content, mtimeMs } = await call('fs.read.v1', { rel: t.rel });
        if (cur.model.getValue() !== content) cur.model.setValue(content);
        setTabs((ts) => ts.map((x) => (x.rel === t.rel ? { ...x, mtimeMs, disk: 'ok', savedAltId: x.model.getAlternativeVersionId() } : x)));
      }).catch(() => {});
    }
    setScmKey((k) => k + 1);
  }), [loadDir]);

  const markSaved = (rel: string, newRel: string, mtimeMs: number) =>
    setTabs((ts) => ts.map((t) => (t.rel === rel ? { ...t, rel: newRel, mtimeMs, disk: 'ok', savedAltId: t.model.getAlternativeVersionId() } : t)));

  const save = useCallback(async (force = false) => {
    const t = tabsRef.current.find((x) => x.rel === activeRef.current);
    if (!t) return;
    try {
      const r = await call('fs.write.v1', { rel: t.rel, content: t.model.getValue(), ...(force ? {} : { expectedMtimeMs: t.mtimeMs }) });
      markSaved(t.rel, t.rel, r.mtimeMs);
      bridgeRef.current?.saved(t.model);
      out(`Saved ${t.rel}`);
    } catch (e) {
      if (e instanceof IpcError && e.code === 'CONFLICT') {
        setDialog({ kind: 'confirm', message: `${t.rel} changed on disk. Overwrite it with your version?`, confirmLabel: 'Overwrite', confirm: () => { setDialog(null); void save(true); } });
        return;
      }
      fail(e);
    }
  }, [fail, out]);

  const saveAs = useCallback(async () => {
    const t = tabsRef.current.find((x) => x.rel === activeRef.current);
    if (!t) return;
    try {
      const r = await call('fs.saveAs.v1', { suggestedRel: t.rel, content: t.model.getValue() });
      if (!r) return;
      markSaved(t.rel, r.rel, r.mtimeMs); setActive(r.rel);
      out(`Saved as ${r.rel}`);
    } catch (e) { fail(e); }
  }, [fail, out]);

  const closeTab = useCallback((rel: string) => {
    if (rel === SETTINGS_TAB || rel === DIFF_TAB) {
      if (rel === DIFF_TAB) setDiff((d) => { d?.original.dispose(); d?.modified.dispose(); return null; });
      setActive(tabsRef.current.at(-1)?.rel ?? null); return;
    }
    const t = tabsRef.current.find((x) => x.rel === rel);
    if (!t) return;
    const doClose = () => {
      const rest = tabsRef.current.filter((x) => x.rel !== rel);
      bridgeRef.current?.detach(t.model); t.model.dispose(); setTabs(rest);
      if (activeRef.current === rel) setActive(rest.at(-1)?.rel ?? null);
    };
    if (t.model.getAlternativeVersionId() !== t.savedAltId) setDialog({ kind: 'confirm', message: `Discard unsaved changes to ${rel}?`, confirmLabel: 'Discard', confirm: () => { setDialog(null); doClose(); } });
    else doClose();
  }, []);

  // ---- explorer file operations
  const targetDir = useCallback((e: DirEntry | null) => (e ? (e.kind === 'dir' ? e.rel : parentOf(e.rel)) : ''), []);
  const newEntry = useCallback((kind: 'file' | 'dir', dir: string) => setDialog({
    kind: 'input', title: kind === 'file' ? 'New file name' : 'New folder name',
    submit: (name) => {
      setDialog(null);
      void call('fs.create.v1', { rel: joinRel(dir, name), kind }).then(async (r) => {
        out(`Created ${r.rel}`);
        if (dir) setExpanded((s) => new Set(s).add(dir));
        await loadDir(dir); await loadDir(parentOf(r.rel)).catch(() => {});
        if (kind === 'file') await openFile(r.rel);
      }).catch(fail);
    },
  }), [fail, loadDir, openFile, out]);
  const renameEntry = useCallback((e: DirEntry) => setDialog({
    kind: 'input', title: `Rename ${e.name}`, initial: e.name,
    submit: (name) => {
      setDialog(null);
      const to = joinRel(parentOf(e.rel), name);
      void call('fs.rename.v1', { from: e.rel, to }).then(async (r) => {
        out(`Renamed ${e.rel} → ${r.rel}`);
        setTabs((ts) => ts.map((t) => {
          if (t.rel !== e.rel && !t.rel.startsWith(e.rel + '/')) return t;
          const nrel = r.rel + t.rel.slice(e.rel.length);
          const model = monaco.editor.createModel(t.model.getValue(), undefined, modelUri(nrel));
          model.onDidChangeContent(() => bump((n) => n + 1));
          const dirty = t.model.getAlternativeVersionId() !== t.savedAltId;
          bridgeRef.current?.detach(t.model); t.model.dispose(); bridgeRef.current?.attach(model);
          return { ...t, rel: nrel, model, savedAltId: dirty ? -1 : model.getAlternativeVersionId() };
        }));
        setActive((a) => (a && (a === e.rel || a.startsWith(e.rel + '/')) ? r.rel + a.slice(e.rel.length) : a));
        await loadDir(parentOf(e.rel));
      }).catch(fail);
    },
  }), [fail, loadDir, out]);
  const deleteEntry = useCallback((e: DirEntry) => setDialog({
    kind: 'confirm', message: `Move "${e.rel}" to the trash?`, confirmLabel: 'Move to Trash',
    confirm: () => {
      setDialog(null);
      const after = async (trashed: boolean) => {
        out(`${trashed ? 'Trashed' : 'Deleted'} ${e.rel}`);
        setTabs((ts) => ts.map((t) => (t.rel === e.rel || t.rel.startsWith(e.rel + '/') ? { ...t, disk: 'deleted' } : t)));
        await loadDir(parentOf(e.rel));
      };
      void call('fs.delete.v1', { rel: e.rel, permanent: false }).then((r) => after(r.trashed)).catch((err) => {
        if (err instanceof IpcError && err.code === 'TRASH_FAILED') {
          setDialog({ kind: 'confirm', message: `Could not move "${e.rel}" to the trash. Delete it permanently? This cannot be undone.`, confirmLabel: 'Delete Permanently',
            confirm: () => { setDialog(null); void call('fs.delete.v1', { rel: e.rel, permanent: true }).then((r) => after(r.trashed)).catch(fail); } });
        } else fail(err);
      });
    },
  }), [fail, loadDir, out]);
  const onContext = useCallback((e: DirEntry | null, x: number, y: number) => {
    const dir = targetDir(e);
    const items: MenuItem[] = [{ label: 'New File…', run: () => newEntry('file', dir) }, { label: 'New Folder…', run: () => newEntry('dir', dir) }];
    if (e) items.push({ label: 'Rename…', run: () => renameEntry(e) }, { label: 'Delete', danger: true, run: () => deleteEntry(e) });
    setCtx({ x, y, items });
  }, [targetDir, newEntry, renameEntry, deleteEntry]);
  const selectedEntry = useCallback((): DirEntry | null => {
    if (!selected) return null;
    for (const list of childrenRef.current.values()) { const f = list.find((x) => x.rel === selected); if (f) return f; }
    return null;
  }, [selected]);

  // ---- diff
  const openDiff = useCallback(async (rel: string, staged: boolean, untracked: boolean) => {
    try {
      const original = untracked ? '' : (await call('git.show.v1', { rel, rev: staged ? 'HEAD' : 'INDEX' })).content;
      const modified = staged ? (await call('git.show.v1', { rel, rev: 'INDEX' })).content : (await call('fs.read.v1', { rel }).catch(() => ({ content: '' }))).content;
      const lang = monaco.editor.createModel('', undefined, monaco.Uri.file(`/__probe__/${Date.now()}/${rel}`));
      const id = lang.getLanguageId(); lang.dispose();
      setDiff((d) => { d?.original.dispose(); d?.modified.dispose(); return { rel, staged, original: monaco.editor.createModel(original, id), modified: monaco.editor.createModel(modified, id) }; });
      setActive(DIFF_TAB);
    } catch (e) { fail(e); }
  }, [fail]);

  const updateSettings = useCallback((p: Partial<Settings>) => {
    setSettings((s) => (s ? { ...s, ...p } : s));
    void call('settings.update.v1', p).then(setSettings).catch(fail);
  }, [fail]);

  // ---- Monaco lifecycle: one editor, models swapped per tab. Keystrokes never cross IPC.
  const activeTab = tabs.find((t) => t.rel === active);
  useEffect(() => {
    if (!hostRef.current || !activeTab) return;
    if (!editorRef.current) {
      const ed = monaco.editor.create(hostRef.current, { theme: 'nova-dark', automaticLayout: true, fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace' });
      ed.onDidChangeCursorPosition((e) => setCursor({ ln: e.position.lineNumber, col: e.position.column }));
      ed.addAction({ id: 'nova.rename', label: 'Rename Symbol (with preview)', keybindings: [monaco.KeyCode.F2], contextMenuGroupId: '1_modification', run: (e) => bridgeRef.current?.rename(e) });
      editorRef.current = ed;
    }
    editorRef.current.setModel(activeTab.model);
    editorRef.current.focus();
  }, [activeTab]);
  useEffect(() => {
    if (!settings || !editorRef.current) return;
    editorRef.current.updateOptions({ fontSize: settings.editorFontSize, tabSize: settings.editorTabSize, wordWrap: settings.editorWordWrap ? 'on' : 'off', minimap: { enabled: settings.editorMinimap } });
  }, [settings, activeTab]);
  useEffect(() => { if (!tabs.length && editorRef.current) { editorRef.current.dispose(); editorRef.current = null; } }, [tabs.length]);
  useEffect(() => {
    if (!diff || active !== DIFF_TAB || !diffHostRef.current) return;
    if (!diffEdRef.current) diffEdRef.current = monaco.editor.createDiffEditor(diffHostRef.current, { theme: 'nova-dark', automaticLayout: true, readOnly: true, originalEditable: false });
    diffEdRef.current.setModel({ original: diff.original, modified: diff.modified });
  }, [diff, active]);
  useEffect(() => { if (!diff && diffEdRef.current) { diffEdRef.current.dispose(); diffEdRef.current = null; } }, [diff]);

  const sizeTimer = useRef<number | undefined>(undefined);
  const resize = (key: 'sidebarWidth' | 'panelHeight', delta: number, min: number, max: number) => {
    setSettings((s) => {
      if (!s) return s;
      const v = Math.round(Math.min(max, Math.max(min, s[key] + delta)));
      window.clearTimeout(sizeTimer.current);
      sizeTimer.current = window.setTimeout(() => void call('settings.update.v1', { [key]: v }).catch(fail), 400);
      return { ...s, [key]: v };
    });
  };
  const showView = (v: View) => { if (view === v && showSidebar) setShowSidebar(false); else { setView(v); setShowSidebar(true); } };

  const commands: Command[] = useMemo(() => [
    { id: 'workspace.openFolder', title: 'File: Open Folder…', keybinding: 'Ctrl+O', run: openFolder },
    { id: 'file.save', title: 'File: Save', keybinding: 'Ctrl+S', run: () => void save() },
    { id: 'file.saveAs', title: 'File: Save As…', keybinding: 'Ctrl+Shift+S', run: () => void saveAs() },
    { id: 'file.close', title: 'File: Close Editor', run: () => active && closeTab(active) },
    { id: 'explorer.newFile', title: 'File: New File…', run: () => ws && newEntry('file', targetDir(selectedEntry())) },
    { id: 'explorer.newFolder', title: 'File: New Folder…', run: () => ws && newEntry('dir', targetDir(selectedEntry())) },
    { id: 'workbench.toggleSidebar', title: 'View: Toggle Sidebar', keybinding: 'Ctrl+B', run: () => setShowSidebar((v) => !v) },
    { id: 'workbench.togglePanel', title: 'View: Toggle Panel', keybinding: 'Ctrl+J', run: () => setShowPanel((v) => !v) },
    { id: 'workbench.search', title: 'View: Search', keybinding: 'Ctrl+Shift+F', run: () => { setView('search'); setShowSidebar(true); } },
    { id: 'workbench.scm', title: 'View: Source Control', keybinding: 'Ctrl+Shift+G', run: () => { setView('scm'); setShowSidebar(true); } },
    { id: 'terminal.focus', title: 'Terminal: Open Terminal', keybinding: 'Ctrl+`', run: () => { setShowPanel(true); setPanelTab('terminal'); } },
    { id: 'workspace.trust', title: 'Workspace: Manage Trust…', run: () => ws && (trusted ? void call('trust.set.v1', { trusted: false }).then((r) => setTrusted(r.trusted)) : askTrust(ws)) },
    { id: 'workbench.settings', title: 'Preferences: Open Settings', keybinding: 'Ctrl+,', run: () => setActive(SETTINGS_TAB) },
    { id: 'mode.focus', title: 'Mode: Focus', run: () => updateSettings({ mode: 'focus' }) },
    { id: 'mode.nova', title: 'Mode: NOVA', run: () => updateSettings({ mode: 'nova' }) },
    { id: 'editor.fontUp', title: 'Editor: Increase Font Size', run: () => settings && updateSettings({ editorFontSize: Math.min(40, settings.editorFontSize + 1) }) },
    { id: 'editor.fontDown', title: 'Editor: Decrease Font Size', run: () => settings && updateSettings({ editorFontSize: Math.max(8, settings.editorFontSize - 1) }) },
    ...recent.map((r) => ({ id: `recent:${r.root}`, title: `Open Recent: ${r.name}  —  ${r.root}`, run: () => void openRecent(r.root) })),
  ], [openFolder, save, saveAs, closeTab, active, updateSettings, settings, recent, openRecent, ws, newEntry, targetDir, selectedEntry, trusted, askTrust]);

  const commandsRef = useRef(commands); commandsRef.current = commands;
  useEffect(() => window.nova.onMenu((id) => {
    if (id === 'workbench.commandPalette') setPalette(true);
    else commandsRef.current.find((c) => c.id === id)?.run();
  }), []);
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const map: Record<string, string> = { ',': 'workbench.settings', '`': 'terminal.focus' };
      const k = e.shiftKey ? ({ F: 'workbench.search', G: 'workbench.scm' } as Record<string, string>)[e.key.toUpperCase()] : map[e.key];
      if (k) { e.preventDefault(); commandsRef.current.find((c) => c.id === k)?.run(); }
    };
    window.addEventListener('keydown', kd);
    return () => window.removeEventListener('keydown', kd);
  }, []);

  if (!settings) return null;
  const isDirty = (t: Tab) => t.model.getAlternativeVersionId() !== t.savedAltId;
  const showSettings = active === SETTINGS_TAB;
  const showDiff = active === DIFF_TAB && !!diff;
  const problemList = [...problems.values()].flat().sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);

  return (
    <div className={`wb mode-${settings.mode}`}>
      <div className="wb-main">
        <nav className="activity" aria-label="Activity bar">
          <img src={logo} alt="DHeaven Code NOVA" />
          <button className={view === 'explorer' && showSidebar ? 'on' : ''} title="Explorer (Ctrl+B)" aria-label="Explorer" onClick={() => showView('explorer')}>☰</button>
          <button className={view === 'search' && showSidebar ? 'on' : ''} title="Search (Ctrl+Shift+F)" aria-label="Search" onClick={() => showView('search')}>⌕</button>
          <button className={view === 'scm' && showSidebar ? 'on' : ''} title="Source Control (Ctrl+Shift+G)" aria-label="Source Control" onClick={() => showView('scm')}>⑂</button>
          <button className={view === 'lsp' && showSidebar ? 'on' : ''} title="Language Servers" aria-label="Language Servers" onClick={() => showView('lsp')}>◇</button>
          <button title="Command Palette (Ctrl+Shift+P)" aria-label="Command Palette" onClick={() => setPalette(true)}>⌘</button>
          <button title="Settings (Ctrl+,)" aria-label="Settings" onClick={() => setActive(SETTINGS_TAB)}>⚙</button>
        </nav>
        {showSidebar && (
          <>
            <aside className="sidebar" style={{ width: settings.sidebarWidth }} aria-label="Sidebar">
              <div className="sidebar-title">
                <span>{view === 'explorer' ? `Explorer${ws ? ` — ${ws.name}` : ''}` : view === 'search' ? 'Search' : view === 'lsp' ? 'Language Servers' : 'Source Control'}</span>
                {view === 'explorer' && ws && (
                  <span>
                    <button className="icon-btn" title="New File" aria-label="New File" onClick={() => newEntry('file', targetDir(selectedEntry()))}>＋</button>
                    <button className="icon-btn" title="New Folder" aria-label="New Folder" onClick={() => newEntry('dir', targetDir(selectedEntry()))}>▣</button>
                    <button className="icon-btn" title="Refresh" aria-label="Refresh Explorer" onClick={() => { for (const d of children.keys()) void loadDir(d).catch(() => {}); }}>↻</button>
                  </span>
                )}
              </div>
              {ws && !trusted && <div className="banner">Restricted Mode <button className="btn small" onClick={() => askTrust(ws)}>Trust…</button></div>}
              {!ws ? (
                <div style={{ padding: 12 }}><button className="btn" onClick={openFolder}>Open Folder</button></div>
              ) : view === 'explorer' ? (
                <Explorer children={children} expanded={expanded} selected={selected} onSelect={setSelected} onToggle={toggleDir} onOpen={(r) => void openFile(r)} onContext={onContext} />
              ) : view === 'search' ? (
                <SearchView onOpen={(r, l, c) => void openFile(r, l, c)} onError={fail} onLog={out} />
              ) : view === 'lsp' ? (
                <LanguageServersView trusted={trusted} onError={fail} askInstall={(sv) => setDialog({
                  kind: 'confirm', confirmLabel: 'Download and Install',
                  message: `Download ${sv.name} ${sv.version} (${sv.download.sizeHint}, ${sv.download.license}) from ${sv.download.url}? The archive is verified against a pinned SHA-256 before it is extracted. Nothing is downloaded without this confirmation.`,
                  confirm: () => { setDialog(null); void call('lsp.install.v1', { serverId: sv.id, consent: true }).catch(fail); },
                })}><JdkPanel onError={fail} hasWorkspace={!!ws} /></LanguageServersView>
              ) : (
                <ScmView refreshKey={scmKey} trusted={trusted} onOpenDiff={(r, s, u) => void openDiff(r, s, u)} onError={fail} onLog={out} />
              )}
            </aside>
            <Splitter dir="v" onDrag={(d) => resize('sidebarWidth', d, 160, 800)} />
          </>
        )}
        <main className="center">
          <section className="editor-area">
            {(tabs.length > 0 || showSettings || diff) && (
              <div className="tabs" role="tablist">
                {tabs.map((t) => (
                  <div key={t.rel} role="tab" aria-selected={t.rel === active} data-rel={t.rel} className={`tab${t.rel === active ? ' active' : ''}`} onClick={() => setActive(t.rel)} title={t.disk === 'ok' ? t.rel : `${t.rel} — ${t.disk === 'deleted' ? 'deleted on disk' : 'changed on disk'}`}>
                    {t.rel.split('/').pop()}
                    {t.disk !== 'ok' && <span className="disk" data-disk={t.disk} aria-label={t.disk === 'deleted' ? 'deleted on disk' : 'changed on disk'}>⚠</span>}
                    {isDirty(t) ? <span className="dirty" aria-label="unsaved changes" /> : null}
                    <button className="close" aria-label={`Close ${t.rel}`} onClick={(e) => { e.stopPropagation(); closeTab(t.rel); }}>×</button>
                  </div>
                ))}
                {diff && <div role="tab" aria-selected={showDiff} className={`tab${showDiff ? ' active' : ''}`} onClick={() => setActive(DIFF_TAB)}>{diff.rel.split('/').pop()} ({diff.staged ? 'Staged' : 'Working Tree'})<button className="close" aria-label="Close Diff" onClick={(e) => { e.stopPropagation(); closeTab(DIFF_TAB); }}>×</button></div>}
                {showSettings && <div role="tab" aria-selected className="tab active">Settings<button className="close" aria-label="Close Settings" onClick={() => closeTab(SETTINGS_TAB)}>×</button></div>}
              </div>
            )}
            {showSettings ? <SettingsView settings={settings} onChange={updateSettings} /> : null}
            <div className="editor-host" ref={hostRef} style={{ display: activeTab && !showSettings && !showDiff ? 'block' : 'none' }} />
            <div className="editor-host" ref={diffHostRef} aria-label="Diff editor" style={{ display: showDiff ? 'block' : 'none' }} />
            {!activeTab && !showSettings && !showDiff && (
              <div className="welcome">
                <img src={logo} alt="" />
                <h1>DHeaven Code: NOVA</h1>
                <div className="tag">Build Beyond Limits.</div>
                <button className="btn" onClick={openFolder}>Open Folder…</button>
                {recent.length > 0 && (
                  <ul className="recent" aria-label="Recent workspaces">
                    {recent.map((r) => <li key={r.root}><button onClick={() => void openRecent(r.root)}>{r.name}<small>{r.root}</small></button></li>)}
                  </ul>
                )}
              </div>
            )}
          </section>
          {showPanel && (
            <>
              <Splitter dir="h" onDrag={(d) => resize('panelHeight', -d, 80, 800)} />
              <section className="panel" style={{ height: settings.panelHeight }} aria-label="Panel">
                <div className="panel-tabs">
                  <button className={panelTab === 'output' ? 'on' : ''} onClick={() => setPanelTab('output')}>Output</button>
                  <button className={panelTab === 'terminal' ? 'on' : ''} onClick={() => setPanelTab('terminal')}>Terminal</button>
                  <button className={panelTab === 'problems' ? 'on' : ''} onClick={() => setPanelTab('problems')}>Problems{problemList.length ? <span className="count" aria-label="problem count">{problemList.length}</span> : null}</button>
                </div>
                {panelTab === 'problems' ? (
                  <ProblemsPanel items={problemList} onOpen={(p) => void openFile(p.rel, p.line, p.col)} />
                ) : panelTab === 'output' ? (
                  <div className="panel-body" role="log">{log.map((l, i) => <div key={i} className={l.err ? 'err' : ''}>{l.t}</div>)}</div>
                ) : ws ? (
                  <TerminalPanel trusted={trusted} workspaceKey={ws.root} onError={fail} onTrust={() => askTrust(ws)} />
                ) : <div className="trust-note muted">Open a folder to use the terminal.</div>}
              </section>
            </>
          )}
        </main>
      </div>
      <footer className="status" role="status">
        <span className="brand">◆ NOVA</span>
        <span>{ws ? ws.name : 'No folder'}</span>
        {ws && <span>{trusted ? 'Trusted' : 'Restricted'}</span>}
        <span title="Native daemon">novad: {daemon}</span>
        <span className="grow" />
        {activeTab && !showDiff && <span>Ln {cursor.ln}, Col {cursor.col}</span>}
        {activeTab && !showDiff && <span>{activeTab.model.getLanguageId()}</span>}
        {activeTab && !showDiff && <span>{isDirty(activeTab) ? 'Unsaved' : 'Saved'}</span>}
        <span>{settings.mode === 'focus' ? 'Focus' : 'NOVA'} mode</span>
      </footer>
      {palette && <CommandPalette commands={commands} onClose={() => { setPalette(false); editorRef.current?.focus(); }} />}
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />}
      {dialog?.kind === 'input' && <InputBox title={dialog.title} initial={dialog.initial ?? ''} onSubmit={dialog.submit} onCancel={() => { dialog.cancel?.(); setDialog(null); }} />}
      {dialog?.kind === 'confirm' && <ConfirmBox message={dialog.message} confirmLabel={dialog.confirmLabel} onConfirm={dialog.confirm} onCancel={() => { dialog.cancel?.(); setDialog(null); }} {...(dialog.extra ? { extra: dialog.extra } : {})}>{dialog.list && <ul className="preview-list" aria-label="Edit preview">{dialog.list.map((l) => <li key={l}>{l}</li>)}</ul>}</ConfirmBox>}
    </div>
  );
}
