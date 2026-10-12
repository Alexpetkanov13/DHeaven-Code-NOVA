import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DirEntry, RecentEntry, Settings, WorkspaceInfo } from '@nova/ipc-contract';
import { call, IpcError } from './lib/ipc';
import { monaco } from './lib/monaco';
import { Explorer } from './components/Explorer';
import { CommandPalette, type Command } from './components/CommandPalette';
import { SettingsView } from './components/SettingsView';
import { Splitter } from './components/Splitter';
import logo from './logo.svg';

interface Tab { rel: string; model: monaco.editor.ITextModel; savedAltId: number; mtimeMs: number }
const SETTINGS_TAB = '__settings__';

export function App() {
  const [ws, setWs] = useState<WorkspaceInfo | null>(null);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [children, setChildren] = useState(new Map<string, DirEntry[]>());
  const [expanded, setExpanded] = useState(new Set<string>());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showPanel, setShowPanel] = useState(true);
  const [log, setLog] = useState<{ t: string; err?: boolean }[]>([{ t: 'DHeaven Code: NOVA started.' }]);
  const [cursor, setCursor] = useState({ ln: 1, col: 1 });
  const [, bump] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const activeRef = useRef(active); activeRef.current = active;

  const out = useCallback((t: string, err = false) => setLog((l) => [...l.slice(-500), { t: `[${new Date().toLocaleTimeString()}] ${t}`, err }]), []);
  const fail = useCallback((e: unknown) => out(e instanceof IpcError ? `${e.code}: ${e.message}` : String(e), true), [out]);

  useEffect(() => {
    void call('settings.get.v1', {}).then(setSettings).catch(fail);
    void call('recent.list.v1', {}).then(setRecent).catch(fail);
  }, [fail]);

  const loadDir = useCallback(async (rel: string) => {
    const entries = await call('fs.list.v1', { rel });
    setChildren((m) => new Map(m).set(rel, entries));
  }, []);

  const adoptWorkspace = useCallback(async (info: WorkspaceInfo | null) => {
    if (!info) return;
    for (const t of tabsRef.current) t.model.dispose();
    setTabs([]); setActive(null); setChildren(new Map()); setExpanded(new Set());
    setWs(info);
    out(`Opened folder ${info.root}`);
    await loadDir('');
    setRecent(await call('recent.list.v1', {}));
  }, [loadDir, out]);

  const openFolder = useCallback(() => call('workspace.openDialog.v1', {}).then(adoptWorkspace).catch(fail), [adoptWorkspace, fail]);
  const openRecent = useCallback((root: string) => call('workspace.open.v1', { root }).then(adoptWorkspace).catch(fail), [adoptWorkspace, fail]);

  const openFile = useCallback(async (rel: string) => {
    if (!tabsRef.current.some((t) => t.rel === rel)) {
      try {
        const { content, mtimeMs } = await call('fs.read.v1', { rel });
        const model = monaco.editor.createModel(content, undefined, monaco.Uri.file('/' + rel));
        model.onDidChangeContent(() => bump((n) => n + 1));
        setTabs((ts) => [...ts, { rel, model, savedAltId: model.getAlternativeVersionId(), mtimeMs }]);
      } catch (e) { fail(e); return; }
    }
    setActive(rel);
  }, [fail]);

  const toggleDir = useCallback((rel: string) => {
    setExpanded((s) => { const n = new Set(s); if (n.has(rel)) n.delete(rel); else { n.add(rel); void loadDir(rel).catch(fail); } return n; });
  }, [loadDir, fail]);

  const markSaved = (rel: string, newRel: string, mtimeMs: number) =>
    setTabs((ts) => ts.map((t) => (t.rel === rel ? { ...t, rel: newRel, mtimeMs, savedAltId: t.model.getAlternativeVersionId() } : t)));

  const save = useCallback(async (force = false) => {
    const t = tabsRef.current.find((x) => x.rel === activeRef.current);
    if (!t) return;
    try {
      const r = await call('fs.write.v1', { rel: t.rel, content: t.model.getValue(), ...(force ? {} : { expectedMtimeMs: t.mtimeMs }) });
      markSaved(t.rel, t.rel, r.mtimeMs);
      out(`Saved ${t.rel}`);
    } catch (e) {
      if (e instanceof IpcError && e.code === 'CONFLICT' && window.confirm(`${t.rel} changed on disk. Overwrite?`)) return save(true);
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
      const parent = r.rel.includes('/') ? r.rel.slice(0, r.rel.lastIndexOf('/')) : '';
      await loadDir(parent);
    } catch (e) { fail(e); }
  }, [fail, out, loadDir]);

  const closeTab = useCallback((rel: string) => {
    if (rel === SETTINGS_TAB) { setActive(tabsRef.current.at(-1)?.rel ?? null); return; }
    const t = tabsRef.current.find((x) => x.rel === rel);
    if (!t) return;
    if (t.model.getAlternativeVersionId() !== t.savedAltId && !window.confirm(`Discard unsaved changes to ${rel}?`)) return;
    const rest = tabsRef.current.filter((x) => x.rel !== rel);
    t.model.dispose();
    setTabs(rest);
    if (activeRef.current === rel) setActive(rest.at(-1)?.rel ?? null);
  }, []);

  const updateSettings = useCallback((p: Partial<Settings>) => {
    setSettings((s) => (s ? { ...s, ...p } : s));
    void call('settings.update.v1', p).then(setSettings).catch(fail);
  }, [fail]);

  // Monaco lifecycle: one editor instance, models swapped per tab. Keystrokes never cross IPC.
  const activeTab = tabs.find((t) => t.rel === active);
  useEffect(() => {
    if (!hostRef.current || !activeTab) return;
    if (!editorRef.current) {
      const ed = monaco.editor.create(hostRef.current, { theme: 'nova-dark', automaticLayout: true, fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace' });
      ed.onDidChangeCursorPosition((e) => setCursor({ ln: e.position.lineNumber, col: e.position.column }));
      editorRef.current = ed;
    }
    editorRef.current.setModel(activeTab.model);
    editorRef.current.focus();
  }, [activeTab]);
  useEffect(() => {
    if (!settings || !editorRef.current) return;
    editorRef.current.updateOptions({ fontSize: settings.editorFontSize, tabSize: settings.editorTabSize, wordWrap: settings.editorWordWrap ? 'on' : 'off', minimap: { enabled: settings.editorMinimap } });
    activeTab?.model.updateOptions({ tabSize: settings.editorTabSize });
  }, [settings, activeTab]);
  useEffect(() => {
    if (!activeTab && editorRef.current) { editorRef.current.dispose(); editorRef.current = null; }
  }, [activeTab]);

  // Persist panel sizes (debounced)
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

  const commands: Command[] = useMemo(() => [
    { id: 'workspace.openFolder', title: 'File: Open Folder…', keybinding: 'Ctrl+O', run: openFolder },
    { id: 'file.save', title: 'File: Save', keybinding: 'Ctrl+S', run: () => void save() },
    { id: 'file.saveAs', title: 'File: Save As…', keybinding: 'Ctrl+Shift+S', run: () => void saveAs() },
    { id: 'file.close', title: 'File: Close Editor', run: () => active && closeTab(active) },
    { id: 'workbench.toggleSidebar', title: 'View: Toggle Sidebar', keybinding: 'Ctrl+B', run: () => setShowSidebar((v) => !v) },
    { id: 'workbench.togglePanel', title: 'View: Toggle Panel', keybinding: 'Ctrl+J', run: () => setShowPanel((v) => !v) },
    { id: 'workbench.settings', title: 'Preferences: Open Settings', keybinding: 'Ctrl+,', run: () => setActive(SETTINGS_TAB) },
    { id: 'mode.focus', title: 'Mode: Focus', run: () => updateSettings({ mode: 'focus' }) },
    { id: 'mode.nova', title: 'Mode: NOVA', run: () => updateSettings({ mode: 'nova' }) },
    { id: 'editor.fontUp', title: 'Editor: Increase Font Size', run: () => settings && updateSettings({ editorFontSize: Math.min(40, settings.editorFontSize + 1) }) },
    { id: 'editor.fontDown', title: 'Editor: Decrease Font Size', run: () => settings && updateSettings({ editorFontSize: Math.max(8, settings.editorFontSize - 1) }) },
    ...recent.map((r) => ({ id: `recent:${r.root}`, title: `Open Recent: ${r.name}  —  ${r.root}`, run: () => void openRecent(r.root) })),
  ], [openFolder, save, saveAs, closeTab, active, updateSettings, settings, recent, openRecent]);

  const commandsRef = useRef(commands); commandsRef.current = commands;
  useEffect(() => window.nova.onMenu((id) => {
    if (id === 'workbench.commandPalette') setPalette(true);
    else commandsRef.current.find((c) => c.id === id)?.run();
  }), []);
  useEffect(() => {
    const kd = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); setActive(SETTINGS_TAB); } };
    window.addEventListener('keydown', kd);
    return () => window.removeEventListener('keydown', kd);
  }, []);

  if (!settings) return null;
  const isDirty = (t: Tab) => t.model.getAlternativeVersionId() !== t.savedAltId;
  const showSettings = active === SETTINGS_TAB;

  return (
    <div className={`wb mode-${settings.mode}`}>
      <div className="wb-main">
        <nav className="activity" aria-label="Activity bar">
          <img src={logo} alt="DHeaven Code NOVA" />
          <button title="Explorer (Ctrl+B)" aria-label="Toggle Explorer" onClick={() => setShowSidebar((v) => !v)}>☰</button>
          <button title="Command Palette (Ctrl+Shift+P)" aria-label="Command Palette" onClick={() => setPalette(true)}>⌘</button>
          <button title="Settings (Ctrl+,)" aria-label="Settings" onClick={() => setActive(SETTINGS_TAB)}>⚙</button>
        </nav>
        {showSidebar && (
          <>
            <aside className="sidebar" style={{ width: settings.sidebarWidth }} aria-label="Sidebar">
              <div className="sidebar-title">Explorer{ws ? ` — ${ws.name}` : ''}</div>
              {ws ? (
                <Explorer children={children} expanded={expanded} selected={active} onToggle={toggleDir} onOpen={(r) => void openFile(r)} />
              ) : (
                <div style={{ padding: 12 }}><button className="btn" onClick={openFolder}>Open Folder</button></div>
              )}
            </aside>
            <Splitter dir="v" onDrag={(d) => resize('sidebarWidth', d, 160, 800)} />
          </>
        )}
        <main className="center">
          <section className="editor-area">
            {(tabs.length > 0 || showSettings) && (
              <div className="tabs" role="tablist">
                {tabs.map((t) => (
                  <div key={t.rel} role="tab" aria-selected={t.rel === active} data-rel={t.rel} className={`tab${t.rel === active ? ' active' : ''}`} onClick={() => setActive(t.rel)} title={t.rel}>
                    {t.rel.split('/').pop()}
                    {isDirty(t) ? <span className="dirty" aria-label="unsaved changes" /> : null}
                    <button className="close" aria-label={`Close ${t.rel}`} onClick={(e) => { e.stopPropagation(); closeTab(t.rel); }}>×</button>
                  </div>
                ))}
                {showSettings && <div role="tab" aria-selected className="tab active">Settings<button className="close" aria-label="Close Settings" onClick={() => closeTab(SETTINGS_TAB)}>×</button></div>}
              </div>
            )}
            {showSettings ? <SettingsView settings={settings} onChange={updateSettings} /> : null}
            <div className="editor-host" ref={hostRef} style={{ display: activeTab && !showSettings ? 'block' : 'none' }} />
            {!activeTab && !showSettings && (
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
                <div className="panel-head">Output</div>
                <div className="panel-body" role="log">{log.map((l, i) => <div key={i} className={l.err ? 'err' : ''}>{l.t}</div>)}</div>
              </section>
            </>
          )}
        </main>
      </div>
      <footer className="status" role="status">
        <span className="brand">◆ NOVA</span>
        <span>{ws ? ws.name : 'No folder'}</span>
        <span className="grow" />
        {activeTab && <span>Ln {cursor.ln}, Col {cursor.col}</span>}
        {activeTab && <span>{activeTab.model.getLanguageId()}</span>}
        {activeTab && <span>{isDirty(activeTab) ? 'Unsaved' : 'Saved'}</span>}
        <span>{settings.mode === 'focus' ? 'Focus' : 'NOVA'} mode</span>
      </footer>
      {palette && <CommandPalette commands={commands} onClose={() => { setPalette(false); editorRef.current?.focus(); }} />}
    </div>
  );
}
